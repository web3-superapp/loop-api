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
  MiningFormulaStateError,
  MiningRepositoryUnavailableError,
  MiningSnapshotNotFoundError,
  MiningWeightOutOfRangeError,
  type CommunityWeightRecord,
  type CreateMiningFormulaVersionInput,
  type InvalidateMiningSnapshotsInput,
  type MiningAccountStandingRecord,
  type MiningCommunityStandingRecord,
  type MiningFormulaRecord,
  type MiningMemberPowerRecord,
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
  })
  .strict();

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
        uuidV4Schema.parse(rawInput.requestId);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await client.query({
            text: `
              select ${formulaColumns}
              from public.mining_formula_versions
              where config_version = $1
              for update
            `,
            values: [configVersion],
          });
          const raw: unknown = current.rows[0];
          if (raw === undefined) {
            throw new MiningFormulaNotFoundError();
          }
          const record = mapFormula(raw);
          if (record.status !== "pending_approval") {
            throw new MiningFormulaStateError();
          }
          await client.query({
            text: `
              update public.mining_formula_versions
              set status = 'retired', updated_at = clock_timestamp()
              where status = 'approved'
            `,
          });
          const approved = await client.query({
            text: `
              update public.mining_formula_versions
              set
                status = 'approved',
                effective_at = clock_timestamp(),
                approved_at = clock_timestamp(),
                updated_at = clock_timestamp()
              where config_version = $1
              returning ${formulaColumns}
            `,
            values: [configVersion],
          });
          return mapFormula(approved.rows[0]);
        });
      } catch (error) {
        return translate(error);
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

    async listAccountRanking(
      input: Parameters<MiningRepository["listAccountRanking"]>[0],
    ) {
      try {
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const result = await pool.query({
          text: `
            with ${accountTotalsSql}
            select
              r.owner_user_id,
              r.total::text as total_power,
              r.position::int as position,
              profile.public_profile_id,
              profile.alias,
              coalesce(privacy.anonymous_mode, false) as anonymous_mode,
              coalesce(privacy.mining_power_visibility, 'self') = 'everyone'
                as power_visible_to_others
            from ranked as r
            left join public.user_profiles as profile
              on profile.owner_user_id = r.owner_user_id
              and profile.profile_status = 'active'
            left join public.privacy_preferences_v2 as privacy
              on privacy.owner_user_id = r.owner_user_id
            order by r.position asc nulls last, r.owner_user_id asc
            limit $2
          `,
          values: [snapshotId, limit],
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
        const snapshotId = opaqueIdSchema.parse(input.snapshotId);
        const configVersion = configVersionSchema.parse(input.configVersion);
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const result = await pool.query({
          text: `
            with ${communityStandingsSql}
            select *
            from standings
            order by position asc nulls last, community_name asc, community_id asc
            limit $3
          `,
          values: [snapshotId, configVersion, limit],
        });
        return Object.freeze(result.rows.map(mapCommunityStanding));
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
              coalesce(privacy.mining_power_visibility, 'self') = 'everyone'
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
