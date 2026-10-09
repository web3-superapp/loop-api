import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  communityAiAskIdempotencyScope,
  communityAiAskDigestVersion,
  communityAiReportIdempotencyScope,
  communityAiReportDigestVersion,
  communityAiReportReasons,
  communityAiSourceKinds,
} from "../features/community-ai/community-ai-contract.js";
import {
  CommunityAiAnswerNotFoundError,
  CommunityAiIdempotencyConflictError,
  CommunityAiQuotaExceededError,
  CommunityAiRepositoryUnavailableError,
  type BeginCommunityAiAskInput,
  type BeginCommunityAiAskResult,
  type CommunityAiAnswerRecord,
  type CommunityAiReportRecord,
  type CommunityAiRepository,
  type CommunityAiStoredCitation,
  type CompleteCommunityAiAskInput,
  type ReportCommunityAiAnswerInput,
  type ReserveCommunityAiBriefInput,
  type SettleCommunityAiUsageInput,
} from "../features/community-ai/community-ai-repository.js";

/**
 * PostgreSQL Community AI repository (Decision 0066).
 *
 * The quota is counted from `community_ai_usage` under a per-community
 * advisory lock and spent before the Provider call, so two concurrent requests
 * cannot both pass the last unit of the budget. Nothing in this file writes,
 * reads, or logs a community message.
 */

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const citationSchema = z
  .object({
    sourceId: z.string().regex(/^s[1-9][0-9]{0,2}$/),
    kind: z.enum(communityAiSourceKinds),
    label: z.string().min(1).max(200),
    observedAt: z.string().min(20).max(40),
  })
  .strict();

const answerRowSchema = z
  .object({
    answer_id: uuidSchema,
    community_id: uuidSchema,
    owner_user_id: uuidSchema,
    question: z.string().min(1),
    answer: z.string(),
    refusal: z.string().nullable(),
    citations: z.array(citationSchema),
    model: z.string().min(1),
    input_tokens: z.number().int().min(0).nullable(),
    output_tokens: z.number().int().min(0).nullable(),
    created_at: z
      .instanceof(Date)
      .refine((value) => !Number.isNaN(value.getTime())),
  })
  .strict();

const reportRowSchema = z
  .object({
    report_id: uuidSchema,
    answer_id: uuidSchema,
    reason: z.enum(communityAiReportReasons),
    note: z.string().nullable(),
    created_at: z
      .instanceof(Date)
      .refine((value) => !Number.isNaN(value.getTime())),
  })
  .strict();

const beginAskInputSchema = z
  .object({
    communityId: uuidSchema,
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
    userLimitPerMinute: z.number().int().min(1).max(60),
    communityDailyLimit: z.number().int().min(1).max(10_000),
  })
  .strict();

const completeAskInputSchema = z
  .object({
    idempotencyRecordId: uuidSchema,
    usageId: uuidSchema,
    communityId: uuidSchema,
    ownerUserId: uuidSchema,
    requestSha256: sha256Schema,
    question: z.string().min(1).max(2_000),
    answer: z.string().max(8_000),
    refusal: z.string().min(1).max(2_000).nullable(),
    citations: z.array(citationSchema).max(12),
    model: z.string().min(1).max(128),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
  })
  .strict();

const reserveBriefInputSchema = z
  .object({
    communityId: uuidSchema,
    ownerUserId: uuidSchema,
    requestId: uuidSchema,
    userLimitPerMinute: z.number().int().min(1).max(60),
    communityDailyLimit: z.number().int().min(1).max(10_000),
  })
  .strict();

const settleUsageInputSchema = z
  .object({
    usageId: uuidSchema,
    status: z.enum(["completed", "failed"]),
    model: z.string().min(1).max(128).nullable(),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
  })
  .strict();

const reportInputSchema = z
  .object({
    answerId: uuidSchema,
    communityId: uuidSchema,
    ownerUserId: uuidSchema,
    reason: z.enum(communityAiReportReasons),
    note: z.string().min(1).max(500).nullable(),
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
  })
  .strict();

const personaInputSchema = z
  .object({
    communityId: uuidSchema,
    ownerUserIds: z.array(uuidSchema).max(200),
  })
  .strict();

const answerSelect = `
  select
    a.answer_id, a.community_id, a.owner_user_id, a.question, a.answer,
    a.refusal, a.citations, a.model, a.input_tokens, a.output_tokens,
    a.created_at
  from public.community_ai_answers a
`;

function mapAnswer(raw: unknown): CommunityAiAnswerRecord {
  const row = answerRowSchema.parse(raw);
  return Object.freeze({
    answerId: row.answer_id,
    communityId: row.community_id,
    ownerUserId: row.owner_user_id,
    question: row.question,
    answer: row.answer,
    refusal: row.refusal,
    citations: Object.freeze(
      row.citations.map((citation) =>
        Object.freeze({ ...citation }),
      ) as CommunityAiStoredCitation[],
    ),
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at.toISOString(),
  });
}

function mapReport(raw: unknown): CommunityAiReportRecord {
  const row = reportRowSchema.parse(raw);
  return Object.freeze({
    reportId: row.report_id,
    answerId: row.answer_id,
    reason: row.reason,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  });
}

function translate(error: unknown): never {
  if (
    error instanceof CommunityAiIdempotencyConflictError ||
    error instanceof CommunityAiQuotaExceededError ||
    error instanceof CommunityAiAnswerNotFoundError ||
    error instanceof CommunityAiRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new CommunityAiRepositoryUnavailableError();
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Spends one unit of both budgets and returns the reserved row. The advisory
 * lock is per community, so the community-day count cannot be read by two
 * transactions at once; the per-account count is read inside the same lock.
 */
async function reserveUsage(
  client: PoolClient,
  input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly kind: "ask" | "brief";
    readonly requestId: string;
    readonly userLimitPerMinute: number;
    readonly communityDailyLimit: number;
  },
): Promise<string> {
  await client.query({
    text: `
      select pg_advisory_xact_lock(
        hashtextextended('loop:v2:community-ai:' || $1, 0)
      )
    `,
    values: [input.communityId],
  });
  const counts = await client.query<{
    owner_minute: number;
    community_day: number;
  }>({
    text: `
      select
        count(*) filter (
          where owner_user_id = $2
            and created_at >= clock_timestamp() - interval '1 minute'
        )::int as owner_minute,
        count(*) filter (
          where community_id = $1
            and created_at >= clock_timestamp() - interval '24 hours'
        )::int as community_day
      from public.community_ai_usage
      where (
        owner_user_id = $2
        and created_at >= clock_timestamp() - interval '1 minute'
      ) or (
        community_id = $1
        and created_at >= clock_timestamp() - interval '24 hours'
      )
    `,
    values: [input.communityId, input.ownerUserId],
  });
  const ownerMinute = counts.rows[0]?.owner_minute ?? Number.MAX_SAFE_INTEGER;
  const communityDay = counts.rows[0]?.community_day ?? Number.MAX_SAFE_INTEGER;
  if (ownerMinute >= input.userLimitPerMinute) {
    throw new CommunityAiQuotaExceededError("user");
  }
  if (communityDay >= input.communityDailyLimit) {
    throw new CommunityAiQuotaExceededError("community");
  }
  const inserted = await client.query<{ usage_id: string }>({
    text: `
      insert into public.community_ai_usage (
        community_id, owner_user_id, kind, status, request_id
      )
      values ($1, $2, $3, 'reserved', $4)
      returning usage_id
    `,
    values: [input.communityId, input.ownerUserId, input.kind, input.requestId],
  });
  const usageId = inserted.rows[0]?.usage_id;
  if (usageId === undefined) {
    throw new CommunityAiRepositoryUnavailableError();
  }
  return usageId;
}

async function bindIdempotencyRecord(
  client: PoolClient,
  input: {
    readonly ownerUserId: string;
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly digestVersion: string;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id, scope, idempotency_key, key_source,
        request_sha256, digest_version
      )
      values ($1, $2, $3, 'client', $4, $5)
      on conflict (scope, idempotency_key)
      do update set last_seen_at = clock_timestamp()
      where idempotency_records.owner_user_id = excluded.owner_user_id
        and idempotency_records.key_source = excluded.key_source
        and idempotency_records.request_sha256 = excluded.request_sha256
        and idempotency_records.digest_version = excluded.digest_version
      returning id
    `,
    values: [
      input.ownerUserId,
      input.scope,
      input.idempotencyKey,
      input.requestSha256,
      input.digestVersion,
    ],
  });
  const recordId = result.rows[0]?.id;
  if (recordId === undefined) {
    throw new CommunityAiIdempotencyConflictError();
  }
  return recordId;
}

export function createPostgresCommunityAiRepository(
  pool: Pool,
): CommunityAiRepository {
  const repository: CommunityAiRepository = {
    async beginAsk(
      rawInput: BeginCommunityAiAskInput,
    ): Promise<BeginCommunityAiAskResult> {
      try {
        const input = beginAskInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const recordId = await bindIdempotencyRecord(client, {
            ownerUserId: input.ownerUserId,
            scope: communityAiAskIdempotencyScope,
            idempotencyKey: input.idempotencyKey,
            requestSha256: input.requestSha256,
            digestVersion: communityAiAskDigestVersion,
          });
          const existing = await client.query<Record<string, unknown>>({
            text: `${answerSelect} where a.create_idempotency_record_id = $1`,
            values: [recordId],
          });
          const replay = existing.rows[0];
          if (replay !== undefined) {
            const answer = mapAnswer(replay);
            if (
              answer.ownerUserId !== input.ownerUserId ||
              answer.communityId !== input.communityId
            ) {
              throw new CommunityAiIdempotencyConflictError();
            }
            return Object.freeze({ kind: "replay" as const, answer });
          }
          const usageId = await reserveUsage(client, {
            communityId: input.communityId,
            ownerUserId: input.ownerUserId,
            kind: "ask",
            requestId: input.requestId,
            userLimitPerMinute: input.userLimitPerMinute,
            communityDailyLimit: input.communityDailyLimit,
          });
          return Object.freeze({
            kind: "reserved" as const,
            idempotencyRecordId: recordId,
            usageId,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async completeAsk(
      rawInput: CompleteCommunityAiAskInput,
    ): Promise<CommunityAiAnswerRecord> {
      try {
        const input = completeAskInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const settled = await client.query({
            text: `
              update public.community_ai_usage
              set status = 'completed',
                  model = $2,
                  input_tokens = $3,
                  output_tokens = $4,
                  settled_at = clock_timestamp()
              where usage_id = $1 and status = 'reserved'
            `,
            values: [
              input.usageId,
              input.model,
              input.inputTokens,
              input.outputTokens,
            ],
          });
          if (settled.rowCount !== 1) {
            throw new CommunityAiRepositoryUnavailableError();
          }
          const inserted = await client.query<{ answer_id: string }>({
            text: `
              insert into public.community_ai_answers (
                community_id, owner_user_id, usage_id, question, answer,
                refusal, citations, model, input_tokens, output_tokens,
                create_idempotency_record_id, create_request_sha256
              )
              values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
              returning answer_id
            `,
            values: [
              input.communityId,
              input.ownerUserId,
              input.usageId,
              input.question,
              input.answer,
              input.refusal,
              JSON.stringify(input.citations),
              input.model,
              input.inputTokens,
              input.outputTokens,
              input.idempotencyRecordId,
              input.requestSha256,
            ],
          });
          const answerId = inserted.rows[0]?.answer_id;
          if (answerId === undefined) {
            throw new CommunityAiRepositoryUnavailableError();
          }
          const stored = await client.query<Record<string, unknown>>({
            text: `${answerSelect} where a.answer_id = $1`,
            values: [answerId],
          });
          const row = stored.rows[0];
          if (row === undefined) {
            throw new CommunityAiRepositoryUnavailableError();
          }
          return mapAnswer(row);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reserveBrief(rawInput: ReserveCommunityAiBriefInput) {
      try {
        const input = reserveBriefInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const usageId = await reserveUsage(client, {
            communityId: input.communityId,
            ownerUserId: input.ownerUserId,
            kind: "brief",
            requestId: input.requestId,
            userLimitPerMinute: input.userLimitPerMinute,
            communityDailyLimit: input.communityDailyLimit,
          });
          return Object.freeze({ usageId });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async settleUsage(rawInput: SettleCommunityAiUsageInput): Promise<void> {
      try {
        const input = settleUsageInputSchema.parse(rawInput);
        await pool.query({
          text: `
            update public.community_ai_usage
            set status = $2,
                model = coalesce($3, model),
                input_tokens = $4,
                output_tokens = $5,
                settled_at = clock_timestamp()
            where usage_id = $1 and status = 'reserved'
          `,
          values: [
            input.usageId,
            input.status,
            input.model,
            input.inputTokens,
            input.outputTokens,
          ],
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reportAnswer(rawInput: ReportCommunityAiAnswerInput) {
      try {
        const input = reportInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const owned = await client.query<{ answer_id: string }>({
            text: `
              select answer_id from public.community_ai_answers
              where answer_id = $1
                and owner_user_id = $2
                and community_id = $3
            `,
            values: [input.answerId, input.ownerUserId, input.communityId],
          });
          if (owned.rows[0] === undefined) {
            throw new CommunityAiAnswerNotFoundError();
          }
          const recordId = await bindIdempotencyRecord(client, {
            ownerUserId: input.ownerUserId,
            scope: communityAiReportIdempotencyScope,
            idempotencyKey: input.idempotencyKey,
            requestSha256: input.requestSha256,
            digestVersion: communityAiReportDigestVersion,
          });
          const existing = await client.query<Record<string, unknown>>({
            text: `
              select report_id, answer_id, reason, note, created_at
              from public.community_ai_answer_reports
              where answer_id = $1 and reporter_user_id = $2
            `,
            values: [input.answerId, input.ownerUserId],
          });
          const stored = existing.rows[0];
          if (stored !== undefined) {
            return Object.freeze({
              created: false,
              report: mapReport(stored),
            });
          }
          const inserted = await client.query<Record<string, unknown>>({
            text: `
              insert into public.community_ai_answer_reports (
                answer_id, reporter_user_id, reason, note,
                create_idempotency_record_id, request_id
              )
              values ($1, $2, $3, $4, $5, $6)
              returning report_id, answer_id, reason, note, created_at
            `,
            values: [
              input.answerId,
              input.ownerUserId,
              input.reason,
              input.note,
              recordId,
              input.requestId,
            ],
          });
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new CommunityAiRepositoryUnavailableError();
          }
          return Object.freeze({ created: true, report: mapReport(row) });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async readPersonaAliases(rawInput): Promise<ReadonlyMap<string, string>> {
      try {
        const input = personaInputSchema.parse(rawInput);
        if (input.ownerUserIds.length === 0) {
          return new Map<string, string>();
        }
        const result = await pool.query<{
          owner_user_id: string;
          alias: string;
        }>({
          text: `
            select owner_user_id, alias
            from public.community_channel_personas
            where community_id = $1 and owner_user_id = any($2::uuid[])
          `,
          values: [input.communityId, [...input.ownerUserIds]],
        });
        return new Map(
          result.rows.map((row) => [row.owner_user_id, row.alias]),
        );
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}
