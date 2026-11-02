import type { Pool, PoolClient } from "pg";

import {
  feedbackContextKeys,
  feedbackReasonCodes,
  isFeedbackCategory,
  isFeedbackStatus,
  type FeedbackContext,
  type FeedbackContextKey,
  type FeedbackPageKey,
  type FeedbackRecord,
  type FeedbackRepository,
} from "../features/feedback/feedback-contract.js";
import { insertAdminAuditRow } from "./admin-repository.js";
import {
  lockV2Owner,
  toIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * Decision 0193: PostgreSQL side of beta feedback (migration 000105).
 * A create runs under the account lock (`loop_users` row), so the
 * idempotency lookup, the rolling daily limit and the screenshot checks
 * cannot race another create of the same account. Console updates lock the
 * report row and write their `admin_audit_log` row (`beta_feedback.update`,
 * target `beta_feedback`) in the same transaction.
 */

export class BetaFeedbackRepositoryUnavailableError extends Error {
  constructor() {
    super("Beta feedback repository returned an unexpected row");
    this.name = "BetaFeedbackRepositoryUnavailableError";
  }
}

type Row = Record<string, unknown>;

function fail(): never {
  throw new BetaFeedbackRepositoryUnavailableError();
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : fail();
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : fail();
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  return value instanceof Date || typeof value === "string"
    ? toIsoString(value)
    : fail();
}

function context(value: unknown): FeedbackContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
  }
  const source = value as Record<string, unknown>;
  const result: Partial<Record<FeedbackContextKey, string>> = {};
  for (const key of feedbackContextKeys) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string") return fail();
    result[key] = entry;
  }
  return Object.freeze(result);
}

function mediaIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return fail();
  return Object.freeze(
    value.map((entry) => (typeof entry === "string" ? entry : fail())),
  );
}

const recordColumns = `
  f.id::text as id, f.account_id::text as account_id,
  account.loop_id, profile.alias as display_name, f.category, f.body, f.context, f.status, f.admin_note,
  f.created_at, f.updated_at,
  coalesce((select array_agg(a.media_id::text order by a.sort)
    from public.beta_feedback_attachments as a
    where a.feedback_id = f.id), array[]::text[]) as media_ids`;

const recordFrom = `
  from public.beta_feedback as f
  join public.loop_users as account on account.id = f.account_id
  left join public.user_profiles as profile
    on profile.owner_user_id = f.account_id`;

function mapRecord(row: Row): FeedbackRecord {
  const category = row["category"];
  const status = row["status"];
  if (!isFeedbackCategory(category) || !isFeedbackStatus(status)) fail();
  return Object.freeze({
    id: text(row, "id"),
    accountId: text(row, "account_id"),
    loopId: nullableText(row, "loop_id"),
    displayName: nullableText(row, "display_name"),
    category,
    body: text(row, "body"),
    context: context(row["context"]),
    status,
    adminNote: nullableText(row, "admin_note"),
    mediaIds: mediaIds(row["media_ids"]),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  });
}

async function readRecord(
  client: Pool | PoolClient,
  id: string,
): Promise<FeedbackRecord | null> {
  const result = await client.query<Row>(
    `select ${recordColumns} ${recordFrom} where f.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

/** `(created_at, id) < (before)` keyset with the given parameter offset. */
function keyset(before: FeedbackPageKey | null, offset: number): string {
  return before === null
    ? "true"
    : `(f.created_at, f.id) < ($${String(offset)}::timestamptz, $${String(offset + 1)}::uuid)`;
}

export function createPostgresBetaFeedbackRepository(
  pool: Pool,
): FeedbackRepository {
  const unavailable = (): Error => new BetaFeedbackRepositoryUnavailableError();

  const service: FeedbackRepository = {
    async create(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        await lockV2Owner(client, input.accountId, unavailable);
        const earlier = await client.query<Row>(
          `select id::text as id, create_request_sha256
           from public.beta_feedback
           where account_id = $1 and create_idempotency_key = $2`,
          [input.accountId, input.idempotency.key],
        );
        const earlierRow = earlier.rows[0];
        if (earlierRow !== undefined) {
          if (
            earlierRow["create_request_sha256"] !==
            input.idempotency.requestSha256
          ) {
            return { status: "conflict" as const };
          }
          const replayed = await readRecord(client, text(earlierRow, "id"));
          return replayed === null
            ? fail()
            : { status: "replayed" as const, record: replayed };
        }
        const recent = await client.query<{ count: number }>(
          `select count(*)::integer as count from public.beta_feedback
           where account_id = $1
             and created_at > $2::timestamptz - ($3::integer * interval '1 millisecond')`,
          [input.accountId, input.now, input.windowMs],
        );
        if ((recent.rows[0]?.count ?? 0) >= input.dailyMax) {
          return { status: "rate_limited" as const };
        }
        if (input.mediaIds.length > 0) {
          const media = await client.query<Row>(
            `select m.media_id::text as media_id,
               (m.owner_user_id = $2 and m.kind = 'feedback_image'
                 and m.created_at >= $3::timestamptz) as usable,
               exists (select 1 from public.beta_feedback_attachments as a
                 where a.media_id = m.media_id) as attached
             from public.media_objects as m
             where m.media_id = any($1::uuid[])`,
            [input.mediaIds, input.accountId, input.mediaFreshSince],
          );
          const byId = new Map(
            media.rows.map((row) => [text(row, "media_id"), row]),
          );
          for (const mediaId of input.mediaIds) {
            const row = byId.get(mediaId);
            if (row === undefined || row["usable"] !== true) {
              return {
                status: "media_rejected" as const,
                reasonCode: feedbackReasonCodes.mediaNotOwned,
                mediaId,
              };
            }
            if (row["attached"] === true) {
              return {
                status: "media_rejected" as const,
                reasonCode: feedbackReasonCodes.mediaInUse,
                mediaId,
              };
            }
          }
        }
        await client.query(
          `insert into public.beta_feedback (
             id, account_id, category, body, context, status,
             create_idempotency_key, create_request_sha256, created_at,
             updated_at
           )
           values ($1, $2, $3, $4, $5::jsonb, 'open', $6, $7, $8, $8)`,
          [
            input.id,
            input.accountId,
            input.category,
            input.body,
            JSON.stringify(input.context),
            input.idempotency.key,
            input.idempotency.requestSha256,
            input.now,
          ],
        );
        for (const [sort, mediaId] of input.mediaIds.entries()) {
          await client.query(
            `insert into public.beta_feedback_attachments
               (feedback_id, media_id, sort)
             values ($1, $2, $3)`,
            [input.id, mediaId, sort],
          );
        }
        const created = await readRecord(client, input.id);
        return created === null
          ? fail()
          : { status: "created" as const, record: created };
      });
    },

    async listMine(input) {
      const result = await pool.query<Row>(
        `select ${recordColumns} ${recordFrom}
         where f.account_id = $1 and ${keyset(input.before, 2)}
         order by f.created_at desc, f.id desc
         limit $${input.before === null ? "2" : "4"}`,
        input.before === null
          ? [input.accountId, input.limit]
          : [
              input.accountId,
              input.before.createdAt,
              input.before.id,
              input.limit,
            ],
      );
      return result.rows.map(mapRecord);
    },

    async adminList(input) {
      const values: unknown[] = [input.status, input.category];
      if (input.before !== null) {
        values.push(input.before.createdAt, input.before.id);
      }
      values.push(input.limit);
      const result = await pool.query<Row>(
        `select ${recordColumns} ${recordFrom}
         where ($1::text is null or f.status = $1)
           and ($2::text is null or f.category = $2)
           and ${keyset(input.before, 3)}
         order by f.created_at desc, f.id desc
         limit $${String(values.length)}`,
        values,
      );
      return result.rows.map(mapRecord);
    },

    async adminGet(id) {
      return readRecord(pool, id);
    },

    async adminUpdate(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const locked = await client.query<Row>(
          `select status, admin_note from public.beta_feedback
           where id = $1 for update`,
          [input.id],
        );
        const row = locked.rows[0];
        if (row === undefined) return { status: "not_found" as const };
        const before = {
          status: text(row, "status"),
          adminNote: nullableText(row, "admin_note"),
        };
        const after = {
          status: input.status ?? before.status,
          adminNote:
            input.adminNote === undefined ? before.adminNote : input.adminNote,
        };
        await client.query(
          `update public.beta_feedback set
             status = $2, admin_note = $3,
             updated_at = greatest($4::timestamptz, created_at)
           where id = $1`,
          [input.id, after.status, after.adminNote, input.now],
        );
        const audit = await insertAdminAuditRow(client, {
          actor: input.audit.actor,
          actorAccountId: input.audit.actorAccountId,
          action: "beta_feedback.update",
          targetType: "beta_feedback",
          targetId: input.id,
          before,
          after: {
            ...after,
            changed:
              after.status !== before.status ||
              after.adminNote !== before.adminNote,
          },
          requestId: input.audit.requestId,
        });
        const record = await readRecord(client, input.id);
        if (record === null) fail();
        return {
          status: "written" as const,
          record,
          audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
        };
      });
    },
  };
  return Object.freeze(service);
}
