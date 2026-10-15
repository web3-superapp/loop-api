import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import { decideSquareAdminTransition } from "../src/features/admin/admin-square-posts.js";
import {
  checkSquarePostText,
  mergeSquareFirstPage,
  parseSquareTokenRef,
  projectSquareToken,
  squareBuyCandidates,
  squareReasonCodes,
  type SquareFeedRecord,
  type SquarePostRecord,
  type SquareRepository,
} from "../src/features/square/square-contract.js";
import { createSquareFeedIngest } from "../src/features/square/square-ingest.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
} from "./helpers/admin-role-fakes.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0143: the square timeline's pure rules (text, token refs,
 * first page merge, buy threshold, quote projection, console state
 * machine), the ingest pass, and the App / console routes over a fake
 * repository (auth, 422 / 429 / 409 mapping, cursor binding, capability).
 */

const now = new Date("2026-10-15T12:00:00.000Z");
const at = (offsetMs: number) =>
  new Date(now.getTime() + offsetMs).toISOString();
const memeId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";

function post(overrides: Partial<SquareFeedRecord> = {}): SquareFeedRecord {
  return {
    postId: randomUUID(),
    kind: "opinion",
    status: "published",
    text: "gm",
    tokenRef: null,
    event: null,
    sourceEventId: null,
    pinned: false,
    author: {
      publicProfileId: "33333333-3333-4333-8333-333333333333",
      loopId: "LOOP-ABCDEFGH",
      alias: "pollak",
      avatarRef: null,
    },
    publishedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    likeCount: 0,
    likedByViewer: false,
    token: null,
    ...overrides,
  };
}

describe("square rules (Decision 0143)", () => {
  it("checks post text: trim, 1..500 code points, line feeds only", () => {
    expect(checkSquarePostText("  gm \r\n wagmi ")).toEqual({
      ok: true,
      text: "gm \n wagmi",
    });
    expect(checkSquarePostText("   ")).toEqual({
      ok: false,
      reasonCode: squareReasonCodes.textEmpty,
    });
    expect(checkSquarePostText(undefined)).toMatchObject({ ok: false });
    expect(checkSquarePostText("😀".repeat(500))).toMatchObject({ ok: true });
    expect(checkSquarePostText("x".repeat(501))).toEqual({
      ok: false,
      reasonCode: squareReasonCodes.textTooLong,
    });
    // Emoji ZWJ sequences keep U+200D; tabs, bidi overrides do not pass.
    expect(checkSquarePostText("👩‍💻 shipping")).toMatchObject({
      ok: true,
    });
    for (const bad of ["a\tb", "a‮b", "a b", "a\u0000b"]) {
      expect(checkSquarePostText(bad)).toEqual({
        ok: false,
        reasonCode: squareReasonCodes.textInvalid,
      });
    }
  });

  it("parses token references strictly", () => {
    expect(parseSquareTokenRef({ kind: "meme", id: memeId })).toEqual({
      kind: "meme",
      id: memeId,
    });
    expect(parseSquareTokenRef({ kind: "launch2", id: instanceId })).toEqual({
      kind: "launch2",
      id: instanceId,
    });
    for (const bad of [
      null,
      "x",
      { kind: "asset", id: memeId },
      { kind: "meme", id: "nope" },
      { kind: "meme", id: memeId, extra: 1 },
    ]) {
      expect(parseSquareTokenRef(bad)).toBeNull();
    }
  });

  it("puts at most three pinned posts first, newest first, never twice", () => {
    const pinned = [1, 2, 3, 4].map((hour) =>
      post({
        kind: "system",
        author: null,
        pinned: true,
        publishedAt: at(-hour * 3_600_000),
      }),
    );
    const timeline = [
      post({ publishedAt: at(-1) }),
      post({ publishedAt: at(-2) }),
    ];
    const page = mergeSquareFirstPage([...pinned].reverse(), [
      ...timeline,
      pinned[0] as SquareFeedRecord,
    ]);
    expect(page.map((item) => item.postId)).toEqual([
      pinned[0]?.postId,
      pinned[1]?.postId,
      pinned[2]?.postId,
      timeline[0]?.postId,
      timeline[1]?.postId,
    ]);
  });

  it("keeps member buys whose stable side paid at least 10", () => {
    const row = (quote: string, decimals = 18) => ({
      sourceEventId: `buy:${quote}`,
      authorUserId: s7AccountId,
      occurredAt: now.toISOString(),
      tokenRef: null,
      quoteAmountRaw: quote,
      quoteDecimals: decimals,
      baseAmountRaw: "-5000000000000000000000",
      baseDecimals: 18,
      transactionHash: `0x${"a".repeat(64)}`,
    });
    const kept = squareBuyCandidates([
      row("9999999999999999999"),
      row("10000000000000000000"),
      row("-12500000"),
      row("12500000", 6),
    ]);
    expect(kept.map((candidate) => candidate.event["amountUsd1"])).toEqual([
      "10",
      "12.5",
    ]);
    expect(kept[0]).toMatchObject({
      kind: "buy",
      event: { tokenAmount: "5000" },
    });
  });

  it("projects quotes from the read models only", () => {
    const base = "https://api.loop.test";
    // A fresh MEME v1 curve: the opening price, 0 % change.
    expect(
      projectSquareToken(
        {
          kind: "meme",
          id: memeId,
          symbol: "AI",
          imageMediaId: memeId,
          status: "trading",
          vUsd1: "6000000000000000000000",
          vToken: "1073000000000000000000000000",
          price1hAgoE18: null,
        },
        base,
      ),
    ).toMatchObject({
      kind: "meme",
      memeTokenId: memeId,
      instanceId: null,
      logoUrl: `${base}/v2/media/${memeId}.webp`,
      change1hPct: "0.00",
    });
    expect(
      projectSquareToken(
        {
          kind: "meme",
          id: memeId,
          symbol: "AI",
          imageMediaId: null,
          status: "graduated",
          vUsd1: "1",
          vToken: "1",
          price1hAgoE18: null,
        },
        base,
      ),
    ).toMatchObject({
      priceUsd1: null,
      change1hPct: null,
      marketCapUsd1: null,
    });
    expect(
      projectSquareToken(
        {
          kind: "launch2",
          id: instanceId,
          symbol: "STFY",
          logoUrl: null,
          graduated: false,
          curvePriceE18: "2000000000000000",
          poolLastPriceE18: null,
          poolPrice1hAgoE18: null,
        },
        base,
      ),
    ).toEqual({
      kind: "launch2",
      memeTokenId: null,
      instanceId,
      symbol: "STFY",
      logoUrl: null,
      priceUsd1: "0.002",
      change1hPct: null,
      marketCapUsd1: "2000000",
    });
    expect(
      projectSquareToken(
        {
          kind: "launch2",
          id: instanceId,
          symbol: "STFY",
          logoUrl: null,
          graduated: true,
          curvePriceE18: "2000000000000000",
          poolLastPriceE18: "3000000000000000",
          poolPrice1hAgoE18: "2000000000000000",
        },
        base,
      ),
    ).toMatchObject({ priceUsd1: "0.003", change1hPct: "50.00" });
  });

  it("decides the console state machine", () => {
    const system = (status: SquarePostRecord["status"]) =>
      post({ kind: "system", author: null, status });
    expect(decideSquareAdminTransition("publish", system("draft"))).toEqual({
      kind: "write",
      fields: null,
      status: "published",
    });
    for (const status of ["published", "archived"] as const) {
      expect(decideSquareAdminTransition("publish", system(status))).toEqual({
        kind: "refuse",
        reasonCode: squareReasonCodes.statusConflict,
      });
    }
    expect(decideSquareAdminTransition("archive", system("archived"))).toEqual({
      kind: "refuse",
      reasonCode: squareReasonCodes.statusConflict,
    });
    expect(
      decideSquareAdminTransition("update", system("archived"), {
        pinned: true,
      }),
    ).toEqual({ kind: "refuse", reasonCode: squareReasonCodes.statusConflict });
    expect(
      decideSquareAdminTransition("update", system("published"), {
        pinned: true,
      }),
    ).toMatchObject({
      kind: "write",
      status: "published",
      fields: { pinned: true, text: "gm" },
    });
    // User / event posts: the console can only archive them.
    expect(
      decideSquareAdminTransition("update", post(), { text: "x" }),
    ).toEqual({
      kind: "refuse",
      reasonCode: squareReasonCodes.kindConflict,
    });
    expect(decideSquareAdminTransition("publish", post())).toEqual({
      kind: "refuse",
      reasonCode: squareReasonCodes.kindConflict,
    });
    expect(decideSquareAdminTransition("archive", post())).toEqual({
      kind: "write",
      fields: null,
      status: "archived",
    });
  });

  it("ingests buys over the threshold, claims and graduations in one pass", async () => {
    const inserted: string[] = [];
    const repository = {
      listBuyCandidates: vi.fn(() =>
        Promise.resolve([
          {
            sourceEventId: "buy:small",
            authorUserId: s7AccountId,
            occurredAt: now.toISOString(),
            tokenRef: null,
            quoteAmountRaw: "1",
            quoteDecimals: 18,
            baseAmountRaw: "-1",
            baseDecimals: 18,
            transactionHash: `0x${"b".repeat(64)}`,
          },
        ]),
      ),
      listClaimCandidates: vi.fn(() =>
        Promise.resolve([
          {
            kind: "claim" as const,
            sourceEventId: "claim:1",
            authorUserId: s7AccountId,
            occurredAt: now.toISOString(),
            tokenRef: { kind: "launch2" as const, id: instanceId },
            event: { amountUsd1: "10.94" },
          },
        ]),
      ),
      listGraduationCandidates: vi.fn(() => Promise.resolve([])),
      insertEventPosts: vi.fn(
        (input: { readonly posts: readonly { sourceEventId: string }[] }) => {
          inserted.push(...input.posts.map((item) => item.sourceEventId));
          return Promise.resolve(input.posts.length);
        },
      ),
    };
    const ingest = createSquareFeedIngest({
      repository,
      usd1Address: "0xABCDEF0000000000000000000000000000000001",
      now: () => now,
    });
    const result = await ingest.runOnce();
    expect(result).toEqual({
      kind: "completed",
      buyCount: 0,
      claimCount: 1,
      graduationCount: 0,
      insertedCount: 1,
    });
    expect(inserted).toEqual(["claim:1"]);
    expect(repository.listBuyCandidates).toHaveBeenCalledWith({
      since: new Date(now.getTime() - 7 * 86_400_000),
      stableAddresses: [
        "0x55d398326f99059ff775485246999027b3197955",
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        "0xabcdef0000000000000000000000000000000001",
      ],
      limit: 200,
    });
  });
});

function fakeRepository(): SquareRepository & {
  readonly calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const record =
    <T>(name: string, value: (input: unknown) => T) =>
    (input: unknown): Promise<T> => {
      (calls[name] ??= []).push(input);
      return Promise.resolve(value(input));
    };
  const pinned = post({
    kind: "system",
    author: null,
    pinned: true,
    text: "日报",
  });
  const timeline = Array.from({ length: 3 }, (_, index) =>
    post({ publishedAt: at(-(index + 1) * 1000) }),
  );
  return {
    calls,
    listPinned: record("listPinned", () => [pinned]),
    listTimeline: record("listTimeline", (input) => {
      const { before } = input as { before: unknown };
      return before === null ? timeline : timeline.slice(2);
    }),
    getFeedPost: record("getFeedPost", (input) =>
      post({ postId: (input as { postId: string }).postId, text: "hello" }),
    ),
    tokenRefExists: record(
      "tokenRefExists",
      (input) => (input as { id: string }).id === memeId,
    ),
    createOpinion: record("createOpinion", (input) => {
      const { text } = input as { text: string };
      if (text === "too fast") return { status: "rate_limited" as const };
      if (text === "conflict") return { status: "conflict" as const };
      return {
        status: text === "again" ? ("replayed" as const) : ("created" as const),
        postId: (input as { postId: string }).postId,
      };
    }),
    archiveOwnPost: record(
      "archiveOwnPost",
      (input) => (input as { postId: string }).postId === memeId,
    ),
    setLike: record("setLike", (input) =>
      (input as { postId: string }).postId === memeId ? { likeCount: 7 } : null,
    ),
    adminList: record("adminList", () => []),
    adminGet: record("adminGet", (input) => ({
      ...post({ kind: "system", author: null, status: "draft" }),
      postId: input as string,
      likeCount: 0,
    })),
    adminCreate: record("adminCreate", (input) => ({
      status: "created" as const,
      postId: (input as { postId: string }).postId,
      audit: { auditId: randomUUID(), seq: 1, at: now.toISOString() },
    })),
    adminTransition: record("adminTransition", (input) => {
      const { decide } = input as {
        decide: (current: SquarePostRecord) => unknown;
      };
      const decision = decide(
        post({ kind: "system", author: null, status: "published" }),
      ) as { kind: string; reasonCode?: string };
      return decision.kind === "refuse"
        ? {
            status: "refused" as const,
            reasonCode: decision.reasonCode as string,
            current: post({
              kind: "system",
              author: null,
              status: "published",
            }),
          }
        : {
            status: "written" as const,
            audit: { auditId: randomUUID(), seq: 2, at: now.toISOString() },
          };
    }),
    listBuyCandidates: record("listBuyCandidates", () => []),
    listClaimCandidates: record("listClaimCandidates", () => []),
    listGraduationCandidates: record("listGraduationCandidates", () => []),
    insertEventPosts: record("insertEventPosts", () => 0),
  };
}

const accountPassword = "account-password-0123";
let passwordHash = "";
beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
});

describe("square routes (Decision 0143)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(repository: SquareRepository | undefined) {
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const app = await buildApp({
      config: s7TestConfig({
        PUBLIC_BASE_URL: "https://api.loop.test",
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: "s187-admin-session-secret-0123456789abcdef",
      }),
      database: {
        ...s7Database({}),
        admin,
        adminAccounts: accounts,
        adminLaunchReview: createInMemoryAdminLaunchReview([], new Map()),
        hooksLaunchReview: createFakeHooksReview({
          grants: new Map(),
          owners: new Map(),
        }),
        ...(repository === undefined ? {} : { squareFeed: repository }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      walletIntentNow: () => now,
      adminNow: () => now,
      logger: false,
    });
    apps.push(app);
    const cookies = new Map<AdminRole, string>();
    for (const role of ["platform_admin", "auditor"] as const) {
      const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
      await accounts.seed({
        username,
        password: accountPassword,
        role,
        operatorUserId: null,
      });
      const login = await app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username, password: accountPassword },
      });
      expect(login.statusCode, login.body).toBe(200);
      cookies.set(
        role,
        (login.headers["set-cookie"] as string).split(";")[0] as string,
      );
    }
    return { app, cookies };
  }

  it("reports squareFeed and answers 503 without the repository", async () => {
    const { app } = await harness(undefined);
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
      headers: s7CommonHeaders(),
    });
    expect(
      capabilities
        .json<{ capabilities: { capabilityId: string }[] }>()
        .capabilities.find((entry) => entry.capabilityId === "squareFeed"),
    ).toEqual({
      capabilityId: "squareFeed",
      availability: "unavailable",
      reasonCode: "SQUARE_REPOSITORY_UNAVAILABLE",
      evidence: { status: "notApplicable", reasonCode: null },
    });
    const feed = await app.inject({
      method: "GET",
      url: "/v2/square/feed",
      headers: s7CommonHeaders(),
    });
    expect(feed.statusCode).toBe(503);
    expect(feed.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "SQUARE_REPOSITORY_UNAVAILABLE" },
    });
  });

  it("serves the feed: pinned first, cursor bound to the scope", async () => {
    const repository = fakeRepository();
    const { app } = await harness(repository);
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
      headers: s7CommonHeaders(),
    });
    expect(
      capabilities
        .json<{
          capabilities: { capabilityId: string; availability: string }[];
        }>()
        .capabilities.find((entry) => entry.capabilityId === "squareFeed")
        ?.availability,
    ).toBe("available");

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v2/square/feed",
      headers: s7CommonHeaders({ authorization: undefined }),
    });
    expect(unauthenticated.statusCode).toBe(401);

    const first = await app.inject({
      method: "GET",
      url: "/v2/square/feed?limit=2",
      headers: s7CommonHeaders(),
    });
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json<{
      scope: string;
      items: { kind: string; pinned: boolean; text: string }[];
      nextCursor: string | null;
    }>();
    expect(body.scope).toBe("global");
    expect(body.items.map((item) => item.pinned)).toEqual([true, false, false]);
    expect(body.items[0]).toMatchObject({ kind: "system", text: "日报" });
    expect(body.nextCursor).not.toBeNull();
    expect(repository.calls["listTimeline"]?.[0]).toMatchObject({
      viewerUserId: s7AccountId,
      scope: "global",
      before: null,
      limit: 3,
    });

    const second = await app.inject({
      method: "GET",
      url: `/v2/square/feed?cursor=${body.nextCursor ?? ""}`,
      headers: s7CommonHeaders(),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ items: unknown[]; nextCursor: null }>()).toMatchObject(
      {
        nextCursor: null,
      },
    );
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(repository.calls["listPinned"]).toHaveLength(1);

    for (const url of [
      `/v2/square/feed?scope=following&cursor=${body.nextCursor ?? ""}`,
      `/v2/square/feed?limit=2&cursor=${body.nextCursor ?? ""}`,
      "/v2/square/feed?limit=31",
      "/v2/square/feed?scope=everyone",
    ]) {
      const refused = await app.inject({
        method: "GET",
        url,
        headers: s7CommonHeaders(),
      });
      expect(refused.statusCode, url).toBe(400);
    }
  });

  it("creates posts with 201 / 200 replay and maps 422, 429, 409", async () => {
    const repository = fakeRepository();
    const { app } = await harness(repository);
    const create = (payload: unknown, headers = s7CommandHeaders()) =>
      app.inject({
        method: "POST",
        url: "/v2/square/posts",
        headers,
        payload: payload as Record<string, unknown>,
      });
    const created = await create({
      text: "  I will buy as much $STFY as I can ",
      tokenRef: { kind: "meme", id: memeId },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      post: { kind: "opinion", text: "hello" },
      contractVersion: "2.0",
    });
    expect(repository.calls["createOpinion"]?.[0]).toMatchObject({
      authorUserId: s7AccountId,
      text: "I will buy as much $STFY as I can",
      tokenRef: { kind: "meme", id: memeId },
      postsPerMinute: 5,
      windowMs: 60_000,
    });
    expect((await create({ text: "again" })).statusCode).toBe(200);

    for (const [payload, reasonCode] of [
      [{ text: " " }, squareReasonCodes.textEmpty],
      [{ text: "x".repeat(501) }, squareReasonCodes.textTooLong],
      [
        { text: "x", tokenRef: { kind: "launch2", id: instanceId } },
        squareReasonCodes.tokenRefInvalid,
      ],
      [
        { text: "x", tokenRef: { kind: "meme", id: "nope" } },
        squareReasonCodes.tokenRefInvalid,
      ],
    ] as const) {
      const refused = await create(payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: { reasonCode },
      });
    }
    const limited = await create({ text: "too fast" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      code: "RATE_LIMITED",
      detailsSafe: { reasonCode: squareReasonCodes.rateLimited },
    });
    expect((await create({ text: "conflict" })).json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect((await create({ text: "x" }, s7CommonHeaders())).statusCode).toBe(
      400,
    );
    expect((await create({ text: "x", kind: "system" })).statusCode).toBe(400);
  });

  it("deletes own posts and toggles likes", async () => {
    const repository = fakeRepository();
    const { app } = await harness(repository);
    const removed = await app.inject({
      method: "DELETE",
      url: `/v2/square/posts/${memeId}`,
      headers: s7CommandHeaders(),
    });
    expect(removed.statusCode).toBe(204);
    const foreign = await app.inject({
      method: "DELETE",
      url: `/v2/square/posts/${instanceId}`,
      headers: s7CommandHeaders(),
    });
    expect(foreign.statusCode).toBe(404);
    const liked = await app.inject({
      method: "PUT",
      url: `/v2/square/posts/${memeId}/like`,
      headers: s7CommandHeaders(),
    });
    expect(liked.statusCode).toBe(200);
    expect(liked.json()).toEqual({
      postId: memeId,
      likeCount: 7,
      likedByViewer: true,
      contractVersion: "2.0",
    });
    const unliked = await app.inject({
      method: "DELETE",
      url: `/v2/square/posts/${memeId}/like`,
      headers: s7CommandHeaders(),
    });
    expect(unliked.json()).toMatchObject({ likedByViewer: false });
    expect(repository.calls["setLike"]).toEqual([
      { postId: memeId, userId: s7AccountId, liked: true },
      { postId: memeId, userId: s7AccountId, liked: false },
    ]);
    const missing = await app.inject({
      method: "PUT",
      url: `/v2/square/posts/${instanceId}/like`,
      headers: s7CommandHeaders(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("guards the console routes and maps refused transitions to 409", async () => {
    const repository = fakeRepository();
    const { app, cookies } = await harness(repository);
    const call = (
      role: AdminRole | null,
      method: "GET" | "POST" | "PATCH",
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: role === null ? {} : { cookie: cookies.get(role) as string },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const base = "/admin/v1/square/posts";
    expect((await call(null, "POST", base, { text: "日报" })).statusCode).toBe(
      401,
    );
    expect(
      (await call("auditor", "POST", base, { text: "日报" })).statusCode,
    ).toBe(403);
    expect((await call("auditor", "GET", base)).statusCode).toBe(200);
    const created = await call("platform_admin", "POST", base, {
      text: "12h 日报",
      pinned: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      post: { kind: "system", author: null },
      replayed: false,
    });
    expect(repository.calls["adminCreate"]?.[0]).toMatchObject({
      fields: { text: "12h 日报", tokenRef: null, pinned: true },
    });
    expect(
      (repository.calls["adminCreate"]?.[0] as { audit: { actor: string } })
        .audit.actor,
    ).toMatch(/^platform-admin-/u);
    const empty = await call("platform_admin", "POST", base, { text: "" });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({
      detailsSafe: { reasonCode: squareReasonCodes.textEmpty, field: "text" },
    });
    // The fake row is published: publishing again is a status conflict.
    const again = await call(
      "platform_admin",
      "POST",
      `${base}/${memeId}/publish`,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: {
        reasonCode: squareReasonCodes.statusConflict,
        status: "published",
      },
    });
    const patched = await call("platform_admin", "PATCH", `${base}/${memeId}`, {
      pinned: false,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      (await call("platform_admin", "PATCH", `${base}/${memeId}`, {}))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("platform_admin", "GET", `${base}/not-a-uuid`)).statusCode,
    ).toBe(404);
  });
});
