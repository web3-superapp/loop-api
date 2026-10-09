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

    async countInvitees(rawInviterUserId: string) {
      try {
        const inviterUserId = userIdSchema.parse(rawInviterUserId);
        const result = await pool.query({
          text: `
            select depth, validation_status, count(*)::int as count
            from public.referral_edges
            where inviter_user_id = $1 and effective_to is null
            group by depth, validation_status
            order by depth asc, validation_status asc
          `,
          values: [inviterUserId],
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
