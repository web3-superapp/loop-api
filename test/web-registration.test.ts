import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openApiV2ArtifactPath,
  openApiWebArtifactPath,
  renderOpenApiWebArtifact,
} from "../scripts/generate-openapi.js";
import { buildApp } from "../src/app.js";
import { ConfigurationError, parseWebSurfaceConfig } from "../src/config.js";
import type { Database } from "../src/database/database.js";
import type {
  ActivateProfileV2RecordInput,
  ProfileV2Record,
  ReplaceProfileV2RecordInput,
} from "../src/features/profile/profile-v2-repository.js";
import {
  createUnavailableProfileV2Repository,
  ProfileV2VersionConflictError,
  type ProfileV2Repository,
} from "../src/features/profile/profile-v2-repository.js";
import { inviteCodeCheckSymbol } from "../src/features/referral/invite-code.js";
import {
  createUnavailableReferralRepository,
  ReferralAlreadyBoundError,
  type ReferralEdgeRecord,
  type ReferralRepository,
} from "../src/features/referral/referral-repository.js";
import type {
  WebAccountSummary,
  WebInviter,
  WebRegistrationRepository,
} from "../src/features/web/web-registration-repository.js";
import { createWebRateLimiter } from "../src/features/web/web-rate-limit.js";
import {
  webCorsAllowedHeaders,
  webCorsAllowedMethods,
} from "../src/routes/v2/web.js";
import {
  calls,
  s7AccountId,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
  s7ValidToken,
} from "./s7-route-fakes.js";

/**
 * Decision 0179: the web registration surface `/v2/web/*` — mounting,
 * CORS allowlist, session, username, claim, preview, meta, and the
 * `/i/{code}` redirect — against in-memory repositories.
 */

const origin = "https://loop.example";
const otherOrigin = "https://evil.example";
const webEnv = {
  V2_MODULES_ENABLED: "profile,referral",
  WEB_ORIGINS: `${origin}/,https://www.loop.example`,
} as const;
const loopId = "LOOP-7HJK2MNP";
const inviterId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const inviterLoopId = "LOOP-ABCD1234";
const code = `LOOP-7HJK${inviteCodeCheckSymbol("7HJK")}`;
const ownCode = `LOOP-8XYZ${inviteCodeCheckSymbol("8XYZ")}`;
const unknownCode = `LOOP-9QRS${inviteCodeCheckSymbol("9QRS")}`;
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba";
const recentActivation = new Date(Date.now() - 86_400_000).toISOString();
/** Decision 0181: far past the former 7-day window. */
const oldActivation = new Date(Date.now() - 400 * 86_400_000).toISOString();

const inviter: WebInviter = Object.freeze({
  userId: inviterId,
  loopId: inviterLoopId,
  username: "Alice",
});
const self: WebInviter = Object.freeze({
  userId: s7AccountId,
  loopId,
  username: "Bob",
});

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

function writeHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${s7ValidToken}`,
    "x-loop-contract-version": "2.0",
    "idempotency-key": idempotencyKey,
    origin,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function profileRecord(
  overrides: Partial<ProfileV2Record> = {},
): ProfileV2Record {
  return Object.freeze({
    ownerUserId: s7AccountId,
    loopId,
    alias: null,
    avatarRef: null,
    bio: null,
    interests: Object.freeze([]),
    profileStatus: "pending",
    activatedAt: null,
    version: 0,
    updatedAt: null,
    ...overrides,
  });
}

function profileFake(initial: ProfileV2Record = profileRecord()) {
  let current = initial;
  const repository: ProfileV2Repository = {
    ...createUnavailableProfileV2Repository(),
    getProfile: vi.fn(() => Promise.resolve(current)),
    activateProfile: vi.fn((input: ActivateProfileV2RecordInput) => {
      if (current.profileStatus === "pending") {
        current = profileRecord({
          ...current,
          alias: input.profile.alias,
          profileStatus: "active",
          activatedAt: new Date().toISOString(),
          version: current.version + 1,
        });
      }
      return Promise.resolve(current);
    }),
    replaceProfile: vi.fn((input: ReplaceProfileV2RecordInput) => {
      if (input.expectedVersion !== current.version) {
        return Promise.reject(new ProfileV2VersionConflictError());
      }
      current = profileRecord({
        ...current,
        ...input.profile,
        version: current.version + 1,
      });
      return Promise.resolve(current);
    }),
  };
  return repository;
}

function referralFake(
  overrides: Partial<ReferralRepository> = {},
): ReferralRepository {
  return {
    ...createUnavailableReferralRepository(),
    findInviterByCode: vi.fn((value: string) =>
      Promise.resolve(
        value === code ? inviterId : value === ownCode ? s7AccountId : null,
      ),
    ),
    getAccountState: vi.fn(() =>
      Promise.resolve({ activatedAt: recentActivation, hasWallet: false }),
    ),
    getAncestorChain: vi.fn(() => Promise.resolve([])),
    getDirectEdge: vi.fn(() => Promise.resolve(null)),
    claim: vi.fn(() => Promise.resolve(edge)),
    recordRejectedClaim: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function summary(overrides: Partial<WebAccountSummary> = {}) {
  return Object.freeze({
    loopId,
    username: null,
    activatedAt: null,
    walletAddress: null,
    inviteBound: false,
    ...overrides,
  });
}

function webFake(
  overrides: Partial<WebRegistrationRepository> = {},
): WebRegistrationRepository {
  return {
    getAccountSummary: vi.fn(() => Promise.resolve(summary())),
    findInviterByCode: vi.fn((value: string) =>
      Promise.resolve(
        value === code ? inviter : value === ownCode ? self : null,
      ),
    ),
    getDirectInviter: vi.fn(() => Promise.resolve(inviter)),
    ...overrides,
  };
}

describe("Decision 0179: web registration surface", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    input: {
      readonly env?: Readonly<Record<string, string>>;
      readonly profiles?: ProfileV2Repository;
      readonly referral?: ReferralRepository;
      readonly web?: WebRegistrationRepository;
      readonly nowMs?: () => number;
    } = {},
  ) {
    const database: Database = {
      ...s7Database({ referral: input.referral ?? referralFake() }),
      profilesV2: input.profiles ?? profileFake(),
      webRegistration: input.web ?? webFake(),
    };
    const app = await buildApp({
      config: s7TestConfig({ ...webEnv, ...input.env }),
      contractSurface: "runtime",
      database,
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
      ...(input.nowMs === undefined ? {} : { webNowMs: input.nowMs }),
    });
    apps.push(app);
    return { app, database };
  }

  describe("mounting and CORS", () => {
    it("is not mounted without WEB_ORIGINS", async () => {
      const { app } = await createApp({ env: { WEB_ORIGINS: "" } });
      const session = await app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders(),
      });
      expect(session.statusCode).toBe(404);
      expect(session.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(session.headers["access-control-allow-origin"]).toBeUndefined();
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/v2/web/session",
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(preflight.statusCode).toBe(404);
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("echoes a listed origin, never *, with Vary and a cross-origin CORP", async () => {
      const { app } = await createApp();
      for (const allowed of [origin, "https://www.loop.example"]) {
        const response = await app.inject({
          method: "GET",
          url: "/v2/web/meta",
          headers: { origin: allowed },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(allowed);
        expect(response.headers["vary"]).toContain("origin");
        expect(response.headers["cross-origin-resource-policy"]).toBe(
          "cross-origin",
        );
        expect(response.headers["access-control-allow-credentials"]).toBe(
          undefined,
        );
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("gives an unlisted or missing origin no Access-Control-Allow-Origin", async () => {
      const { app } = await createApp();
      for (const headers of [
        { origin: otherOrigin },
        { origin: "https://loop.example.evil.example" },
        { origin: "http://loop.example" },
        {},
      ]) {
        const response = await app.inject({
          method: "GET",
          url: "/v2/web/meta",
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["vary"]).toContain("origin");
      }
    });

    it("answers a listed preflight 204 with methods and headers, an unlisted one without them", async () => {
      const { app } = await createApp();
      const allowed = await app.inject({
        method: "OPTIONS",
        url: "/v2/web/profile/username",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers":
            "authorization, content-type, idempotency-key, x-loop-contract-version",
        },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
      expect(allowed.headers["access-control-allow-methods"]).toBe(
        webCorsAllowedMethods,
      );
      expect(allowed.headers["access-control-allow-headers"]).toBe(
        webCorsAllowedHeaders,
      );
      expect(allowed.headers["access-control-max-age"]).toBe("600");
      expect(webCorsAllowedMethods).toBe("GET, POST, PUT, OPTIONS");
      for (const name of ["authorization", "content-type"]) {
        expect(webCorsAllowedHeaders).toContain(name);
      }

      const denied = await app.inject({
        method: "OPTIONS",
        url: "/v2/web/session",
        headers: {
          origin: otherOrigin,
          "access-control-request-method": "POST",
        },
      });
      expect(denied.statusCode).toBe(204);
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
      expect(denied.headers["access-control-allow-methods"]).toBeUndefined();
      expect(denied.headers["access-control-allow-headers"]).toBeUndefined();
    });

    it("carries CORS on errors too (401 without a token)", async () => {
      const { app } = await createApp();
      const response = await app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders({ authorization: undefined }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(
        Object.keys(response.json<Record<string, unknown>>()).sort(),
      ).toEqual([
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ]);
    });

    it("keeps every other route same-origin", async () => {
      const { app } = await createApp();
      for (const url of ["/v2/referral", "/health/live", "/i/LOOP-AAAAA"]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { origin },
        });
        expect(response.headers["access-control-allow-origin"], url).toBe(
          undefined,
        );
      }
      const v2 = await app.inject({
        method: "GET",
        url: "/v2/referral",
        headers: { origin },
      });
      expect(v2.headers["cross-origin-resource-policy"]).toBe("same-origin");
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/v2/referral/claim",
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("POST /v2/web/session", () => {
    it("gets or creates the account without any App device header", async () => {
      const { app, database } = await createApp();
      const response = await app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body).toEqual({
        loopId,
        username: null,
        usernameRequired: true,
        walletAddress: null,
        invite: { bound: false, canClaim: true },
        observedAt: expect.any(String) as string,
      });
      expect(
        calls(database.internalUsers, "getOrCreateByPrivyUserId"),
      ).toHaveBeenCalledWith("did:privy:verified-user");
    });

    it("accepts an empty JSON object body and reports the invite state", async () => {
      const web = webFake({
        getAccountSummary: vi.fn(() =>
          Promise.resolve(
            summary({
              username: "Bob",
              activatedAt: recentActivation,
              walletAddress: "0x00000000000000000000000000000000000000aa",
            }),
          ),
        ),
      });
      const { app } = await createApp({ web });
      const response = await app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders(),
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        username: "Bob",
        usernameRequired: false,
        walletAddress: "0x00000000000000000000000000000000000000aa",
        invite: { bound: false, canClaim: true },
      });
      expect(
        response.json<{ invite: Record<string, unknown> }>().invite,
      ).not.toHaveProperty("windowEndsAt");
    });

    it("keeps an account activated 400 days ago claimable (Decision 0181) and a bound invite not", async () => {
      const old = await createApp({
        web: webFake({
          getAccountSummary: vi.fn(() =>
            Promise.resolve(
              summary({ username: "Bob", activatedAt: oldActivation }),
            ),
          ),
        }),
      });
      const bound = await createApp({
        web: webFake({
          getAccountSummary: vi.fn(() =>
            Promise.resolve(summary({ inviteBound: true })),
          ),
        }),
      });
      for (const [{ app }, claimable] of [
        [old, true],
        [bound, false],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/v2/web/session",
          headers: writeHeaders(),
        });
        expect(
          response.json<{ invite: { canClaim: boolean } }>().invite.canClaim,
        ).toBe(claimable);
      }
    });

    it("validates the contract version and the Idempotency-Key", async () => {
      const { app } = await createApp();
      const cases: [Record<string, string | undefined>, number, string][] = [
        [{ "x-loop-contract-version": undefined }, 400, "INVALID_REQUEST"],
        [{ "x-loop-contract-version": "1.0" }, 409, "VERSION_CONFLICT"],
        [{ "idempotency-key": undefined }, 400, "INVALID_REQUEST"],
        [
          { "idempotency-key": idempotencyKey.toUpperCase() },
          400,
          "INVALID_REQUEST",
        ],
        [{ authorization: "Bearer nope" }, 401, "AUTH_INVALID"],
      ];
      for (const [overrides, status, errorCode] of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/v2/web/session",
          headers: writeHeaders(overrides),
        });
        expect(response.statusCode, JSON.stringify(overrides)).toBe(status);
        expect(response.json()).toMatchObject({ code: errorCode });
      }
    });

    it("fails closed when the session slice is off or the repository is missing", async () => {
      const off = await createApp({ env: { V2_SESSION_ENABLED: "false" } });
      const response = await off.app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "WEB_SESSION_DISABLED" },
      });

      const app = await buildApp({
        config: s7TestConfig(webEnv),
        contractSurface: "web",
        database: s7Database({ referral: referralFake() }),
        privyAccessTokenVerifier: s7PrivyVerifier(),
        logger: false,
      });
      apps.push(app);
      const missing = await app.inject({
        method: "POST",
        url: "/v2/web/session",
        headers: writeHeaders(),
      });
      expect(missing.statusCode).toBe(503);
      expect(missing.json()).toMatchObject({
        detailsSafe: { reasonCode: "WEB_REPOSITORY_UNAVAILABLE" },
      });
    });
  });

  describe("PUT /v2/web/profile/username", () => {
    function put(
      app: FastifyInstance,
      username: unknown,
      headers = writeHeaders(),
    ) {
      return app.inject({
        method: "PUT",
        url: "/v2/web/profile/username",
        headers,
        payload: { username },
      });
    }

    it("activates a pending profile with the alias and the Idempotency-Key", async () => {
      const profiles = profileFake();
      const { app } = await createApp({ profiles });
      const response = await put(app, "  Bob  ");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ username: "Bob" });
      expect(calls(profiles, "activateProfile")).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: s7AccountId,
          idempotencyKey,
          profile: { alias: "Bob", avatarRef: null, interests: [] },
        }),
      );
      expect(calls(profiles, "replaceProfile")).not.toHaveBeenCalled();
    });

    it("replaces the alias of an active profile, keeping the other fields", async () => {
      const profiles = profileFake(
        profileRecord({
          alias: "Bob",
          bio: "hello",
          avatarRef: "avatar:preset/people-03",
          interests: Object.freeze(["MEME"] as const),
          profileStatus: "active",
          activatedAt: recentActivation,
          version: 3,
        }),
      );
      const { app } = await createApp({ profiles });
      const response = await put(app, "Bobby");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ username: "Bobby" });
      expect(calls(profiles, "replaceProfile")).toHaveBeenCalledWith({
        ownerUserId: s7AccountId,
        expectedVersion: 3,
        profile: {
          alias: "Bobby",
          avatarRef: "avatar:preset/people-03",
          bio: "hello",
          interests: ["MEME"],
        },
      });
      expect(calls(profiles, "activateProfile")).not.toHaveBeenCalled();
    });

    it("applies the App's alias rules (length, reserved words, characters); names may repeat", async () => {
      const { app } = await createApp();
      expect((await put(app, "x".repeat(41))).json()).toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect((await put(app, "admin")).json()).toMatchObject({
        code: "ALIAS_RESERVED",
      });
      expect((await put(app, "a​b")).statusCode).toBe(400);
      expect((await put(app, "   ")).statusCode).toBe(400);
      expect((await put(app, "x".repeat(40))).statusCode).toBe(200);
    });

    it("re-reads and retries once on a concurrent profile edit", async () => {
      const profiles = profileFake(
        profileRecord({
          alias: "Bob",
          profileStatus: "active",
          activatedAt: recentActivation,
          version: 2,
        }),
      );
      const replace = vi.mocked(calls(profiles, "replaceProfile"));
      const original = replace.getMockImplementation()!;
      replace.mockImplementationOnce(() =>
        Promise.reject(new ProfileV2VersionConflictError()),
      );
      const { app } = await createApp({ profiles });
      const response = await put(app, "Bobby");
      expect(response.statusCode).toBe(200);
      expect(replace).toHaveBeenCalledTimes(2);
      expect(original).toBeTypeOf("function");

      replace.mockImplementation(() =>
        Promise.reject(new ProfileV2VersionConflictError()),
      );
      const conflict = await put(app, "Bobby 2");
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    });

    it("needs the account first (409 ACCOUNT_BOOTSTRAP_REQUIRED)", async () => {
      const { app, database } = await createApp();
      vi.mocked(
        calls(database.internalUsers, "findByPrivyUserId"),
      ).mockResolvedValueOnce(null);
      const response = await put(app, "Bob");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "ACCOUNT_BOOTSTRAP_REQUIRED",
      });
    });

    it("is 503 when the profile module is off", async () => {
      const { app } = await createApp({
        env: { V2_MODULES_ENABLED: "referral" },
      });
      const response = await put(app, "Bob");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "V2_PROFILE_MODULE_DEFERRED" },
      });
    });
  });

  describe("POST /v2/web/referral/claim", () => {
    function claim(
      app: FastifyInstance,
      value: unknown,
      headers = writeHeaders(),
    ) {
      return app.inject({
        method: "POST",
        url: "/v2/web/referral/claim",
        headers,
        payload: { code: value },
      });
    }

    it("binds with the existing claim service and names the inviter", async () => {
      const referral = referralFake();
      const { app } = await createApp({ referral });
      const response = await claim(app, code.toLowerCase());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "bound",
        inviterLoopId,
      });
      expect(calls(referral, "claim")).toHaveBeenCalledWith(
        expect.objectContaining({
          inviteeUserId: s7AccountId,
          idempotencyKey,
          edges: [{ inviterUserId: inviterId, depth: 1 }],
        }),
      );
    });

    it("answers already_bound for an account that is bound", async () => {
      const referral = referralFake({
        claim: vi.fn(() => Promise.reject(new ReferralAlreadyBoundError())),
      });
      const { app } = await createApp({ referral });
      const same = await claim(app, code);
      expect(same.statusCode).toBe(200);
      expect(same.json()).toEqual({ status: "already_bound", inviterLoopId });

      const other = await createApp({
        referral: referralFake({
          claim: vi.fn(() => Promise.reject(new ReferralAlreadyBoundError())),
          getAncestorChain: vi.fn(() => Promise.resolve([])),
        }),
        web: webFake({
          getDirectInviter: vi.fn(() =>
            Promise.resolve({
              ...inviter,
              userId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            }),
          ),
        }),
      });
      const response = await claim(other.app, code);
      expect(response.json()).toEqual({ status: "already_bound" });
    });

    it("refuses the caller's own code with REFERRAL_SELF_INVITE", async () => {
      const referral = referralFake();
      const { app } = await createApp({ referral });
      const response = await claim(app, ownCode);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: { reasonCode: "REFERRAL_SELF_INVITE" },
      });
      expect(calls(referral, "claim")).not.toHaveBeenCalled();
    });

    it("refuses a cycle with REFERRAL_CYCLE", async () => {
      const { app } = await createApp({
        referral: referralFake({
          getAncestorChain: vi.fn(() => Promise.resolve([s7AccountId])),
        }),
      });
      const response = await claim(app, code);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "REFERRAL_CYCLE" },
      });
    });

    it("binds an account activated 400 days ago (Decision 0181: no claim deadline)", async () => {
      const referral = referralFake({
        getAccountState: vi.fn(() =>
          Promise.resolve({ activatedAt: oldActivation, hasWallet: false }),
        ),
      });
      const { app } = await createApp({ referral });
      const response = await claim(app, code);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "bound", inviterLoopId });
      expect(calls(referral, "claim")).toHaveBeenCalledWith(
        expect.objectContaining({
          inviteeUserId: s7AccountId,
          edges: [{ inviterUserId: inviterId, depth: 1 }],
        }),
      );
      expect(calls(referral, "recordRejectedClaim")).not.toHaveBeenCalled();
    });

    it("needs the username first, then names unknown and malformed codes", async () => {
      const unactivated = await createApp({
        referral: referralFake({
          getAccountState: vi.fn(() =>
            Promise.resolve({ activatedAt: null, hasWallet: false }),
          ),
        }),
      });
      const pending = await claim(unactivated.app, code);
      expect(pending.statusCode).toBe(409);
      expect(pending.json()).toMatchObject({
        code: "PROFILE_ACTIVATION_REQUIRED",
        detailsSafe: { reasonCode: "PROFILE_ACTIVATION_REQUIRED" },
      });

      const { app } = await createApp();
      const unknown = await claim(app, unknownCode);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({
        detailsSafe: { reasonCode: "REFERRAL_CODE_UNKNOWN" },
      });
      const malformed = await claim(app, "LOOP-12");
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({
        detailsSafe: { reasonCode: "REFERRAL_CODE_INVALID" },
      });
      const missingKey = await claim(
        app,
        code,
        writeHeaders({ "idempotency-key": undefined }),
      );
      expect(missingKey.statusCode).toBe(400);
    });

    it("is 503 when the referral module is off", async () => {
      const { app } = await createApp({
        env: { V2_MODULES_ENABLED: "profile" },
      });
      const response = await claim(app, code);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "V2_REFERRAL_MODULE_DEFERRED" },
      });
    });
  });

  describe("GET /v2/web/referral/preview", () => {
    it("names the owner of a valid code without authentication", async () => {
      const { app } = await createApp();
      const response = await app.inject({
        method: "GET",
        url: `/v2/web/referral/preview?code=${code.toLowerCase()}`,
        headers: { origin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        valid: true,
        inviter: { username: "Alice", loopId: inviterLoopId },
      });
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    });

    it("answers valid=false for malformed and unknown codes", async () => {
      const { app } = await createApp();
      for (const value of ["nope", unknownCode, "LOOP-7HJKZ"]) {
        const response = await app.inject({
          method: "GET",
          url: `/v2/web/referral/preview?code=${encodeURIComponent(value)}`,
        });
        expect(response.statusCode, value).toBe(200);
        expect(response.json()).toEqual({ valid: false, inviter: null });
      }
      const missing = await app.inject({
        method: "GET",
        url: "/v2/web/referral/preview",
      });
      expect(missing.statusCode).toBe(400);
    });

    it("limits each visitor per minute with Retry-After", async () => {
      let now = 1_000_000;
      const { app } = await createApp({
        env: { PUBLIC_RATE_LIMIT_PER_MINUTE: "10" },
        nowMs: () => now,
      });
      const get = () =>
        app.inject({
          method: "GET",
          url: `/v2/web/referral/preview?code=${code}`,
          headers: { origin },
        });
      for (let index = 0; index < 10; index += 1) {
        expect((await get()).statusCode).toBe(200);
      }
      const limited = await get();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({
        code: "RATE_LIMITED",
        detailsSafe: { reasonCode: "WEB_RATE_LIMITED" },
      });
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.headers["x-ratelimit-limit"]).toBe("10");
      expect(limited.headers["access-control-allow-origin"]).toBe(origin);
      now += 60_000;
      expect((await get()).statusCode).toBe(200);
    });
  });

  describe("GET /v2/web/meta", () => {
    it("publishes null links by default and the configured ones", async () => {
      const empty = await createApp();
      expect(
        (await empty.app.inject({ method: "GET", url: "/v2/web/meta" })).json(),
      ).toEqual({
        appStore: { ios: null, android: null, testflight: null },
        observedAt: expect.any(String) as string,
      });
      const { app } = await createApp({
        env: {
          WEB_APP_LINKS_IOS: "https://apps.apple.com/app/id1",
          WEB_APP_LINKS_ANDROID: "https://example.com/loop.apk",
          WEB_APP_LINKS_TESTFLIGHT: "https://testflight.apple.com/join/abc",
        },
      });
      expect(
        (await app.inject({ method: "GET", url: "/v2/web/meta" })).json(),
      ).toMatchObject({
        appStore: {
          ios: "https://apps.apple.com/app/id1",
          android: "https://example.com/loop.apk",
          testflight: "https://testflight.apple.com/join/abc",
        },
      });
    });
  });

  describe("GET /i/{code}", () => {
    it("keeps the API's own landing page without WEB_BASE_URL", async () => {
      const { app } = await createApp();
      const response = await app.inject({ method: "GET", url: `/i/${code}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
    });

    it("redirects to the website with the code as given when WEB_BASE_URL is set", async () => {
      const { app } = await createApp({
        env: { WEB_BASE_URL: "https://loop.example/" },
      });
      const response = await app.inject({ method: "GET", url: `/i/${code}` });
      expect(response.statusCode).toBe(302);
      expect(response.headers["location"]).toBe(
        `https://loop.example/i/${code}`,
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      const raw = await app.inject({
        method: "GET",
        url: "/i/loop-7hjk%2F..x",
      });
      expect(raw.statusCode).toBe(302);
      expect(raw.headers["location"]).toBe(
        "https://loop.example/i/loop-7hjk%2F..x",
      );
    });
  });
});

describe("Decision 0179: web surface configuration", () => {
  it("defaults to an unmounted surface with no links", () => {
    expect(parseWebSurfaceConfig({}, "production")).toEqual({
      origins: [],
      baseUrl: null,
      appLinks: { ios: null, android: null, testflight: null },
    });
  });

  it("normalises origins like the Provider origins", () => {
    expect(
      parseWebSurfaceConfig(
        {
          WEB_ORIGINS: " https://LOOP.example/ , https://www.loop.example:443",
          WEB_BASE_URL: "https://loop.example/base/",
        },
        "production",
      ),
    ).toMatchObject({
      origins: ["https://loop.example", "https://www.loop.example"],
      baseUrl: "https://loop.example/base",
    });
    expect(
      parseWebSurfaceConfig(
        { WEB_ORIGINS: "http://localhost:3001" },
        "development",
      ).origins,
    ).toEqual(["http://localhost:3001"]);
  });

  it("refuses unsafe values", () => {
    for (const environment of [
      { WEB_ORIGINS: "http://loop.example" },
      { WEB_ORIGINS: "http://localhost:3001" },
      { WEB_ORIGINS: "https://loop.example/path" },
      { WEB_ORIGINS: "https://loop.example?x=1" },
      { WEB_ORIGINS: "https://user:pw@loop.example" },
      { WEB_ORIGINS: "https://loop.example,https://loop.example/" },
      { WEB_ORIGINS: "https://loop.example,," },
      { WEB_ORIGINS: "*" },
      { WEB_BASE_URL: "http://loop.example" },
      { WEB_BASE_URL: "https://loop.example/?q=1" },
      { WEB_APP_LINKS_IOS: "http://apps.apple.com/app" },
    ]) {
      expect(
        () => parseWebSurfaceConfig(environment, "production"),
        JSON.stringify(environment),
      ).toThrow(ConfigurationError);
    }
  });
});

describe("Decision 0179: web rate limiter", () => {
  it("counts a fixed one-minute window per key", () => {
    let now = 0;
    const limiter = createWebRateLimiter({ perWindow: 2, nowMs: () => now });
    expect(limiter.admit("a")).toBeNull();
    expect(limiter.admit("a")).toBeNull();
    expect(limiter.admit("b")).toBeNull();
    now = 30_000;
    expect(limiter.admit("a")).toBe(30);
    now = 60_000;
    expect(limiter.admit("a")).toBeNull();
  });
});

describe("Decision 0179: web OpenAPI artifact", () => {
  it("is its own deterministic artifact; the App's V2 artifact has no web route", async () => {
    const [first, second, committed, v2] = await Promise.all([
      renderOpenApiWebArtifact(),
      renderOpenApiWebArtifact(),
      readFile(openApiWebArtifactPath, "utf8"),
      readFile(openApiV2ArtifactPath, "utf8"),
    ]);
    expect(committed).toBe(first);
    expect(first).toBe(second);
    expect(v2).not.toContain("/v2/web/");
    const document = JSON.parse(committed) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(
      Object.entries(document.paths)
        .flatMap(([path, methods]) =>
          Object.keys(methods).map(
            (method) => `${method.toUpperCase()} ${path}`,
          ),
        )
        .sort(),
    ).toEqual([
      "GET /health/live",
      "GET /health/ready",
      "GET /v2/web/meta",
      "GET /v2/web/referral/me",
      "GET /v2/web/referral/preview",
      "POST /v2/web/referral/claim",
      "POST /v2/web/session",
      "PUT /v2/web/profile/username",
    ]);
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual([
      "privyBearer",
    ]);
    const writes = [
      document.paths["/v2/web/session"]?.["post"],
      document.paths["/v2/web/profile/username"]?.["put"],
      document.paths["/v2/web/referral/claim"]?.["post"],
    ];
    for (const operation of writes) {
      expect(operation?.["security"]).toEqual([{ privyBearer: [] }]);
      const names = (
        operation?.["parameters"] as { name: string; required?: boolean }[]
      ).map((parameter) => parameter.name);
      expect(names).toEqual(
        expect.arrayContaining(["x-loop-contract-version", "idempotency-key"]),
      );
      expect(names).not.toContain("x-loop-client-version");
      expect(names).not.toContain("x-loop-device-id");
      expect(names).not.toContain("x-loop-platform");
    }
    for (const operation of [
      document.paths["/v2/web/referral/preview"]?.["get"],
      document.paths["/v2/web/meta"]?.["get"],
    ]) {
      expect(operation?.["security"]).toBeUndefined();
      expect(operation?.["tags"]).toEqual(["web"]);
    }
  });
});
