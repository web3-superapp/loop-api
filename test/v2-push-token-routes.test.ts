import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import {
  PushIdempotencyConflictError,
  PushSessionInvalidError,
  type PushRepository,
  type PushTokenRecord,
} from "../src/features/push/push-repository.js";
import type {
  DeviceSession,
  DeviceSessionRepository,
} from "../src/features/session/device-session-repository.js";
import type { FcmSender } from "../src/integrations/fcm/fcm-sender.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

/**
 * `POST`/`DELETE /v2/devices/push-token` (Decision 0067). The FCM sender is a
 * fake: the suite proves the route contract, not a Provider account.
 */

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const sessionId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const deviceId = "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60";
const idempotencyKey = "4f605172-8d9e-4fa0-8123-3d4e5f607182";
const pushTokenId = "5a716283-9eaf-4ab1-9234-4e5f60718293";
const registrationToken = `fcm-${"a".repeat(60)}`;
const now = new Date("2026-09-22T02:00:00.000Z");

function tokenRecord(
  overrides: Partial<PushTokenRecord> = {},
): PushTokenRecord {
  return {
    pushTokenId,
    ownerUserId: accountId,
    sessionId,
    deviceId,
    platform: "ios",
    tokenSha256: "b".repeat(64),
    appVersion: "1.2.3",
    status: "active",
    registeredAt: now.toISOString(),
    lastObservedAt: now.toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

const activeSession: DeviceSession = {
  sessionId,
  ownerUserId: accountId,
  deviceId,
  clientPlatform: "ios",
  clientVersion: "1.0.0",
  authStrength: "providerAuthenticated",
  policyVersion: "sessionPolicyV1",
  status: "active",
  createdAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  revokedAt: null,
};

function deviceSessionsFake(): DeviceSessionRepository {
  return {
    bootstrapVerifiedPrivyUser: () => Promise.reject(new Error("not used")),
    create: () => Promise.reject(new Error("not used")),
    findById: (ownerUserId, requestedSessionId) =>
      Promise.resolve(
        ownerUserId === accountId && requestedSessionId === sessionId
          ? activeSession
          : null,
      ),
    listByOwner: () => Promise.resolve([activeSession]),
    revoke: () => Promise.reject(new Error("not used")),
  };
}

function pushFake(
  options: {
    readonly registerError?: Error;
    readonly registered?: boolean;
  } = {},
) {
  const registerToken = vi.fn<PushRepository["registerToken"]>((input) => {
    if (options.registerError !== undefined) {
      return Promise.reject(options.registerError);
    }
    return Promise.resolve({
      created: true,
      token: tokenRecord({
        platform: input.platform,
        appVersion: input.appVersion,
      }),
    });
  });
  const unregisterToken = vi.fn<PushRepository["unregisterToken"]>(() =>
    Promise.resolve(
      options.registered === false
        ? { unregistered: false, revokedAt: null }
        : { unregistered: true, revokedAt: now.toISOString() },
    ),
  );
  const repository: PushRepository = {
    registerToken,
    unregisterToken,
    findActiveTokenBySession: () => Promise.resolve(null),
    listOwnerTargets: () => Promise.resolve([]),
    listCommunityTargets: () => Promise.resolve([]),
    reserveDelivery: () => Promise.reject(new Error("not used")),
    completeDelivery: () => Promise.reject(new Error("not used")),
    revokeToken: () => Promise.reject(new Error("not used")),
  };
  return { repository, registerToken, unregisterToken };
}

const senderFake: FcmSender = {
  projectId: "loop-test",
  send: () => Promise.resolve({ outcome: "sent", providerMessageRef: null }),
};

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "security,notifications",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function fakes(push = pushFake()) {
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: deviceSessionsFake(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    push: push.repository,
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: accountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  } satisfies PrivyAccessTokenVerifier;
  return { database, privyAccessTokenVerifier, push };
}

const commandHeaders = {
  authorization: `Bearer ${validToken}`,
  "x-loop-contract-version": "2.0",
  "x-loop-client-version": "1.0.0",
  "x-loop-platform": "ios",
  "x-loop-device-id": deviceId,
  "x-loop-session-id": sessionId,
  "idempotency-key": idempotencyKey,
} as const;

const body = {
  platform: "ios",
  token: registrationToken,
  appVersion: "1.2.3",
} as const;

function expectEnvelope(
  response: LightMyRequestResponse,
  status: number,
  code: string,
): Record<string, unknown> {
  expect(response.statusCode).toBe(status);
  const payload = response.json<Record<string, unknown>>();
  expect(Object.keys(payload).sort()).toEqual([
    "category",
    "code",
    "correlationId",
    "detailsSafe",
    "providerReferenceSafe",
    "retryable",
    "userMessageKey",
  ]);
  expect(payload["code"]).toBe(code);
  return payload;
}

describe("LOOP API V2 device push token", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    options: {
      readonly sender?: FcmSender | null;
      readonly overrides?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const app = await buildApp({
      config: testConfig(options.overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      fcmSender: options.sender === undefined ? senderFake : options.sender,
      securityNow: () => now,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers the caller session's token and reports the capability as available", async () => {
    const { app, push } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      registered: true,
      pushTokenId,
      platform: "ios",
      provider: "fcm",
      appVersion: "1.2.3",
      observedAt: now.toISOString(),
      contractVersion: "2.0",
    });
    // The registration token is never echoed back.
    expect(response.payload).not.toContain(registrationToken);
    expect(push.registerToken).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: accountId,
        sessionId,
        deviceId,
        platform: "ios",
        token: registrationToken,
        idempotencyKey,
      }),
    );

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const push2 = capabilities
      .json<{
        readonly capabilities: readonly {
          readonly capabilityId: string;
          readonly availability: string;
          readonly evidence: { readonly reasonCode: string | null };
        }[];
      }>()
      .capabilities.find((entry) => entry.capabilityId === "pushNotifications");
    expect(push2).toMatchObject({
      availability: "available",
      evidence: { reasonCode: "PUSH_DEVICE_DELIVERY_EVIDENCE_PENDING" },
    });
  });

  it("refuses registration and keeps the capability deferred without a credential", async () => {
    const { app, push } = await createApp(fakes(), { sender: null });
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: body,
    });
    const envelope = expectEnvelope(response, 503, "CAPABILITY_UNAVAILABLE");
    expect(envelope["detailsSafe"]).toEqual({
      reasonCode: "PUSH_RUNTIME_DEFERRED",
    });
    expect(push.registerToken).not.toHaveBeenCalled();

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    expect(
      capabilities
        .json<{
          readonly capabilities: readonly {
            readonly capabilityId: string;
            readonly availability: string;
            readonly reasonCode: string | null;
          }[];
        }>()
        .capabilities.find(
          (entry) => entry.capabilityId === "pushNotifications",
        ),
    ).toMatchObject({
      availability: "unavailable",
      reasonCode: "PUSH_RUNTIME_DEFERRED",
    });
  });

  it("refuses a body platform that disagrees with the session header", async () => {
    const { app, push } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: { ...body, platform: "android" },
    });
    expectEnvelope(response, 400, "INVALID_REQUEST");
    expect(push.registerToken).not.toHaveBeenCalled();
  });

  it("refuses an unknown field, a short token, and a non-semver app version", async () => {
    const { app } = await createApp();
    for (const payload of [
      { ...body, extra: "x" },
      { ...body, token: "short" },
      { ...body, appVersion: "1.2" },
      { platform: "ios", token: registrationToken },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v2/devices/push-token",
        headers: commandHeaders,
        payload,
      });
      expectEnvelope(response, 400, "INVALID_REQUEST");
    }
  });

  it("requires the session, device, platform, and idempotency headers", async () => {
    const { app } = await createApp();
    for (const omitted of [
      "x-loop-session-id",
      "x-loop-device-id",
      "x-loop-platform",
      "idempotency-key",
      "x-loop-contract-version",
    ]) {
      const headers = Object.fromEntries(
        Object.entries(commandHeaders).filter(([key]) => key !== omitted),
      );
      const response = await app.inject({
        method: "POST",
        url: "/v2/devices/push-token",
        headers,
        payload: body,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
  });

  it("reports a revoked or foreign session as SESSION_NOT_FOUND", async () => {
    const { app } = await createApp(
      fakes(pushFake({ registerError: new PushSessionInvalidError() })),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: body,
    });
    expectEnvelope(response, 404, "SESSION_NOT_FOUND");
  });

  it("reports a reused idempotency key with another request as a conflict", async () => {
    const { app } = await createApp(
      fakes(pushFake({ registerError: new PushIdempotencyConflictError() })),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: body,
    });
    expectEnvelope(response, 409, "IDEMPOTENCY_CONFLICT");
  });

  it("unregisters idempotently, including with no credential configured", async () => {
    const { app, push } = await createApp(fakes(), { sender: null });
    const response = await app.inject({
      method: "DELETE",
      url: "/v2/devices/push-token",
      headers: { ...commandHeaders, "idempotency-key": randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      registered: false,
      revokedAt: now.toISOString(),
      observedAt: now.toISOString(),
      contractVersion: "2.0",
    });
    expect(push.unregisterToken).toHaveBeenCalledOnce();
  });

  it("answers 200 with a null revokedAt when the session had no token", async () => {
    const { app } = await createApp(fakes(pushFake({ registered: false })));
    const response = await app.inject({
      method: "DELETE",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      registered: false,
      revokedAt: null,
    });
  });

  it("refuses a body on the removal route", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/v2/devices/push-token",
      headers: { ...commandHeaders, "content-type": "application/json" },
      payload: body,
    });
    expectEnvelope(response, 400, "INVALID_REQUEST");
  });

  it("stays unavailable when the push repository is not composed", async () => {
    const dependencies = fakes();
    const database = { ...dependencies.database };
    delete (database as { push?: unknown }).push;
    const { app } = await createApp({ ...dependencies, database });
    const response = await app.inject({
      method: "POST",
      url: "/v2/devices/push-token",
      headers: commandHeaders,
      payload: body,
    });
    expectEnvelope(response, 503, "CAPABILITY_UNAVAILABLE");
  });
});
