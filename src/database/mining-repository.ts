import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { z } from "zod";

import { normalizeDecimalString } from "../features/market/market-contract.js";
import {
  communityWeightStatuses,
  isCommunityWeightWithinRange,
  miningFormulaDocumentSchema,
  miningFormulaStatuses,
  miningHoldingsSources,
  miningPriceGuardRulesSchema,
  miningReferencePriceQualities,
  miningSnapshotStatuses,
  miningUnreadInputsSchema,
  miningWeightRangeDocumentSchema,
  priceVersionPatternSource,
  unsignedDecimalPatternSource,
  walletBalanceSources,
} from "../features/mining/mining-contract.js";
import {
  MiningCommunityAssetNotBoundError,
  MiningCommunityNotFoundError,
  MiningCommunityWeightConflictError,
  MiningFormulaExistsError,
  MiningFormulaNotFoundError,
  MiningFormulaSelfApprovalError,
  MiningFormulaStateError,
  MiningRepositoryUnavailableError,
  MiningSnapshotNotFoundError,
  MiningWeightOutOfRangeError,
  type CommunityWeightRecord,
  type CreateMiningFormulaVersionInput,
  type InvalidateMiningSnapshotsInput,
  type MiningAccountStandingRecord,
  type MiningCommunityStandingRecord,
  type MiningEpochAccountStandingRecord,
  type MiningFormulaRecord,
  type MiningMemberPowerRecord,
  type MiningRankEpochRecord,
  type MiningRankedAccountRecord,
  type MiningRepository,
  type MiningSnapshotAttemptRecord,
  type MiningSnapshotRecord,
  type SetCommunityWeightInput,
  type WriteIncompleteMiningSnapshotInput,
  type WriteMiningSnapshotInput,
} from "../features/mining/mining-repository.js";
import type {
  MiningBalanceInput,
  MiningCommunityWeightInput,
  MiningSnapshotPower,
} from "../features/mining/mining-snapshot.js";
import {
  isUniqueViolation,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * PostgreSQL implementation of the Mining boundary (Decisions 0036 and
 * 0043). Balance inputs are the latest `wallet_balance_snapshots` row per
 * active wallet and readable asset; community weights join the community's
 * canonical bound asset key; standings aggregate the stored snapshot powers
 * with exact `numeric` arithmetic. Nothing here derives a number that was
 * not observed, reviewed, or computed by the lane.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaqueIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(uuidV4Pattern);
const configVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const decimalSchema = z
  .string()
  .regex(new RegExp(unsignedDecimalPatternSource));
const blockNumberSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
/** Lowercase pool address a derived reference price names (Decision 0059). */
const pairAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const blockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const formulaRowSchema = z
  .object({
    config_version: configVersionSchema,
    formula: miningFormulaDocumentSchema,
    weight_range: miningWeightRangeDocumentSchema,
    price_guard_rules: miningPriceGuardRulesSchema,
    status: z.enum(miningFormulaStatuses),
    effective_at: dateSchema.nullable(),
    approved_at: dateSchema.nullable(),
    created_at: dateSchema,
  })
  .strict();

const weightRowSchema = z
  .object({
    community_id: opaqueIdSchema,
    community_name: z.string().min(1),
    bound_asset_id: z.string().nullable(),
    status: z.enum(communityWeightStatuses),
    weight: decimalSchema.nullable(),
    config_version: configVersionSchema.nullable(),
    reviewed_at: dateSchema.nullable(),
  })
  .strict();

const snapshotRowSchema = z
  .object({
    snapshot_id: opaqueIdSchema,
    block_number: blockNumberSchema,
    block_hash: blockHashSchema,
    formula_version: configVersionSchema,
    price_version: z.string().regex(new RegExp(priceVersionPatternSource)),
    total_power: decimalSchema,
    account_count: z.number().int().min(0),
    computed_at: dateSchema,
    holdings_source: z.enum(miningHoldingsSources),
  })
  .strict();

const snapshotAttemptRowSchema = z
  .object({
    snapshot_id: opaqueIdSchema,
    status: z.enum(miningSnapshotStatuses),
    formula_version: configVersionSchema,
    block_number: blockNumberSchema,
    computed_at: dateSchema,
    unread_inputs: miningUnreadInputsSchema,
    invalidated_at: dateSchema.nullable(),
    invalidation_reason: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .nullable(),
  })
  .strict();

const snapshotAttemptColumns = `
  snapshot_id, status, formula_version, block_number::text as block_number,
  computed_at, unread_inputs, invalidated_at, invalidation_reason
`;

const powerRowSchema = z
  .object({
    owner_user_id: opaqueIdSchema,
    asset_id: z.string().min(1),
    holding: decimalSchema,
    reference_price_usd: decimalSchema,
    reference_price_quality: z.enum(miningReferencePriceQualities),
    reference_price_proxy_asset_id: z.string().min(1).nullable(),
    reference_price_pair_address: z
      .string()
      .regex(/^0x[0-9a-f]{40}$/)
      .nullable(),
    weight: decimalSchema,
    power: decimalSchema,
    block_number: blockNumberSchema,
  })
  .strict()
  .refine(
    (row) =>
      (row.reference_price_quality === "proxied") ===
      (row.reference_price_proxy_asset_id !== null),
  )
  .refine(
    (row) =>
      row.reference_price_quality !== "derived" ||
      row.reference_price_pair_address !== null,
  );

/** `numeric::text` may carry trailing zeros; the wire form is canonical. */
const numericTextSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/)
  .transform((value) => normalizeDecimalString(value));
const positionSchema = z.number().int().min(1);
const countSchema = z.number().int().min(0);

const accountStandingRowSchema = z
  .object({
    total_power: numericTextSchema,
    position: positionSchema.nullable(),
    participant_count: countSchema,
  })
  .strict();

const rankedAccountRowSchema = z
  .object({
    owner_user_id: opaqueIdSchema,
    total_power: numericTextSchema,
    position: positionSchema.nullable(),
    public_profile_id: opaqueIdSchema.nullable(),
    alias: z.string().min(1).nullable(),
    anonymous_mode: z.boolean(),
    power_visible_to_others: z.boolean(),
    avatar_ref: z.string().min(1).nullable(),
  })
  .strict();

const referralRankRowSchema = z
  .object({
    owner_user_id: opaqueIdSchema,
    invited_count: z.number().int().min(1),
    position: positionSchema,
    public_profile_id: opaqueIdSchema.nullable(),
    alias: z.string().min(1).nullable(),
    anonymous_mode: z.boolean(),
    avatar_ref: z.string().min(1).nullable(),
  })
  .strict();

const referralStandingRowSchema = z
  .object({
    invited_count: z.number().int().min(1).nullable(),
    position: positionSchema.nullable(),
    participant_count: countSchema,
  })
  .strict();

/** Keyset decimal bound: canonical unsigned decimal or absent. */
const keysetDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,60})?$/);

const communityStandingRowSchema = z
  .object({
    community_id: opaqueIdSchema,
    community_name: z.string().min(1),
    bound_asset_id: z.string().min(1),
    weight: decimalSchema,
    power: numericTextSchema,
    participant_count: countSchema,
    position: positionSchema.nullable(),
  })
  .strict();

const memberPowerRowSchema = z
  .object({
    public_profile_id: opaqueIdSchema,
    owner_user_id: opaqueIdSchema,
    total_power: numericTextSchema.nullable(),
    visible_to_others: z.boolean(),
  })
  .strict();

const balanceRowSchema = z
  .object({
    owner_user_id: opaqueIdSchema,
    wallet_id: opaqueIdSchema,
    asset_id: z.string().min(1),
    decimals: z.number().int().min(0).max(36),
    raw_value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
    block_number: blockNumberSchema,
    block_hash: blockHashSchema,
    source: z.enum(walletBalanceSources),
  })
  .strict();

const formulaColumns = `
  config_version, formula, weight_range, price_guard_rules, status,
  effective_at, approved_at, created_at
`;

function mapFormula(raw: unknown): MiningFormulaRecord {
  const row = formulaRowSchema.parse(raw);
  return Object.freeze({
    configVersion: row.config_version,
    formula: row.formula,
    weightRange: row.weight_range,
    priceGuardRules: Object.freeze(row.price_guard_rules),
    status: row.status,
    effectiveAt: toNullableIsoString(row.effective_at),
    approvedAt: toNullableIsoString(row.approved_at),
    createdAt: toIsoString(row.created_at),
  });
}

function mapSnapshot(raw: unknown): MiningSnapshotRecord {
  const row = snapshotRowSchema.parse(raw);
  return Object.freeze({
    snapshotId: row.snapshot_id,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    formulaVersion: row.formula_version,
    priceVersion: row.price_version,
    totalPower: row.total_power,
    accountCount: row.account_count,
    computedAt: toIsoString(row.computed_at),
    holdingsSource: row.holdings_source,
  });
}

function mapSnapshotAttempt(raw: unknown): MiningSnapshotAttemptRecord {
  const row = snapshotAttemptRowSchema.parse(raw);
  return Object.freeze({
    snapshotId: row.snapshot_id,
    status: row.status,
    formulaVersion: row.formula_version,
    blockNumber: row.block_number,
    computedAt: toIsoString(row.computed_at),
    unreadInputs: Object.freeze(
      row.unread_inputs.map((input) => Object.freeze({ ...input })),
    ),
    invalidatedAt: toNullableIsoString(row.invalidated_at),
    invalidationReason: row.invalidation_reason,
  });
}

function mapCommunityStanding(raw: unknown): MiningCommunityStandingRecord {
  const row = communityStandingRowSchema.parse(raw);
  return Object.freeze({
    communityId: row.community_id,
    communityName: row.community_name,
    boundAssetId: row.bound_asset_id,
    weight: row.weight,
    power: row.power,
    participantCount: row.participant_count,
    position: row.position,
  });
}

function mapWeight(raw: unknown): CommunityWeightRecord {
  const row = weightRowSchema.parse(raw);
  return Object.freeze({
    communityId: row.community_id,
    communityName: row.community_name,
    boundAssetId: row.bound_asset_id,
    status: row.status,
    weight: row.weight,
    configVersion: row.config_version,
    reviewedAt: toNullableIsoString(row.reviewed_at),
  });
}

function unavailable(): MiningRepositoryUnavailableError {
  return new MiningRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof MiningFormulaNotFoundError ||
    error instanceof MiningFormulaStateError ||
    error instanceof MiningFormulaSelfApprovalError ||
    error instanceof MiningFormulaExistsError ||
    error instanceof MiningCommunityNotFoundError ||
    error instanceof MiningCommunityAssetNotBoundError ||
    error instanceof MiningWeightOutOfRangeError ||
    error instanceof MiningCommunityWeightConflictError ||
    error instanceof MiningSnapshotNotFoundError ||
    error instanceof MiningRepositoryUnavailableError
  ) {
    throw error;
  }
  throw unavailable();
}

/**
 * Per-account totals of one snapshot and their `rank()` among positive
 * totals. Zero-power accounts are in `totals` but hold no position
 * (`ranked` lists every account; `position` is null at zero power).
 */
const accountTotalsSql = `
  totals as (
    select owner_user_id, sum(power::numeric) as total
    from public.mining_snapshot_powers
    where snapshot_id = $1
    group by owner_user_id
  ),
  ranked as (
    select
      owner_user_id,
      total,
      case
        when total > 0 then rank() over (order by total desc)
      end as position
    from totals
  )
`;

/**
 * Decision 0148: the same totals and positions over one settled hour. An
 * account's power is its hourly total of both tracks
 * (`nft_total_power + asset_total_power`, self plus referral), exact
 * PostgreSQL numeric arithmetic over the stored decimal strings.
 */
const epochAccountTotalsSql = `
  totals as (
    select
      owner_user_id,
      nft_total_power::numeric + asset_total_power::numeric as total
    from public.mining_epoch_rewards
    where epoch_id = $1
  ),
  ranked as (
    select
      owner_user_id,
      total,
      case
        when total > 0 then rank() over (order by total desc)
      end as position
    from totals
  )
`;

/**
 * Decision 0148: community standings over one settled hour. Every community
 * with a bound asset is listed; `weight` is its NFT coefficient under the
 * hour's parameter version (listed coefficient, else the version's
 * `defaultCommunityCoefficient`, else 0 — the calculator's own rule). A
 * non-banned member contributes the part of the hour's power that belongs to
 * the community:
 *
 * - NFT self: the `nft_holdings[].power` of the community's instances;
 * - NFT referral: the equivalent NFT units the member received from the
 *   community's NFTs (`referral_levels[].nftUnitsByCommunity`) × the
 *   coefficient, truncated to 18 decimals like every stored power (exact
 *   while the coefficient does not change inside the hour);
 * - asset self: the `asset_holdings[].power` of the bound asset. Asset
 *   referral power is stored per level only, not per asset, so it ranks
 *   accounts, not communities.
 */
const epochCommunityStandingsSql = `
  epoch_version as (
    select v.document
    from public.mining_epochs as e
    join public.mining_parameter_versions as v on v.version_id = e.version_id
    where e.epoch_id = $1
  ),
  bound as (
    select
      c.community_id,
      c.name as community_name,
      c.bound_asset_key as bound_asset_id,
      coalesce(
        (
          select (entry->>'coefficient')::numeric
          from epoch_version as ev,
            jsonb_array_elements(
              coalesce(ev.document->'communityCoefficients', '[]'::jsonb)
            ) as entry
          where entry->>'communityId' = c.community_id::text
          limit 1
        ),
        (
          select (ev.document->>'defaultCommunityCoefficient')::numeric
          from epoch_version as ev
        ),
        0
      ) as coefficient
    from public.communities as c
    where c.bound_asset_key is not null
  ),
  member_powers as (
    select
      b.community_id,
      r.owner_user_id,
      coalesce((
        select sum((holding->>'power')::numeric)
        from jsonb_array_elements(r.nft_holdings) as holding
        where holding->>'communityId' = b.community_id::text
      ), 0) + trunc(coalesce((
        select sum((unit->>'units')::numeric)
        from jsonb_array_elements(r.referral_levels) as level,
          jsonb_array_elements(
            coalesce(level->'nftUnitsByCommunity', '[]'::jsonb)
          ) as unit
        where unit->>'communityId' = b.community_id::text
      ), 0) * b.coefficient, 18) + coalesce((
        select sum((holding->>'power')::numeric)
        from jsonb_array_elements(r.asset_holdings) as holding
        where holding->>'assetId' = b.bound_asset_id
      ), 0) as power
    from bound as b
    join public.community_memberships as m
      on m.community_id = b.community_id and m.status <> 'banned'
    join public.mining_epoch_rewards as r
      on r.epoch_id = $1 and r.owner_user_id = m.owner_user_id
  ),
  powers as (
    select
      b.community_id,
      coalesce(sum(p.power), 0) as total,
      count(p.owner_user_id) filter (where p.power > 0)::int
        as participant_count
    from bound as b
    left join member_powers as p on p.community_id = b.community_id
    group by b.community_id
  ),
  standings as (
    select
      b.community_id,
      b.community_name,
      b.bound_asset_id,
      trim_scale(b.coefficient)::text as weight,
      p.total::text as power,
      p.participant_count,
      case
        when p.total > 0
          then (rank() over (order by p.total desc))::int
      end as position
    from bound as b
    join powers as p on p.community_id = b.community_id
  )
`;

const epochAccountStandingRowSchema = z
  .object({
    total_power: numericTextSchema.nullable(),
    position: z.number().int().min(1).nullable(),
    participant_count: z.number().int().min(0),
  })
  .strict();

const rankEpochRowSchema = z
  .object({
    epoch_id: opaqueIdSchema,
    hour_start: z.date(),
    hour_end: z.date(),
    settled_at: z.date(),
    input_digest: z.string().regex(/^[0-9a-f]{64}$/),
    config_version: configVersionSchema,
  })
  .strict();

/**
 * Community standings under one snapshot and formula version: every
 * community with a bound asset and an approved weight under the version,
 * its non-banned members' power on that asset, and its rank among the
 * communities with positive power.
 */
const communityStandingsSql = `
  bound as (
    select
      c.community_id,
      c.name as community_name,
      c.bound_asset_key as bound_asset_id,
      w.weight
    from public.communities as c
    join public.community_mining_weights as w
      on w.community_id = c.community_id
    where c.bound_asset_key is not null
      and w.status = 'approved'
      and w.config_version = $2
  ),
  powers as (
    select
      b.community_id,
      coalesce(sum(p.power::numeric), 0) as total,
      count(p.owner_user_id) filter (where p.power::numeric > 0)::int
        as participant_count
    from bound as b
    left join public.community_memberships as m
      on m.community_id = b.community_id and m.status <> 'banned'
    left join public.mining_snapshot_powers as p
      on p.snapshot_id = $1
      and p.owner_user_id = m.owner_user_id
      and p.asset_id = b.bound_asset_id
    group by b.community_id
  ),
  standings as (
    select
      b.community_id,
      b.community_name,
      b.bound_asset_id,
      b.weight,
      p.total::text as power,
      p.participant_count,
      case
        when p.total > 0
          then (rank() over (order by p.total desc))::int
      end as position
    from bound as b
    join powers as p on p.community_id = b.community_id
  )
`;

/**
 * Referral rank (Decision 0100): direct invitees in force per inviter
 * (`depth = 1`, `effective_to is null`, any validation status), ranked with
 * shared positions on ties. Only inviters with at least one invitee appear.
 */
const referralTotalsSql = `
  referral_counts as (
    select inviter_user_id as owner_user_id, count(*)::int as invited_count
    from public.referral_edges
    where depth = 1 and effective_to is null
    group by inviter_user_id
  ),
  referral_ranked as (
    select
      owner_user_id,
      invited_count,
      (rank() over (order by invited_count desc))::int as position
    from referral_counts
  )
`;

/** Decision 0111: `--approved-by` and `--reason` of the break-glass CLI. */
const cliApprovalSchema = z
  .object({
    approvedBy: z.string().regex(/^[A-Za-z0-9._@-]{1,60}$/u),
    reason: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)),
    bypass: z.boolean(),
  })
  .strict();

const draftAuthorSchema = z.union([
  z.object({ kind: z.null(), actor: z.null() }).strict(),
  z
    .object({
      kind: z.enum(["admin_account", "admin_bootstrap"]),
      actor: z.string(),
    })
    .strict(),
]);

/** Compares people by name: case-insensitive, without the `cli:` marker. */
function cliApproverName(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith("cli:") ? lower.slice(4) : lower;
}

async function insertCliApprovalAudit(
  client: {
    query(config: {
      readonly text: string;
      readonly values: readonly unknown[];
    }): Promise<unknown>;
  },
  input: {
    readonly action: "mining.formula.approve" | "mining.formula.approve.failed";
    readonly configVersion: string;
    readonly requestId: string;
    readonly before: unknown;
    readonly after: unknown;
  },
): Promise<void> {
  // Decision 0111: actor `cli` with no console account; the person is in
  // `after.approvedBy`.
  await client.query({
    text: `
      insert into public.admin_audit_log (
        audit_id, actor, actor_account_id, action, target_type, target_id,
        before, after, request_id
      )
      values ($1, 'cli', null, $2, 'mining_formula_version', $3,
        $4::jsonb, $5::jsonb, $6)
    `,
    values: [
      randomUUID(),
      input.action,
      input.configVersion,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      input.requestId,
    ],
  });
}

export function createPostgresMiningRepository(pool: Pool): MiningRepository {
  return Object.freeze({
    async getApprovedFormula() {
      try {
        const result = await pool.query({
          text: `
            select ${formulaColumns}
            from public.mining_formula_versions
            where status = 'approved'
            limit 1
          `,
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapFormula(row);
      } catch (error) {
        return translate(error);
      }
    },

    async listFormulaVersions() {
      try {
        const result = await pool.query({
          text: `
            select ${formulaColumns}
            from public.mining_formula_versions
            order by created_at desc, config_version desc
            limit 50
          `,
        });
        return Object.freeze(result.rows.map(mapFormula));
      } catch (error) {
        return translate(error);
      }
    },

    async approveFormula(
      rawInput: Parameters<MiningRepository["approveFormula"]>[0],
    ) {
      try {
        const configVersion = configVersionSchema.parse(rawInput.configVersion);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const approval = cliApprovalSchema.parse(rawInput.approval);
        const approvedBy = `cli:${approval.approvedBy}`;
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await client.query({
            text: `
              select ${formulaColumns}, draft_author_kind, draft_author
              from public.mining_formula_versions
              where config_version = $1
              for update
            `,
            values: [configVersion],
          });
          const raw = current.rows[0] as Record<string, unknown> | undefined;
          if (raw === undefined) {
            throw new MiningFormulaNotFoundError();
          }
          const {
            draft_author_kind: rawAuthorKind,
            draft_author: rawAuthor,
            ...formulaRow
          } = raw;
          const record = mapFormula(formulaRow);
          if (record.status !== "pending_approval") {
            throw new MiningFormulaStateError();
          }
          const author = draftAuthorSchema.parse({
            kind: rawAuthorKind,
            actor: rawAuthor,
          });
          // Decision 0111: the person who saved the draft (console name, or
          // a `cli:` name) may not approve it through the CLI either.
          if (
            author.actor !== null &&
            cliApproverName(author.actor) ===
              cliApproverName(approval.approvedBy)
          ) {
            throw new MiningFormulaSelfApprovalError();
          }
          const retired = await client.query<{ config_version: string }>({
            text: `
              update public.mining_formula_versions
              set status = 'retired', updated_at = clock_timestamp()
              where status = 'approved'
              returning config_version
            `,
          });
          const approved = await client.query({
            text: `
              update public.mining_formula_versions
              set
                status = 'approved',
                effective_at = clock_timestamp(),
                approved_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                approved_by = $2,
                approved_by_account_id = null
              where config_version = $1
              returning ${formulaColumns}
            `,
            values: [configVersion, approvedBy],
          });
          const version = mapFormula(approved.rows[0]);
          const retiredVersion = retired.rows[0]?.config_version ?? null;
          await insertCliApprovalAudit(client, {
            action: "mining.formula.approve",
            configVersion,
            requestId,
            before: {
              configVersion,
              status: record.status,
              effectiveAt: record.effectiveAt,
              approvedVersion: retiredVersion,
            },
            after: {
              configVersion,
              status: version.status,
              effectiveAt: version.effectiveAt,
              retiredVersion,
              channel: "cli",
              draftAuthor:
                author.kind === null
                  ? null
                  : { kind: author.kind, actor: author.actor },
              approvedBy,
              reason: approval.reason,
              bypass: approval.bypass,
            },
          });
          return version;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async recordFormulaApprovalRefusal(
      rawInput: Parameters<MiningRepository["recordFormulaApprovalRefusal"]>[0],
    ) {
      try {
        const configVersion = configVersionSchema.parse(rawInput.configVersion);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const approval = cliApprovalSchema.parse(rawInput.approval);
        const reasonCode = z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/u)
          .parse(rawInput.reasonCode);
        await insertCliApprovalAudit(pool, {
          action: "mining.formula.approve.failed",
          configVersion,
          requestId,
          before: null,
          after: {
            configVersion,
            channel: "cli",
            approvedBy: `cli:${approval.approvedBy}`,
            reason: approval.reason,
            bypass: approval.bypass,
            reasonCode,
          },
        });
        return true;
      } catch {
        return false;
      }
    },

    async getCommunityWeight(
      rawCommunityId: Parameters<MiningRepository["getCommunityWeight"]>[0],
    ) {
      try {
        const communityId = opaqueIdSchema.parse(rawCommunityId);
        const result = await pool.query({
          text: `
            select
              c.community_id,
              c.name as community_name,
              c.bound_asset_key as bound_asset_id,
              coalesce(w.status, 'pending_review') as status,
              w.weight,
              w.config_version,
              w.reviewed_at
            from public.communities as c
            left join public.community_mining_weights as w
              on w.community_id = c.community_id
            where c.community_id = $1
          `,
          values: [communityId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = weightRowSchema.parse(raw);
        const record: CommunityWeightRecord = Object.freeze({
          communityId: row.community_id,
          communityName: row.community_name,
          boundAssetId: row.bound_asset_id,
          status: row.status,
          weight: row.weight,
          configVersion: row.config_version,
          reviewedAt: toNullableIsoString(row.reviewed_at),
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunityWeightInputs(rawConfigVersion: string) {
      try {
        const configVersion = configVersionSchema.parse(rawConfigVersion);
        const result = await pool.query({
          text: `
            select
              c.community_id,
              c.name as community_name,
              c.bound_asset_key as bound_asset_id,
              case
                when w.config_version = $1 then w.status
                else 'pending_review'
              end as status,
              case when w.config_version = $1 then w.weight end as weight,
              case when w.config_version = $1 then w.config_version end
                as config_version,
              case when w.config_version = $1 then w.reviewed_at end
                as reviewed_at
            from public.communities as c
            left join public.community_mining_weights as w
              on w.community_id = c.community_id
            where c.bound_asset_key is not null
            order by c.community_id
          `,
          values: [configVersion],
        });
        return Object.freeze(
          result.rows.map((raw): MiningCommunityWeightInput => {
            const row = weightRowSchema.parse(raw);
            return Object.freeze({
              communityId: row.community_id,
              assetId: row.bound_asset_id ?? "",
              weight: row.weight,
              status: row.status,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getLatestSnapshot() {
      try {
        const result = await pool.query({
          text: `
            select
              snapshot_id, block_number::text as block_number, block_hash,
              formula_version, price_version, total_power, account_count,
              computed_at, holdings_source
            from public.mining_snapshots
            where status = 'complete'
            order by computed_at desc, snapshot_id desc
            limit 1
          `,
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapSnapshot(row);
      } catch (error) {
        return translate(error);
      }
    },

    async getLatestSnapshotAttempt(rawConfigVersion: string) {
      try {
        const configVersion = configVersionSchema.parse(rawConfigVersion);
        const result = await pool.query({
          text: `
            select ${snapshotAttemptColumns}
            from public.mining_snapshots
            where formula_version = $1
            order by computed_at desc, snapshot_id desc
            limit 1
          `,
          values: [configVersion],
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapSnapshotAttempt(row);
      } catch (error) {
        return translate(error);
      }
    },

    async writeIncompleteSnapshot(
      rawInput: WriteIncompleteMiningSnapshotInput,
    ) {
      try {
        const snapshotId = uuidV4Schema.parse(rawInput.snapshotId);
        const blockNumber = blockNumberSchema.parse(rawInput.blockNumber);
        const blockHash = blockHashSchema.parse(rawInput.blockHash);
        const formulaVersion = configVersionSchema.parse(
          rawInput.formulaVersion,
        );
        const priceVersion =
          rawInput.priceVersion === null
            ? null
            : z
                .string()
                .regex(new RegExp(priceVersionPatternSource))
                .parse(rawInput.priceVersion);
        const unreadInputs = miningUnreadInputsSchema
          .min(1)
          .parse(rawInput.unreadInputs);
        const inserted = await pool.query({
          text: `
            insert into public.mining_snapshots (
              snapshot_id, block_number, block_hash, formula_version,
              price_version, total_power, account_count, status, unread_inputs
            )
            values ($1, $2, $3, $4, $5, '0', 0, 'incomplete', $6::jsonb)
            returning ${snapshotAttemptColumns}
          `,
          values: [
            snapshotId,
            blockNumber,
            blockHash,
            formulaVersion,
            priceVersion,
            JSON.stringify(unreadInputs),
          ],
        });
        return mapSnapshotAttempt(inserted.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async invalidateSnapshots(rawInput: InvalidateMiningSnapshotsInput) {
      try {
        uuidV4Schema.parse(rawInput.requestId);
        const reason = z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .parse(rawInput.reason);
        const selector = rawInput.selector;
        return await withV2Transaction(pool, unavailable, async (client) => {
          let targetIds: string[];
          if (selector.kind === "after") {
            const anchorId = opaqueIdSchema.parse(selector.snapshotId);
            const anchor = await client.query<{ snapshot_id: string }>({
              text: `
                select snapshot_id
                from public.mining_snapshots
                where snapshot_id = $1 and status = 'complete'
                for update
              `,
              values: [anchorId],
            });
            if (anchor.rows[0] === undefined) {
              throw new MiningSnapshotNotFoundError();
            }
            // The anchor's clock is compared inside SQL: `computed_at` has
            // microsecond precision and a JS Date would truncate it to
            // milliseconds, which made the anchor match itself.
            const later = await client.query<{ snapshot_id: string }>({
              text: `
                select s.snapshot_id
                from public.mining_snapshots as s
                where s.status = 'complete'
                  and (s.computed_at, s.snapshot_id) > (
                    (select a.computed_at from public.mining_snapshots as a where a.snapshot_id = $1),
                    $1::uuid
                  )
                order by s.computed_at asc, s.snapshot_id asc
                for update
              `,
              values: [anchorId],
            });
            targetIds = later.rows.map((row) =>
              opaqueIdSchema.parse(row.snapshot_id),
            );
          } else {
            const ids = z
              .array(opaqueIdSchema)
              .min(1)
              .parse(selector.snapshotIds);
            const found = await client.query<{ snapshot_id: string }>({
              text: `
                select snapshot_id
                from public.mining_snapshots
                where status = 'complete' and snapshot_id = any($1::uuid[])
                for update
              `,
              values: [ids],
            });
            if (found.rows.length !== new Set(ids).size) {
              throw new MiningSnapshotNotFoundError();
            }
            targetIds = found.rows.map((row) =>
              opaqueIdSchema.parse(row.snapshot_id),
            );
          }
          if (targetIds.length === 0) {
            return Object.freeze({ snapshotIds: Object.freeze([]) });
          }
          const updated = await client.query<{ snapshot_id: string }>({
            text: `
              update public.mining_snapshots
              set status = 'invalidated',
                  invalidated_at = clock_timestamp(),
                  invalidation_reason = $2
              where status = 'complete' and snapshot_id = any($1::uuid[])
              returning snapshot_id
            `,
            values: [targetIds, reason],
          });
          return Object.freeze({
            snapshotIds: Object.freeze(
              updated.rows.map((row) => opaqueIdSchema.parse(row.snapshot_id)),
            ),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async writeSnapshot(rawInput: WriteMiningSnapshotInput) {
      try {
        const snapshotId = uuidV4Schema.parse(rawInput.snapshotId);
        const blockNumber = blockNumberSchema.parse(rawInput.blockNumber);
        const blockHash = blockHashSchema.parse(rawInput.blockHash);
        const formulaVersion = configVersionSchema.parse(
          rawInput.formulaVersion,
        );
        const priceVersion = z
          .string()
          .regex(new RegExp(priceVersionPatternSource))
          .parse(rawInput.priceVersion);
        const totalPower = decimalSchema.parse(rawInput.totalPower);
        const accounts = new Set(rawInput.powers.map((row) => row.ownerUserId));
        return await withV2Transaction(pool, unavailable, async (client) => {
          const inserted = await client.query({
            text: `
              insert into public.mining_snapshots (
                snapshot_id, block_number, block_hash, formula_version,
                price_version, total_power, account_count, status,
                holdings_source
              )
              values ($1, $2, $3, $4, $5, $6, $7, 'complete', $8)
              returning
                snapshot_id, block_number::text as block_number, block_hash,
                formula_version, price_version, total_power, account_count,
                computed_at, holdings_source
            `,
            values: [
              snapshotId,
              blockNumber,
              blockHash,
              formulaVersion,
              priceVersion,
              totalPower,
              accounts.size,
              z.enum(miningHoldingsSources).parse(rawInput.holdingsSource),
            ],
          });
          for (const power of rawInput.powers) {
            await client.query({
              text: `
                insert into public.mining_snapshot_powers (
                  snapshot_id, owner_user_id, asset_id, holding,
                  reference_price_usd, reference_price_quality,
                  reference_price_proxy_asset_id, reference_price_pair_address,
                  weight, power, block_number
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `,
              values: [
                snapshotId,
                opaqueIdSchema.parse(power.ownerUserId),
                power.assetId,
                decimalSchema.parse(power.holding),
                decimalSchema.parse(power.referencePriceUsd),
                z
                  .enum(miningReferencePriceQualities)
                  .parse(power.referencePriceQuality),
                power.referencePriceProxyAssetId,
                power.referencePricePairAddress === null
                  ? null
                  : pairAddressSchema.parse(power.referencePricePairAddress),
                decimalSchema.parse(power.weight),
                decimalSchema.parse(power.power),
                blockNumberSchema.parse(power.blockNumber),
              ],
            });
          }
          return mapSnapshot(inserted.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async createFormulaVersion(rawInput: CreateMiningFormulaVersionInput) {
      try {
        const configVersion = configVersionSchema.parse(rawInput.configVersion);
        uuidV4Schema.parse(rawInput.requestId);
        const formula = miningFormulaDocumentSchema.parse(rawInput.formula);
        const weightRange = miningWeightRangeDocumentSchema.parse(
          rawInput.weightRange,
        );
        const priceGuardRules = miningPriceGuardRulesSchema.parse(
          rawInput.priceGuardRules,
        );
        const inserted = await pool.query({
          text: `
            insert into public.mining_formula_versions (
              config_version, formula, weight_range, price_guard_rules, status
            )
            values ($1, $2::jsonb, $3::jsonb, $4::jsonb, 'pending_approval')
            returning ${formulaColumns}
          `,
          values: [
            configVersion,
            JSON.stringify(formula),
            JSON.stringify(weightRange),
            JSON.stringify(priceGuardRules),
          ],
        });
        return mapFormula(inserted.rows[0]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new MiningFormulaExistsError();
        }
        return translate(error);
      }
    },

    async setCommunityWeight(rawInput: SetCommunityWeightInput) {
      try {
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const weight = decimalSchema.parse(rawInput.weight);
        const configVersion = configVersionSchema.parse(rawInput.configVersion);
        uuidV4Schema.parse(rawInput.requestId);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const version = await client.query({
            text: `
              select ${formulaColumns}
              from public.mining_formula_versions
              where config_version = $1
              for share
            `,
            values: [configVersion],
          });
          const versionRaw: unknown = version.rows[0];
          if (versionRaw === undefined) {
            throw new MiningFormulaNotFoundError();
          }
          const formula = mapFormula(versionRaw);
          if (formula.status === "retired") {
            throw new MiningFormulaStateError();
          }
          const range = formula.weightRange.community.range;
          if (
            range === undefined ||
            !isCommunityWeightWithinRange(weight, range)
          ) {
            throw new MiningWeightOutOfRangeError();
          }
          const community = await client.query<{
            bound_asset_key: string | null;
          }>({
            text: `
              select bound_asset_key
              from public.communities
              where community_id = $1
              for update
            `,
            values: [communityId],
          });
          const communityRow = community.rows[0];
          if (communityRow === undefined) {
            throw new MiningCommunityNotFoundError();
          }
          if (communityRow.bound_asset_key === null) {
            throw new MiningCommunityAssetNotBoundError();
          }
          const conflict = await client.query({
            text: `
              select 1
              from public.community_mining_weights as w
              join public.communities as c on c.community_id = w.community_id
              where w.status = 'approved'
                and w.config_version = $1
                and c.bound_asset_key = $2
                and w.community_id <> $3
              limit 1
            `,
            values: [configVersion, communityRow.bound_asset_key, communityId],
          });
          if (conflict.rows.length > 0) {
            throw new MiningCommunityWeightConflictError();
          }
          await client.query({
            text: `
              insert into public.community_mining_weights (
                community_id, status, weight, config_version, reviewed_at
              )
              values ($1, 'approved', $2, $3, clock_timestamp())
              on conflict (community_id) do update
              set
                status = 'approved',
                weight = excluded.weight,
                config_version = excluded.config_version,
                reviewed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            `,
            values: [communityId, weight, configVersion],
          });
          const stored = await client.query({
            text: `
              select
                c.community_id,
                c.name as community_name,
                c.bound_asset_key as bound_asset_id,
                w.status,
                w.weight,
                w.config_version,
                w.reviewed_at
              from public.communities as c
              join public.community_mining_weights as w
                on w.community_id = c.community_id
              where c.community_id = $1
            `,
            values: [communityId],
          });
          return mapWeight(stored.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listAccountPowers(
      input: Parameters<MiningRepository["listAccountPowers"]>[0],
    ) {
      try {
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const ownerUserId = opaqueIdSchema.parse(input.ownerUserId);
        const result = await pool.query({
          text: `
            select
              owner_user_id, asset_id, holding, reference_price_usd,
              reference_price_quality, reference_price_proxy_asset_id,
              reference_price_pair_address, weight,
              power, block_number::text as block_number
            from public.mining_snapshot_powers
            where snapshot_id = $1 and owner_user_id = $2
            order by asset_id
          `,
          values: [snapshotId, ownerUserId],
        });
        return Object.freeze(
          result.rows.map((raw): MiningSnapshotPower => {
            const row = powerRowSchema.parse(raw);
            return Object.freeze({
              ownerUserId: row.owner_user_id,
              assetId: row.asset_id,
              holding: row.holding,
              referencePriceUsd: row.reference_price_usd,
              referencePriceQuality: row.reference_price_quality,
              referencePriceProxyAssetId: row.reference_price_proxy_asset_id,
              referencePricePairAddress: row.reference_price_pair_address,
              weight: row.weight,
              power: row.power,
              blockNumber: row.block_number,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getAccountStanding(
      input: Parameters<MiningRepository["getAccountStanding"]>[0],
    ) {
      try {
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const ownerUserId = opaqueIdSchema.parse(input.ownerUserId);
        const result = await pool.query({
          text: `
            with ${accountTotalsSql}
            select
              r.total::text as total_power,
              r.position::int as position,
              (select count(*) from ranked where position is not null)::int
                as participant_count
            from ranked as r
            where r.owner_user_id = $2
          `,
          values: [snapshotId, ownerUserId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = accountStandingRowSchema.parse(raw);
        const record: MiningAccountStandingRecord = Object.freeze({
          totalPower: row.total_power,
          position: row.position,
          participantCount: row.participant_count,
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async getLatestRankEpoch() {
      try {
        const result = await pool.query({
          text: `
            select
              e.epoch_id, e.hour_start, e.hour_end, e.settled_at,
              e.input_digest, v.config_version
            from public.mining_epochs as e
            join public.mining_parameter_versions as v
              on v.version_id = e.version_id
            where e.status = 'settled'
            order by e.hour_start desc
            limit 1
          `,
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = rankEpochRowSchema.parse(raw);
        const record: MiningRankEpochRecord = Object.freeze({
          epochId: row.epoch_id,
          hourStart: row.hour_start.toISOString(),
          hourEnd: row.hour_end.toISOString(),
          settledAt: row.settled_at.toISOString(),
          inputDigest: row.input_digest,
          configVersion: row.config_version,
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async getEpochAccountStanding(
      input: Parameters<MiningRepository["getEpochAccountStanding"]>[0],
    ) {
      try {
        const epochId = opaqueIdSchema.parse(input.epochId);
        const ownerUserId = opaqueIdSchema.parse(input.ownerUserId);
        const result = await pool.query({
          text: `
            with ${epochAccountTotalsSql}
            select
              r.total::text as total_power,
              r.position::int as position,
              (select count(*) from ranked where position is not null)::int
                as participant_count
            from (select 1) as one
            left join ranked as r on r.owner_user_id = $2
          `,
          values: [epochId, ownerUserId],
        });
        const row = epochAccountStandingRowSchema.parse(result.rows[0]);
        const record: MiningEpochAccountStandingRecord = Object.freeze({
          totalPower: row.total_power,
          position: row.position,
          participantCount: row.participant_count,
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async listAccountRanking(
      input: Parameters<MiningRepository["listAccountRanking"]>[0],
    ) {
      try {
        const epochId = opaqueIdSchema.parse(input.epochId);
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const afterTotal =
          input.after === undefined
            ? null
            : keysetDecimalSchema.parse(input.after.totalPower);
        const afterOwner =
          input.after === undefined
            ? null
            : opaqueIdSchema.parse(input.after.ownerUserId);
        // Ordering by total desc then owner is the rank order: positions are
        // rank() over positive totals and zero totals (position null) follow.
        const result = await pool.query({
          text: `
            with ${epochAccountTotalsSql}
            select
              r.owner_user_id,
              r.total::text as total_power,
              r.position::int as position,
              profile.public_profile_id,
              profile.alias,
              coalesce(privacy.anonymous_mode, false) as anonymous_mode,
              coalesce(privacy.mining_power_visibility, 'everyone') = 'everyone'
                as power_visible_to_others,
              profile.avatar_ref
            from ranked as r
            left join public.user_profiles as profile
              on profile.owner_user_id = r.owner_user_id
              and profile.profile_status = 'active'
            left join public.privacy_preferences_v2 as privacy
              on privacy.owner_user_id = r.owner_user_id
            where $3::numeric is null
              or r.total < $3::numeric
              or (r.total = $3::numeric and r.owner_user_id > $4::uuid)
            order by r.total desc, r.owner_user_id asc
            limit $2
          `,
          values: [epochId, limit, afterTotal, afterOwner],
        });
        return Object.freeze(
          result.rows.map((raw): MiningRankedAccountRecord => {
            const row = rankedAccountRowSchema.parse(raw);
            return Object.freeze({
              ownerUserId: row.owner_user_id,
              totalPower: row.total_power,
              position: row.position,
              publicProfileId: row.public_profile_id,
              alias: row.alias,
              anonymousMode: row.anonymous_mode,
              powerVisibleToOthers: row.power_visible_to_others,
              avatarRef: row.avatar_ref,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunityRanking(
      input: Parameters<MiningRepository["listCommunityRanking"]>[0],
    ) {
      try {
        const epochId = opaqueIdSchema.parse(input.epochId);
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const after = input.after;
        const afterPower =
          after === undefined ? null : keysetDecimalSchema.parse(after.power);
        const afterName =
          after === undefined
            ? null
            : z.string().min(1).max(1024).parse(after.communityName);
        const afterId =
          after === undefined ? null : opaqueIdSchema.parse(after.communityId);
        // power desc, name, id is the rank order (positions are rank() over
        // positive power; zero-power communities follow with position null).
        const result = await pool.query({
          text: `
            with ${epochCommunityStandingsSql}
            select *
            from standings
            where $3::numeric is null
              or power::numeric < $3::numeric
              or (
                power::numeric = $3::numeric
                and (
                  community_name > $4::text
                  or (community_name = $4::text and community_id > $5::uuid)
                )
              )
            order by power::numeric desc, community_name asc, community_id asc
            limit $2
          `,
          values: [epochId, limit, afterPower, afterName, afterId],
        });
        return Object.freeze(result.rows.map(mapCommunityStanding));
      } catch (error) {
        return translate(error);
      }
    },

    async getMemberBestCommunityStanding(
      input: Parameters<MiningRepository["getMemberBestCommunityStanding"]>[0],
    ) {
      try {
        const epochId = opaqueIdSchema.parse(input.epochId);
        const ownerUserId = opaqueIdSchema.parse(input.ownerUserId);
        const result = await pool.query({
          text: `
            with ${epochCommunityStandingsSql}
            select s.*
            from standings as s
            join public.community_memberships as m
              on m.community_id = s.community_id
              and m.owner_user_id = $2
              and m.status <> 'banned'
            where s.position is not null
            order by s.position asc, s.community_name asc, s.community_id asc
            limit 1
          `,
          values: [epochId, ownerUserId],
        });
        const raw: unknown = result.rows[0];
        return raw === undefined ? null : mapCommunityStanding(raw);
      } catch (error) {
        return translate(error);
      }
    },

    async listReferralRanking(
      input: Parameters<MiningRepository["listReferralRanking"]>[0],
    ) {
      try {
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const afterCount =
          input.after === undefined
            ? null
            : z.number().int().min(1).parse(input.after.invitedCount);
        const afterOwner =
          input.after === undefined
            ? null
            : opaqueIdSchema.parse(input.after.ownerUserId);
        const result = await pool.query({
          text: `
            with ${referralTotalsSql}
            select
              r.owner_user_id,
              r.invited_count,
              r.position,
              profile.public_profile_id,
              profile.alias,
              coalesce(privacy.anonymous_mode, false) as anonymous_mode,
              profile.avatar_ref
            from referral_ranked as r
            left join public.user_profiles as profile
              on profile.owner_user_id = r.owner_user_id
              and profile.profile_status = 'active'
            left join public.privacy_preferences_v2 as privacy
              on privacy.owner_user_id = r.owner_user_id
            where $2::int is null
              or r.invited_count < $2::int
              or (r.invited_count = $2::int and r.owner_user_id > $3::uuid)
            order by r.invited_count desc, r.owner_user_id asc
            limit $1
          `,
          values: [limit, afterCount, afterOwner],
        });
        return Object.freeze(
          result.rows.map((raw) => {
            const row = referralRankRowSchema.parse(raw);
            return Object.freeze({
              ownerUserId: row.owner_user_id,
              invitedCount: row.invited_count,
              position: row.position,
              publicProfileId: row.public_profile_id,
              alias: row.alias,
              anonymousMode: row.anonymous_mode,
              avatarRef: row.avatar_ref,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getReferralStanding(
      input: Parameters<MiningRepository["getReferralStanding"]>[0],
    ) {
      try {
        const ownerUserId = opaqueIdSchema.parse(input.ownerUserId);
        const result = await pool.query({
          text: `
            with ${referralTotalsSql}
            select
              r.invited_count,
              r.position,
              (select count(*) from referral_ranked)::int as participant_count
            from (select 1) as one
            left join referral_ranked as r on r.owner_user_id = $1
          `,
          values: [ownerUserId],
        });
        const row = referralStandingRowSchema.parse(result.rows[0]);
        return Object.freeze({
          invitedCount: row.invited_count,
          position: row.position,
          participantCount: row.participant_count,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunityStanding(
      input: Parameters<MiningRepository["getCommunityStanding"]>[0],
    ) {
      try {
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const configVersion = configVersionSchema.parse(input.configVersion);
        const communityId = opaqueIdSchema.parse(input.communityId);
        const result = await pool.query({
          text: `
            with ${communityStandingsSql}
            select *
            from standings
            where community_id = $3
          `,
          values: [snapshotId, configVersion, communityId],
        });
        const raw: unknown = result.rows[0];
        return raw === undefined ? null : mapCommunityStanding(raw);
      } catch (error) {
        return translate(error);
      }
    },

    async listMemberPowers(
      input: Parameters<MiningRepository["listMemberPowers"]>[0],
    ) {
      try {
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const publicProfileIds = z
          .array(opaqueIdSchema)
          .max(500)
          .parse(input.publicProfileIds);
        if (publicProfileIds.length === 0) {
          return Object.freeze([]);
        }
        const result = await pool.query({
          text: `
            with totals as (
              select owner_user_id, sum(power::numeric)::text as total
              from public.mining_snapshot_powers
              where snapshot_id = $1
              group by owner_user_id
            )
            select
              profile.public_profile_id,
              profile.owner_user_id,
              t.total as total_power,
              coalesce(privacy.mining_power_visibility, 'everyone') = 'everyone'
                as visible_to_others
            from public.user_profiles as profile
            left join totals as t on t.owner_user_id = profile.owner_user_id
            left join public.privacy_preferences_v2 as privacy
              on privacy.owner_user_id = profile.owner_user_id
            where profile.public_profile_id = any($2::uuid[])
          `,
          values: [snapshotId, publicProfileIds],
        });
        return Object.freeze(
          result.rows.map((raw): MiningMemberPowerRecord => {
            const row = memberPowerRowSchema.parse(raw);
            return Object.freeze({
              publicProfileId: row.public_profile_id,
              ownerUserId: row.owner_user_id,
              totalPower: row.total_power,
              visibleToOthers: row.visible_to_others,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listAccountBalanceAssetIds(rawOwnerUserId: string) {
      try {
        const ownerUserId = opaqueIdSchema.parse(rawOwnerUserId);
        const result = await pool.query<{ asset_id: string }>({
          text: `
            select distinct s.asset_id
            from public.wallet_balance_snapshots as s
            join public.account_wallets as w on w.wallet_id = s.wallet_id
            where w.owner_user_id = $1 and w.status = 'active'
            order by s.asset_id
          `,
          values: [ownerUserId],
        });
        return Object.freeze(
          result.rows.map((row) => z.string().min(1).parse(row.asset_id)),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async hasActiveWallet(rawOwnerUserId: string) {
      try {
        const ownerUserId = opaqueIdSchema.parse(rawOwnerUserId);
        const result = await pool.query<{ present: boolean }>({
          text: `
            select exists (
              select 1
              from public.account_wallets
              where owner_user_id = $1 and status = 'active'
            ) as present
          `,
          values: [ownerUserId],
        });
        return z.boolean().parse(result.rows[0]?.present);
      } catch (error) {
        return translate(error);
      }
    },

    async listBalanceInputs(rawInput: {
      readonly includeMockSeedHoldings: boolean;
    }) {
      try {
        const includeMockSeedHoldings = z
          .boolean()
          .parse(rawInput.includeMockSeedHoldings);
        // The seeded holdings of Decision 0061 are a separate class of row,
        // not a different value of the same one: unless the lane was told to
        // include them the query cannot see them at all.
        const result = await pool.query({
          text: `
            select distinct on (s.wallet_id, s.asset_id)
              w.owner_user_id,
              s.wallet_id,
              s.asset_id,
              a.decimals,
              s.raw_value::text as raw_value,
              s.block_number::text as block_number,
              s.block_hash,
              s.source
            from public.wallet_balance_snapshots as s
            join public.account_wallets as w on w.wallet_id = s.wallet_id
            join public.assets as a on a.asset_id = s.asset_id
            where w.status = 'active' and a.status <> 'blocked'
              and ($1::boolean is true or s.source = 'chain')
            order by s.wallet_id, s.asset_id, s.block_number desc
          `,
          values: [includeMockSeedHoldings],
        });
        return Object.freeze(
          result.rows.map((raw): MiningBalanceInput => {
            const row = balanceRowSchema.parse(raw);
            return Object.freeze({
              ownerUserId: row.owner_user_id,
              walletId: row.wallet_id,
              assetId: row.asset_id,
              decimals: row.decimals,
              rawValue: row.raw_value,
              blockNumber: row.block_number,
              blockHash: row.block_hash,
              source: row.source,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },
  });
}
