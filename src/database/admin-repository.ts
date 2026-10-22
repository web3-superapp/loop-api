import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  AdminRepositoryUnavailableError,
  AdminSeparationOfDutiesError,
  AdminStateConflictError,
  AdminTargetNotFoundError,
  AdminValidationError,
  type AdminAuditInput,
  type AdminAuditRecord,
  type AdminCommunityRecord,
  type AdminFormulaVersionRecord,
  type AdminLaunch2InstanceListingRecord,
  type AdminMemeTokenRecord,
  type AdminRepository,
  type AdminSettingKey,
  type AdminSettingRecord,
  type CommunityReviewNoteRecord,
} from "../features/admin/admin-repository.js";
import { adminReasonCodes } from "../features/admin/admin-contract.js";
import {
  isCommunityWeightWithinRange,
  miningFormulaDocumentSchema,
  miningFormulaStatuses,
  miningPriceGuardRulesSchema,
  miningWeightRangeDocumentSchema,
  unsignedDecimalPatternSource,
} from "../features/mining/mining-contract.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * PostgreSQL side of the operator console (Decision 0102). Every write
 * appends its `admin_audit_log` row inside the transaction of the change it
 * records, so a committed change always has its audit row and a refused one
 * has none. Timestamps the console compares (`admin_settings.updated_at`)
 * are written at millisecond precision so the ISO string a client echoes
 * back compares exactly.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuidSchema = z.string().regex(canonicalUuidPattern);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const decimalSchema = z
  .string()
  .regex(new RegExp(unsignedDecimalPatternSource, "u"));
const configVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);

function unavailable(): AdminRepositoryUnavailableError {
  return new AdminRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof AdminStateConflictError ||
    error instanceof AdminTargetNotFoundError ||
    error instanceof AdminValidationError ||
    error instanceof AdminSeparationOfDutiesError ||
    error instanceof AdminRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new AdminRepositoryUnavailableError({ cause: error });
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

type Queryable = Pool | PoolClient;

const auditRowSchema = z
  .object({
    audit_id: uuidSchema,
    seq: z.string().regex(/^[1-9][0-9]{0,18}$/u),
    at: dateSchema,
    actor: z.string(),
    actor_account_id: uuidSchema.nullable(),
    action: z.string(),
    target_type: z.string(),
    target_id: z.string().nullable(),
    before: z.unknown(),
    after: z.unknown(),
    request_id: uuidSchema,
  })
  .strict();

const auditColumns = `
  audit_id, seq::text as seq, at, actor, actor_account_id, action,
  target_type, target_id,
  before, after, request_id
`;

function mapAudit(raw: unknown): AdminAuditRecord {
  const row = auditRowSchema.parse(raw);
  return Object.freeze({
    auditId: row.audit_id,
    seq: Number(row.seq),
    at: row.at.toISOString(),
    actor: row.actor,
    actorAccountId: row.actor_account_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before ?? null,
    after: row.after ?? null,
    requestId: row.request_id,
  });
}

/**
 * Decision 0135: the same audit insert for a console write whose change
 * lives in another repository (the chain guard's manual resolve); the
 * caller runs it inside the transaction of that change.
 */
export function insertAdminAuditRow(
  client: Queryable,
  input: AdminAuditInput,
): Promise<AdminAuditRecord> {
  return insertAudit(client, input);
}

async function insertAudit(
  client: Queryable,
  input: AdminAuditInput,
): Promise<AdminAuditRecord> {
  const result = await client.query({
    text: `
      insert into public.admin_audit_log (
        audit_id, actor, action, target_type, target_id, before, after,
        request_id, actor_account_id
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      returning ${auditColumns}
    `,
    values: [
      randomUUID(),
      input.actor,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.requestId,
      input.actorAccountId ?? null,
    ],
  });
  return mapAudit(result.rows[0]);
}

const settingRowSchema = z
  .object({
    key: z.enum([
      "recommended_community_ids",
      "intel_promotions",
      "meme_listing_policy",
    ]),
    value: z.unknown(),
    updated_at: dateSchema,
    updated_by: z.string(),
  })
  .strict();

function mapSetting(raw: unknown): AdminSettingRecord {
  const row = settingRowSchema.parse(raw);
  return Object.freeze({
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  });
}

const communityRowSchema = z
  .object({
    community_id: uuidSchema,
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    logo_ref: z.string().nullable(),
    verification_status: z.enum(["pending", "verified", "rejected"]),
    label: z.string().nullable(),
    bound_asset_key: z.string().nullable(),
    member_count: z.number().int(),
    created_by_user_id: uuidSchema,
    owner_loop_id: z.string().nullable(),
    application_submitted_at: dateSchema.nullable(),
    reviewed_at: dateSchema.nullable(),
    verified_at: dateSchema.nullable(),
    rejected_reason: z.string().nullable(),
    created_at: dateSchema,
    updated_at: dateSchema,
  })
  .strict();

const communityColumns = `
  c.community_id, c.name, c.slug, c.description, c.logo_ref,
  c.verification_status, c.label, c.bound_asset_key, c.member_count,
  c.created_by_user_id, u.loop_id as owner_loop_id,
  c.application_submitted_at, c.reviewed_at, c.verified_at,
  c.rejected_reason, c.created_at, c.updated_at
`;
const communityFrom = `
  public.communities as c
  left join public.loop_users as u on u.id = c.created_by_user_id
`;

function mapCommunity(raw: unknown): AdminCommunityRecord {
  const row = communityRowSchema.parse(raw);
  return Object.freeze({
    communityId: row.community_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoRef: row.logo_ref,
    verificationStatus: row.verification_status,
    label: row.label,
    boundAssetId: row.bound_asset_key,
    memberCount: row.member_count,
    ownerUserId: row.created_by_user_id,
    ownerLoopId: row.owner_loop_id,
    applicationSubmittedAt: iso(row.application_submitted_at),
    reviewedAt: iso(row.reviewed_at),
    verifiedAt: iso(row.verified_at),
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

const noteRowSchema = z
  .object({
    note_id: uuidSchema,
    community_id: uuidSchema,
    at: dateSchema,
    actor: z.string(),
    decision: z.enum(["verify", "reject"]),
    reason_code: z.string(),
    reason_text: z.string().nullable(),
    audit_id: uuidSchema,
  })
  .strict();

function mapNote(raw: unknown): CommunityReviewNoteRecord {
  const row = noteRowSchema.parse(raw);
  return Object.freeze({
    noteId: row.note_id,
    communityId: row.community_id,
    at: row.at.toISOString(),
    actor: row.actor,
    decision: row.decision,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    auditId: row.audit_id,
  });
}

const memeRowSchema = z
  .object({
    meme_token_id: uuidSchema,
    chain_id: z.string(),
    contract_address: z.string(),
    token_address: z.string().nullable(),
    name: z.string(),
    symbol: z.string(),
    status: z.string(),
    listing: z.enum(["listed", "hidden"]),
    listing_reason_code: z.string().nullable(),
    listing_reason_text: z.string().nullable(),
    listing_changed_at: dateSchema.nullable(),
    creator_user_id: uuidSchema,
    creator_loop_id: z.string().nullable(),
    holder_count: z.number().int(),
    trade_count: z.number().int(),
    sold: z.string(),
    graduation_needs_operator: z.boolean(),
    chain_created_at: dateSchema.nullable(),
    graduated_at: dateSchema.nullable(),
    created_at: dateSchema,
  })
  .strict();

const memeColumns = `
  t.meme_token_id, t.chain_id, t.contract_address, t.token_address, t.name,
  t.symbol, t.status, t.listing, t.listing_reason_code,
  t.listing_reason_text, t.listing_changed_at, t.creator_user_id,
  u.loop_id as creator_loop_id, t.holder_count, t.trade_count,
  t.sold::text as sold, t.graduation_needs_operator, t.chain_created_at,
  t.graduated_at, t.created_at
`;
const memeFrom = `
  public.meme_tokens as t
  left join public.loop_users as u on u.id = t.creator_user_id
`;

const launch2ListingRowSchema = z
  .object({
    instance_id: uuidSchema,
    project_id: uuidSchema,
    chain_id: z.string(),
    name: z.string(),
    ticker: z.string(),
    meme_address: z.string(),
    stage: z.string(),
    graduated_at: dateSchema.nullable(),
    registered_at: dateSchema,
    listing: z.enum(["visible", "hidden"]),
    listing_reason: z.string().nullable(),
    listing_updated_at: dateSchema.nullable(),
    listing_updated_by: z.string().nullable(),
  })
  .strict();

const launch2ListingColumns = `
  i.instance_id::text as instance_id, i.project_id::text as project_id,
  i.chain_id, i.name, i.ticker, i.meme_address, i.stage, i.graduated_at,
  i.registered_at, i.listing, i.listing_reason, i.listing_updated_at,
  i.listing_updated_by
`;

function mapLaunch2Listing(raw: unknown): AdminLaunch2InstanceListingRecord {
  const row = launch2ListingRowSchema.parse(raw);
  return Object.freeze({
    instanceId: row.instance_id,
    projectId: row.project_id,
    chainId: row.chain_id,
    name: row.name,
    ticker: row.ticker,
    memeAddress: row.meme_address,
    stage: row.stage,
    graduatedAt: iso(row.graduated_at),
    registeredAt: row.registered_at.toISOString(),
    listing: row.listing,
    listingReason: row.listing_reason,
    listingUpdatedAt: iso(row.listing_updated_at),
    listingUpdatedBy: row.listing_updated_by,
  });
}

function mapMeme(raw: unknown): AdminMemeTokenRecord {
  const row = memeRowSchema.parse(raw);
  return Object.freeze({
    memeTokenId: row.meme_token_id,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    tokenAddress: row.token_address,
    name: row.name,
    symbol: row.symbol,
    status: row.status,
    listing: row.listing,
    listingReasonCode: row.listing_reason_code,
    listingReasonText: row.listing_reason_text,
    listingChangedAt: iso(row.listing_changed_at),
    creatorUserId: row.creator_user_id,
    creatorLoopId: row.creator_loop_id,
    holderCount: row.holder_count,
    tradeCount: row.trade_count,
    sold: row.sold,
    graduationNeedsOperator: row.graduation_needs_operator,
    chainCreatedAt: iso(row.chain_created_at),
    graduatedAt: iso(row.graduated_at),
    createdAt: row.created_at.toISOString(),
  });
}

const communityWeightsSchema = z
  .array(z.object({ communityId: uuidSchema, weight: decimalSchema }).strict())
  .max(500);

/**
 * Decision 0111: the approving reviewer, row-locked against a concurrent
 * disable, must still be an active account whose bound LOOP user is an
 * enabled ops operator — disabling the account or revoking the operator
 * (console or deployment CLI) stops formula approval like it stops the
 * Hooks launch review.
 */
async function assertApproverActive(
  client: Queryable,
  accountId: string,
): Promise<void> {
  const account = await client.query({
    text: `
      select disabled_at is not null as disabled, operator_user_id
      from public.admin_accounts
      where id = $1
      for share
    `,
    values: [uuidSchema.parse(accountId)],
  });
  const row = z
    .object({ disabled: z.boolean(), operator_user_id: uuidSchema.nullable() })
    .strict()
    .optional()
    .parse(account.rows[0]);
  if (row === undefined || row.disabled) {
    throw new AdminSeparationOfDutiesError(adminReasonCodes.accountDisabled);
  }
  if (row.operator_user_id === null) {
    throw new AdminSeparationOfDutiesError(adminReasonCodes.operatorDisabled);
  }
  const operator = await client.query({
    text: `
      select enabled from public.ops_operators
      where user_id = $1
      for share
    `,
    values: [row.operator_user_id],
  });
  const enabled = z
    .object({ enabled: z.boolean() })
    .strict()
    .optional()
    .parse(operator.rows[0]);
  if (enabled?.enabled !== true) {
    throw new AdminSeparationOfDutiesError(adminReasonCodes.operatorDisabled);
  }
}

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
    updated_at: dateSchema,
    community_weights: communityWeightsSchema.nullable(),
    draft_author_kind: z.enum(["admin_account", "admin_bootstrap"]).nullable(),
    draft_author: z.string().nullable(),
    draft_author_account_id: uuidSchema.nullable(),
    approved_by: z.string().nullable(),
    approved_by_account_id: uuidSchema.nullable(),
  })
  .strict();

const formulaColumns = `
  config_version, formula, weight_range, price_guard_rules, status,
  effective_at, approved_at, created_at, updated_at, community_weights,
  draft_author_kind, draft_author, draft_author_account_id,
  approved_by, approved_by_account_id
`;

function mapFormula(raw: unknown): AdminFormulaVersionRecord {
  const row = formulaRowSchema.parse(raw);
  return Object.freeze({
    configVersion: row.config_version,
    formula: row.formula,
    weightRange: row.weight_range,
    priceGuardRules: row.price_guard_rules,
    status: row.status,
    effectiveAt: iso(row.effective_at),
    approvedAt: iso(row.approved_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    communityWeights:
      row.community_weights === null
        ? null
        : Object.freeze(
            row.community_weights.map((entry) => Object.freeze({ ...entry })),
          ),
    draftAuthor:
      row.draft_author_kind === null || row.draft_author === null
        ? null
        : Object.freeze({
            kind: row.draft_author_kind,
            actor: row.draft_author,
            accountId: row.draft_author_account_id,
          }),
    approvedBy:
      row.approved_by === null || row.approved_by_account_id === null
        ? null
        : Object.freeze({
            actor: row.approved_by,
            accountId: row.approved_by_account_id,
          }),
  });
}

function formulaSummary(record: AdminFormulaVersionRecord) {
  return {
    configVersion: record.configVersion,
    status: record.status,
    effectiveAt: record.effectiveAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

/** Escapes LIKE metacharacters so an operator query is matched literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

export function createPostgresAdminRepository(pool: Pool): AdminRepository {
  async function readSetting(
    client: Queryable,
    key: AdminSettingKey,
    lock: boolean,
  ): Promise<AdminSettingRecord | null> {
    const result = await client.query({
      text: `
        select key, value, updated_at, updated_by
        from public.admin_settings
        where key = $1
        ${lock ? "for update" : ""}
      `,
      values: [key],
    });
    return result.rows[0] === undefined ? null : mapSetting(result.rows[0]);
  }

  async function readMeme(
    client: Queryable,
    memeTokenId: string,
    lock: boolean,
  ): Promise<AdminMemeTokenRecord | null> {
    const result = await client.query({
      text: `
        select ${memeColumns}
        from ${memeFrom}
        where t.meme_token_id = $1
        ${lock ? "for update of t" : ""}
      `,
      values: [uuidSchema.parse(memeTokenId)],
    });
    return result.rows[0] === undefined ? null : mapMeme(result.rows[0]);
  }

  async function readLaunch2Listing(
    client: Queryable,
    instanceId: string,
    lock: boolean,
  ): Promise<AdminLaunch2InstanceListingRecord | null> {
    const result = await client.query({
      text: `
        select ${launch2ListingColumns}
        from public.launch2_instances as i
        where i.instance_id = $1
        ${lock ? "for update of i" : ""}
      `,
      values: [uuidSchema.parse(instanceId)],
    });
    return result.rows[0] === undefined
      ? null
      : mapLaunch2Listing(result.rows[0]);
  }

  async function readFormula(
    client: Queryable,
    configVersion: string,
    lock: boolean,
  ): Promise<AdminFormulaVersionRecord | null> {
    const result = await client.query({
      text: `
        select ${formulaColumns}
        from public.mining_formula_versions
        where config_version = $1
        ${lock ? "for update" : ""}
      `,
      values: [configVersionSchema.parse(configVersion)],
    });
    return result.rows[0] === undefined ? null : mapFormula(result.rows[0]);
  }

  const repository: AdminRepository = {
    async getSetting(key) {
      try {
        return await readSetting(pool, key, false);
      } catch (error) {
        return translate(error);
      }
    },

    async writeSetting(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          // Serialises concurrent writers of a key that has no row yet.
          await client.query({
            text: `select pg_advisory_xact_lock(hashtextextended($1, 102))`,
            values: [`admin_settings:${input.key}`],
          });
          const current = await readSetting(client, input.key, true);
          const currentUpdatedAt = current?.updatedAt ?? null;
          if (currentUpdatedAt !== input.expectedUpdatedAt) {
            throw new AdminStateConflictError(
              adminReasonCodes.updatedAtMismatch,
              { currentUpdatedAt },
            );
          }
          let setting: AdminSettingRecord | null = null;
          if (input.value === null) {
            await client.query({
              text: `delete from public.admin_settings where key = $1`,
              values: [input.key],
            });
          } else {
            const written = await client.query({
              text: `
                insert into public.admin_settings (key, value, updated_at, updated_by)
                values ($1, $2::jsonb, date_trunc('milliseconds', clock_timestamp()), $3)
                on conflict (key) do update
                set
                  value = excluded.value,
                  updated_at = greatest(
                    excluded.updated_at,
                    public.admin_settings.updated_at + interval '1 millisecond'
                  ),
                  updated_by = excluded.updated_by
                returning key, value, updated_at, updated_by
              `,
              values: [
                input.key,
                JSON.stringify(input.value),
                input.audit.actor,
              ],
            });
            setting = mapSetting(written.rows[0]);
          }
          const audit = await insertAudit(client, {
            ...input.audit,
            before:
              current === null
                ? null
                : { value: current.value, updatedAt: current.updatedAt },
            after:
              setting === null
                ? null
                : { value: setting.value, updatedAt: setting.updatedAt },
          });
          return Object.freeze({ setting, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async appendAudit(input) {
      try {
        return await insertAudit(pool, input);
      } catch (error) {
        return translate(error);
      }
    },

    async listAudit(input) {
      try {
        const result = await pool.query({
          text: `
            select ${auditColumns}
            from public.admin_audit_log as log
            where ($1::bigint is null or log.seq < $1::bigint)
              and ($2::text is null or log.actor = $2)
              and ($3::text is null or log.action = $3)
            -- Qualified: the select list re-exposes seq as text.
            order by log.seq desc
            limit $4
          `,
          values: [
            input.beforeSeq === null ? null : String(input.beforeSeq),
            input.actor,
            input.action,
            input.limit,
          ],
        });
        return Object.freeze(result.rows.map(mapAudit));
      } catch (error) {
        return translate(error);
      }
    },

    async overview() {
      try {
        const [accounts, communities, voice, meme, lanes] = await Promise.all([
          pool.query<{ total: string }>(
            `select count(*)::text as total from public.loop_users`,
          ),
          pool.query<{ verification_status: string; total: string }>(
            `
              select verification_status, count(*)::text as total
              from public.communities
              group by verification_status
            `,
          ),
          pool.query<{ live: string; participants: string }>(
            `
              select
                (select count(*) from public.voice_rooms where state = 'live')::text as live,
                (
                  select count(*)
                  from public.voice_room_members as m
                  join public.voice_rooms as r on r.voice_room_id = m.voice_room_id
                  where r.state = 'live' and m.state = 'joined'
                )::text as participants
            `,
          ),
          pool.query<{ status: string; listing: string; total: string }>(
            `
              select status, listing, count(*)::text as total
              from public.meme_tokens
              group by status, listing
            `,
          ),
          pool.query<{
            lane: string;
            chain_id: string;
            last_block_number: string;
            updated_at: Date;
          }>(
            `
              select lane, chain_id, last_block_number::text as last_block_number,
                updated_at
              from public.indexer_checkpoints
              order by lane, chain_id
            `,
          ),
        ]);
        const communityCounts = { pending: 0, verified: 0, rejected: 0 };
        for (const row of communities.rows) {
          if (
            row.verification_status === "pending" ||
            row.verification_status === "verified" ||
            row.verification_status === "rejected"
          ) {
            communityCounts[row.verification_status] = Number(row.total);
          }
        }
        const byStatus: Record<string, number> = {};
        let hidden = 0;
        for (const row of meme.rows) {
          byStatus[row.status] =
            (byStatus[row.status] ?? 0) + Number(row.total);
          if (row.listing === "hidden") {
            hidden += Number(row.total);
          }
        }
        return Object.freeze({
          accounts: Number(accounts.rows[0]?.total ?? "0"),
          communities: Object.freeze(communityCounts),
          pendingReviews: communityCounts.pending,
          voiceRooms: Object.freeze({
            live: Number(voice.rows[0]?.live ?? "0"),
            participants: Number(voice.rows[0]?.participants ?? "0"),
          }),
          memeTokens: Object.freeze({
            byStatus: Object.freeze(byStatus),
            hidden,
          }),
          indexerLanes: Object.freeze(
            lanes.rows.map((row) =>
              Object.freeze({
                lane: row.lane,
                chainId: row.chain_id,
                lastBlockNumber: row.last_block_number,
                updatedAt: row.updated_at.toISOString(),
              }),
            ),
          ),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunities(input) {
      try {
        const result = await pool.query({
          text: `
            select ${communityColumns}
            from ${communityFrom}
            where ($1::text is null or c.verification_status = $1)
              and (
                $2::text is null
                or c.name ilike $2 escape '\\'
                or c.slug ilike $2 escape '\\'
                or c.community_id::text = $3
              )
              and (
                $4::timestamptz is null
                or (c.created_at, c.community_id) < ($4::timestamptz, $5::uuid)
              )
            order by c.created_at desc, c.community_id desc
            limit $6
          `,
          values: [
            input.status,
            input.query === null ? null : likePattern(input.query),
            input.query,
            input.after?.createdAt ?? null,
            input.after?.communityId ?? null,
            input.limit,
          ],
        });
        return Object.freeze(result.rows.map(mapCommunity));
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunity(communityId) {
      try {
        const result = await pool.query({
          text: `select ${communityColumns} from ${communityFrom} where c.community_id = $1`,
          values: [uuidSchema.parse(communityId)],
        });
        return result.rows[0] === undefined
          ? null
          : mapCommunity(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunitiesByIds(ids) {
      if (ids.length === 0) {
        return Object.freeze([]);
      }
      try {
        const result = await pool.query({
          text: `
            select ${communityColumns}
            from unnest($1::uuid[]) with ordinality as wanted(community_id, position)
            join public.communities as c on c.community_id = wanted.community_id
            left join public.loop_users as u on u.id = c.created_by_user_id
            order by wanted.position
          `,
          values: [ids.map((id) => uuidSchema.parse(id))],
        });
        return Object.freeze(result.rows.map(mapCommunity));
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunityReviewNotes(communityId) {
      try {
        const result = await pool.query({
          text: `
            select note_id, community_id, at, actor, decision, reason_code,
              reason_text, audit_id
            from public.community_review_notes
            where community_id = $1
            order by at desc, note_id desc
            limit 50
          `,
          values: [uuidSchema.parse(communityId)],
        });
        return Object.freeze(result.rows.map(mapNote));
      } catch (error) {
        return translate(error);
      }
    },

    async recordCommunityReview(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const audit = await insertAudit(client, input.audit);
          const note = await client.query({
            text: `
              insert into public.community_review_notes (
                note_id, community_id, actor, decision, reason_code,
                reason_text, audit_id
              )
              values ($1, $2, $3, $4, $5, $6, $7)
              returning note_id, community_id, at, actor, decision,
                reason_code, reason_text, audit_id
            `,
            values: [
              randomUUID(),
              uuidSchema.parse(input.communityId),
              input.audit.actor,
              input.decision,
              input.reasonCode,
              input.reasonText,
              audit.auditId,
            ],
          });
          return Object.freeze({ note: mapNote(note.rows[0]), audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async setCommunityLabel(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const communityId = uuidSchema.parse(input.communityId);
          const locked = await client.query({
            text: `
              select label from public.communities
              where community_id = $1
              for update
            `,
            values: [communityId],
          });
          if (locked.rows.length === 0) {
            return null;
          }
          const before = z
            .object({ label: z.string().nullable() })
            .parse(locked.rows[0]).label;
          let audit: AdminAuditRecord | null = null;
          if (before !== input.label) {
            await client.query({
              text: `
                update public.communities
                set label = $2, updated_at = now()
                where community_id = $1
              `,
              values: [communityId, input.label],
            });
            audit = await insertAudit(client, {
              ...input.audit,
              before: { label: before },
              after: { label: input.label },
            });
          }
          const current = await client.query({
            text: `select ${communityColumns} from ${communityFrom} where c.community_id = $1`,
            values: [communityId],
          });
          return Object.freeze({
            community: mapCommunity(current.rows[0]),
            changed: audit !== null,
            audit,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listMemeTokens(input) {
      try {
        const result = await pool.query({
          text: `
            select ${memeColumns}
            from ${memeFrom}
            where ($1::text is null or t.status = $1)
              and ($2::text is null or t.listing = $2)
              and (
                $3::text is null
                or t.name ilike $3 escape '\\'
                or t.symbol ilike $3 escape '\\'
                or t.meme_token_id::text = $4
                or t.token_address = lower($4)
              )
              and (
                $5::timestamptz is null
                or (t.created_at, t.meme_token_id) < ($5::timestamptz, $6::uuid)
              )
            order by t.created_at desc, t.meme_token_id desc
            limit $7
          `,
          values: [
            input.status,
            input.listing,
            input.query === null ? null : likePattern(input.query),
            input.query,
            input.after?.createdAt ?? null,
            input.after?.memeTokenId ?? null,
            input.limit,
          ],
        });
        return Object.freeze(result.rows.map(mapMeme));
      } catch (error) {
        return translate(error);
      }
    },

    async getMemeToken(memeTokenId) {
      try {
        return await readMeme(pool, memeTokenId, false);
      } catch (error) {
        return translate(error);
      }
    },

    async setMemeListing(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readMeme(client, input.memeTokenId, true);
          if (current === null) {
            throw new AdminTargetNotFoundError(
              adminReasonCodes.memeTokenNotFound,
            );
          }
          const changed = current.listing !== input.listing;
          await client.query({
            text: `
              update public.meme_tokens
              set
                listing = $2,
                listing_reason_code = $3,
                listing_reason_text = $4,
                listing_changed_at = clock_timestamp(),
                updated_at = greatest(updated_at, clock_timestamp())
              where meme_token_id = $1
            `,
            values: [
              current.memeTokenId,
              input.listing,
              input.reasonCode,
              input.reasonText,
            ],
          });
          const token = await readMeme(client, input.memeTokenId, false);
          if (token === null) {
            throw unavailable();
          }
          const audit = await insertAudit(client, {
            ...input.audit,
            before: {
              listing: current.listing,
              reasonCode: current.listingReasonCode,
              reasonText: current.listingReasonText,
            },
            after: {
              listing: token.listing,
              reasonCode: token.listingReasonCode,
              reasonText: token.listingReasonText,
            },
          });
          return Object.freeze({ token, changed, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listLaunch2Instances(input) {
      try {
        const result = await pool.query({
          text: `
            select ${launch2ListingColumns}
            from public.launch2_instances as i
            where ($1::text is null or i.listing = $1)
              and ($2::text is null
                or i.name ilike $3 escape '\\'
                or i.ticker ilike $3 escape '\\'
                or i.instance_id::text = lower($2)
                or i.meme_address = lower($2))
            order by i.registered_at desc, i.instance_id desc
            limit $4
          `,
          values: [
            input.listing,
            input.query,
            input.query === null ? null : likePattern(input.query),
            input.limit,
          ],
        });
        return Object.freeze(result.rows.map(mapLaunch2Listing));
      } catch (error) {
        return translate(error);
      }
    },

    async setLaunch2Listing(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readLaunch2Listing(
            client,
            input.instanceId,
            true,
          );
          if (current === null) {
            throw new AdminTargetNotFoundError(
              adminReasonCodes.launch2InstanceNotFound,
            );
          }
          const changed = current.listing !== input.listing;
          // Decision 0163: only the listing columns; chain facts untouched.
          await client.query({
            text: `
              update public.launch2_instances
              set
                listing = $2,
                listing_reason = coalesce($3, listing_reason),
                listing_updated_at = clock_timestamp(),
                listing_updated_by = $4
              where instance_id = $1
            `,
            values: [
              current.instanceId,
              input.listing,
              input.reason,
              input.audit.actor,
            ],
          });
          const instance = await readLaunch2Listing(
            client,
            input.instanceId,
            false,
          );
          if (instance === null) {
            throw unavailable();
          }
          const audit = await insertAudit(client, {
            ...input.audit,
            before: {
              listing: current.listing,
              reason: current.listingReason,
            },
            after: {
              listing: instance.listing,
              reason: instance.listingReason,
            },
          });
          return Object.freeze({ instance, changed, audit });
        });
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

    async getFormulaVersion(configVersion) {
      try {
        return await readFormula(pool, configVersion, false);
      } catch (error) {
        return translate(error);
      }
    },

    async listApprovedCommunityWeights() {
      try {
        const result = await pool.query<{
          community_id: string;
          weight: string;
        }>({
          text: `
            select w.community_id, w.weight
            from public.community_mining_weights as w
            join public.mining_formula_versions as f
              on f.config_version = w.config_version and f.status = 'approved'
            where w.status = 'approved' and w.weight is not null
            order by w.community_id
          `,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              communityId: uuidSchema.parse(row.community_id),
              weight: decimalSchema.parse(row.weight),
            }),
          ),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async createFormulaDraft(input) {
      try {
        const formula = miningFormulaDocumentSchema.parse(input.formula);
        const weightRange = miningWeightRangeDocumentSchema.parse(
          input.weightRange,
        );
        const priceGuardRules = miningPriceGuardRulesSchema.parse(
          input.priceGuardRules,
        );
        const communityWeights = communityWeightsSchema.parse(
          input.communityWeights,
        );
        return await withV2Transaction(pool, unavailable, async (client) => {
          let inserted;
          try {
            inserted = await client.query({
              text: `
                insert into public.mining_formula_versions (
                  config_version, formula, weight_range, price_guard_rules,
                  status, community_weights,
                  draft_author_kind, draft_author, draft_author_account_id
                )
                values (
                  $1, $2::jsonb, $3::jsonb, $4::jsonb, 'pending_approval',
                  $5::jsonb, $6, $7, $8
                )
                returning ${formulaColumns}
              `,
              values: [
                configVersionSchema.parse(input.configVersion),
                JSON.stringify(formula),
                JSON.stringify(weightRange),
                JSON.stringify(priceGuardRules),
                JSON.stringify(communityWeights),
                input.author.kind,
                input.author.actor,
                input.author.kind === "admin_account"
                  ? uuidSchema.parse(input.author.accountId)
                  : null,
              ],
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new AdminStateConflictError(adminReasonCodes.formulaExists);
            }
            throw error;
          }
          const version = mapFormula(inserted.rows[0]);
          const audit = await insertAudit(client, {
            ...input.audit,
            before: null,
            after: {
              ...formulaSummary(version),
              formula: version.formula,
              weightRange: version.weightRange,
              communityWeights: version.communityWeights,
              draftAuthor: version.draftAuthor,
            },
          });
          return Object.freeze({ version, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async approveFormula(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          await assertApproverActive(client, input.approver.accountId);
          const current = await readFormula(client, input.configVersion, true);
          if (current === null) {
            throw new AdminTargetNotFoundError(
              adminReasonCodes.formulaNotFound,
            );
          }
          if (current.status !== "pending_approval") {
            throw new AdminStateConflictError(adminReasonCodes.formulaState, {
              status: current.status,
            });
          }
          // Decision 0110: approver ≠ author, checked on the locked row.
          if (current.draftAuthor === null) {
            throw new AdminStateConflictError(
              adminReasonCodes.formulaDraftAuthorUnknown,
            );
          }
          if (
            current.draftAuthor.accountId !== null &&
            current.draftAuthor.accountId === input.approver.accountId
          ) {
            throw new AdminSeparationOfDutiesError(
              adminReasonCodes.formulaSelfApproval,
            );
          }
          const weights = current.communityWeights ?? [];
          const range = current.weightRange.community.range;
          const boundAssets = new Map<string, string>();
          for (const entry of weights) {
            if (
              range === undefined ||
              !isCommunityWeightWithinRange(entry.weight, range)
            ) {
              throw new AdminValidationError(
                adminReasonCodes.formulaWeightOutOfRange,
                { communityId: entry.communityId },
              );
            }
            const community = await client.query<{
              bound_asset_key: string | null;
            }>({
              text: `
                select bound_asset_key from public.communities
                where community_id = $1
                for update
              `,
              values: [entry.communityId],
            });
            const row = community.rows[0];
            if (row === undefined) {
              throw new AdminValidationError(
                adminReasonCodes.communityNotFound,
                { communityId: entry.communityId },
              );
            }
            if (row.bound_asset_key === null) {
              throw new AdminValidationError(
                adminReasonCodes.formulaWeightUnbound,
                { communityId: entry.communityId },
              );
            }
            const other = boundAssets.get(row.bound_asset_key);
            if (other !== undefined && other !== entry.communityId) {
              throw new AdminValidationError(
                adminReasonCodes.formulaWeightConflict,
                { communityId: entry.communityId },
              );
            }
            boundAssets.set(row.bound_asset_key, entry.communityId);
          }
          const retired = await client.query<{ config_version: string }>({
            text: `
              update public.mining_formula_versions
              set status = 'retired', updated_at = clock_timestamp()
              where status = 'approved'
              returning config_version
            `,
          });
          await client.query({
            text: `
              update public.mining_formula_versions
              set
                status = 'approved',
                effective_at = clock_timestamp(),
                approved_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                approved_by = $2,
                approved_by_account_id = $3
              where config_version = $1
            `,
            values: [
              current.configVersion,
              input.approver.actor,
              uuidSchema.parse(input.approver.accountId),
            ],
          });
          for (const entry of weights) {
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
              values: [entry.communityId, entry.weight, current.configVersion],
            });
          }
          const version = await readFormula(
            client,
            current.configVersion,
            false,
          );
          if (version === null) {
            throw unavailable();
          }
          const retiredVersion = retired.rows[0]?.config_version ?? null;
          const audit = await insertAudit(client, {
            ...input.audit,
            before: {
              ...formulaSummary(current),
              approvedVersion: retiredVersion,
            },
            after: {
              ...formulaSummary(version),
              retiredVersion,
              communityWeightsApplied: weights.length,
              draftAuthor: current.draftAuthor,
              approvedBy: version.approvedBy,
              requestedAuditId: input.requestedAuditId,
            },
          });
          return Object.freeze({ version, retiredVersion, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async withdrawFormula(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readFormula(client, input.configVersion, true);
          if (current === null) {
            throw new AdminTargetNotFoundError(
              adminReasonCodes.formulaNotFound,
            );
          }
          if (current.status !== "pending_approval") {
            throw new AdminStateConflictError(adminReasonCodes.formulaState, {
              status: current.status,
            });
          }
          await client.query({
            text: `
              update public.mining_formula_versions
              set status = 'retired', updated_at = clock_timestamp()
              where config_version = $1
            `,
            values: [current.configVersion],
          });
          const version = await readFormula(
            client,
            current.configVersion,
            false,
          );
          if (version === null) {
            throw unavailable();
          }
          const audit = await insertAudit(client, {
            ...input.audit,
            before: formulaSummary(current),
            after: formulaSummary(version),
          });
          return Object.freeze({ version, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}

export function createUnavailableAdminRepository(): AdminRepository {
  const fail = (): Promise<never> =>
    Promise.reject(new AdminRepositoryUnavailableError());
  return Object.freeze({
    getSetting: fail,
    writeSetting: fail,
    appendAudit: fail,
    listAudit: fail,
    overview: fail,
    listCommunities: fail,
    getCommunity: fail,
    getCommunitiesByIds: fail,
    listCommunityReviewNotes: fail,
    recordCommunityReview: fail,
    setCommunityLabel: fail,
    listMemeTokens: fail,
    getMemeToken: fail,
    setMemeListing: fail,
    listLaunch2Instances: fail,
    setLaunch2Listing: fail,
    listFormulaVersions: fail,
    getFormulaVersion: fail,
    listApprovedCommunityWeights: fail,
    createFormulaDraft: fail,
    approveFormula: fail,
    withdrawFormula: fail,
  });
}
