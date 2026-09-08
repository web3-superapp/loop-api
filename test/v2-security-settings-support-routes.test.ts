import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import type {
  NotificationRecord,
  NotificationRepository,
} from "../src/database/notification-repository.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { securityCapabilityIds } from "../src/features/security/security-contract.js";
import type {
  DeviceSession,
  DeviceSessionRepository,
} from "../src/features/session/device-session-repository.js";
import {
  AccountSettingsVersionConflictError,
  type AccountSettingsRecord,
  type AccountSettingsRepository,
} from "../src/features/settings/account-settings-repository.js";
import {
  SupportTicketIdempotencyConflictError,
  type SupportTicketRecord,
  type SupportTicketRepository,
} from "../src/features/support/support-ticket-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherAccountId = "7e23b97f-5245-48f7-a423-d6f086b41066";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const currentSessionId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const otherSessionId = "1c3d2e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f";
const currentDeviceId = "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60";
const otherDeviceId = "3e5f4061-7c8d-4e9f-9012-2c3d4e5f6071";
const idempotencyKey = "4f605172-8d9e-4fa0-8123-3d4e5f607182";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const now = new Date("2026-09-09T02:00:00.000Z");

function session(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    sessionId: currentSessionId,
    ownerUserId: accountId,
    deviceId: currentDeviceId,
    clientPlatform: "ios",
    clientVersion: "1.0.0",
    authStrength: "providerAuthenticated",
    policyVersion: "sessionPolicyV1",
    status: "active",
    createdAt: "2026-09-08T20:00:00.000Z",
    lastSeenAt: "2026-09-08T20:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function deviceSessionsFake(seed: readonly DeviceSession[]) {
  const rows = new Map(seed.map((row) => [row.sessionId, row]));
  const revoke = vi.fn<DeviceSessionRepository["revoke"]>((input) => {
    const row = rows.get(input.sessionId);
    if (row === undefined || row.ownerUserId !== input.ownerUserId) {
      return Promise.resolve(null);
    }
    const revoked: DeviceSession =
      row.status === "revoked"
        ? row
        : { ...row, status: "revoked", revokedAt: now.toISOString() };
    rows.set(row.sessionId, revoked);
    return Promise.resolve(revoked);
  });
  const repository: DeviceSessionRepository = {
    bootstrapVerifiedPrivyUser: () => Promise.reject(new Error("not used")),
    create: () => Promise.reject(new Error("not used")),
    findById: (ownerUserId, sessionId) =>
      Promise.resolve(
        [...rows.values()].find(
          (row) =>
            row.ownerUserId === ownerUserId && row.sessionId === sessionId,
        ) ?? null,
      ),
    listByOwner: (ownerUserId, limit) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => row.ownerUserId === ownerUserId)
          .slice(0, limit),
      ),
    revoke,
  };
  return { repository, revoke, rows };
}

function notification(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    notificationId: randomUUID(),
    ownerUserId: accountId,
    type: "security.event",
    entityRef: `deviceSession:${otherSessionId}`,
    contextRoute: "devices",
    contextParams: {},
    payload: { event: "session_revoked" },
    dedupeKey: randomUUID(),
    source: null,
    observedAt: null,
    readAt: null,
    createdAt: "2026-09-08T21:00:00.000Z",
    createdAtCursor: "2026-09-08T21:00:00.000000Z",
    ...overrides,
  };
}

function notificationsFake(seed: readonly NotificationRecord[]) {
  const rows = [...seed];
  const record = vi.fn<NotificationRepository["record"]>((input) => {
    if (rows.some((row) => row.dedupeKey === input.dedupeKey)) {
      return Promise.resolve(null);
    }
    const row: NotificationRecord = {
      ...input,
      notificationId: randomUUID(),
      readAt: null,
      createdAt: now.toISOString(),
      createdAtCursor: now.toISOString().replace("Z", "000Z"),
    };
    rows.unshift(row);
    return Promise.resolve(row);
  });
  const repository: NotificationRepository = {
    listFeed: () => Promise.reject(new Error("not used")),
    record,
    listRecentByType: (input) =>
      Promise.resolve(
        rows
          .filter(
            (row) =>
              row.ownerUserId === input.ownerUserId && row.type === input.type,
          )
          .slice(0, input.limit),
      ),
    markRead: () => Promise.reject(new Error("not used")),
    getPreferences: () => Promise.reject(new Error("not used")),
    replacePreferences: () => Promise.reject(new Error("not used")),
    isCategoryEnabled: () => Promise.resolve(true),
  };
  return { repository, record, rows };
}

function settingsFake(): AccountSettingsRepository {
  let record: AccountSettingsRecord = {
    version: 0,
    updatedAt: null,
    settings: { displayCurrency: "USD", language: "zh-CN" },
  };
  return {
    get: () => Promise.resolve(record),
    replace: (input) => {
      if (input.expectedVersion === record.version) {
        record = {
          version: record.version + 1,
          updatedAt: now.toISOString(),
          settings: input.settings,
        };
        return Promise.resolve(record);
      }
      if (record.version > 0 && input.expectedVersion === record.version - 1) {
        return Promise.resolve(record);
      }
      return Promise.reject(new AccountSettingsVersionConflictError());
    },
  };
}

function supportFake() {
  const tickets = new Map<string, SupportTicketRecord>();
  const byKey = new Map<string, { sha: string; ticketId: string }>();
  const repository: SupportTicketRepository = {
    create: (input) => {
      const bound = byKey.get(input.idempotencyKey);
      if (bound !== undefined) {
        if (bound.sha !== input.requestSha256) {
          return Promise.reject(new SupportTicketIdempotencyConflictError());
        }
        const ticket = tickets.get(bound.ticketId);
        if (ticket === undefined) {
          throw new Error("lost ticket");
        }
        return Promise.resolve({ created: false, ticket });
      }
      const ticketId = randomUUID();
      const createdAt = new Date(
        now.getTime() + tickets.size * 1_000,
      ).toISOString();
      const ticket: SupportTicketRecord = {
        ticketId,
        ownerUserId: input.ownerUserId,
        category: input.category,
        body: input.body,
        status: "open",
        createdAt,
        createdAtCursor: createdAt.replace("Z", "000Z"),
        updatedAt: createdAt,
        lastEventAt: createdAt,
        events: [
          {
            eventVersion: 0,
            eventType: "created",
            actor: "user",
            note: null,
            occurredAt: createdAt,
          },
        ],
      };
      tickets.set(ticketId, ticket);
      byKey.set(input.idempotencyKey, { sha: input.requestSha256, ticketId });
      return Promise.resolve({ created: true, ticket });
    },
    list: (input) => {
      const owned = [...tickets.values()]
        .filter((row) => row.ownerUserId === input.ownerUserId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .filter(
          (row) =>
            input.before === undefined ||
            row.createdAt < input.before.createdAt,
        );
      return Promise.resolve({
        items: owned.slice(0, input.limit),
        hasMore: owned.length > input.limit,
      });
    },
    advance: () => Promise.reject(new Error("not used")),
  };
  return { repository, tickets };
}

function walletsFake(active: boolean): AccountWalletRepository {
  const wallet = {
    walletId: "5a716283-9eaf-4ab1-9234-4e5f60718293",
    providerWalletId: "wallet_1",
    address: "0x00000000000000000000000000000000000000a1",
    kind: "embedded" as const,
    status: "active" as const,
    isActive: active,
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  return {
    sync: () => Promise.resolve([wallet]),
    list: () => Promise.resolve([wallet]),
    get: () => Promise.resolve(wallet),
    setActive: () => Promise.resolve([wallet]),
    recordBalanceSnapshot: () => Promise.resolve(),
  };
}

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "security,settings,support",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function fakes(
  options: {
    readonly sessions?: readonly DeviceSession[];
    readonly notifications?: readonly NotificationRecord[] | null;
    readonly wallets?: AccountWalletRepository;
    readonly withSettings?: boolean;
    readonly withSupport?: boolean;
  } = {},
) {
  const sessions = deviceSessionsFake(
    options.sessions ?? [
      session(),
      session({
        sessionId: otherSessionId,
        deviceId: otherDeviceId,
        clientPlatform: "android",
        createdAt: "2026-09-01T00:00:00.000Z",
        lastSeenAt: "2026-09-01T00:00:00.000Z",
      }),
    ],
  );
  const support = supportFake();
  const notifications = notificationsFake(options.notifications ?? []);
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: sessions.repository,
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    ...(options.notifications === null
      ? {}
      : { notifications: notifications.repository }),
    ...(options.wallets === undefined
      ? {}
      : { accountWallets: options.wallets }),
    ...(options.withSettings === false
      ? {}
      : { accountSettings: settingsFake() }),
    ...(options.withSupport === false
      ? {}
      : { supportTickets: support.repository }),
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
  return {
    database,
    privyAccessTokenVerifier,
    sessions,
    support,
    notifications,
  };
}

const readHeaders = {
  authorization: `Bearer ${validToken}`,
  "x-loop-contract-version": "2.0",
  "x-loop-client-version": "1.0.0",
} as const;

const commandHeaders = {
  ...readHeaders,
  "x-loop-platform": "ios",
  "x-loop-device-id": currentDeviceId,
  "x-loop-session-id": currentSessionId,
  "idempotency-key": idempotencyKey,
} as const;

function omitHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key !== name),
  );
}

interface CapabilityView {
  readonly capabilityId: string;
  readonly availability: string;
  readonly reasonCode: string | null;
}

async function readCapabilities(
  app: FastifyInstance,
): Promise<Record<string, CapabilityView>> {
  const response = await app.inject({
    method: "GET",
    url: "/v2/meta/capabilities",
  });
  expect(response.statusCode).toBe(200);
  return Object.fromEntries(
    response
      .json<{ readonly capabilities: readonly CapabilityView[] }>()
      .capabilities.map((entry) => [entry.capabilityId, entry]),
  );
}

function expectEnvelope(
  response: LightMyRequestResponse,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json<Record<string, unknown>>();
  expect(Object.keys(body).sort()).toEqual([
    "category",
    "code",
    "correlationId",
    "detailsSafe",
    "providerReferenceSafe",
    "retryable",
    "userMessageKey",
  ]);
  expect(body["code"]).toBe(code);
  expect(body["correlationId"]).toBe(response.headers["x-request-id"]);
}

describe("LOOP API V2 security, settings, and support modules", () => {
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
      securityNow: () => now,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("reports the three module capabilities from the composed runtime", async () => {
    const { app } = await createApp();
    const capabilities = await readCapabilities(app);
    expect(capabilities["security"]?.availability).toBe("available");
    expect(capabilities["settings"]?.availability).toBe("available");
    expect(capabilities["support"]?.availability).toBe("available");

    const closed = await createApp(
      fakes({ withSettings: false, withSupport: false }),
      { V2_SESSION_ENABLED: "false" },
    );
    const closedCapabilities = await readCapabilities(closed.app);
    expect(closedCapabilities["security"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "SECURITY_RUNTIME_UNAVAILABLE",
    });
    expect(closedCapabilities["settings"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "SETTINGS_RUNTIME_UNAVAILABLE",
    });
    expect(closedCapabilities["support"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "SUPPORT_RUNTIME_UNAVAILABLE",
    });

    const deferred = await createApp(fakes(), { V2_MODULES_ENABLED: "" });
    const deferredCapabilities = await readCapabilities(deferred.app);
    for (const capabilityId of ["security", "settings", "support"]) {
      expect(deferredCapabilities[capabilityId]?.availability).toBe("deferred");
    }
    for (const url of [
      "/v2/devices",
      "/v2/security/summary",
      "/v2/settings",
      "/v2/support/tickets",
    ]) {
      const missing = await deferred.app.inject({
        method: "GET",
        url,
        headers: readHeaders,
      });
      expectEnvelope(missing, 404, "NOT_FOUND");
    }
  });

  describe("devices", () => {
    it("lists the owner's sessions with the current marker and the risk signal", async () => {
      const { app } = await createApp();
      const response = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: { ...readHeaders, "x-loop-session-id": currentSessionId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
      const body = response.json<{
        readonly devices: readonly Record<string, unknown>[];
        readonly currentSessionId: string | null;
        readonly riskSignals: Record<string, unknown>;
        readonly revokeAll: Record<string, unknown>;
        readonly truncated: boolean;
      }>();
      expect(body.devices.map((device) => device["isCurrent"])).toEqual([
        true,
        false,
      ]);
      expect(body.devices[0]).toEqual({
        sessionId: currentSessionId,
        deviceId: currentDeviceId,
        platform: "ios",
        clientVersion: "1.0.0",
        status: "active",
        authStrength: "providerAuthenticated",
        isCurrent: true,
        createdAt: "2026-09-08T20:00:00.000Z",
        lastSeenAt: "2026-09-08T20:00:00.000Z",
        revokedAt: null,
      });
      expect(body.currentSessionId).toBe(currentSessionId);
      expect(body.riskSignals).toEqual({
        newSessions24h: 1,
        highRiskNewDevice: false,
        policy: {
          configVersion: "deviceRiskV1",
          windowHours: 24,
          newSessionThreshold: 2,
        },
      });
      expect(body.revokeAll).toEqual({
        status: "unavailable",
        reasonCode: "AUTH_STEP_UP_REQUIRED",
      });
      expect(body.truncated).toBe(false);
      expect(JSON.stringify(body)).not.toContain("privy");
    });

    it("flags two sessions inside 24 hours as a high-risk new device and marks nothing current without the header", async () => {
      const { app } = await createApp(
        fakes({
          sessions: [
            session(),
            session({
              sessionId: otherSessionId,
              deviceId: otherDeviceId,
              createdAt: "2026-09-09T01:30:00.000Z",
              lastSeenAt: "2026-09-09T01:30:00.000Z",
            }),
          ],
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: readHeaders,
      });
      const body = response.json<{
        readonly devices: readonly { readonly isCurrent: boolean }[];
        readonly currentSessionId: string | null;
        readonly riskSignals: { readonly highRiskNewDevice: boolean };
      }>();
      expect(response.statusCode).toBe(200);
      expect(body.currentSessionId).toBeNull();
      expect(body.devices.every((device) => !device.isCurrent)).toBe(true);
      expect(body.riskSignals.highRiskNewDevice).toBe(true);
    });

    it("rejects an Idempotency-Key, an unknown X-Loop header, and a malformed session header on the read", async () => {
      const { app } = await createApp();
      for (const headers of [
        { ...readHeaders, "idempotency-key": idempotencyKey },
        { ...readHeaders, "x-loop-device-id": currentDeviceId },
        { ...readHeaders, "x-loop-session-id": "not-a-uuid" },
      ]) {
        const response = await app.inject({
          method: "GET",
          url: "/v2/devices",
          headers,
        });
        expectEnvelope(response, 400, "INVALID_REQUEST");
      }
    });

    it("revokes another session as a durable revoke command", async () => {
      const { app, sessions } = await createApp();
      const response = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: commandHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        session: {
          sessionId: otherSessionId,
          status: "revoked",
          revokedAt: now.toISOString(),
        },
        effect: "auditOnly",
        providerAccessTerminated: false,
        contractVersion: "2.0",
      });
      expect(sessions.revoke).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: accountId,
          sessionId: otherSessionId,
          idempotencyKey,
          commandKind: "revoke",
          callerSessionId: currentSessionId,
        }),
      );
      const digest = sessions.revoke.mock.calls[0]?.[0].requestSha256;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

      const replay = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: commandHeaders,
      });
      expect(replay.statusCode).toBe(200);
      expect(sessions.revoke.mock.calls[1]?.[0].requestSha256).toBe(digest);
    });

    it("writes one security.event notification per revoked session and day, and the summary lists it", async () => {
      const { app, notifications } = await createApp();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: `/v2/devices/${otherSessionId}/revoke`,
          headers: commandHeaders,
        });
        expect(response.statusCode).toBe(200);
      }
      expect(notifications.record).toHaveBeenCalledTimes(2);
      expect(notifications.record).toHaveBeenCalledWith({
        ownerUserId: accountId,
        type: "security.event",
        entityRef: `deviceSession:${otherSessionId}`,
        contextRoute: "devices",
        contextParams: { sessionId: otherSessionId },
        payload: {
          event: "session_revoked",
          sessionId: otherSessionId,
          deviceId: otherDeviceId,
          platform: "android",
          revokedAt: now.toISOString(),
          revokedFromSessionId: currentSessionId,
        },
        dedupeKey: `security.event:deviceSession:${otherSessionId}:revoked:2026-09-09`,
        source: "loop_session",
        observedAt: now.toISOString(),
      });
      expect(notifications.rows).toHaveLength(1);

      const summary = await app.inject({
        method: "GET",
        url: "/v2/security/summary",
        headers: readHeaders,
      });
      expect(summary.statusCode).toBe(200);
      expect(
        summary.json<{
          readonly recentSecurityEvents: Record<string, unknown>;
        }>().recentSecurityEvents,
      ).toMatchObject({
        status: "available",
        items: [
          expect.objectContaining({
            type: "security.event",
            entityRef: `deviceSession:${otherSessionId}`,
            contextRoute: "devices",
          }),
        ],
      });
    });

    it("keeps the revoke result when the notification write fails", async () => {
      const dependencies = fakes();
      dependencies.notifications.record.mockRejectedValueOnce(
        new Error("feed unavailable"),
      );
      const { app } = await createApp(dependencies);
      const response = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: commandHeaders,
      });
      expect(response.statusCode).toBe(200);
    });

    it("refuses to revoke the current session or every session without a step-up", async () => {
      const { app, sessions } = await createApp();
      const self = await app.inject({
        method: "POST",
        url: `/v2/devices/${currentSessionId}/revoke`,
        headers: commandHeaders,
      });
      expectEnvelope(self, 403, "AUTH_STEP_UP_REQUIRED");
      expect(self.headers["www-authenticate"]).toBeUndefined();

      const all = await app.inject({
        method: "POST",
        url: "/v2/devices/revoke-all",
        headers: commandHeaders,
      });
      expectEnvelope(all, 403, "AUTH_STEP_UP_REQUIRED");
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it("keeps missing and foreign sessions non-enumerable and requires the logout header set", async () => {
      const { app } = await createApp(
        fakes({
          sessions: [
            session(),
            session({ sessionId: otherSessionId, ownerUserId: otherAccountId }),
          ],
        }),
      );
      const foreign = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: commandHeaders,
      });
      expectEnvelope(foreign, 404, "SESSION_NOT_FOUND");

      const missing = await app.inject({
        method: "POST",
        url: `/v2/devices/${randomUUID()}/revoke`,
        headers: commandHeaders,
      });
      expectEnvelope(missing, 404, "SESSION_NOT_FOUND");

      const withoutSession = omitHeader(commandHeaders, "x-loop-session-id");
      const noSession = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: withoutSession,
      });
      expectEnvelope(noSession, 400, "INVALID_REQUEST");

      const withoutKey = omitHeader(commandHeaders, "idempotency-key");
      const noKey = await app.inject({
        method: "POST",
        url: `/v2/devices/${otherSessionId}/revoke`,
        headers: withoutKey,
      });
      expectEnvelope(noKey, 400, "INVALID_REQUEST");
    });

    it("refuses LOOP access to a request that names a revoked session", async () => {
      const { app } = await createApp(
        fakes({
          sessions: [
            session(),
            session({
              sessionId: otherSessionId,
              deviceId: otherDeviceId,
              status: "revoked",
              revokedAt: now.toISOString(),
            }),
          ],
        }),
      );
      const revoked = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: { ...readHeaders, "x-loop-session-id": otherSessionId },
      });
      expectEnvelope(revoked, 401, "AUTH_INVALID");
      expect(revoked.headers["www-authenticate"]).toBe(
        'Bearer realm="loop-api"',
      );

      const active = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: { ...readHeaders, "x-loop-session-id": currentSessionId },
      });
      expect(active.statusCode).toBe(200);

      const unknown = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: { ...readHeaders, "x-loop-session-id": randomUUID() },
      });
      expect(unknown.statusCode).toBe(200);
    });

    it("requires a Bearer token", async () => {
      const { app } = await createApp();
      const anonymous = omitHeader(readHeaders, "authorization");
      const response = await app.inject({
        method: "GET",
        url: "/v2/devices",
        headers: anonymous,
      });
      expectEnvelope(response, 401, "AUTH_REQUIRED");
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="loop-api"',
      );
    });
  });

  describe("security", () => {
    it("reports all six security capabilities as unavailable with pending Privy evidence", async () => {
      const { app } = await createApp();
      const response = await app.inject({
        method: "GET",
        url: "/v2/security/capabilities",
        headers: readHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        readonly items: readonly {
          readonly capabilityId: string;
          readonly status: string;
          readonly reasonCode: string;
          readonly evidence: {
            readonly status: string;
            readonly reasonCode: string;
          };
          readonly guideKey: string;
        }[];
      }>();
      expect(body.items.map((item) => item.capabilityId)).toEqual([
        ...securityCapabilityIds,
      ]);
      expect(body.items).toHaveLength(6);
      for (const item of body.items) {
        expect(item.status).toBe("unavailable");
        expect(item.reasonCode).toMatch(/^PRIVY_[A-Z_]+_EVIDENCE_PENDING$/);
        expect(item.evidence).toEqual({
          status: "pending",
          reasonCode: item.reasonCode,
        });
        expect(item.guideKey).toBe(
          `security.capability.${item.capabilityId}.howToEnable`,
        );
      }
      expect(body.items[0]?.reasonCode).toBe("PRIVY_MFA_EVIDENCE_PENDING");
      expect(body.items[5]?.reasonCode).toBe(
        "PRIVY_KEY_EXPORT_EVIDENCE_PENDING",
      );
    });

    it("summarises devices, the mandatory security category, and recent security events without a score", async () => {
      const events = [notification(), notification({ type: "trade.result" })];
      const { app } = await createApp(
        fakes({ notifications: events, wallets: walletsFake(true) }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v2/security/summary",
        headers: readHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual([
        "approvals",
        "contractVersion",
        "devices",
        "notifications",
        "observedAt",
        "recentSecurityEvents",
      ]);
      expect(body["devices"]).toEqual({
        status: "available",
        deviceCount: 2,
        activeSessionCount: 2,
        newSessions24h: 1,
        highRiskNewDevice: false,
        policy: {
          configVersion: "deviceRiskV1",
          windowHours: 24,
          newSessionThreshold: 2,
        },
      });
      // sendApprovals is not enabled in this app: the block closes with the
      // module's deferred reason, never with a fabricated count.
      expect(body["approvals"]).toEqual({
        status: "unavailable",
        reasonCode: "SEND_APPROVALS_RUNTIME_DEFERRED",
      });
      expect(body["notifications"]).toEqual({
        securityEvents: {
          category: "security.event",
          enabled: true,
          locked: true,
        },
      });
      expect(body["recentSecurityEvents"]).toMatchObject({
        status: "available",
        items: [
          expect.objectContaining({
            notificationId: events[0]?.notificationId,
            type: "security.event",
          }),
        ],
      });
      expect(JSON.stringify(body)).not.toContain("score");
    });

    it("closes the approvals block when the module is enabled but its runtime is missing, and the events block without a repository", async () => {
      const { app } = await createApp(
        fakes({ notifications: null, wallets: walletsFake(false) }),
        { V2_MODULES_ENABLED: "security,sendApprovals" },
      );
      const response = await app.inject({
        method: "GET",
        url: "/v2/security/summary",
        headers: readHeaders,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body["approvals"]).toEqual({
        status: "unavailable",
        reasonCode: "WALLET_INTENT_RUNTIME_UNAVAILABLE",
      });
      expect(body["recentSecurityEvents"]).toEqual({
        status: "unavailable",
        reasonCode: "NOTIFICATIONS_RUNTIME_UNAVAILABLE",
      });

      const withActive = await createApp(
        fakes({ notifications: null, wallets: walletsFake(true) }),
        { V2_MODULES_ENABLED: "security,sendApprovals" },
      );
      const rpcMissing = await withActive.app.inject({
        method: "GET",
        url: "/v2/security/summary",
        headers: readHeaders,
      });
      expect(
        rpcMissing.json<{ readonly approvals: Record<string, unknown> }>()
          .approvals,
      ).toEqual({
        status: "unavailable",
        reasonCode: "WALLET_INTENT_RUNTIME_UNAVAILABLE",
      });
    });
  });

  describe("settings", () => {
    const fixed = { displayCurrency: "USD", language: "zh-CN" } as const;

    it("returns the fixed defaults at version 0 and replaces through expectedVersion", async () => {
      const { app } = await createApp();
      const initial = await app.inject({
        method: "GET",
        url: "/v2/settings",
        headers: readHeaders,
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({
        settings: fixed,
        version: 0,
        updatedAt: null,
        policy: {
          configVersion: "accountSettingsV1",
          fixed,
          localOnly: ["reduceMotion", "theme"],
        },
        contractVersion: "2.0",
      });

      const write = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: { ...readHeaders, "x-loop-platform": "ios" },
        payload: { expectedVersion: 0, settings: fixed },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json()).toMatchObject({
        version: 1,
        updatedAt: now.toISOString(),
      });

      const retry = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: readHeaders,
        payload: { expectedVersion: 0, settings: fixed },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ version: 1 });

      const stale = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: readHeaders,
        payload: { expectedVersion: 7, settings: fixed },
      });
      expectEnvelope(stale, 409, "VERSION_CONFLICT");
    });

    it("rejects an Idempotency-Key, unknown fields, and any value other than the fixed constants", async () => {
      const { app } = await createApp();
      const withKey = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: { ...readHeaders, "idempotency-key": idempotencyKey },
        payload: { expectedVersion: 0, settings: fixed },
      });
      expectEnvelope(withKey, 400, "INVALID_REQUEST");

      const unknownField = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: readHeaders,
        payload: {
          expectedVersion: 0,
          settings: { ...fixed, reduceMotion: true },
        },
      });
      expectEnvelope(unknownField, 400, "INVALID_REQUEST");

      const otherCurrency = await app.inject({
        method: "PUT",
        url: "/v2/settings",
        headers: readHeaders,
        payload: {
          expectedVersion: 0,
          settings: { displayCurrency: "EUR", language: "zh-CN" },
        },
      });
      expectEnvelope(otherCurrency, 422, "VALIDATION_FAILED");
    });

    it("is CAPABILITY_UNAVAILABLE without a composed repository", async () => {
      const { app } = await createApp(fakes({ withSettings: false }));
      const response = await app.inject({
        method: "GET",
        url: "/v2/settings",
        headers: readHeaders,
      });
      expectEnvelope(response, 503, "CAPABILITY_UNAVAILABLE");
    });
  });

  describe("support", () => {
    const ticketHeaders = {
      ...readHeaders,
      "idempotency-key": idempotencyKey,
    } as const;

    it("creates a ticket once, replays it for the same key and body, and conflicts on a different body", async () => {
      const { app } = await createApp();
      const created = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "mining", body: "  为什么我的币没有权重  " },
      });

      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const body = created.json<{
        readonly ticket: { readonly ticketId: string } & Record<
          string,
          unknown
        >;
        readonly attachments: Record<string, unknown>;
        readonly policy: Record<string, unknown>;
      }>();
      expect(body.ticket).toMatchObject({
        category: "mining",
        body: "为什么我的币没有权重",
        status: "open",
        events: [
          expect.objectContaining({
            eventVersion: 0,
            eventType: "created",
            actor: "user",
            note: null,
          }),
        ],
      });
      expect(body.attachments).toEqual({
        status: "unavailable",
        reasonCode: "SUPPORT_ATTACHMENTS_UNAVAILABLE",
      });
      expect(body.policy).toEqual({
        configVersion: "supportPolicyV1",
        responseWindowHours: 24,
        businessDaysOnly: true,
        escalationChannel: "copy",
      });

      const replay = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "mining", body: "为什么我的币没有权重" },
      });
      expect(replay.statusCode).toBe(200);
      expect(
        replay.json<{ readonly ticket: { readonly ticketId: string } }>().ticket
          .ticketId,
      ).toBe(body.ticket.ticketId);

      const conflict = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "mining", body: "另一个问题" },
      });
      expectEnvelope(conflict, 409, "IDEMPOTENCY_CONFLICT");
    });

    it("validates the category, the character safety, the code-point length, and the headers", async () => {
      const { app } = await createApp();
      const unknownCategory = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "refund", body: "hello" },
      });
      expectEnvelope(unknownCategory, 400, "INVALID_REQUEST");

      for (const unsafe of ["hello\u0001", "hello\u202eworld", "   "]) {
        const response = await app.inject({
          method: "POST",
          url: "/v2/support/tickets",
          headers: ticketHeaders,
          payload: { category: "other", body: unsafe },
        });
        expectEnvelope(response, 400, "INVALID_REQUEST");
      }

      const tooLong = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "other", body: "问".repeat(2_001) },
      });
      expectEnvelope(tooLong, 422, "VALIDATION_FAILED");

      const exact = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: { ...ticketHeaders, "idempotency-key": randomUUID() },
        payload: { category: "other", body: "\u{1F600}".repeat(2_000) },
      });
      expect(exact.statusCode).toBe(201);

      const attachment = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: ticketHeaders,
        payload: { category: "other", body: "hello", attachments: [] },
      });
      expectEnvelope(attachment, 400, "INVALID_REQUEST");

      const withoutKey = omitHeader(ticketHeaders, "idempotency-key");
      const noKey = await app.inject({
        method: "POST",
        url: "/v2/support/tickets",
        headers: withoutKey,
        payload: { category: "other", body: "hello" },
      });
      expectEnvelope(noKey, 400, "INVALID_REQUEST");
    });

    it("lists the owner's tickets newest first with an owner-bound cursor", async () => {
      const { app } = await createApp();
      for (const index of [1, 2, 3]) {
        const response = await app.inject({
          method: "POST",
          url: "/v2/support/tickets",
          headers: { ...ticketHeaders, "idempotency-key": randomUUID() },
          payload: { category: "account", body: `ticket ${String(index)}` },
        });
        expect(response.statusCode).toBe(201);
      }

      const first = await app.inject({
        method: "GET",
        url: "/v2/support/tickets?limit=2",
        headers: readHeaders,
      });
      expect(first.statusCode).toBe(200);
      const page = first.json<{
        readonly items: readonly { readonly body: string }[];
        readonly nextCursor: string | null;
      }>();
      expect(page.items.map((item) => item.body)).toEqual([
        "ticket 3",
        "ticket 2",
      ]);
      expect(page.nextCursor).not.toBeNull();
      const cursor = encodeURIComponent(page.nextCursor ?? "");

      const second = await app.inject({
        method: "GET",
        url: `/v2/support/tickets?cursor=${cursor}`,
        headers: readHeaders,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        items: [{ body: "ticket 1" }],
        nextCursor: null,
      });

      const both = await app.inject({
        method: "GET",
        url: `/v2/support/tickets?cursor=${cursor}&limit=1`,
        headers: readHeaders,
      });
      expectEnvelope(both, 400, "INVALID_REQUEST");

      const malformed = await app.inject({
        method: "GET",
        url: "/v2/support/tickets?cursor=not-a-cursor",
        headers: readHeaders,
      });
      expectEnvelope(malformed, 400, "INVALID_REQUEST");
    });

    it("fails closed without a cursor secret", async () => {
      const { app } = await createApp(fakes(), { V2_CURSOR_HMAC_SECRET: "" });
      const response = await app.inject({
        method: "GET",
        url: "/v2/support/tickets",
        headers: readHeaders,
      });
      expectEnvelope(response, 503, "CAPABILITY_UNAVAILABLE");
    });
  });
});
