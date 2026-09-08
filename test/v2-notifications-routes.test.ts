import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import {
  AlertIdempotencyConflictError,
  AlertVersionConflictError,
  createUnavailableAlertRepository,
} from "../src/database/alert-repository.js";
import type {
  AlertV2Repository,
  PriceAlertV2Record,
} from "../src/database/alert-v2-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import type {
  NotificationPreferenceValues,
  NotificationRecord,
  NotificationRepository,
} from "../src/database/notification-repository.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { defaultNotificationPreferences } from "../src/features/alerts/notification-contract.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const observedAt = "2026-09-08T00:00:00.000Z";

const wbnbAsset: AssetRecord = Object.freeze({
  assetId: wbnbAssetId,
  chainId: bscChainId,
  address: wbnb,
  symbol: "WBNB",
  name: "Wrapped BNB",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "120000000",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "notifications",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
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

function commandHeaders(idempotencyKey = randomUUID()): Record<string, string> {
  return commonHeaders({ "idempotency-key": idempotencyKey });
}

function registryFake(): ChainRegistryRepository {
  return {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn((assetId: string) =>
      Promise.resolve(assetId === wbnbAssetId ? wbnbAsset : null),
    ),
    listAssets: vi.fn((assetIds: readonly string[]) =>
      Promise.resolve(assetIds.includes(wbnbAssetId) ? [wbnbAsset] : []),
    ),
    listReadableAssets: vi.fn(() => Promise.resolve([wbnbAsset])),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve([])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

/** In-memory V2 alert storage keeping the idempotency and CAS rules. */
function alertsFake() {
  const alerts = new Map<string, PriceAlertV2Record>();
  const keys = new Map<
    string,
    { readonly sha: string; readonly alertId: string }
  >();
  let clock = 0;
  const stamp = (): string => {
    clock += 1;
    return new Date(Date.parse(observedAt) + clock * 1_000).toISOString();
  };
  const repository: AlertV2Repository = {
    create: (input) => {
      const existing = keys.get(input.idempotencyKey);
      if (existing !== undefined) {
        const alert = alerts.get(existing.alertId);
        if (existing.sha !== input.requestSha256 || alert === undefined) {
          return Promise.reject(new AlertIdempotencyConflictError());
        }
        return Promise.resolve({ created: false, alert });
      }
      const at = stamp();
      const alert: PriceAlertV2Record = {
        alertId: randomUUID(),
        ownerUserId: input.ownerUserId,
        createRequestSha256: input.requestSha256,
        ...input.definition,
        state: "active",
        triggeredAt: null,
        lastEvaluatedAt: null,
        deletedAt: null,
        recordVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      alerts.set(alert.alertId, alert);
      keys.set(input.idempotencyKey, {
        sha: input.requestSha256,
        alertId: alert.alertId,
      });
      return Promise.resolve({ created: true, alert });
    },
    listOwned: (input) => {
      const owned = [...alerts.values()]
        .filter(
          (alert) =>
            alert.ownerUserId === input.ownerUserId && alert.deletedAt === null,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .filter((alert) =>
          input.before === undefined
            ? true
            : alert.createdAt < input.before.createdAt,
        );
      return Promise.resolve({
        items: owned.slice(0, input.limit),
        hasMore: owned.length > input.limit,
      });
    },
    findOwned: (ownerUserId, alertId) => {
      const alert = alerts.get(alertId);
      return Promise.resolve(
        alert !== undefined &&
          alert.ownerUserId === ownerUserId &&
          alert.deletedAt === null
          ? alert
          : null,
      );
    },
    replaceOwned: (input) => {
      const alert = alerts.get(input.alertId);
      if (alert === undefined || alert.ownerUserId !== input.ownerUserId) {
        return Promise.resolve(null);
      }
      if (alert.recordVersion !== input.expectedVersion) {
        return Promise.reject(new AlertVersionConflictError());
      }
      const updated: PriceAlertV2Record = {
        ...alert,
        ...input.definition,
        state: "active",
        triggeredAt: null,
        recordVersion: alert.recordVersion + 1,
        updatedAt: stamp(),
      };
      alerts.set(alert.alertId, updated);
      return Promise.resolve(updated);
    },
    softDeleteOwned: (input) => {
      const alert = alerts.get(input.alertId);
      if (
        alert === undefined ||
        alert.ownerUserId !== input.ownerUserId ||
        alert.deletedAt !== null
      ) {
        return Promise.resolve(false);
      }
      if (alert.recordVersion !== input.expectedVersion) {
        return Promise.reject(new AlertVersionConflictError());
      }
      alerts.set(alert.alertId, {
        ...alert,
        deletedAt: stamp(),
        recordVersion: alert.recordVersion + 1,
      });
      return Promise.resolve(true);
    },
    listEvaluable: () => Promise.resolve([]),
    markEvaluated: () => Promise.resolve(),
    recordTrigger: () => Promise.reject(new Error("not used")),
  };
  return { repository, alerts };
}

function notificationsFake(seed: readonly NotificationRecord[] = []) {
  const rows = new Map(seed.map((row) => [row.notificationId, row]));
  let version = 0;
  let values: NotificationPreferenceValues = {
    ...defaultNotificationPreferences,
  };
  const repository: NotificationRepository = {
    listFeed: (input) => {
      const owned = [...rows.values()]
        .filter((row) => row.ownerUserId === input.ownerUserId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return Promise.resolve({
        items: owned.slice(0, input.limit),
        hasMore: owned.length > input.limit,
        unreadCount: owned.filter((row) => row.readAt === null).length,
      });
    },
    markRead: (ownerUserId, notificationId) => {
      const row = rows.get(notificationId);
      if (row === undefined || row.ownerUserId !== ownerUserId) {
        return Promise.resolve(null);
      }
      const read =
        row.readAt === null
          ? { ...row, readAt: "2026-09-08T00:00:09.000Z" }
          : row;
      rows.set(notificationId, read);
      return Promise.resolve(read);
    },
    getPreferences: () =>
      Promise.resolve({
        recordVersion: version,
        updatedAt: version === 0 ? null : observedAt,
        values,
      }),
    replacePreferences: (input) => {
      if (input.expectedVersion !== version) {
        return Promise.reject(new AlertVersionConflictError());
      }
      version += 1;
      values = { ...input.values };
      return Promise.resolve({
        recordVersion: version,
        updatedAt: observedAt,
        values,
      });
    },
    isCategoryEnabled: (_owner, category) => Promise.resolve(values[category]),
  };
  return { repository };
}

function notificationRecord(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    notificationId: "1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    ownerUserId: accountId,
    type: "trade.priceAlert",
    entityRef: "priceAlert:0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    contextRoute: "token",
    contextParams: { assetId: wbnbAssetId },
    payload: {
      assetId: wbnbAssetId,
      symbol: "WBNB",
      observedValue: "747.39",
      source: "dexscreener",
    },
    dedupeKey: "trade.priceAlert:0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e:0",
    source: "dexscreener",
    observedAt,
    readAt: null,
    createdAt: observedAt,
    ...overrides,
  };
}

function fakes(seedNotifications: readonly NotificationRecord[] = []) {
  const alerts = alertsFake();
  const notifications = notificationsFake(seedNotifications);
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    chainRegistry: registryFake(),
    alertsV2: alerts.repository,
    notifications: notifications.repository,
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
  return { database, privyAccessTokenVerifier, alerts };
}

const definition = {
  assetId: wbnbAssetId,
  condition: "at_or_above",
  threshold: "800.5",
  expiresAt: null,
} as const;

describe("LOOP API V2 notifications module", () => {
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

  it("projects the module capabilities and keeps push closed", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const capabilities = Object.fromEntries(
      response
        .json<{
          readonly capabilities: readonly {
            readonly capabilityId: string;
            readonly availability: string;
            readonly reasonCode: string | null;
          }[];
        }>()
        .capabilities.map((capability) => [
          capability.capabilityId,
          capability,
        ]),
    );
    expect(capabilities["priceAlerts"]).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    expect(capabilities["notificationsFeed"]).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    expect(capabilities["pushNotifications"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "PUSH_RUNTIME_DEFERRED",
    });
  });

  it("creates an alert idempotently and refuses a different body under the same key", async () => {
    const { app } = await createApp();
    const key = randomUUID();
    const created = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(key),
      payload: definition,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toMatchObject({
      alert: {
        assetId: wbnbAssetId,
        asset: { symbol: "WBNB", decimals: 18 },
        condition: "at_or_above",
        threshold: "800.5",
        expiresAt: null,
        state: "active",
        triggeredAt: null,
        lastEvaluatedAt: null,
        delivery: {
          status: "unavailable",
          reasonCode: "PUSH_RUNTIME_DEFERRED",
        },
        version: 1,
      },
      contractVersion: "2.0",
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(key),
      payload: definition,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ alert: { alertId: string } }>().alert.alertId).toBe(
      created.json<{ alert: { alertId: string } }>().alert.alertId,
    );
    const conflict = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(key),
      payload: { ...definition, threshold: "900" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects malformed and unregistered definitions", async () => {
    const { app } = await createApp();
    const missingKey = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commonHeaders(),
      payload: definition,
    });
    expect(missingKey.statusCode).toBe(400);
    const unknownAsset = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: {
        ...definition,
        assetId: "eip155:56:0x0000000000000000000000000000000000000abc",
      },
    });
    expect(unknownAsset.statusCode).toBe(422);
    expect(unknownAsset.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const pastExpiry = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: { ...definition, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(pastExpiry.statusCode).toBe(422);
    // The route schema declares threshold as a string; Fastify's default AJV
    // type coercion turns a JSON number into that string. This is documented
    // in api-v2-conventions: the server does not reject the number form.
    const numberThreshold = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: { ...definition, threshold: 800.5 },
    });
    expect(numberThreshold.statusCode).toBe(201);
    expect(numberThreshold.json()).toMatchObject({
      alert: { threshold: "800.5" },
    });
    const exponentThreshold = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: { ...definition, threshold: "8e2" },
    });
    expect(exponentThreshold.statusCode).toBe(400);
    const otherChain = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: { ...definition, assetId: `eip155:1:${wbnb}` },
    });
    expect(otherChain.statusCode).toBe(422);
    expect(otherChain.json()).toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("lists, reads, replaces with CAS, and soft-deletes alerts", async () => {
    const { app } = await createApp();
    const first = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: definition,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v2/alerts",
      headers: commandHeaders(),
      payload: { ...definition, condition: "below", threshold: "600" },
    });
    const firstId = first.json<{ alert: { alertId: string } }>().alert.alertId;
    const secondId = second.json<{ alert: { alertId: string } }>().alert
      .alertId;

    const page = await app.inject({
      method: "GET",
      url: "/v2/alerts?limit=1",
      headers: commonHeaders(),
    });
    expect(page.statusCode).toBe(200);
    const pageBody = page.json<{
      items: { alertId: string }[];
      nextCursor: string | null;
    }>();
    expect(pageBody.items.map((item) => item.alertId)).toEqual([secondId]);
    expect(pageBody.nextCursor).not.toBeNull();
    const nextPage = await app.inject({
      method: "GET",
      url: `/v2/alerts?cursor=${encodeURIComponent(pageBody.nextCursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(
      nextPage
        .json<{ items: { alertId: string }[] }>()
        .items.map((item) => item.alertId),
    ).toEqual([firstId]);

    const get = await app.inject({
      method: "GET",
      url: `/v2/alerts/${firstId}`,
      headers: commonHeaders(),
    });
    expect(get.statusCode).toBe(200);
    const unknown = await app.inject({
      method: "GET",
      url: `/v2/alerts/${randomUUID()}`,
      headers: commonHeaders(),
    });
    expect(unknown.statusCode).toBe(404);

    const replaced = await app.inject({
      method: "PUT",
      url: `/v2/alerts/${firstId}`,
      headers: commonHeaders(),
      payload: { expectedVersion: 1, ...definition, threshold: "850" },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      alert: { threshold: "850", version: 2, state: "active" },
    });
    const stale = await app.inject({
      method: "PUT",
      url: `/v2/alerts/${firstId}`,
      headers: commonHeaders(),
      payload: { expectedVersion: 1, ...definition, threshold: "860" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const keyed = await app.inject({
      method: "PUT",
      url: `/v2/alerts/${firstId}`,
      headers: commandHeaders(),
      payload: { expectedVersion: 2, ...definition, threshold: "860" },
    });
    expect(keyed.statusCode).toBe(400);

    const staleDelete = await app.inject({
      method: "DELETE",
      url: `/v2/alerts/${firstId}?expectedVersion=1`,
      headers: commonHeaders(),
    });
    expect(staleDelete.statusCode).toBe(409);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v2/alerts/${firstId}?expectedVersion=2`,
      headers: commonHeaders(),
    });
    expect(deleted.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/v2/alerts/${firstId}?expectedVersion=2`,
      headers: commonHeaders(),
    });
    expect(again.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: `/v2/alerts/${firstId}`,
      headers: commonHeaders(),
    });
    expect(gone.statusCode).toBe(404);
  });

  it("serves the context feed and acknowledges reads idempotently", async () => {
    const { app } = await createApp(
      fakes([
        notificationRecord(),
        notificationRecord({
          notificationId: "2c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
          createdAt: "2026-09-07T00:00:00.000Z",
          readAt: "2026-09-07T01:00:00.000Z",
          dedupeKey: "trade.priceAlert:x:1",
        }),
      ]),
    );
    const feed = await app.inject({
      method: "GET",
      url: "/v2/notifications/feed",
      headers: commonHeaders(),
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json()).toMatchObject({
      items: [
        {
          notificationId: "1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
          type: "trade.priceAlert",
          entityRef: "priceAlert:0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
          contextRoute: "token",
          contextParams: { assetId: wbnbAssetId },
          payload: { observedValue: "747.39", source: "dexscreener" },
          readAt: null,
        },
        { notificationId: "2c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" },
      ],
      nextCursor: null,
      unreadCount: 1,
      push: { status: "unavailable", reasonCode: "PUSH_RUNTIME_DEFERRED" },
    });
    expect(feed.body).not.toContain("dedupeKey");

    const read = await app.inject({
      method: "POST",
      url: "/v2/notifications/1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f/read",
      headers: commandHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      notification: { readAt: "2026-09-08T00:00:09.000Z" },
    });
    const readAgain = await app.inject({
      method: "POST",
      url: "/v2/notifications/1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f/read",
      headers: commandHeaders(),
    });
    expect(readAgain.json()).toMatchObject({
      notification: { readAt: "2026-09-08T00:00:09.000Z" },
    });
    const withoutKey = await app.inject({
      method: "POST",
      url: "/v2/notifications/1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f/read",
      headers: commonHeaders(),
    });
    expect(withoutKey.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: `/v2/notifications/${randomUUID()}/read`,
      headers: commandHeaders(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves the ten-category preferences with a locked security category", async () => {
    const { app } = await createApp();
    const initial = await app.inject({
      method: "GET",
      url: "/v2/notification-preferences",
      headers: commonHeaders(),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      version: 0,
      updatedAt: null,
      categories: {
        "mining.settlement": { enabled: true, locked: false },
        "community.all": { enabled: false, locked: false },
        "security.event": { enabled: true, locked: true },
      },
      push: { status: "unavailable", reasonCode: "PUSH_RUNTIME_DEFERRED" },
    });
    const categories = {
      "mining.settlement": true,
      "mining.weight": false,
      "launch.round": true,
      "launch.graduation": true,
      "trade.result": true,
      "trade.priceAlert": false,
      "community.mention": true,
      "community.announcement": true,
      "community.all": false,
      "security.event": true,
    };
    const disableSecurity = await app.inject({
      method: "PUT",
      url: "/v2/notification-preferences",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 0,
        categories: { ...categories, "security.event": false },
      },
    });
    expect(disableSecurity.statusCode).toBe(400);
    expect(disableSecurity.json()).toMatchObject({ code: "INVALID_REQUEST" });
    const partial = await app.inject({
      method: "PUT",
      url: "/v2/notification-preferences",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 0,
        categories: { "mining.settlement": true },
      },
    });
    expect(partial.statusCode).toBe(400);
    const replaced = await app.inject({
      method: "PUT",
      url: "/v2/notification-preferences",
      headers: commonHeaders(),
      payload: { expectedVersion: 0, categories },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      version: 1,
      categories: {
        "mining.weight": { enabled: false, locked: false },
        "trade.priceAlert": { enabled: false, locked: false },
        "security.event": { enabled: true, locked: true },
      },
    });
    const stale = await app.inject({
      method: "PUT",
      url: "/v2/notification-preferences",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 0,
        categories: { ...categories, "mining.weight": true },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const keyed = await app.inject({
      method: "PUT",
      url: "/v2/notification-preferences",
      headers: commandHeaders(),
      payload: { expectedVersion: 1, categories },
    });
    expect(keyed.statusCode).toBe(400);
  });

  it("fails closed without the cursor codec", async () => {
    const { app } = await createApp(fakes(), { V2_CURSOR_HMAC_SECRET: "" });
    const response = await app.inject({
      method: "GET",
      url: "/v2/alerts",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});
