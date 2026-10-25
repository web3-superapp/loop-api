import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openApiWebArtifactPath } from "../scripts/generate-openapi.js";
import { buildApp } from "../src/app.js";
import type { Database } from "../src/database/database.js";
import { createUnavailableProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import { inviteCodeCheckSymbol } from "../src/features/referral/invite-code.js";
import {
  createUnavailableReferralRepository,
  ReferralRepositoryUnavailableError,
  type ReferralEdgeRecord,
  type ReferralInviteeRecord,
  type ReferralRepository,
} from "../src/features/referral/referral-repository.js";
import {
  WebRegistrationRepositoryUnavailableError,
  type WebRegistrationRepository,
} from "../src/features/web/web-registration-repository.js";
import {
  calls,
  s7AccountId,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
  s7ValidToken,
} from "./s7-route-fakes.js";

/**
 * Decision 0180: `GET /v2/web/referral/me` — the website's "my invites"
 * panel over the App's invite-center reads — against in-memory repositories.
 */

const origin = "https://loop.example";
const webEnv = {
  V2_MODULES_ENABLED: "profile,referral",
  WEB_ORIGINS: origin,
  PUBLIC_BASE_URL: "https://api.loop.example",
} as const;
const ownCode = `LOOP-8XYZ${inviteCodeCheckSymbol("8XYZ")}`;
const inviterId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const inviterLoopId = "LOOP-ABCD1234";
const epochId = "0f1e2d3c-4b5a-4968-8776-655443322110";
const recentActivation = new Date(Date.now() - 86_400_000).toISOString();
const oldActivation = new Date(Date.now() - 400 * 86_400_000).toISOString();

const edge: ReferralEdgeRecord = Object.freeze({
  referralEdgeId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
  inviterUserId: inviterId,
  inviteeUserId: s7AccountId,
  depth: 1,
  validationStatus: "pending_wallet",
  lockedAt: recentActivation,
  effectiveFrom: recentActivation,
  effectiveTo: null,
  configVersion: "referralRulesV1",
});

function invitee(
  index: number,
  overrides: Partial<ReferralInviteeRecord> = {},
): ReferralInviteeRecord {
  const minute = String(59 - (index % 60)).padStart(2, "0");
  const hour = String(10 + Math.floor(index / 60)).padStart(2, "0");
  return Object.freeze({
    referralEdgeId: `7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4${String(index).padStart(4, "0")}`,
    publicProfileId: `5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d${String(index).padStart(4, "0")}`,
    alias: `friend${String(index)}`,
    avatarRef: null,
    loopId: `LOOP-FRND${String(index).padStart(4, "0")}`,
    boundAt: `2026-10-20T${hour}:${minute}:00.000Z`,
    boundAtKey: `2026-10-20T${hour}:${minute}:00.000000Z`,
    validationStatus: "pending",
    ...overrides,
  });
}

function referralFake(
  overrides: Partial<ReferralRepository> = {},
): ReferralRepository {
  return {
    ...createUnavailableReferralRepository(),
    getInviteCode: vi.fn(() =>
      Promise.resolve({ code: ownCode, issuedAt: oldActivation }),
    ),
    getAccountState: vi.fn(() =>
      Promise.resolve({ activatedAt: recentActivation, hasWallet: true }),
    ),
    getDirectEdge: vi.fn(() => Promise.resolve(edge)),
    getLatestSettledEpochId: vi.fn(() => Promise.resolve(epochId)),
    getInviteeStats: vi.fn(() =>
      Promise.resolve({
        directCount: 2,
        validCount: 1,
        level2to5Count: 3,
        validAsOf: "2026-10-24T03:00:00.000Z",
      }),
    ),
    listDirectInvitees: vi.fn(() =>
      Promise.resolve([
        invitee(0, { validationStatus: "valid" }),
        invitee(1, { alias: null }),
        invitee(2, {
          publicProfileId: null,
          alias: null,
          loopId: null,
          validationStatus: "invalid",
        }),
      ]),
    ),
    ...overrides,
  };
}

function webFake(
  overrides: Partial<WebRegistrationRepository> = {},
): WebRegistrationRepository {
  return {
    getAccountSummary: vi.fn(() => Promise.reject(new Error("unused"))),
    findInviterByCode: vi.fn(() => Promise.resolve(null)),
    getDirectInviter: vi.fn(() =>
      Promise.resolve({
        userId: inviterId,
        loopId: inviterLoopId,
        username: "Alice",
      }),
    ),
    ...overrides,
  };
}

function bearer(extra: Readonly<Record<string, string>> = {}) {
  return { authorization: `Bearer ${s7ValidToken}`, origin, ...extra };
}

describe("Decision 0180: GET /v2/web/referral/me", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    input: {
      readonly env?: Readonly<Record<string, string>>;
      readonly referral?: ReferralRepository;
      readonly web?: WebRegistrationRepository;
    } = {},
  ) {
    const database: Database = {
      ...s7Database({ referral: input.referral ?? referralFake() }),
      profilesV2: createUnavailableProfileV2Repository(),
      webRegistration: input.web ?? webFake(),
    };
    const app = await buildApp({
      config: s7TestConfig({ ...webEnv, ...input.env }),
      contractSurface: "runtime",
      database,
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return { app, database };
  }

  function get(app: FastifyInstance, url = "/v2/web/referral/me") {
    return app.inject({ method: "GET", url, headers: bearer() });
  }

  it("returns code, link, stats, invitees, inviter, and binding", async () => {
    const referral = referralFake();
    const { app } = await createApp({ referral });
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.json()).toEqual({
      code: ownCode,
      inviteLink: `https://api.loop.example/i/${ownCode}`,
      stats: {
        direct: 2,
        valid: 1,
        deeper: 3,
        pendingVerification: 1,
        validAsOf: "2026-10-24T03:00:00.000Z",
      },
      invitees: [
        {
          loopId: "LOOP-FRND0000",
          username: "friend0",
          depth: 1,
          status: "valid",
          joinedAt: "2026-10-20T10:59:00.000Z",
        },
        {
          loopId: "LOOP-FRND0001",
          username: null,
          depth: 1,
          status: "pending",
          joinedAt: "2026-10-20T10:58:00.000Z",
        },
        {
          loopId: null,
          username: null,
          depth: 1,
          status: "void",
          joinedAt: "2026-10-20T10:57:00.000Z",
        },
      ],
      nextCursor: null,
      inviter: { loopId: inviterLoopId, username: "Alice" },
      binding: { bound: true, canClaim: false },
      observedAt: expect.any(String) as string,
    });
    // Same settled hour for the stats as the App (Decision 0162).
    expect(calls(referral, "getInviteeStats")).toHaveBeenCalledWith(
      s7AccountId,
      epochId,
    );
    expect(calls(referral, "listDirectInvitees")).toHaveBeenCalledWith({
      inviterUserId: s7AccountId,
      after: null,
      limit: 101,
    });
  });

  it("never publishes e-mail, wallet, or profile ids of invitees", async () => {
    const { app } = await createApp();
    const body = (await get(app)).body;
    expect(body).not.toContain("publicProfileId");
    expect(body).not.toContain("5c6d7e8f");
    expect(body).not.toContain("avatarRef");
    expect(body).not.toContain("walletAddress");
    expect(body).not.toContain("email");
  });

  it("issues the code on the first read, before the username is set", async () => {
    const issueInviteCode = vi.fn(
      (input: { readonly code: string; readonly ownerUserId: string }) =>
        Promise.resolve({ code: input.code, issuedAt: "2026-10-24T00:00:00Z" }),
    );
    const referral = referralFake({
      getInviteCode: vi.fn(() => Promise.resolve(null)),
      issueInviteCode,
      getAccountState: vi.fn(() =>
        Promise.resolve({ activatedAt: null, hasWallet: false }),
      ),
      getDirectEdge: vi.fn(() => Promise.resolve(null)),
      listDirectInvitees: vi.fn(() => Promise.resolve([])),
    });
    const web = webFake();
    const { app } = await createApp({ referral, web });
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["code"]).toMatch(/^LOOP-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(issueInviteCode).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: s7AccountId }),
    );
    expect(body["binding"]).toEqual({ bound: false, canClaim: true });
    expect(body["inviter"]).toBeNull();
    expect(body["invitees"]).toEqual([]);
    // Unbound: the inviter lookup is skipped.
    expect(calls(web, "getDirectInviter")).not.toHaveBeenCalled();
  });

  it("answers stats null (not zeros) before the first settled hour or on a failed read", async () => {
    const referral = referralFake({
      getLatestSettledEpochId: vi.fn(() => Promise.resolve(null)),
    });
    const { app } = await createApp({ referral });
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stats: null });
    expect(calls(referral, "getInviteeStats")).not.toHaveBeenCalled();

    const failing = await createApp({
      referral: referralFake({
        getInviteeStats: vi.fn(() => Promise.reject(new Error("db"))),
      }),
    });
    const failed = await get(failing.app);
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ stats: null });
  });

  it("keeps an unbound account activated 400 days ago claimable (Decision 0181)", async () => {
    const { app } = await createApp({
      referral: referralFake({
        getAccountState: vi.fn(() =>
          Promise.resolve({ activatedAt: oldActivation, hasWallet: true }),
        ),
        getDirectEdge: vi.fn(() => Promise.resolve(null)),
      }),
    });
    expect((await get(app)).json()).toMatchObject({
      binding: { bound: false, canClaim: true },
      inviter: null,
    });
  });

  it("pages 100 invitees newest first with an owner-bound cursor", async () => {
    const rows = Array.from({ length: 130 }, (_, index) => invitee(index));
    const listDirectInvitees = vi.fn(
      (input: {
        readonly after: { readonly boundAtKey: string } | null;
        readonly limit: number;
      }) => {
        const start =
          input.after === null
            ? 0
            : rows.findIndex(
                (row) => row.boundAtKey === input.after?.boundAtKey,
              ) + 1;
        return Promise.resolve(rows.slice(start, start + input.limit));
      },
    );
    const { app } = await createApp({
      referral: referralFake({ listDirectInvitees }),
    });
    const first = await get(app);
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      invitees: { joinedAt: string }[];
      nextCursor: string | null;
    }>();
    expect(page.invitees).toHaveLength(100);
    expect(page.nextCursor).toEqual(expect.any(String));

    const second = await get(
      app,
      `/v2/web/referral/me?cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
    );
    expect(second.statusCode).toBe(200);
    const next = second.json<{
      invitees: { loopId: string }[];
      nextCursor: string | null;
    }>();
    expect(next.invitees).toHaveLength(30);
    expect(next.invitees[0]?.loopId).toBe("LOOP-FRND0100");
    expect(next.nextCursor).toBeNull();
    expect(listDirectInvitees).toHaveBeenLastCalledWith({
      inviterUserId: s7AccountId,
      after: {
        boundAtKey: rows[99]?.boundAtKey,
        referralEdgeId: rows[99]?.referralEdgeId,
      },
      limit: 101,
    });

    // A cursor of the App's invitee list is not accepted here, nor junk.
    for (const cursor of ["junk", "a".repeat(40)]) {
      const refused = await get(app, `/v2/web/referral/me?cursor=${cursor}`);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("refuses unknown query keys and a body", async () => {
    const { app } = await createApp();
    expect((await get(app, "/v2/web/referral/me?limit=5")).statusCode).toBe(
      400,
    );
  });

  it("needs a Bearer token and an account", async () => {
    const { app, database } = await createApp();
    const anonymous = await app.inject({
      method: "GET",
      url: "/v2/web/referral/me",
      headers: { origin },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(anonymous.headers["access-control-allow-origin"]).toBe(origin);

    vi.mocked(
      calls(database.internalUsers, "findByPrivyUserId"),
    ).mockResolvedValueOnce(null);
    const missing = await get(app);
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({
      code: "ACCOUNT_BOOTSTRAP_REQUIRED",
    });
  });

  it("reads no contract, idempotency, or device header", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/web/referral/me",
      headers: bearer({
        "x-loop-contract-version": "9.9",
        "idempotency-key": "not-a-uuid",
      }),
    });
    expect(response.statusCode).toBe(200);
  });

  it("is 503 when the referral module is off", async () => {
    const { app } = await createApp({
      env: { V2_MODULES_ENABLED: "profile" },
    });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "V2_REFERRAL_MODULE_DEFERRED" },
    });
  });

  it("is 503 V2_CURSOR_NOT_CONFIGURED without the cursor secret", async () => {
    const { app } = await createApp({ env: { V2_CURSOR_HMAC_SECRET: "" } });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "V2_CURSOR_NOT_CONFIGURED" },
    });
  });

  it("is 503 when the referral store fails, with the seven-field envelope", async () => {
    const { app } = await createApp({
      referral: referralFake({
        listDirectInvitees: vi.fn(() =>
          Promise.reject(new ReferralRepositoryUnavailableError()),
        ),
      }),
    });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(Object.keys(response.json<object>()).sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ].sort(),
    );
  });

  it("is 503 WEB_REPOSITORY_UNAVAILABLE when the inviter read fails", async () => {
    const { app } = await createApp({
      web: webFake({
        getDirectInviter: vi.fn(() =>
          Promise.reject(new WebRegistrationRepositoryUnavailableError()),
        ),
      }),
    });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "WEB_REPOSITORY_UNAVAILABLE" },
    });
  });

  it("is not mounted without WEB_ORIGINS", async () => {
    const { app } = await createApp({ env: { WEB_ORIGINS: "" } });
    expect((await get(app)).statusCode).toBe(404);
  });
});

describe("Decision 0180: web OpenAPI contract of /v2/web/referral/me", () => {
  it("is a Bearer read with only the cursor parameter and a closed response", async () => {
    const document = JSON.parse(
      await readFile(openApiWebArtifactPath, "utf8"),
    ) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths["/v2/web/referral/me"]?.["get"];
    expect(operation?.["operationId"]).toBe("getWebReferralDashboard");
    expect(operation?.["security"]).toEqual([{ privyBearer: [] }]);
    expect(operation?.["tags"]).toEqual(["web"]);
    const names = (
      (operation?.["parameters"] ?? []) as { name: string; in: string }[]
    ).map((parameter) => `${parameter.in}:${parameter.name}`);
    expect(names).toEqual(["query:cursor"]);
    const responses = operation?.["responses"] as Record<
      string,
      { content?: Record<string, { schema: Record<string, unknown> }> }
    >;
    expect(Object.keys(responses).sort()).toEqual(
      ["200", "400", "401", "409", "500", "503"].sort(),
    );
    const schema = responses["200"]?.content?.["application/json"]?.schema as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      [
        "binding",
        "code",
        "invitees",
        "inviteLink",
        "inviter",
        "nextCursor",
        "observedAt",
        "stats",
      ].sort(),
    );
  });
});
