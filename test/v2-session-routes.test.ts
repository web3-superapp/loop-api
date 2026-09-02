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
import {
  DeviceSessionIdempotencyConflictError,
  DeviceSessionRateLimitedError,
  type DeviceSessionRepository,
} from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const validToken = "header.payload.signature";
const createdAt = "2026-09-02T01:00:00.000Z";
const revokedAt = "2026-09-02T02:00:00.000Z";

function testConfig(sessionEnabled = true) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_SESSION_ENABLED: sessionEnabled ? "true" : "false",
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  });
}

function requestHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "idempotency-key": idempotencyKey,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
    "x-loop-device-id": deviceId,
    "x-loop-platform": "ios",
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

function commonRequestHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
}

function fakes() {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const getOrCreateByPrivyUserId = vi.fn<
    InternalUserRepository["getOrCreateByPrivyUserId"]
  >(() => Promise.resolve({ id: accountId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: accountId }),
  );
  const bootstrapSession = vi.fn<
    DeviceSessionRepository["bootstrapVerifiedPrivyUser"]
  >(() =>
    Promise.resolve({
      account: { id: accountId },
      session: {
        sessionId,
        ownerUserId: accountId,
        deviceId,
        clientPlatform: "ios",
        clientVersion: "1.2.3",
        authStrength: "providerAuthenticated",
        policyVersion: "sessionPolicyV1",
        status: "active",
        createdAt,
        lastSeenAt: createdAt,
        revokedAt: null,
      },
    }),
  );
  const createSession = vi.fn<DeviceSessionRepository["create"]>(() =>
    Promise.resolve({
      sessionId,
      ownerUserId: accountId,
      deviceId,
      clientPlatform: "ios",
      clientVersion: "1.2.3",
      authStrength: "providerAuthenticated",
      policyVersion: "sessionPolicyV1",
      status: "active",
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
    }),
  );
  const revokeSession = vi.fn<DeviceSessionRepository["revoke"]>(() =>
    Promise.resolve({
      sessionId,
      ownerUserId: accountId,
      deviceId,
      clientPlatform: "ios",
      clientVersion: "1.2.3",
      authStrength: "providerAuthenticated",
      policyVersion: "sessionPolicyV1",
      status: "revoked",
      createdAt,
      lastSeenAt: createdAt,
      revokedAt,
    }),
  );
  const deviceSessions = {
    bootstrapVerifiedPrivyUser: bootstrapSession,
    create: createSession,
    findById: vi.fn<DeviceSessionRepository["findById"]>(() =>
      Promise.resolve(null),
    ),
    revoke: revokeSession,
  } satisfies DeviceSessionRepository;
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions,
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: { findByPrivyUserId, getOrCreateByPrivyUserId },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken,
  } satisfies PrivyAccessTokenVerifier;

  return {
    bootstrapSession,
    createSession,
    database,
    findByPrivyUserId,
    getOrCreateByPrivyUserId,
    privyAccessTokenVerifier,
    revokeSession,
    verifyAccessToken,
  };
}

describe("LOOP API V2 account sessions", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(dependencies = fakes(), sessionEnabled = true) {
    const app = await buildApp({
      config: testConfig(sessionEnabled),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers the LOOP account and creates an owner-bound device session", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      account: { accountId },
      session: {
        sessionId,
        deviceId,
        status: "active",
        authStrength: "providerAuthenticated",
        policyVersion: "sessionPolicyV1",
        createdAt,
        lastSeenAt: createdAt,
        revokedAt: null,
      },
      communication: { streamUserId },
      contractVersion: "2.0",
    });
    expect(dependencies.verifyAccessToken).toHaveBeenCalledWith(validToken);
    expect(dependencies.getOrCreateByPrivyUserId).not.toHaveBeenCalled();
    const bootstrapInput = dependencies.bootstrapSession.mock.calls[0]?.[0];
    expect(bootstrapInput).toMatchObject({
      privyUserId: "did:privy:verified-user",
      idempotencyKey,
      deviceId,
      clientPlatform: "ios",
      clientVersion: "1.2.3",
    });
    expect(bootstrapInput?.requestSha256).toBe(
      "440bd74013612f22fca29ca408c13701f5c1779a14b83b46b21f1d2f9d3eda5b",
    );
    expect(bootstrapInput?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body).not.toContain("did:privy");
    expect(response.body).not.toContain("email");
    expect(response.body).not.toContain("wallet");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("accepts SemVer 2.0 prerelease and build client metadata", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders({
        "x-loop-client-version": "1.2.3-beta.1+42",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(dependencies.bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientVersion: "1.2.3-beta.1+42" }),
    );
  });

  it("publishes fail-closed client policy and capability metadata without authentication", async () => {
    const { app } = await createApp();
    const [policyResponse, capabilitiesResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/v2/meta/client-policy" }),
      app.inject({ method: "GET", url: "/v2/meta/capabilities" }),
    ]);

    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json()).toMatchObject({
      contractVersion: "2.0",
      defaultRoute: "community",
      navigation: {
        primaryTabs: ["community", "mining", "launch", "market", "wallet"],
      },
      versionGate: { status: "unavailable" },
      regionGate: { status: "unavailable" },
      termsGate: { status: "unavailable" },
    });
    expect(capabilitiesResponse.statusCode).toBe(200);
    const capabilities = capabilitiesResponse.json<{
      readonly contractVersion: string;
      readonly capabilities: readonly {
        readonly capabilityId: string;
        readonly availability: string;
        readonly evidence: {
          readonly status: string;
          readonly reasonCode: string | null;
        };
      }[];
    }>();
    expect(capabilities.contractVersion).toBe("2.0");
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capabilityId === "accountSession",
      ),
    ).toMatchObject({
      availability: "available",
      evidence: { status: "pending" },
    });
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capabilityId === "streamChatToken",
      )?.availability,
    ).toBe("unavailable");
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capabilityId === "bscRead",
      )?.availability,
    ).toBe("deferred");
    expect(
      Object.fromEntries(
        capabilities.capabilities.map((capability) => [
          capability.capabilityId,
          capability.availability,
        ]),
      ),
    ).toMatchObject({
      bridge: "deferred",
      communityAi: "deferred",
      dappExecution: "deferred",
      launch: "deferred",
      mining: "deferred",
      pay: "deferred",
      privySwap: "deferred",
      pushNotifications: "deferred",
      sendApprovals: "deferred",
      walletRead: "deferred",
    });
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capabilityId === "pushNotifications",
      ),
    ).toMatchObject({
      availability: "deferred",
      reasonCode: "PUSH_RUNTIME_DEFERRED",
      evidence: { status: "notApplicable", reasonCode: null },
    });
  });

  it("rejects query input on public metadata with the V2 envelope", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy?unexpected=1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_REQUEST",
      correlationId: response.headers["x-request-id"],
    });
  });

  it.each([
    ["missing device ID", { "x-loop-device-id": undefined }],
    ["uppercase UUID", { "x-loop-device-id": deviceId.toUpperCase() }],
    ["invalid platform", { "x-loop-platform": "web" }],
    ["leading-zero core version", { "x-loop-client-version": "01.2.3" }],
    ["leading-zero prerelease", { "x-loop-client-version": "1.2.3-01" }],
    ["empty prerelease", { "x-loop-client-version": "1.2.3-." }],
    ["empty build", { "x-loop-client-version": "1.2.3+." }],
    ["unknown LOOP authority", { "x-loop-account-id": accountId }],
    ["logout session on bootstrap", { "x-loop-session-id": sessionId }],
  ])(
    "rejects %s before authentication or persistence",
    async (_name, overrides) => {
      const dependencies = await createApp();
      const response = await dependencies.app.inject({
        method: "POST",
        url: "/v2/session/bootstrap",
        headers: requestHeaders(overrides),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect(dependencies.verifyAccessToken).not.toHaveBeenCalled();
      expect(dependencies.getOrCreateByPrivyUserId).not.toHaveBeenCalled();
      expect(dependencies.bootstrapSession).not.toHaveBeenCalled();
      expect(dependencies.createSession).not.toHaveBeenCalled();
    },
  );

  it("rejects a different contract version before authentication", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders({ "x-loop-contract-version": "2" }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      category: "conflict",
      retryable: false,
    });
    expect(dependencies.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns the V2 Bearer challenge without calling Privy when auth is missing", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders({ authorization: undefined }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(dependencies.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns the current account without treating local session state as authentication", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "GET",
      url: "/v2/account/me",
      headers: commonRequestHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      account: { accountId },
      authentication: {
        provider: "privy",
        authStrength: "providerAuthenticated",
      },
      communication: { streamUserId },
      policyVersion: "sessionPolicyV1",
      contractVersion: "2.0",
    });
    expect(dependencies.findByPrivyUserId).toHaveBeenCalledWith(
      "did:privy:verified-user",
    );
    expect(
      dependencies.database.deviceSessions.findById,
    ).not.toHaveBeenCalled();
  });

  it("requires bootstrap when the Privy identity has no LOOP account", async () => {
    const dependencies = fakes();
    dependencies.findByPrivyUserId.mockResolvedValueOnce(null);
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/v2/account/me",
      headers: commonRequestHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ACCOUNT_BOOTSTRAP_REQUIRED",
    });
  });

  it("revokes the projection and requires the client to log out from Privy", async () => {
    const dependencies = await createApp();
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/logout",
      headers: requestHeaders({ "x-loop-session-id": sessionId }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: { sessionId, status: "revoked", revokedAt },
      providerLogoutRequired: true,
      contractVersion: "2.0",
    });
    const revokeInput = dependencies.revokeSession.mock.calls[0]?.[0];
    expect(revokeInput).toMatchObject({
      ownerUserId: accountId,
      sessionId,
      idempotencyKey,
    });
    expect(revokeInput?.requestSha256).toBe(
      "dc507491fe9bc7aa6a6a5f26a26b647c281325aa1460d4b53f2d6a04819e59d8",
    );
  });

  it("uses one non-enumerating not-found result for missing and foreign sessions", async () => {
    const dependencies = fakes();
    dependencies.revokeSession.mockResolvedValueOnce(null);
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/v2/session/logout",
      headers: requestHeaders({ "x-loop-session-id": sessionId }),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("maps idempotency conflicts to the stable V2 envelope", async () => {
    const dependencies = fakes();
    dependencies.bootstrapSession.mockRejectedValueOnce(
      new DeviceSessionIdempotencyConflictError(),
    );
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      category: "conflict",
      retryable: false,
    });
  });

  it("maps the persistent-session creation bound to RATE_LIMITED", async () => {
    const dependencies = fakes();
    dependencies.bootstrapSession.mockRejectedValueOnce(
      new DeviceSessionRateLimitedError(),
    );
    const { app } = await createApp(dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "RATE_LIMITED",
      category: "rateLimit",
      retryable: true,
    });
  });

  it("fails closed when the session capability is disabled", async () => {
    const dependencies = await createApp(fakes(), false);
    const response = await dependencies.app.inject({
      method: "POST",
      url: "/v2/session/bootstrap",
      headers: requestHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
    });
    expect(dependencies.bootstrapSession).not.toHaveBeenCalled();
    expect(dependencies.createSession).not.toHaveBeenCalled();
  });

  it("returns the exact sanitized V2 not-found envelope", async () => {
    const { app } = await createApp();
    const response = await app.inject({ method: "GET", url: "/v2/missing" });
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(404);
    expect(Object.keys(body).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      correlationId: response.headers["x-request-id"],
      detailsSafe: null,
      providerReferenceSafe: null,
    });
  });
});
