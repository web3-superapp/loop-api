import type { Pool } from "pg";
import { z } from "zod";

import { inviteCodePatternSource } from "../features/referral/invite-code.js";
import {
  referralCommandDigestVersion,
  referralCommandIdempotencyScope,
  referralEventTypes,
  referralMaximumDepth,
  referralValidationStatuses,
} from "../features/referral/referral-contract.js";
import {
  ReferralAlreadyBoundError,
  ReferralCodeTakenError,
  ReferralIdempotencyConflictError,
  ReferralRepositoryUnavailableError,
  type ClaimReferralInput,
  type InviteCodeRecord,
  type ReferralEdgeRecord,
  referralInviteeStatuses,
  type ReferralBoostRecord,
  type ReferralInviteeRecord,
  type ReferralLevelCountRecord,
  type ReferralRepository,
} from "../features/referral/referral-repository.js";
import {
  claimV2Command,
  isUniqueViolation,
  lockV2Owner,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";

/**
 * PostgreSQL implementation of the referral boundary (Decision 0036).
 * A claim is one transaction: owner lock, durable idempotency claim, the
 * "never bound before" check under lock, edge inserts (unique per invitee
 * and depth), and one append-only audit row.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(uuidV4Pattern);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const codeSchema = z.string().regex(new RegExp(inviteCodePatternSource));
const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const codeRowSchema = z
  .object({ code: codeSchema, created_at: dateSchema })
  .strict();

const edgeRowSchema = z
  .object({
    referral_edge_id: userIdSchema,
    inviter_user_id: userIdSchema,
    invitee_user_id: userIdSchema,
    depth: z.number().int().min(1).max(referralMaximumDepth),
    validation_status: z.enum(referralValidationStatuses),
    locked_at: dateSchema,
    effective_from: dateSchema,
    effective_to: dateSchema.nullable(),
    config_version: z.string().min(1),
  })
  .strict();

const stateRowSchema = z
  .object({
    activated_at: dateSchema.nullable(),
    has_wallet: z.boolean(),
  })
  .strict();

const countRowSchema = z
  .object({
    depth: z.number().int().min(1).max(referralMaximumDepth),
    validation_status: z.enum(referralValidationStatuses),
    count: z.coerce.number().int().min(0),
  })
  .strict();

const powerSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,18})?$/);
const boundAtKeySchema = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/);

const inviteeRowSchema = z
  .object({
    referral_edge_id: userIdSchema,
    public_profile_id: z.string().nullable(),
    alias: z.string().nullable(),
    avatar_ref: z.string().nullable(),
    locked_at: dateSchema,
    bound_at_key: boundAtKeySchema,
    status: z.enum(referralInviteeStatuses),
  })
  .strict();

const statsRowSchema = z
  .object({
    direct_count: z.coerce.number().int().min(0),
    valid_count: z.coerce.number().int().min(0),
    level2to5_count: z.coerce.number().int().min(0),
    valid_as_of: dateSchema.nullable(),
  })
  .strict();

const boostLevelSchema = z.object({
  level: z.number().int().min(1).max(referralMaximumDepth),
  effectiveMembers: z.number().int().min(0),
  nftPower: powerSchema,
  assetPower: powerSchema,
});

const boostRowSchema = z
  .object({
    epoch_id: z.string().uuid(),
    hour_start: dateSchema,
    hour_end: dateSchema,
    referral_power: powerSchema.nullable(),
    nft_referral_power: powerSchema.nullable(),
    asset_referral_power: powerSchema.nullable(),
    referral_levels: z.array(boostLevelSchema).nullable(),
  })
  .strict();

/**
 * Decision 0162: the newest settled hour. An account without a reward row
 * in it had no power in that hour (Decision 0116: no row = no power).
 */
const latestSettledEpochSql = `
  latest as (
    select epoch_id, hour_start, hour_end
    from public.mining_epochs
    where status = 'settled'
    order by hour_start desc
    limit 1
  )
`;

/**
 * Decision 0162: one settled hour chosen by the caller (`$param`), so the
 * reads of one `GET /v2/referral` response share it. Null = no settled hour
 * yet (the CTE is empty).
 */
function pinnedEpochSql(param: string): string {
  return `
  latest as (
    select epoch_id, hour_start, hour_end
    from public.mining_epochs
    where status = 'settled' and epoch_id = ${param}::uuid
  )
`;
}

const epochIdSchema = z.string().uuid().nullable();

const edgeColumns = `
  referral_edge_id, inviter_user_id, invitee_user_id, depth, validation_status,
  locked_at, effective_from, effective_to, config_version
`;

function mapCode(raw: unknown): InviteCodeRecord {
  const row = codeRowSchema.parse(raw);
  return Object.freeze({
    code: row.code,
    issuedAt: toIsoString(row.created_at),
  });
}

function mapEdge(raw: unknown): ReferralEdgeRecord {
  const row = edgeRowSchema.parse(raw);
  return Object.freeze({
    referralEdgeId: row.referral_edge_id,
    inviterUserId: row.inviter_user_id,
    inviteeUserId: row.invitee_user_id,
    depth: row.depth,
    validationStatus: row.validation_status,
    lockedAt: toIsoString(row.locked_at),
    effectiveFrom: toIsoString(row.effective_from),
    effectiveTo: toNullableIsoString(row.effective_to),
    configVersion: row.config_version,
  });
}

function unavailable(): ReferralRepositoryUnavailableError {
  return new ReferralRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof ReferralAlreadyBoundError ||
    error instanceof ReferralCodeTakenError ||
    error instanceof ReferralIdempotencyConflictError ||
    error instanceof ReferralRepositoryUnavailableError
  ) {
    throw error;
  }
  if (isUniqueViolation(error, "invite_codes_code_unique")) {
    throw new ReferralCodeTakenError();
  }
  if (isUniqueViolation(error, "referral_edges_invitee_depth_unique")) {
    throw new ReferralAlreadyBoundError();
  }
  throw unavailable();
}

async function readDirectEdge(
  client: DatabaseClient,
  inviteeUserId: string,
  forUpdate = false,
): Promise<ReferralEdgeRecord | null> {
  const result = await client.query({
    text: `
      select ${edgeColumns}
      from public.referral_edges
      where invitee_user_id = $1 and depth = 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [inviteeUserId],
  });
  const row: unknown = result.rows[0];
  return row === undefined ? null : mapEdge(row);
}

async function appendAudit(
  client: DatabaseClient,
  input: {
    readonly inviteeUserId: string;
    readonly inviterUserId: string | null;
    readonly eventType: string;
    readonly reasonCode: string | null;
    readonly idempotencyRecordId: string | null;
    readonly requestId: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.referral_events (
        invitee_user_id, inviter_user_id, event_type, reason_code,
        idempotency_record_id, request_id
      )
      values ($1, $2, $3, $4, $5, $6)
    `,
    values: [
      input.inviteeUserId,
      input.inviterUserId,
      input.eventType,
      input.reasonCode,
      input.idempotencyRecordId,
      input.requestId,
    ],
  });
}

export function createPostgresReferralRepository(
  pool: Pool,
): ReferralRepository {
  return Object.freeze({
    async getInviteCode(rawOwnerUserId: string) {
      try {
        const ownerUserId = userIdSchema.parse(rawOwnerUserId);
        const result = await pool.query({
          text: `select code, created_at from public.invite_codes where owner_user_id = $1`,
          values: [ownerUserId],
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapCode(row);
      } catch (error) {
        return translate(error);
      }
    },

    async issueInviteCode(
      rawInput: Parameters<ReferralRepository["issueInviteCode"]>[0],
    ) {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const code = codeSchema.parse(rawInput.code);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, ownerUserId, unavailable);
          const existing = await client.query({
            text: `select code, created_at from public.invite_codes where owner_user_id = $1`,
            values: [ownerUserId],
          });
          const existingRow: unknown = existing.rows[0];
          if (existingRow !== undefined) {
            return mapCode(existingRow);
          }
          const inserted = await client.query({
            text: `
              insert into public.invite_codes (owner_user_id, code)
              values ($1, $2)
              returning code, created_at
            `,
            values: [ownerUserId, code],
          });
          await appendAudit(client, {
            inviteeUserId: ownerUserId,
            inviterUserId: null,
            eventType: referralEventTypes.codeIssued,
            reasonCode: null,
            idempotencyRecordId: null,
            requestId,
          });
          return mapCode(inserted.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async findInviterByCode(rawCode: string) {
      try {
        const code = codeSchema.parse(rawCode);
        const result = await pool.query<{ owner_user_id: string }>({
          text: `select owner_user_id from public.invite_codes where code = $1`,
          values: [code],
        });
        const ownerUserId = result.rows[0]?.owner_user_id;
        return ownerUserId === undefined
          ? null
          : userIdSchema.parse(ownerUserId);
      } catch (error) {
        return translate(error);
      }
    },

    async getAccountState(rawUserId: string) {
      try {
        const userId = userIdSchema.parse(rawUserId);
        const result = await pool.query({
          text: `
            select
              p.activated_at,
              exists (
                select 1 from public.account_wallets as w
                where w.owner_user_id = u.id and w.status = 'active'
              ) as has_wallet
            from public.loop_users as u
            left join public.user_profiles as p on p.owner_user_id = u.id
            where u.id = $1
          `,
          values: [userId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          throw unavailable();
        }
        const row = stateRowSchema.parse(raw);
        return Object.freeze({
          activatedAt: toNullableIsoString(row.activated_at),
          hasWallet: row.has_wallet,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getAncestorChain(rawUserId: string, limit: number) {
      try {
        const userId = userIdSchema.parse(rawUserId);
        const depthLimit = z.number().int().min(1).max(64).parse(limit);
        const result = await pool.query<{
          inviter_user_id: string;
          level: number;
        }>({
          text: `
            with recursive chain as (
              select e.inviter_user_id, 1 as level
              from public.referral_edges as e
              where e.invitee_user_id = $1 and e.depth = 1 and e.effective_to is null
              union all
              select e.inviter_user_id, chain.level + 1
              from public.referral_edges as e
              join chain on e.invitee_user_id = chain.inviter_user_id
              where e.depth = 1 and e.effective_to is null and chain.level < $2
            )
            select inviter_user_id, level from chain order by level asc
          `,
          values: [userId, depthLimit],
        });
        return Object.freeze(
          result.rows.map((row) => userIdSchema.parse(row.inviter_user_id)),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getDirectEdge(rawInviteeUserId: string) {
      try {
        return await readDirectEdge(pool, userIdSchema.parse(rawInviteeUserId));
      } catch (error) {
        return translate(error);
      }
    },

    async claim(rawInput: ClaimReferralInput) {
      try {
        const inviteeUserId = userIdSchema.parse(rawInput.inviteeUserId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const direct = rawInput.edges.find((edge) => edge.depth === 1);
        if (direct === undefined) {
          throw unavailable();
        }
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, inviteeUserId, unavailable);
          const recordId = await claimV2Command(
            client,
            {
              ownerUserId: inviteeUserId,
              scope: referralCommandIdempotencyScope,
              digestVersion: referralCommandDigestVersion,
              idempotencyKey,
              requestSha256,
            },
            () => new ReferralIdempotencyConflictError(),
          );
          const replay = await client.query<{ event_id: string }>({
            text: `select event_id from public.referral_events where idempotency_record_id = $1`,
            values: [recordId],
          });
          if (replay.rows[0] !== undefined) {
            const existing = await readDirectEdge(client, inviteeUserId);
            if (existing === null) {
              throw unavailable();
            }
            return existing;
          }
          const bound = await readDirectEdge(client, inviteeUserId, true);
          if (bound !== null) {
            throw new ReferralAlreadyBoundError();
          }
          for (const edge of rawInput.edges) {
            await client.query({
              text: `
                insert into public.referral_edges (
                  inviter_user_id, invitee_user_id, depth, validation_status
                )
                values ($1, $2, $3, $4)
              `,
              values: [
                userIdSchema.parse(edge.inviterUserId),
                inviteeUserId,
                z
                  .number()
                  .int()
                  .min(1)
                  .max(referralMaximumDepth)
                  .parse(edge.depth),
                rawInput.validationStatus,
              ],
            });
          }
          await appendAudit(client, {
            inviteeUserId,
            inviterUserId: userIdSchema.parse(direct.inviterUserId),
            eventType: referralEventTypes.claimed,
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          const created = await readDirectEdge(client, inviteeUserId);
          if (created === null) {
            throw unavailable();
          }
          return created;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async countInvitees(rawInviterUserId: string, rawEpochId: string | null) {
      try {
        const inviterUserId = userIdSchema.parse(rawInviterUserId);
        const epochId = epochIdSchema.parse(rawEpochId);
        const result = await pool.query({
          // Decision 0162 §E: `valid` comes from the newest settled hour
          // (the invitee's own power > 0), the same source as
          // stats.validCount; every other edge keeps its stored status.
          text: `
            with ${pinnedEpochSql("$2")},
            classified as (
              select
                e.depth,
                case
                  when e.validation_status <> 'invalidated'
                    and r.owner_user_id is not null
                    and r.nft_self_power::numeric + r.asset_self_power::numeric > 0
                    then 'valid'
                  when e.validation_status = 'valid' then 'pending_mining'
                  else e.validation_status
                end as validation_status
              from public.referral_edges as e
              left join latest on true
              left join public.mining_epoch_rewards as r
                on r.epoch_id = latest.epoch_id and r.owner_user_id = e.invitee_user_id
              where e.inviter_user_id = $1 and e.effective_to is null
            )
            select depth, validation_status, count(*)::int as count
            from classified
            group by depth, validation_status
            order by depth asc, validation_status asc
          `,
          values: [inviterUserId, epochId],
        });
        return Object.freeze(
          result.rows.map((raw): ReferralLevelCountRecord => {
            const row = countRowSchema.parse(raw);
            return Object.freeze({
              depth: row.depth,
              validationStatus: row.validation_status,
              count: row.count,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listDirectInvitees(
      rawInput: Parameters<ReferralRepository["listDirectInvitees"]>[0],
    ) {
      try {
        const inviterUserId = userIdSchema.parse(rawInput.inviterUserId);
        const limit = z.number().int().min(1).max(101).parse(rawInput.limit);
        const after =
          rawInput.after === null
            ? null
            : {
                boundAtKey: boundAtKeySchema.parse(rawInput.after.boundAtKey),
                referralEdgeId: userIdSchema.parse(
                  rawInput.after.referralEdgeId,
                ),
              };
        const result = await pool.query({
          text: `
            with ${latestSettledEpochSql}
            select
              e.referral_edge_id,
              case when blocked.blocked then null
                else p.public_profile_id::text end as public_profile_id,
              case when blocked.blocked then null else p.alias end as alias,
              case when blocked.blocked then null else p.avatar_ref end as avatar_ref,
              e.locked_at,
              to_char(e.locked_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at_key,
              case
                when e.effective_to is not null
                  or e.validation_status = 'invalidated' then 'invalid'
                when r.owner_user_id is not null
                  and r.nft_self_power::numeric + r.asset_self_power::numeric > 0
                  then 'valid'
                else 'pending'
              end as status
            from public.referral_edges as e
            left join public.user_profiles as p
              on p.owner_user_id = e.invitee_user_id and p.profile_status = 'active'
            left join lateral (
              select exists (
                select 1 from public.user_blocks as b
                where b.kind = 'user'
                  and b.owner_user_id = e.invitee_user_id
                  and b.target_user_id = e.inviter_user_id
              ) as blocked
            ) as blocked on true
            left join latest on true
            left join public.mining_epoch_rewards as r
              on r.epoch_id = latest.epoch_id and r.owner_user_id = e.invitee_user_id
            where e.inviter_user_id = $1 and e.depth = 1
              and (
                $2::timestamptz is null
                or (e.locked_at, e.referral_edge_id) < ($2::timestamptz, $3::uuid)
              )
            order by e.locked_at desc, e.referral_edge_id desc
            limit $4
          `,
          values: [
            inviterUserId,
            after?.boundAtKey ?? null,
            after?.referralEdgeId ?? null,
            limit,
          ],
        });
        return Object.freeze(
          result.rows.map((raw): ReferralInviteeRecord => {
            const row = inviteeRowSchema.parse(raw);
            return Object.freeze({
              referralEdgeId: row.referral_edge_id,
              publicProfileId: row.public_profile_id,
              alias: row.alias,
              avatarRef: row.avatar_ref,
              boundAt: toIsoString(row.locked_at),
              boundAtKey: row.bound_at_key,
              validationStatus: row.status,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getInviteeStats(rawInviterUserId: string, rawEpochId: string | null) {
      try {
        const inviterUserId = userIdSchema.parse(rawInviterUserId);
        const epochId = epochIdSchema.parse(rawEpochId);
        const result = await pool.query({
          text: `
            with ${pinnedEpochSql("$2")}
            select
              count(*) filter (where e.depth = 1)::int as direct_count,
              count(*) filter (
                where e.depth = 1 and r.owner_user_id is not null
                  and r.nft_self_power::numeric + r.asset_self_power::numeric > 0
              )::int as valid_count,
              count(*) filter (where e.depth between 2 and 5)::int
                as level2to5_count,
              (select hour_end from latest) as valid_as_of
            from public.referral_edges as e
            left join latest on true
            left join public.mining_epoch_rewards as r
              on r.epoch_id = latest.epoch_id and r.owner_user_id = e.invitee_user_id
            where e.inviter_user_id = $1 and e.effective_to is null
          `,
          values: [inviterUserId, epochId],
        });
        const row = statsRowSchema.parse(result.rows[0]);
        return Object.freeze({
          directCount: row.direct_count,
          validCount: row.valid_count,
          level2to5Count: row.level2to5_count,
          validAsOf: toNullableIsoString(row.valid_as_of),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getLatestSettledEpochId() {
      try {
        const result = await pool.query<{ epoch_id: string }>({
          text: `
            select epoch_id::text as epoch_id
            from public.mining_epochs
            where status = 'settled'
            order by hour_start desc
            limit 1
          `,
        });
        const row = result.rows[0];
        return row === undefined ? null : z.string().uuid().parse(row.epoch_id);
      } catch (error) {
        return translate(error);
      }
    },

    async getReferralBoost(rawUserId: string, rawEpochId: string | null) {
      try {
        const userId = userIdSchema.parse(rawUserId);
        const epochId = epochIdSchema.parse(rawEpochId);
        if (epochId === null) {
          return null;
        }
        const result = await pool.query({
          text: `
            with ${pinnedEpochSql("$2")}
            select
              latest.epoch_id::text as epoch_id,
              latest.hour_start,
              latest.hour_end,
              trim_scale(r.nft_referral_power::numeric
                + r.asset_referral_power::numeric)::text as referral_power,
              r.nft_referral_power,
              r.asset_referral_power,
              (
                select jsonb_agg(jsonb_build_object(
                  'level', (level->>'level')::int,
                  'effectiveMembers', (level->>'effectiveMembers')::int,
                  'nftPower', level->>'nftPower',
                  'assetPower', level->>'assetPower'
                ) order by (level->>'level')::int)
                from jsonb_array_elements(r.referral_levels) as level
              ) as referral_levels
            from latest
            left join public.mining_epoch_rewards as r
              on r.epoch_id = latest.epoch_id and r.owner_user_id = $1
          `,
          values: [userId, epochId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = boostRowSchema.parse(raw);
        const record: ReferralBoostRecord = Object.freeze({
          epochId: row.epoch_id,
          hourStart: toIsoString(row.hour_start),
          hourEnd: toIsoString(row.hour_end),
          referralPower: row.referral_power ?? "0",
          nftReferralPower: row.nft_referral_power ?? "0",
          assetReferralPower: row.asset_referral_power ?? "0",
          levels: Object.freeze(
            row.referral_levels === null
              ? Array.from({ length: referralMaximumDepth }, (_, index) =>
                  Object.freeze({
                    level: index + 1,
                    effectiveMembers: 0,
                    nftPower: "0",
                    assetPower: "0",
                  }),
                )
              : row.referral_levels.map((level) => Object.freeze(level)),
          ),
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async recordRejectedClaim(
      rawInput: Parameters<ReferralRepository["recordRejectedClaim"]>[0],
    ) {
      try {
        await appendAudit(pool, {
          inviteeUserId: userIdSchema.parse(rawInput.inviteeUserId),
          inviterUserId:
            rawInput.inviterUserId === null
              ? null
              : userIdSchema.parse(rawInput.inviterUserId),
          eventType: referralEventTypes.claimRejected,
          reasonCode: reasonCodeSchema.parse(rawInput.reasonCode),
          idempotencyRecordId: null,
          requestId: uuidV4Schema.parse(rawInput.requestId),
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}
