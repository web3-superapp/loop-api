import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { avatarPresets } from "../src/features/profile/avatar-presets.js";
import {
  profileActivationDigest,
  type ProfileV2ActivationValues,
} from "../src/features/profile/profile-v2-contract.js";
import {
  ProfileV2IdempotencyConflictError,
  ProfileV2RepositoryUnavailableError,
  ProfileV2VersionConflictError,
  type PrivacyV2Record,
  type ProfileV2Record,
  type ProfileV2Repository,
} from "../src/features/profile/profile-v2-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const loopId = "LOOP-7HJKMNPQ";
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const validToken = "header.payload.signature";
const updatedAt = "2026-09-07T01:00:00.000Z";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pendingRecord: ProfileV2Record = Object.freeze({
  ownerUserId: accountId,
  loopId,
  alias: null,
  avatarRef: null,
  bio: null,
  interests: Object.freeze([]),
  profileStatus: "pending",
  activatedAt: null,
  version: 0,
  updatedAt: null,
});

const activeRecord: ProfileV2Record = Object.freeze({
  ownerUserId: accountId,
  loopId,
  alias: "Alice",
  avatarRef: "avatar:preset/people-03",
  bio: null,
  interests: Object.freeze(["MEME", "AI"] as const),
  profileStatus: "active",
  activatedAt: updatedAt,
  version: 1,
  updatedAt,
});

const privacyRecord: PrivacyV2Record = Object.freeze({
  ownerUserId: accountId,
  discoverable: true,
  anonymousMode: false,
  visibility: Object.freeze({
    totalAssets: "self",
    miningPower: "everyone",
    communities: "everyone",
    tradeHistory: "self",
  }),
  version: 1,
  updatedAt,
});

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "profile",
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function commonHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function activationHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return commonHeaders({
    "idempotency-key": idempotencyKey,
    "x-loop-device-id": deviceId,
    "x-loop-platform": "ios",
    ...overrides,
  });
}

function fakes(bootstrapped = true) {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: accountId } : null),
  );
  const profilesV2 = {
    getProfile: vi.fn<ProfileV2Repository["getProfile"]>(() =>
      Promise.resolve(pendingRecord),
    ),
    replaceProfile: vi.fn<ProfileV2Repository["replaceProfile"]>((input) =>
      Promise.resolve({
        ...activeRecord,
        ...input.profile,
        profileStatus: "pending",
        activatedAt: null,
        version: input.expectedVersion + 1,
      }),
    ),
    activateProfile: vi.fn<ProfileV2Repository["activateProfile"]>(() =>
      Promise.resolve(activeRecord),
    ),
    getPrivacy: vi.fn<ProfileV2Repository["getPrivacy"]>(() =>
      Promise.resolve(null),
    ),
    replacePrivacy: vi.fn<ProfileV2Repository["replacePrivacy"]>(() =>
      Promise.resolve(privacyRecord),
    ),
  } satisfies ProfileV2Repository;
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    profilesV2,
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId,
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken,
  } satisfies PrivyAccessTokenVerifier;

  return {
    database,
    findByPrivyUserId,
    privyAccessTokenVerifier,
    profilesV2,
    verifyAccessToken,
  };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("LOOP API V2 profile module", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("does not register any profile route when the module is disabled", async () => {
    const { app, verifyAccessToken } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "",
    });
    for (const [method, url] of [
      ["GET", "/v2/profile"],
      ["PUT", "/v2/profile"],
      ["POST", "/v2/profile/loop-id"],
      ["GET", "/v2/profile/privacy"],
      ["PUT", "/v2/profile/privacy"],
      ["GET", "/v2/profile/avatars"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: activationHeaders(),
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    expect(
      capabilities
        .json<{
          capabilities: { capabilityId: string; availability: string }[];
        }>()
        .capabilities.find((entry) => entry.capabilityId === "profile"),
    ).toMatchObject({ availability: "deferred" });
  });

  it("publishes the preset avatar catalog without authentication", async () => {
    const { app, verifyAccessToken } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile/avatars",
    });

    expect(response.statusCode).toBe(200);
    expectOperationalHeaders(response);
    const body = response.json<{
      avatars: { avatarRef: string; atlas: string; slot: number | null }[];
      contractVersion: string;
    }>();
    expect(body.contractVersion).toBe("2.0");
    expect(body.avatars).toHaveLength(13);
    expect(body.avatars).toEqual(avatarPresets);
    expect(body.avatars[0]).toEqual({
      avatarRef: "avatar:preset/people-01",
      atlas: "people",
      slot: 1,
      label: "People 01",
    });
    expect(body.avatars.at(-1)).toEqual({
      avatarRef: "avatar:preset/monogram",
      atlas: "monogram",
      slot: null,
      label: "Monogram",
    });
    expect(verifyAccessToken).not.toHaveBeenCalled();

    const withQuery = await app.inject({
      method: "GET",
      url: "/v2/profile/avatars?x=1",
    });
    expect(withQuery.statusCode).toBe(400);
    expect(withQuery.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const projected = Object.fromEntries(
      capabilities
        .json<{
          capabilities: {
            capabilityId: string;
            availability: string;
            reasonCode: string | null;
          }[];
        }>()
        .capabilities.map((entry) => [entry.capabilityId, entry]),
    );
    expect(projected["profile"]).toMatchObject({ availability: "available" });
    expect(projected["avatarUpload"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "AVATAR_STORAGE_NOT_SELECTED",
    });
  });

  it("returns the version-0 pending default with the account's LOOP ID", async () => {
    const { app, profilesV2 } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile",
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectOperationalHeaders(response);
    expect(response.json()).toEqual({
      profile: {
        loopId,
        alias: null,
        avatarRef: null,
        bio: null,
        interests: [],
        profileStatus: "pending",
        activatedAt: null,
      },
      version: 0,
      updatedAt: null,
      contractVersion: "2.0",
    });
    expect(profilesV2.getProfile).toHaveBeenCalledWith(accountId);
    expect(response.body).not.toContain("did:privy");
    expect(response.body).not.toContain(accountId);
  });

  it("requires bootstrap before reading or writing the profile", async () => {
    const { app, profilesV2 } = await createApp(fakes(false));
    const read = await app.inject({
      method: "GET",
      url: "/v2/profile",
      headers: commonHeaders(),
    });
    expect(read.statusCode).toBe(409);
    expect(read.json()).toMatchObject({
      code: "ACCOUNT_BOOTSTRAP_REQUIRED",
      category: "authentication",
    });

    const activate = await app.inject({
      method: "POST",
      url: "/v2/profile/loop-id",
      headers: activationHeaders(),
      payload: { alias: "Alice", avatarRef: null, interests: [] },
    });
    expect(activate.statusCode).toBe(409);
    expect(activate.json()).toMatchObject({
      code: "ACCOUNT_BOOTSTRAP_REQUIRED",
    });
    expect(profilesV2.getProfile).not.toHaveBeenCalled();
    expect(profilesV2.activateProfile).not.toHaveBeenCalled();
  });

  it("returns the Bearer challenge and never calls Privy without a token", async () => {
    const { app, verifyAccessToken } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile",
      headers: commonHeaders({ authorization: undefined }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("replaces the profile with CAS semantics and no client Idempotency-Key", async () => {
    const { app, profilesV2 } = await createApp();
    const body = {
      expectedVersion: 0,
      profile: {
        alias: "  Alice  ",
        avatarRef: "avatar:preset/people-05",
        bio: "  Building on LOOP  ",
        interests: ["DEFI", "AI", "DEFI"],
      },
    };
    const response = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: commonHeaders(),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expectOperationalHeaders(response);
    expect(response.json()).toMatchObject({
      profile: {
        loopId,
        alias: "Alice",
        avatarRef: "avatar:preset/people-05",
        bio: "Building on LOOP",
        interests: ["DEFI", "AI"],
        profileStatus: "pending",
      },
      version: 1,
      contractVersion: "2.0",
    });
    expect(profilesV2.replaceProfile).toHaveBeenCalledWith({
      ownerUserId: accountId,
      expectedVersion: 0,
      profile: {
        alias: "Alice",
        avatarRef: "avatar:preset/people-05",
        bio: "Building on LOOP",
        interests: ["DEFI", "AI"],
      },
    });

    const withKey = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: commonHeaders({ "idempotency-key": idempotencyKey }),
      payload: body,
    });
    expect(withKey.statusCode).toBe(400);
    expect(withKey.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(profilesV2.replaceProfile).toHaveBeenCalledTimes(1);
  });

  it("maps a stale expectedVersion to VERSION_CONFLICT", async () => {
    const dependencies = fakes();
    dependencies.profilesV2.replaceProfile.mockRejectedValueOnce(
      new ProfileV2VersionConflictError(),
    );
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "PUT",
      url: "/v2/profile",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 3,
        profile: {
          alias: "Changed",
          avatarRef: null,
          bio: null,
          interests: [],
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      category: "conflict",
      retryable: false,
    });
  });

  it.each([
    ["reserved word", "admin", "ALIAS_RESERVED"],
    ["reserved word with digits", "LOOP2026", "ALIAS_RESERVED"],
    ["reserved compound", "loop_official", "ALIAS_RESERVED"],
    ["blocked term", "Best scam coin", "ALIAS_BLOCKED"],
    ["full-width blocked term", "ｓｃａｍ", "ALIAS_BLOCKED"],
  ])(
    "rejects a %s alias with %s on both write routes",
    async (_label, alias, code) => {
      const { app, profilesV2 } = await createApp(fakes(), {
        V2_ALIAS_BLOCKED_TERMS: "scam, rug pull",
      });
      const replaced = await app.inject({
        method: "PUT",
        url: "/v2/profile",
        headers: commonHeaders(),
        payload: {
          expectedVersion: 0,
          profile: { alias, avatarRef: null, bio: null, interests: [] },
        },
      });
      expect(replaced.statusCode).toBe(422);
      expect(replaced.json()).toMatchObject({
        code,
        category: "validation",
        retryable: false,
        detailsSafe: null,
      });

      const activated = await app.inject({
        method: "POST",
        url: "/v2/profile/loop-id",
        headers: activationHeaders(),
        payload: { alias, avatarRef: null, interests: [] },
      });
      expect(activated.statusCode).toBe(422);
      expect(activated.json()).toMatchObject({ code });
      expect(profilesV2.replaceProfile).not.toHaveBeenCalled();
      expect(profilesV2.activateProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "bidirectional control in alias",
      { alias: "safe‮unsafe", avatarRef: null, bio: null, interests: [] },
      400,
    ],
    [
      "blank alias",
      { alias: "   ", avatarRef: null, bio: null, interests: [] },
      400,
    ],
    [
      "alias over 40 code points",
      { alias: "a".repeat(41), avatarRef: null, bio: null, interests: [] },
      422,
    ],
    [
      "bio over 160 code points",
      { alias: "Alice", avatarRef: null, bio: "b".repeat(161), interests: [] },
      422,
    ],
    [
      "zero-width character in bio",
      { alias: "Alice", avatarRef: null, bio: "hi​there", interests: [] },
      400,
    ],
    [
      "non-preset avatar reference",
      {
        alias: "Alice",
        avatarRef: "avatar:alice/main",
        bio: null,
        interests: [],
      },
      400,
    ],
    [
      "unknown interest",
      { alias: "Alice", avatarRef: null, bio: null, interests: ["PERP"] },
      400,
    ],
    [
      "too many interests",
      {
        alias: "Alice",
        avatarRef: null,
        bio: null,
        interests: ["MEME", "DEFI", "AI", "GAMEFI", "NFT", "RWA", "MEME"],
      },
      400,
    ],
    [
      "authority field",
      {
        alias: "Alice",
        avatarRef: null,
        bio: null,
        interests: [],
        loopId: "LOOP-AAAAAAAA",
      },
      400,
    ],
  ] as const)(
    "rejects %s before persistence",
    async (_label, profile, statusCode) => {
      const { app, profilesV2 } = await createApp();
      const response = await app.inject({
        method: "PUT",
        url: "/v2/profile",
        headers: commonHeaders(),
        payload: { expectedVersion: 0, profile },
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        code: statusCode === 400 ? "INVALID_REQUEST" : "VALIDATION_FAILED",
        category: "validation",
      });
      expect(profilesV2.replaceProfile).not.toHaveBeenCalled();
    },
  );

  it("activates the LOOP ID under an owner/route/digest-bound idempotency key", async () => {
    const { app, profilesV2 } = await createApp();
    const values: ProfileV2ActivationValues = {
      alias: "Alice",
      avatarRef: "avatar:preset/people-03",
      interests: ["MEME", "AI"],
    };
    const response = await app.inject({
      method: "POST",
      url: "/v2/profile/loop-id",
      headers: activationHeaders(),
      payload: {
        ...values,
        alias: " Alice ",
        interests: ["MEME", "AI", "MEME"],
      },
    });

    expect(response.statusCode).toBe(200);
    expectOperationalHeaders(response);
    expect(response.json()).toEqual({
      profile: {
        loopId,
        alias: "Alice",
        avatarRef: "avatar:preset/people-03",
        bio: null,
        interests: ["MEME", "AI"],
        profileStatus: "active",
        activatedAt: updatedAt,
      },
      version: 1,
      updatedAt,
      contractVersion: "2.0",
    });
    const input = profilesV2.activateProfile.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ownerUserId: accountId,
      idempotencyKey,
      profile: values,
    });
    expect(input?.requestSha256).toBe(profileActivationDigest(values, "2.0"));
    expect(input?.requestId).toMatch(requestIdPattern);
  });

  it("returns the current resource on replay and conflicts on a different body", async () => {
    const dependencies = fakes();
    dependencies.profilesV2.activateProfile
      .mockResolvedValueOnce(activeRecord)
      .mockRejectedValueOnce(new ProfileV2IdempotencyConflictError());
    const { app } = await createApp(dependencies);

    const replay = await app.inject({
      method: "POST",
      url: "/v2/profile/loop-id",
      headers: activationHeaders(),
      payload: {
        alias: "Alice",
        avatarRef: "avatar:preset/people-03",
        interests: ["MEME", "AI"],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      profile: { profileStatus: "active" },
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v2/profile/loop-id",
      headers: activationHeaders(),
      payload: { alias: "Bob", avatarRef: null, interests: [] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      category: "conflict",
      retryable: false,
    });
  });

  it.each([
    ["missing Idempotency-Key", { "idempotency-key": undefined }],
    [
      "uppercase Idempotency-Key",
      { "idempotency-key": idempotencyKey.toUpperCase() },
    ],
    ["missing device ID", { "x-loop-device-id": undefined }],
    ["invalid platform", { "x-loop-platform": "web" }],
    ["unknown LOOP authority", { "x-loop-account-id": accountId }],
  ])(
    "rejects activation with %s before authentication",
    async (_label, overrides) => {
      const { app, verifyAccessToken, profilesV2 } = await createApp();
      const response = await app.inject({
        method: "POST",
        url: "/v2/profile/loop-id",
        headers: activationHeaders(overrides),
        payload: { alias: "Alice", avatarRef: null, interests: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(profilesV2.activateProfile).not.toHaveBeenCalled();
    },
  );

  it("rejects a foreign contract version before authentication", async () => {
    const { app, verifyAccessToken } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile",
      headers: commonHeaders({ "x-loop-contract-version": "1.0" }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns fail-closed privacy defaults and replaces them with CAS", async () => {
    const { app, profilesV2 } = await createApp();
    const defaults = await app.inject({
      method: "GET",
      url: "/v2/profile/privacy",
      headers: commonHeaders(),
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toEqual({
      privacy: {
        discoverable: false,
        anonymousMode: false,
        visibility: {
          totalAssets: "self",
          miningPower: "self",
          communities: "self",
          tradeHistory: "self",
        },
      },
      version: 0,
      updatedAt: null,
      contractVersion: "2.0",
    });
    expect(defaults.body).not.toContain("copyTrade");

    const body = {
      expectedVersion: 0,
      privacy: {
        discoverable: true,
        anonymousMode: false,
        visibility: {
          totalAssets: "self",
          miningPower: "everyone",
          communities: "everyone",
          tradeHistory: "self",
        },
      },
    };
    const replaced = await app.inject({
      method: "PUT",
      url: "/v2/profile/privacy",
      headers: commonHeaders(),
      payload: body,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toEqual({
      privacy: body.privacy,
      version: 1,
      updatedAt,
      contractVersion: "2.0",
    });
    expect(profilesV2.replacePrivacy).toHaveBeenCalledWith({
      ownerUserId: accountId,
      expectedVersion: 0,
      privacy: body.privacy,
    });

    const legacyField = await app.inject({
      method: "PUT",
      url: "/v2/profile/privacy",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 0,
        privacy: { ...body.privacy, copyTradeVisibility: "public" },
      },
    });
    expect(legacyField.statusCode).toBe(400);
    expect(legacyField.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const withKey = await app.inject({
      method: "PUT",
      url: "/v2/profile/privacy",
      headers: commonHeaders({ "idempotency-key": idempotencyKey }),
      payload: body,
    });
    expect(withKey.statusCode).toBe(400);
    expect(profilesV2.replacePrivacy).toHaveBeenCalledTimes(1);
  });

  it("fails closed with CAPABILITY_UNAVAILABLE when the repository is unavailable", async () => {
    const dependencies = fakes();
    dependencies.profilesV2.getProfile.mockRejectedValueOnce(
      new ProfileV2RepositoryUnavailableError(),
    );
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile",
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
    });
    expect(response.body).not.toContain("repository");
  });

  it("returns the seven-field envelope for every profile error", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/profile?owner=forbidden",
      headers: commonHeaders(),
    });
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(400);
    expect(Object.keys(body).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    expect(body["correlationId"]).toBe(response.headers["x-request-id"]);
  });
});
