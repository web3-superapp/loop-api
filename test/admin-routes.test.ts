import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  adminArgon2InFlight,
  hashAdminPassword,
} from "../src/features/admin/admin-auth.js";
import { adminErrorCodes } from "../src/features/admin/admin-contract.js";
import { AdminRepositoryUnavailableError } from "../src/features/admin/admin-repository.js";
import type {
  CommunityRepository,
  CommunityReviewRecord,
} from "../src/features/community/community-repository.js";
import type { MemePauseSender } from "../src/integrations/meme/meme-pause-sender.js";
import {
  adminCommunityFixture,
  adminFormulaFixture,
  adminLaunch2InstanceFixture,
  adminMemeFixture,
  createInMemoryAdminRepository,
  fakeMemePauseSender,
  type InMemoryAdminRepository,
} from "./helpers/admin-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0102 route contract: mounting, login and lockout, the session
 * cookie, the seven-field error envelope with console codes, and one audit
 * row per write on every write route.
 */

const password = "correct-horse-battery-staple";
const sessionSecret = "s119-admin-session-secret-0123456789abcdef";
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashAdminPassword(password);
});

function adminEnv(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ADMIN_USERNAME: "operator",
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: sessionSecret,
    ...extra,
  };
}

function fakeCommunityRepository(
  communities: InMemoryAdminRepository["communities"],
): CommunityRepository {
  const review = (
    status: "verified" | "rejected",
    input: { readonly communityId: string; readonly reason?: string },
  ): Promise<CommunityReviewRecord> => {
    const current = communities.get(input.communityId);
    if (current === undefined) {
      return Promise.reject(
        Object.assign(new Error("missing"), { code: "community_not_found" }),
      );
    }
    if (status === "rejected" && current.verificationStatus === "verified") {
      return Promise.reject(
        Object.assign(new Error("stale"), { code: "community_data_stale" }),
      );
    }
    const changed = current.verificationStatus !== status;
    communities.set(input.communityId, {
      ...current,
      verificationStatus: status,
      rejectedReason: status === "rejected" ? (input.reason ?? null) : null,
    });
    return Promise.resolve({
      community: {
        communityId: input.communityId,
        verificationStatus: status,
      },
      ownerUserId: null,
      eventId: changed ? randomUUID() : null,
      changed,
    } as unknown as CommunityReviewRecord);
  };
  return {
    verifyCommunity: (input: { readonly communityId: string }) =>
      review("verified", input),
    rejectCommunity: (input: {
      readonly communityId: string;
      readonly reason: string;
    }) => review("rejected", input),
  } as unknown as CommunityRepository;
}

describe("Operator console routes (Decision 0102)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly configured?: boolean;
      readonly repository?: InMemoryAdminRepository;
      readonly memePauseSender?: MemePauseSender | null;
      readonly clock?: { now: number };
      readonly modules?: string;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryAdminRepository();
    const clock = options.clock ?? { now: Date.now() };
    const app = await buildApp({
      config: s7TestConfig({
        V2_MODULES_ENABLED: options.modules ?? "launch,mining,referral",
        ...(options.configured === false ? {} : adminEnv()),
        ...options.env,
      }),
      database: {
        ...s7Database({}),
        admin: repository,
        community: fakeCommunityRepository(repository.communities),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender:
        options.memePauseSender === undefined ? null : options.memePauseSender,
      adminNow: () => new Date(clock.now),
      logger: false,
    });
    apps.push(app);
    return { app, repository, clock };
  }

  async function login(app: FastifyInstance): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "operator", password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.headers["set-cookie"];
    expect(typeof cookie).toBe("string");
    return (cookie as string).split(";")[0] as string;
  }

  function expectError(
    response: { statusCode: number; json: () => unknown },
    status: number,
    code: string,
  ): Record<string, unknown> {
    expect(response.statusCode).toBe(status);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(errorKeys);
    expect(body["code"]).toBe(code);
    expect(adminErrorCodes).toContain(body["code"]);
    return body;
  }

  it("is not mounted without all three ADMIN_* values", async () => {
    const { app } = await createApp({ configured: false });
    for (const [method, url] of [
      ["POST", "/admin/v1/session"],
      ["GET", "/admin/v1/overview"],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "not_found" });
    }
    const partial = await createApp({
      configured: false,
      env: { ADMIN_USERNAME: "operator", ADMIN_SESSION_SECRET: sessionSecret },
    });
    const response = await partial.app.inject({
      method: "GET",
      url: "/admin/v1/overview",
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a malformed password hash at boot", () => {
    expect(() =>
      s7TestConfig(adminEnv({ ADMIN_PASSWORD_HASH: "plain-text-password" })),
    ).toThrow(/ADMIN_PASSWORD_HASH/u);
  });

  it("requires the session cookie on every protected route", async () => {
    const { app } = await createApp();
    await app.ready();
    const document = app.swagger() as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    let checked = 0;
    for (const [path, operations] of Object.entries(document.paths)) {
      if (!path.startsWith("/admin/v1/")) {
        continue;
      }
      for (const [method, operation] of Object.entries(operations)) {
        if (operation.security === undefined || method === "delete") {
          continue;
        }
        const url = path
          .replace("{communityId}", randomUUID())
          .replace("{memeTokenId}", randomUUID())
          .replace("{configVersion}", "v1");
        const response = await app.inject({
          method: method.toUpperCase() as "GET",
          url,
          headers: { cookie: "loop_admin_session=forged.value" },
          ...(method === "get" ? {} : { payload: {} }),
        });
        expectError(response, 401, "ADMIN_SESSION_REQUIRED");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(17);
  });

  it("logs in with a signed HttpOnly SameSite=Strict cookie and logs out", async () => {
    const { app, repository } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "operator", password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookie = response.headers["set-cookie"] as string;
    expect(cookie).toMatch(
      /^loop_admin_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/u,
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("Max-Age=43200");
    const body = response.json<Record<string, string>>();
    expect(body["actor"]).toBe("operator");
    expect(
      Date.parse(body["expiresAt"] as string) -
        Date.parse(body["issuedAt"] as string),
    ).toBe(12 * 3600 * 1000);
    const session = cookie.split(";")[0] as string;
    const me = await app.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { cookie: session },
    });
    expect(me.statusCode).toBe(200);
    const out = await app.inject({
      method: "DELETE",
      url: "/admin/v1/session",
      headers: { cookie: session },
    });
    expect(out.statusCode).toBe(204);
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
    const after = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: session },
    });
    expectError(after, 401, "ADMIN_SESSION_REQUIRED");
    expect(repository.audit.map((row) => row.action)).toEqual([
      "session.login",
      "session.logout",
    ]);
  });

  it("locks the login name for 15 minutes after five failures, never another name (Decision 0110)", async () => {
    const clock = { now: Date.parse("2026-10-08T00:00:00.000Z") };
    const { app, repository } = await createApp({ clock });
    const attempt = (secret: string, username = "operator") =>
      app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username, password: secret },
      });
    for (let index = 0; index < 4; index += 1) {
      expectError(
        await attempt("wrong-password-123"),
        401,
        "ADMIN_LOGIN_INVALID",
      );
    }
    const fifth = await attempt("wrong-password-123");
    const body = expectError(fifth, 423, "ADMIN_LOGIN_LOCKED");
    expect(body["category"]).toBe("rateLimit");
    expect(body["detailsSafe"]).toEqual({
      scope: "username",
      retryAfterSeconds: 900,
    });
    expect(fifth.headers["retry-after"]).toBe("900");
    // The right password is refused while the name is locked, in any case.
    expectError(await attempt(password), 423, "ADMIN_LOGIN_LOCKED");
    expectError(await attempt(password, "OPERATOR"), 423, "ADMIN_LOGIN_LOCKED");
    // Another name is not locked (Decision 0110).
    expectError(
      await attempt(password, "intruder"),
      401,
      "ADMIN_LOGIN_INVALID",
    );
    clock.now += 15 * 60 * 1000;
    expect((await attempt(password)).statusCode).toBe(200);
    const failed = repository.audit.filter(
      (row) => row.action === "session.login_failed",
    );
    expect(failed).toHaveLength(6);
    expect(failed[4]?.after).toMatchObject({
      locked: true,
      lockScope: "username",
      username: "operator",
      usernameFailures: 5,
    });
    // An unknown name is never written down.
    expect(failed[5]?.after).toMatchObject({ locked: false, username: null });
    const locks = repository.audit.filter(
      (row) => row.action === "session.login_locked",
    );
    expect(locks).toHaveLength(1);
    expect(locks[0]?.after).toMatchObject({
      scope: "username",
      retryAfterSeconds: 900,
      username: "operator",
    });
  });

  it("holds the lock under 200 concurrent logins and verifies one at a time (Decision 0105)", async () => {
    const clock = { now: Date.parse("2026-10-08T00:00:00.000Z") };
    const { app, repository } = await createApp({ clock });
    const attempt = (secret: string) =>
      app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username: "operator", password: secret },
      });
    const statuses = new Map<number, number>();
    let waves = 0;
    while ((statuses.get(423) ?? 0) === 0 && waves < 20) {
      waves += 1;
      const responses = await Promise.all(
        Array.from({ length: 200 }, () => attempt("wrong-password-123")),
      );
      // One verification per wave; everything else is refused before argon2.
      const verified = responses.filter(
        (response) => response.statusCode !== 429,
      );
      expect(verified).toHaveLength(1);
      for (const response of responses) {
        statuses.set(
          response.statusCode,
          (statuses.get(response.statusCode) ?? 0) + 1,
        );
        if (response.statusCode === 429) {
          const body = expectError(response, 429, "ADMIN_LOGIN_BUSY");
          expect(body["detailsSafe"]).toEqual({ retryAfterSeconds: 1 });
          expect(response.headers["retry-after"]).toBe("1");
        }
      }
    }
    // Exactly five failures were ever verified: four 401s, then the lock.
    expect(waves).toBe(5);
    expect(statuses.get(401)).toBe(4);
    expect(statuses.get(423)).toBe(1);
    expect(adminArgon2InFlight()).toBe(0);
    expect(
      repository.audit.filter((row) => row.action === "session.login_failed"),
    ).toHaveLength(5);
    // Locked: 200 more concurrent attempts, the right password included,
    // are all 423 and none reaches argon2.
    const locked = await Promise.all([
      ...Array.from({ length: 199 }, () => attempt("wrong-password-123")),
      attempt(password),
    ]);
    expect(new Set(locked.map((response) => response.statusCode))).toEqual(
      new Set([423]),
    );
    expect(
      repository.audit.filter((row) => row.action === "session.login_failed"),
    ).toHaveLength(5);
  });

  it("expires the session after 12 hours and refuses a forged one", async () => {
    const clock = { now: Date.parse("2026-10-08T00:00:00.000Z") };
    const { app } = await createApp({ clock });
    const session = await login(app);
    const [name, value] = session.split("=") as [string, string];
    const [payload] = value.split(".") as [string];
    const forged = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: `${name}=${payload}.AAAA` },
    });
    expectError(forged, 401, "ADMIN_SESSION_REQUIRED");
    clock.now += 12 * 3600 * 1000;
    const expired = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: session },
    });
    expectError(expired, 401, "ADMIN_SESSION_REQUIRED");
  });

  it("serves the overview with the latest audit rows", async () => {
    const { app } = await createApp();
    const cookie = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      accounts: 7,
      pendingReviews: 1,
      voiceRooms: { live: 1, participants: 4 },
    });
    expect((body["recentAudit"] as unknown[]).length).toBe(1);
    expect(body["indexerLanes"]).toEqual([
      expect.objectContaining({ lane: "meme_event", lastBlockNumber: "123" }),
    ]);
  });

  it("replaces the recommended communities with CAS and an audit row", async () => {
    const envId = "11111111-1111-4111-8111-111111111111";
    const { app, repository } = await createApp({
      env: { RECOMMENDED_COMMUNITY_IDS: envId },
    });
    const verified = adminCommunityFixture();
    const pending = adminCommunityFixture({ verificationStatus: "pending" });
    repository.communities.set(verified.communityId, verified);
    repository.communities.set(pending.communityId, pending);
    const cookie = await login(app);
    const read = await app.inject({
      method: "GET",
      url: "/admin/v1/settings/recommended-communities",
      headers: { cookie },
    });
    expect(read.json()).toMatchObject({
      source: "environment",
      communityIds: [envId],
      updatedAt: null,
    });
    const put = (body: Record<string, unknown>) =>
      app.inject({
        method: "PUT",
        url: "/admin/v1/settings/recommended-communities",
        headers: { cookie },
        payload: body,
      });
    const refused = await put({
      communityIds: [pending.communityId],
      updatedAt: null,
    });
    expect(
      expectError(refused, 422, "VALIDATION_FAILED")["detailsSafe"],
    ).toEqual({
      reasonCode: "ADMIN_COMMUNITY_NOT_VERIFIED",
      communityId: pending.communityId,
    });
    const auditBefore = repository.audit.length;
    const saved = await put({
      communityIds: [verified.communityId],
      updatedAt: null,
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json<Record<string, unknown>>();
    expect(savedBody).toMatchObject({
      source: "database",
      communityIds: [verified.communityId],
      updatedBy: "operator",
    });
    expect(repository.audit.length).toBe(auditBefore + 1);
    expect(repository.audit.at(-1)).toMatchObject({
      action: "settings.recommended_communities.update",
      targetType: "setting",
    });
    expect(savedBody["audit"]).toMatchObject({ seq: repository.audit.length });
    const stale = await put({
      communityIds: [verified.communityId],
      updatedAt: null,
    });
    expect(
      expectError(stale, 409, "ADMIN_CONFLICT")["detailsSafe"],
    ).toMatchObject({ reasonCode: "ADMIN_UPDATED_AT_MISMATCH" });
    const cleared = await put({
      communityIds: null,
      updatedAt: savedBody["updatedAt"],
    });
    expect(cleared.json()).toMatchObject({
      source: "environment",
      communityIds: [envId],
    });
    expect(repository.audit.length).toBe(auditBefore + 2);
  });

  it("validates and replaces the intel promotion cards", async () => {
    const { app, repository } = await createApp({ modules: "market" });
    const cookie = await login(app);
    const initial = await app.inject({
      method: "GET",
      url: "/admin/v1/settings/intel-promotions",
      headers: { cookie },
    });
    expect(initial.json()).toMatchObject({
      source: "constant",
      configVersion: "intelPromotionsV1",
      maximumItems: 20,
    });
    const card = {
      title: "社区周赛",
      subtitle: "本周算力榜",
      imageUrl: null,
      deeplink: "/meme",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      order: 1,
    };
    const put = (items: unknown, updatedAt: unknown = null) =>
      app.inject({
        method: "PUT",
        url: "/admin/v1/settings/intel-promotions",
        headers: { cookie },
        payload: { items, updatedAt },
      });
    const bad = await put([
      card,
      { ...card, deeplink: "https://evil.example" },
    ]);
    expect(expectError(bad, 422, "VALIDATION_FAILED")["detailsSafe"]).toEqual({
      reasonCode: "ADMIN_PROMOTION_INVALID",
      index: 1,
    });
    const saved = await put([card]);
    expect(saved.statusCode).toBe(200);
    const body = saved.json<Record<string, unknown>>();
    expect(body["source"]).toBe("database");
    expect(body["configVersion"]).toMatch(/^intelPromotionsV1\+db\.[0-9]+$/u);
    expect(body["effectiveAt"]).toBe(body["updatedAt"]);
    expect((body["items"] as { id: string }[])[0]?.id).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(repository.audit.at(-1)?.action).toBe(
      "settings.intel_promotions.update",
    );
    // The App reads the console list at once (same process invalidation).
    const v2 = await app.inject({
      method: "GET",
      url: "/v2/intel/promotions",
      headers: s7CommonHeaders(),
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toMatchObject({
      configVersion: body["configVersion"],
      items: [
        expect.objectContaining({ title: "社区周赛", deeplink: "/meme" }),
      ],
    });
  });

  it("filters promotion text and allow-lists image hosts (Decision 0105)", async () => {
    const card = {
      title: "社区周赛",
      subtitle: "本周算力榜",
      imageUrl: null as string | null,
      deeplink: "/meme",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      order: 1,
    };
    const imageUrl = "https://cdn.loop.example/promo/week.png";
    // Without INTEL_PROMOTION_IMAGE_HOSTS only null is accepted.
    {
      const { app } = await createApp({ modules: "market" });
      const cookie = await login(app);
      const response = await app.inject({
        method: "PUT",
        url: "/admin/v1/settings/intel-promotions",
        headers: { cookie },
        payload: { items: [{ ...card, imageUrl }], updatedAt: null },
      });
      expect(
        expectError(response, 422, "VALIDATION_FAILED")["detailsSafe"],
      ).toEqual({
        reasonCode: "ADMIN_PROMOTION_INVALID",
        index: 0,
        field: "imageUrl",
      });
    }
    const { app, repository } = await createApp({
      modules: "market",
      env: { INTEL_PROMOTION_IMAGE_HOSTS: "cdn.loop.example" },
    });
    const cookie = await login(app);
    const put = (items: unknown[]) =>
      app.inject({
        method: "PUT",
        url: "/admin/v1/settings/intel-promotions",
        headers: { cookie },
        payload: {
          items,
          updatedAt:
            repository.settings.get("intel_promotions")?.updatedAt ?? null,
        },
      });
    for (const [index, item] of [
      { ...card, title: "周赛\u202e反转" },
      { ...card, subtitle: "第一行\n第二行" },
      { ...card, title: "零宽\u200b字符" },
      { ...card, imageUrl: "https://evil.example/x.png" },
      { ...card, imageUrl: "https://cdn.loop.example:8443/x.png" },
      { ...card, imageUrl: "https://user@cdn.loop.example/x.png" },
      { ...card, imageUrl: `https://cdn.loop.example/${"a".repeat(500)}` },
    ].entries()) {
      const response = await put([item]);
      expect(
        expectError(response, 422, "VALIDATION_FAILED")["detailsSafe"],
        `case ${index}`,
      ).toMatchObject({ reasonCode: "ADMIN_PROMOTION_INVALID", index: 0 });
    }
    const saved = await put([{ ...card, imageUrl }]);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      imageHosts: ["cdn.loop.example"],
      imageUrlMaximumLength: 512,
      items: [expect.objectContaining({ imageUrl })],
    });
    const v2 = await app.inject({
      method: "GET",
      url: "/v2/intel/promotions",
      headers: s7CommonHeaders(),
    });
    expect(v2.json()).toMatchObject({
      items: [expect.objectContaining({ imageUrl })],
    });
  });

  it("reviews a community, writes a note and an audit row", async () => {
    const { app, repository } = await createApp();
    const pending = adminCommunityFixture({ verificationStatus: "pending" });
    const verified = adminCommunityFixture();
    repository.communities.set(pending.communityId, pending);
    repository.communities.set(verified.communityId, verified);
    const cookie = await login(app);
    const list = await app.inject({
      method: "GET",
      url: "/admin/v1/communities?status=pending",
      headers: { cookie },
    });
    expect(list.json()).toMatchObject({
      items: [expect.objectContaining({ communityId: pending.communityId })],
      nextCursor: null,
    });
    const review = (communityId: string, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/admin/v1/communities/${communityId}/review`,
        headers: { cookie },
        payload: body,
      });
    expectError(
      await review(pending.communityId, {
        decision: "reject",
        reasonCode: "material_mismatch",
      }),
      422,
      "VALIDATION_FAILED",
    );
    const auditBefore = repository.audit.length;
    const rejected = await review(pending.communityId, {
      decision: "reject",
      reasonCode: "material_mismatch",
      reasonText: "社区名称与介绍对不上，请修改后重新提交。",
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      changed: true,
      community: {
        verificationStatus: "rejected",
        rejectedReason: "社区名称与介绍对不上，请修改后重新提交。",
      },
      note: { decision: "reject", reasonCode: "material_mismatch" },
    });
    expect(repository.audit.length).toBe(auditBefore + 2);
    expect(repository.audit.slice(-2).map((row) => row.action)).toEqual([
      "community.review.requested",
      "community.review.decided",
    ]);
    expect(repository.audit.at(-1)?.after).toMatchObject({
      decision: "reject",
      requestedAuditId: repository.audit.at(-2)?.auditId,
    });
    const conflict = await review(verified.communityId, {
      decision: "reject",
      reasonCode: "policy_violation",
      reasonText: "不符合规则",
    });
    expect(expectError(conflict, 409, "ADMIN_CONFLICT")["detailsSafe"]).toEqual(
      { reasonCode: "ADMIN_COMMUNITY_ALREADY_VERIFIED" },
    );
    expectError(
      await review(randomUUID(), {
        decision: "verify",
        reasonCode: "operator_manual_review",
      }),
      404,
      "NOT_FOUND",
    );
    const detail = await app.inject({
      method: "GET",
      url: `/admin/v1/communities/${pending.communityId}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      reviewNotes: [expect.objectContaining({ decision: "reject" })],
    });
  });

  it("drafts and withdraws mining formula versions; the platform administrator cannot approve (Decision 0110)", async () => {
    const { app, repository } = await createApp();
    const base = adminFormulaFixture();
    repository.formulas.set(base.configVersion, base);
    const bound = adminCommunityFixture({ boundAssetId: "eip155:97:native" });
    repository.communities.set(bound.communityId, bound);
    const cookie = await login(app);
    const draft = (body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/admin/v1/mining/formula-versions",
        headers: { cookie },
        payload: body,
      });
    expectError(
      await draft({
        configVersion: "miningFormulaV2",
        baseVersion: base.configVersion,
        parameters: {
          communityWeights: [{ communityId: bound.communityId, weight: "9" }],
        },
      }),
      422,
      "VALIDATION_FAILED",
    );
    const created = await draft({
      configVersion: "miningFormulaV2",
      baseVersion: base.configVersion,
      parameters: {
        dailyOutputBudget: "2000",
        referralBoostStatus: "approved",
        communityWeights: [{ communityId: bound.communityId, weight: "2.5" }],
        nftWeight: "1.2",
        inviteInitialPower: "100",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      baseVersion: base.configVersion,
      version: {
        configVersion: "miningFormulaV2",
        status: "pending_approval",
        parameters: {
          dailyOutputBudget: "2000",
          referralBoostStatus: "approved",
          communityWeightRange: { min: "1", max: "3" },
          communityWeights: [{ communityId: bound.communityId, weight: "2.5" }],
          nftWeight: "1.2",
          inviteInitialPower: "100",
        },
        draftAuthor: {
          kind: "admin_bootstrap",
          username: "operator",
          accountId: null,
        },
        approvedBy: null,
      },
    });
    expectError(
      await draft({
        configVersion: "miningFormulaV2",
        baseVersion: base.configVersion,
      }),
      409,
      "ADMIN_CONFLICT",
    );
    // Decision 0110: drafting is the platform administrator's, approving a
    // reviewer's; nothing changes and no audit row is written.
    const refused = await app.inject({
      method: "POST",
      url: "/admin/v1/mining/formula-versions/miningFormulaV2/approve",
      headers: { cookie },
    });
    expect(
      expectError(refused, 403, "PERMISSION_DENIED")["detailsSafe"],
    ).toEqual({
      reasonCode: "ADMIN_ROLE_FORBIDDEN",
      permission: "formula.approve",
    });
    expect(repository.formulas.get("miningFormulaV2")?.status).toBe(
      "pending_approval",
    );
    await draft({
      configVersion: "miningFormulaV3",
      baseVersion: base.configVersion,
    });
    const withdrawn = await app.inject({
      method: "POST",
      url: "/admin/v1/mining/formula-versions/miningFormulaV3/withdraw",
      headers: { cookie },
    });
    expect(withdrawn.json()).toMatchObject({ version: { status: "retired" } });
    const list = await app.inject({
      method: "GET",
      url: "/admin/v1/mining/formula-versions",
      headers: { cookie },
    });
    expect(list.json()).toMatchObject({
      approvedVersion: base.configVersion,
      approval: { available: true, reasonCode: null },
    });
    expect(
      repository.audit
        .map((row) => row.action)
        .filter((action) => action.startsWith("mining.")),
    ).toEqual([
      "mining.formula.draft",
      "mining.formula.draft",
      "mining.formula.withdraw",
    ]);
  });

  it("hides a MEME token and reports pause unavailable without the operator key", async () => {
    const { app, repository } = await createApp();
    const token = adminMemeFixture();
    repository.memeTokens.set(token.memeTokenId, token);
    const cookie = await login(app);
    const list = await app.inject({
      method: "GET",
      url: "/admin/v1/meme/tokens",
      headers: { cookie },
    });
    expect(list.json()).toMatchObject({
      pause: {
        available: false,
        reasonCode: "MEME_OPERATOR_KEY_MISSING",
        executorAddress: null,
      },
    });
    const listing = (body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/admin/v1/meme/tokens/${token.memeTokenId}/listing`,
        headers: { cookie },
        payload: body,
      });
    expectError(
      await listing({ listing: "hidden", reasonCode: "user_reports" }),
      422,
      "VALIDATION_FAILED",
    );
    const hidden = await listing({
      listing: "hidden",
      reasonCode: "user_reports",
      reasonText: "该代币因多次举报已被平台隐藏。",
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toMatchObject({
      changed: true,
      memeToken: { listing: "hidden", listingReasonCode: "user_reports" },
    });
    expect(repository.audit.at(-1)?.action).toBe("meme.listing.update");
    const pause = await app.inject({
      method: "POST",
      url: `/admin/v1/meme/tokens/${token.memeTokenId}/pause`,
      headers: { cookie },
      payload: { reasonCode: "user_reports" },
    });
    expect(
      expectError(pause, 503, "CAPABILITY_UNAVAILABLE")["detailsSafe"],
    ).toEqual({ reasonCode: "MEME_OPERATOR_KEY_MISSING" });
  });

  it("hides and restores a launch2 instance with an audit row (Decision 0163)", async () => {
    const { app, repository } = await createApp();
    const instance = adminLaunch2InstanceFixture();
    const other = adminLaunch2InstanceFixture({ name: "Frog", ticker: "FROG" });
    repository.launch2Instances.set(instance.instanceId, instance);
    repository.launch2Instances.set(other.instanceId, other);
    const cookie = await login(app);
    const put = (instanceId: string, body: Record<string, unknown>) =>
      app.inject({
        method: "PUT",
        url: `/admin/v1/launch2/instances/${instanceId}/listing`,
        headers: { cookie },
        payload: body,
      });
    expect(
      expectError(
        await put(instance.instanceId, { listing: "hidden" }),
        422,
        "VALIDATION_FAILED",
      )["detailsSafe"],
    ).toEqual({ reasonCode: "ADMIN_REASON_TEXT_REQUIRED" });
    expectError(
      await put(instance.instanceId, { listing: "listed", reason: "x" }),
      400,
      "INVALID_REQUEST",
    );
    expect(
      expectError(
        await put(randomUUID(), { listing: "hidden", reason: "test" }),
        404,
        "NOT_FOUND",
      )["detailsSafe"],
    ).toEqual({ reasonCode: "ADMIN_LAUNCH2_INSTANCE_NOT_FOUND" });
    expect(
      repository.audit.filter((row) => row.action === "launch2.listing.update"),
    ).toHaveLength(0);

    const hidden = await put(instance.instanceId, {
      listing: "hidden",
      reason: "  测试网验收项目  ",
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.headers["cache-control"]).toBe("no-store");
    expect(hidden.json()).toMatchObject({
      changed: true,
      instance: {
        instanceId: instance.instanceId,
        listing: "hidden",
        listingReason: "测试网验收项目",
      },
    });
    expect(
      typeof hidden.json<{ audit: { auditId: unknown } }>().audit.auditId,
    ).toBe("string");
    expect(repository.audit.at(-1)).toMatchObject({
      action: "launch2.listing.update",
      targetType: "launch2_instance",
      targetId: instance.instanceId,
      before: { listing: "visible", reason: null },
      after: { listing: "hidden", reason: "测试网验收项目" },
    });

    const hiddenList = await app.inject({
      method: "GET",
      url: "/admin/v1/launch2/instances?listing=hidden",
      headers: { cookie },
    });
    expect(hiddenList.statusCode).toBe(200);
    expect(
      hiddenList
        .json<{ items: { instanceId: string }[] }>()
        .items.map((row) => row.instanceId),
    ).toEqual([instance.instanceId]);
    expectError(
      await app.inject({
        method: "GET",
        url: "/admin/v1/launch2/instances?listing=listed",
        headers: { cookie },
      }),
      400,
      "INVALID_REQUEST",
    );

    const restored = await put(instance.instanceId, { listing: "visible" });
    expect(restored.json()).toMatchObject({
      changed: true,
      instance: { listing: "visible", listingReason: "测试网验收项目" },
    });
    const again = await put(instance.instanceId, { listing: "visible" });
    expect(again.json()).toMatchObject({ changed: false });
    expect(
      repository.audit.filter((row) => row.action === "launch2.listing.update"),
    ).toHaveLength(3);
  });

  it("broadcasts pause/unpause through the executor and audits it", async () => {
    const sender = fakeMemePauseSender();
    const { app, repository } = await createApp({ memePauseSender: sender });
    const trading = adminMemeFixture();
    const paused = adminMemeFixture({ status: "paused" });
    const draft = adminMemeFixture({ status: "draft", tokenAddress: null });
    for (const token of [trading, paused, draft]) {
      repository.memeTokens.set(token.memeTokenId, token);
    }
    const cookie = await login(app);
    const post = (id: string, action: string) =>
      app.inject({
        method: "POST",
        url: `/admin/v1/meme/tokens/${id}/${action}`,
        headers: { cookie },
        payload: { reasonCode: "operator_incident", reasonText: "排查异常" },
      });
    const ok = await post(trading.memeTokenId, "pause");
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({
      action: "pause",
      status: "submitted",
      transactionHash: `0x${"ab".repeat(32)}`,
      executorAddress: sender.address,
    });
    expect(sender.calls).toEqual([`pause:${trading.tokenAddress}`]);
    const [requested, submitted] = repository.audit.slice(-2);
    expect(requested).toMatchObject({
      action: "meme.pause.requested",
      targetId: trading.memeTokenId,
      after: { reasonCode: "operator_incident", reasonText: "排查异常" },
    });
    expect(submitted).toMatchObject({
      action: "meme.pause.submitted",
      targetId: trading.memeTokenId,
      after: {
        requestedAuditId: requested?.auditId,
        transactionHash: `0x${"ab".repeat(32)}`,
      },
    });
    expect(ok.json()).toMatchObject({ audit: { seq: submitted?.seq } });
    expect((await post(paused.memeTokenId, "unpause")).statusCode).toBe(202);
    expect(
      expectError(
        await post(paused.memeTokenId, "pause"),
        409,
        "ADMIN_CONFLICT",
      )["detailsSafe"],
    ).toEqual({ reasonCode: "MEME_PAUSE_STATE_INVALID", status: "paused" });
    expect(
      expectError(
        await post(draft.memeTokenId, "pause"),
        409,
        "ADMIN_CONFLICT",
      )["detailsSafe"],
    ).toEqual({ reasonCode: "MEME_TOKEN_NOT_ON_CHAIN" });
    expectError(await post(randomUUID(), "pause"), 404, "NOT_FOUND");
  });

  it("records requested + failed when the dry run reverts (Decision 0105)", async () => {
    const { app, repository } = await createApp({
      memePauseSender: fakeMemePauseSender("simulation_reverted"),
    });
    const token = adminMemeFixture();
    repository.memeTokens.set(token.memeTokenId, token);
    const cookie = await login(app);
    const before = repository.audit.length;
    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/meme/tokens/${token.memeTokenId}/pause`,
      headers: { cookie },
      payload: { reasonCode: "operator_incident" },
    });
    expect(expectError(response, 409, "ADMIN_CONFLICT")["detailsSafe"]).toEqual(
      { reasonCode: "MEME_PAUSE_SIMULATION_REVERTED" },
    );
    expect(repository.audit.slice(before).map((row) => row.action)).toEqual([
      "meme.pause.requested",
      "meme.pause.failed",
    ]);
    expect(repository.audit.at(-1)?.after).toMatchObject({
      errorCode: "MEME_PAUSE_SIMULATION_REVERTED",
      requestedAuditId: repository.audit.at(-2)?.auditId,
    });
  });

  it("records requested + failed when the broadcast fails or throws (Decision 0105)", async () => {
    for (const [outcome, status, code] of [
      ["failed", 503, "CAPABILITY_UNAVAILABLE"],
      ["throws", 500, "INTERNAL_ERROR"],
    ] as const) {
      const sender = fakeMemePauseSender(outcome);
      const { app, repository } = await createApp({ memePauseSender: sender });
      const token = adminMemeFixture();
      repository.memeTokens.set(token.memeTokenId, token);
      const cookie = await login(app);
      const before = repository.audit.length;
      const response = await app.inject({
        method: "POST",
        url: `/admin/v1/meme/tokens/${token.memeTokenId}/pause`,
        headers: { cookie },
        payload: { reasonCode: "operator_incident" },
      });
      expectError(response, status, code);
      expect(sender.calls).toHaveLength(1);
      expect(repository.audit.slice(before).map((row) => row.action)).toEqual([
        "meme.pause.requested",
        "meme.pause.failed",
      ]);
    }
  });

  it("signs nothing and changes nothing when the intent audit row cannot be written (Decision 0105)", async () => {
    const base = createInMemoryAdminRepository();
    let auditDown = false;
    const repository: InMemoryAdminRepository = {
      ...base,
      appendAudit: (input) =>
        auditDown
          ? Promise.reject(new AdminRepositoryUnavailableError())
          : base.appendAudit(input),
    };
    const sender = fakeMemePauseSender();
    const { app } = await createApp({ repository, memePauseSender: sender });
    const token = adminMemeFixture();
    const pending = adminCommunityFixture({ verificationStatus: "pending" });
    repository.memeTokens.set(token.memeTokenId, token);
    repository.communities.set(pending.communityId, pending);
    const cookie = await login(app);
    auditDown = true;
    const pause = await app.inject({
      method: "POST",
      url: `/admin/v1/meme/tokens/${token.memeTokenId}/pause`,
      headers: { cookie },
      payload: { reasonCode: "operator_incident" },
    });
    expect(
      expectError(pause, 503, "CAPABILITY_UNAVAILABLE")["detailsSafe"],
    ).toEqual({ reasonCode: "ADMIN_AUDIT_UNAVAILABLE" });
    expect(sender.calls).toEqual([]);
    const review = await app.inject({
      method: "POST",
      url: `/admin/v1/communities/${pending.communityId}/review`,
      headers: { cookie },
      payload: { decision: "verify", reasonCode: "operator_manual_review" },
    });
    expect(
      expectError(review, 503, "CAPABILITY_UNAVAILABLE")["detailsSafe"],
    ).toEqual({ reasonCode: "ADMIN_AUDIT_UNAVAILABLE" });
    expect(
      repository.communities.get(pending.communityId)?.verificationStatus,
    ).toBe("pending");
    expect(repository.notes).toEqual([]);
  });

  it("refuses a second pause of a token while the first is in flight or unmined (Decision 0105)", async () => {
    const sender = fakeMemePauseSender();
    const { app, repository } = await createApp({ memePauseSender: sender });
    const token = adminMemeFixture();
    repository.memeTokens.set(token.memeTokenId, token);
    const cookie = await login(app);
    const post = () =>
      app.inject({
        method: "POST",
        url: `/admin/v1/meme/tokens/${token.memeTokenId}/pause`,
        headers: { cookie },
        payload: { reasonCode: "operator_incident" },
      });
    // Two clicks at once: one reaches the signer, the other is 409.
    let release = (): void => undefined;
    sender.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = post();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post();
    expect(expectError(second, 409, "ADMIN_CONFLICT")["detailsSafe"]).toEqual({
      reasonCode: "MEME_PAUSE_PENDING",
    });
    release();
    sender.gate = null;
    expect((await first).statusCode).toBe(202);
    expect(sender.calls).toHaveLength(1);
    // Broadcast but not mined (the token is still `trading` in the index).
    sender.state = "pending";
    const unmined = await post();
    expect(expectError(unmined, 409, "ADMIN_CONFLICT")["detailsSafe"]).toEqual({
      reasonCode: "MEME_PAUSE_PENDING",
      transactionHash: `0x${"ab".repeat(32)}`,
    });
    // A failed state read is treated as pending.
    sender.state = "unknown";
    expectError(await post(), 409, "ADMIN_CONFLICT");
    expect(sender.calls).toHaveLength(1);
    // Mined (or dropped): the dry run decides again.
    sender.state = "settled";
    expect((await post()).statusCode).toBe(202);
    expect(sender.calls).toHaveLength(2);
  });

  it("records requested and failed review rows when the review path refuses (Decision 0105)", async () => {
    const { app, repository } = await createApp();
    const verified = adminCommunityFixture();
    repository.communities.set(verified.communityId, verified);
    const cookie = await login(app);
    const before = repository.audit.length;
    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/communities/${verified.communityId}/review`,
      headers: { cookie },
      payload: {
        decision: "reject",
        reasonCode: "policy_violation",
        reasonText: "不符合规则",
      },
    });
    expectError(response, 409, "ADMIN_CONFLICT");
    expect(repository.audit.slice(before).map((row) => row.action)).toEqual([
      "community.review.requested",
      "community.review.failed",
    ]);
    expect(repository.audit.at(-1)?.after).toMatchObject({
      errorCode: "community_data_stale",
      requestedAuditId: repository.audit.at(-2)?.auditId,
    });
  });

  it("pages the audit log newest first with filters", async () => {
    const { app, repository } = await createApp();
    const cookie = await login(app);
    for (let index = 0; index < 5; index += 1) {
      await repository.appendAudit({
        actor: "operator",
        action: "meme.listing.update",
        targetType: "meme_token",
        targetId: randomUUID(),
        before: null,
        after: { index },
        requestId: randomUUID(),
      });
    }
    const first = await app.inject({
      method: "GET",
      url: "/admin/v1/audit?action=meme.listing.update&limit=3",
      headers: { cookie },
    });
    const page = first.json<{
      items: { seq: number; action: string }[];
      nextCursor: string | null;
    }>();
    expect(page.items.map((row) => row.seq)).toEqual([6, 5, 4]);
    expect(page.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: "GET",
      url: `/admin/v1/audit?action=meme.listing.update&cursor=${encodeURIComponent(page.nextCursor as string)}`,
      headers: { cookie },
    });
    expect(
      second.json<{ items: { seq: number }[] }>().items.map((r) => r.seq),
    ).toEqual([3, 2]);
    const tampered = await app.inject({
      method: "GET",
      url: `/admin/v1/audit?action=session.login&cursor=${encodeURIComponent(page.nextCursor as string)}`,
      headers: { cookie },
    });
    expectError(tampered, 400, "INVALID_REQUEST");
  });

  it("answers 503 when the database is unavailable", async () => {
    const repository = createInMemoryAdminRepository();
    const { app } = await createApp({
      repository: {
        ...repository,
        overview: () => Promise.reject(new AdminRepositoryUnavailableError()),
      },
    });
    const cookie = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie },
    });
    expect(
      expectError(response, 503, "CAPABILITY_UNAVAILABLE")["detailsSafe"],
    ).toEqual({ reasonCode: "ADMIN_DATABASE_UNAVAILABLE" });
  });
});
