import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresCommunityAiRepository } from "../src/database/community-ai-repository.js";
import {
  askDigest,
  reportDigest,
} from "../src/features/community-ai/community-ai-contract.js";
import {
  CommunityAiAnswerNotFoundError,
  CommunityAiIdempotencyConflictError,
  CommunityAiQuotaExceededError,
} from "../src/features/community-ai/community-ai-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: requireIntegrationDatabaseUrl() });
const testPrivyPrefix = "community-ai-test:";
const repository = createPostgresCommunityAiRepository(pool);

async function cleanFixtures(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  const values = [`${testPrivyPrefix}%`];
  await pool.query(
    `alter table public.community_ai_answer_reports disable trigger community_ai_answer_reports_immutable`,
  );
  await pool.query(
    `alter table public.community_ai_answers disable trigger community_ai_answers_immutable`,
  );
  await pool.query(
    `alter table public.community_ai_usage disable trigger community_ai_usage_guard_mutation`,
  );
  await pool.query(
    `alter table public.community_channel_personas disable trigger community_channel_personas_guard`,
  );
  try {
    await pool.query({
      text: `delete from public.community_ai_answer_reports where reporter_user_id in (${owners})`,
      values,
    });
    for (const table of ["community_ai_answers", "community_ai_usage"]) {
      await pool.query({
        text: `delete from public.${table} where owner_user_id in (${owners})`,
        values,
      });
    }
    await pool.query({
      text: `delete from public.community_channel_personas where owner_user_id in (${owners})`,
      values,
    });
    await pool.query({
      text: `delete from public.idempotency_records where owner_user_id in (${owners})`,
      values,
    });
    await pool.query({
      text: `delete from public.communities where created_by_user_id in (${owners})`,
      values,
    });
    await pool.query({
      text: `delete from public.loop_users where privy_user_id like $1`,
      values,
    });
  } finally {
    await pool.query(
      `alter table public.community_channel_personas enable trigger community_channel_personas_guard`,
    );
    await pool.query(
      `alter table public.community_ai_usage enable trigger community_ai_usage_guard_mutation`,
    );
    await pool.query(
      `alter table public.community_ai_answers enable trigger community_ai_answers_immutable`,
    );
    await pool.query(
      `alter table public.community_ai_answer_reports enable trigger community_ai_answer_reports_immutable`,
    );
  }
}

async function createOwner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${testPrivyPrefix}${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("owner insert returned no id");
  }
  return id;
}

async function createCommunity(ownerUserId: string): Promise<string> {
  const slug = `ai-${randomUUID().slice(0, 12)}`;
  const result = await pool.query<{ community_id: string }>({
    text: `
      insert into public.communities (name, slug, created_by_user_id)
      values ($1, $2, $3)
      returning community_id
    `,
    values: ["AI Test Community", slug, ownerUserId],
  });
  const id = result.rows[0]?.community_id;
  if (id === undefined) {
    throw new Error("community insert returned no id");
  }
  return id;
}

const citation = Object.freeze({
  sourceId: "s1",
  kind: "communityProfile" as const,
  label: "社区档案：AI Test Community",
  observedAt: "2026-09-22T03:00:00.000Z",
});

async function storeAnswer(
  communityId: string,
  ownerUserId: string,
  question = "社区有多少人",
) {
  const requestSha256 = askDigest({ communityId, question });
  const begun = await repository.beginAsk({
    communityId,
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256,
    requestId: randomUUID(),
    userLimitPerMinute: 6,
    communityDailyLimit: 200,
  });
  if (begun.kind !== "reserved") {
    throw new Error("expected a reservation");
  }
  return repository.completeAsk({
    idempotencyRecordId: begun.idempotencyRecordId,
    usageId: begun.usageId,
    communityId,
    ownerUserId,
    requestSha256,
    question,
    answer: "社区现有 42 名成员 [s1]。",
    refusal: null,
    citations: [citation],
    model: "claude-sonnet-5",
    inputTokens: 120,
    outputTokens: 40,
  });
}

describe("community AI repository (migration 000036)", () => {
  beforeAll(cleanFixtures);
  afterEach(cleanFixtures);
  afterAll(async () => {
    await pool.end();
  });

  it("stores an answer with its citations and settles the reserved quota row", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    const answer = await storeAnswer(communityId, owner);

    expect(answer.answer).toBe("社区现有 42 名成员 [s1]。");
    expect(answer.citations).toEqual([citation]);
    expect(answer.model).toBe("claude-sonnet-5");
    expect(answer.inputTokens).toBe(120);

    const usage = await pool.query<{ status: string; kind: string }>({
      text: `select status, kind from public.community_ai_usage where owner_user_id = $1`,
      values: [owner],
    });
    expect(usage.rows).toEqual([{ status: "completed", kind: "ask" }]);
  });

  it("replays the same key and question, and conflicts on a different question", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    const question = "怎么参与挖矿";
    const key = randomUUID();
    const requestSha256 = askDigest({ communityId, question });
    const first = await repository.beginAsk({
      communityId,
      ownerUserId: owner,
      idempotencyKey: key,
      requestSha256,
      requestId: randomUUID(),
      userLimitPerMinute: 6,
      communityDailyLimit: 200,
    });
    if (first.kind !== "reserved") {
      throw new Error("expected a reservation");
    }
    const stored = await repository.completeAsk({
      idempotencyRecordId: first.idempotencyRecordId,
      usageId: first.usageId,
      communityId,
      ownerUserId: owner,
      requestSha256,
      question,
      answer: "先绑定钱包 [s1]。",
      refusal: null,
      citations: [citation],
      model: "claude-sonnet-5",
      inputTokens: 90,
      outputTokens: 30,
    });

    const replay = await repository.beginAsk({
      communityId,
      ownerUserId: owner,
      idempotencyKey: key,
      requestSha256,
      requestId: randomUUID(),
      userLimitPerMinute: 6,
      communityDailyLimit: 200,
    });
    expect(replay).toEqual({ kind: "replay", answer: stored });

    await expect(
      repository.beginAsk({
        communityId,
        ownerUserId: owner,
        idempotencyKey: key,
        requestSha256: askDigest({ communityId, question: "另一个问题" }),
        requestId: randomUUID(),
        userLimitPerMinute: 6,
        communityDailyLimit: 200,
      }),
    ).rejects.toBeInstanceOf(CommunityAiIdempotencyConflictError);

    // The conflicting attempt spent no quota: only the first call reserved.
    const usage = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.community_ai_usage where owner_user_id = $1`,
      values: [owner],
    });
    expect(usage.rows[0]?.count).toBe("1");
  });

  it("refuses the request that would exceed the per-account minute quota", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    await storeAnswer(communityId, owner, "第一问");

    await expect(
      repository.beginAsk({
        communityId,
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: askDigest({ communityId, question: "第二问" }),
        requestId: randomUUID(),
        userLimitPerMinute: 1,
        communityDailyLimit: 200,
      }),
    ).rejects.toMatchObject({ scope: "user" });
  });

  it("refuses the request that would exceed the community daily quota", async () => {
    const owner = await createOwner();
    const other = await createOwner();
    const communityId = await createCommunity(owner);
    await storeAnswer(communityId, owner, "第一问");

    await expect(
      repository.beginAsk({
        communityId,
        ownerUserId: other,
        idempotencyKey: randomUUID(),
        requestSha256: askDigest({ communityId, question: "第二问" }),
        requestId: randomUUID(),
        userLimitPerMinute: 6,
        communityDailyLimit: 1,
      }),
    ).rejects.toBeInstanceOf(CommunityAiQuotaExceededError);
  });

  it("keeps a failed model call charged against the budget", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    const reserved = await repository.reserveBrief({
      communityId,
      ownerUserId: owner,
      requestId: randomUUID(),
      userLimitPerMinute: 6,
      communityDailyLimit: 200,
    });
    await repository.settleUsage({
      usageId: reserved.usageId,
      status: "failed",
      model: "claude-sonnet-5",
      inputTokens: null,
      outputTokens: null,
    });

    const usage = await pool.query<{ status: string; kind: string }>({
      text: `select status, kind from public.community_ai_usage where usage_id = $1`,
      values: [reserved.usageId],
    });
    expect(usage.rows).toEqual([{ status: "failed", kind: "brief" }]);
    await expect(
      repository.beginAsk({
        communityId,
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: askDigest({ communityId, question: "还能问吗" }),
        requestId: randomUUID(),
        userLimitPerMinute: 6,
        communityDailyLimit: 1,
      }),
    ).rejects.toMatchObject({ scope: "community" });
  });

  it("records one report per answer and per reporter", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    const answer = await storeAnswer(communityId, owner);
    const key = randomUUID();
    const input = {
      answerId: answer.answerId,
      communityId,
      ownerUserId: owner,
      reason: "inaccurate" as const,
      note: "价格不对",
      idempotencyKey: key,
      requestSha256: reportDigest({
        answerId: answer.answerId,
        reason: "inaccurate",
        note: "价格不对",
      }),
      requestId: randomUUID(),
    };
    const created = await repository.reportAnswer(input);
    expect(created.created).toBe(true);
    expect(created.report.reason).toBe("inaccurate");

    const replay = await repository.reportAnswer(input);
    expect(replay.created).toBe(false);
    expect(replay.report.reportId).toBe(created.report.reportId);

    const rows = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.community_ai_answer_reports where answer_id = $1`,
      values: [answer.answerId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("does not let an account report another account's answer", async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const communityId = await createCommunity(owner);
    const answer = await storeAnswer(communityId, owner);

    await expect(
      repository.reportAnswer({
        answerId: answer.answerId,
        communityId,
        ownerUserId: stranger,
        reason: "harmful",
        note: null,
        idempotencyKey: randomUUID(),
        requestSha256: reportDigest({
          answerId: answer.answerId,
          reason: "harmful",
          note: null,
        }),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityAiAnswerNotFoundError);
  });

  it("refuses to change a stored answer", async () => {
    const owner = await createOwner();
    const communityId = await createCommunity(owner);
    const answer = await storeAnswer(communityId, owner);

    await expect(
      pool.query({
        text: `update public.community_ai_answers set answer = $2 where answer_id = $1`,
        values: [answer.answerId, "rewritten"],
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("resolves only the personas of the community it was asked about", async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const communityId = await createCommunity(owner);
    const otherCommunityId = await createCommunity(owner);
    await pool.query({
      text: `
        insert into public.community_channel_personas (community_id, owner_user_id, alias)
        values ($1, $2, $3), ($4, $5, $6)
      `,
      values: [
        communityId,
        owner,
        "Otter-1234",
        otherCommunityId,
        stranger,
        "Panda-5678",
      ],
    });

    const aliases = await repository.readPersonaAliases({
      communityId,
      ownerUserIds: [owner, stranger],
    });
    expect([...aliases.entries()]).toEqual([[owner, "Otter-1234"]]);
    expect(
      await repository.readPersonaAliases({ communityId, ownerUserIds: [] }),
    ).toEqual(new Map());
  });
});
