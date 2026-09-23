import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAlertEvaluatorWorker } from "../src/alert-evaluator-worker.js";
import type {
  AlertV2Repository,
  PriceAlertV2Record,
} from "../src/database/alert-v2-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import type { NotificationRepository } from "../src/database/notification-repository.js";
import type {
  CachedFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import type {
  OwnerPushDispatchInput,
  PushDispatchService,
} from "../src/features/push/push-dispatch-service.js";
import { createDeviceService } from "../src/features/security/device-service.js";
import {
  createV2SessionService,
  newDeviceSignInNotification,
} from "../src/features/session/session-service.js";
import type {
  DeviceSession,
  DeviceSessionRepository,
} from "../src/features/session/device-session-repository.js";
import type { TokenPairsSnapshot } from "../src/integrations/market/market-data-provider.js";

/**
 * The three first-batch producers (Decision 0067). Each proves the same
 * rule: the in-app fact is written first and the push is a second copy whose
 * absence changes nothing the caller was told.
 */

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const callerSessionId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const targetSessionId = "1c3d2e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f";
const observedAt = "2026-09-22T00:00:00.000Z";

function pushFake() {
  const owner: OwnerPushDispatchInput[] = [];
  const service: PushDispatchService = {
    available: true,
    dispatchToOwner: (input) => {
      owner.push(input);
      return Promise.resolve({
        status: "delivered",
        reasonCode: null,
        attemptedCount: 1,
        sentCount: 1,
        duplicateCount: 0,
        rateLimitedCount: 0,
        failedCount: 0,
        invalidTokenCount: 0,
        audienceTruncated: false,
      });
    },
    dispatchToCommunity: () => Promise.reject(new Error("not used")),
  };
  return { service, owner };
}

function session(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    sessionId: targetSessionId,
    ownerUserId,
    deviceId: "5a716283-9eaf-4ab1-9234-4e5f60718293",
    clientPlatform: "android",
    clientVersion: "1.0.0",
    authStrength: "providerAuthenticated",
    policyVersion: "sessionPolicyV1",
    status: "active",
    createdAt: observedAt,
    lastSeenAt: observedAt,
    revokedAt: null,
    ...overrides,
  };
}

function notificationsFake() {
  const record = vi.fn<NotificationRepository["record"]>((input) =>
    Promise.resolve({
      ...input,
      notificationId: randomUUID(),
      readAt: null,
      createdAt: observedAt,
      createdAtCursor: observedAt.replace("Z", "000Z"),
    }),
  );
  const repository: NotificationRepository = {
    listFeed: () => Promise.reject(new Error("not used")),
    record,
    listRecentByType: () => Promise.resolve([]),
    markRead: () => Promise.reject(new Error("not used")),
    getPreferences: () => Promise.reject(new Error("not used")),
    replacePreferences: () => Promise.reject(new Error("not used")),
    isCategoryEnabled: () => Promise.resolve(true),
  };
  return { repository, record };
}

describe("security_event producers", () => {
  const metadata = Object.freeze({
    clientVersion: "1.0.0",
    contractVersion: "2.0" as const,
    deviceId: "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60",
    idempotencyKey: "3e5f4061-7c8d-4e9f-9012-2c3d4e5f6071",
    platform: "ios" as const,
    sessionId: callerSessionId,
  });
  const principal = Object.freeze({
    userId: ownerUserId,
    privyUserId: "did:privy:x",
    streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
  });

  it("pushes a mandatory pointer after a remote revocation", async () => {
    const push = pushFake();
    const notifications = notificationsFake();
    const sessions: DeviceSessionRepository = {
      bootstrapVerifiedPrivyUser: () => Promise.reject(new Error("not used")),
      create: () => Promise.reject(new Error("not used")),
      findById: () => Promise.resolve(null),
      listByOwner: () => Promise.resolve([]),
      revoke: () =>
        Promise.resolve(
          session({ status: "revoked", revokedAt: "2026-09-22T02:00:00.000Z" }),
        ),
    };
    const service = createDeviceService({
      sessions,
      notifications: notifications.repository,
      push: push.service,
      logger: { warn: vi.fn() },
    });
    const result = await service.revoke({
      principal,
      targetSessionId,
      metadata,
      requestId: randomUUID(),
    });
    expect(result.session.status).toBe("revoked");
    expect(push.owner).toEqual([
      {
        ownerUserId,
        eventType: "security_event",
        entityRef: `deviceSession:${targetSessionId}`,
        contextRoute: "devices",
        eventKey: `security_event:deviceSession:${targetSessionId}:revoked`,
      },
    ]);
  });

  it("raises a new-device sign-in once, and not for a device the account already used", async () => {
    const push = pushFake();
    const notifications = notificationsFake();
    const known = session({ sessionId: callerSessionId });
    const fresh = session({
      sessionId: targetSessionId,
      deviceId: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    });
    const sessions: DeviceSessionRepository = {
      bootstrapVerifiedPrivyUser: () =>
        Promise.resolve({
          account: { id: ownerUserId },
          session: { ...fresh, status: "active" as const, revokedAt: null },
        }),
      create: () => Promise.reject(new Error("not used")),
      findById: () => Promise.resolve(null),
      listByOwner: () => Promise.resolve([fresh, known]),
      revoke: () => Promise.reject(new Error("not used")),
    };
    const service = createV2SessionService({
      enabled: true,
      sessions,
      notifications: notifications.repository,
      push: push.service,
    });
    await service.bootstrap({
      principal: { privyUserId: "did:privy:x" },
      metadata,
      requestId: randomUUID(),
    });
    expect(notifications.record).toHaveBeenCalledOnce();
    expect(push.owner[0]).toMatchObject({
      eventType: "security_event",
      entityRef: `deviceSession:${targetSessionId}`,
      eventKey: `security_event:deviceSession:${targetSessionId}:new_device`,
    });

    // Same device, a second session: known hardware raises nothing.
    const quiet = pushFake();
    const quietNotifications = notificationsFake();
    const sameDevice = session({
      sessionId: callerSessionId,
      deviceId: fresh.deviceId,
    });
    const second = createV2SessionService({
      enabled: true,
      sessions: {
        ...sessions,
        listByOwner: () => Promise.resolve([fresh, sameDevice]),
      },
      notifications: quietNotifications.repository,
      push: quiet.service,
    });
    await second.bootstrap({
      principal: { privyUserId: "did:privy:x" },
      metadata,
      requestId: randomUUID(),
    });
    expect(quietNotifications.record).not.toHaveBeenCalled();
    expect(quiet.owner).toHaveLength(0);
  });

  it("keeps the new-device dedupe key stable for one session", () => {
    const notification = newDeviceSignInNotification({
      ownerUserId,
      session: session(),
    });
    expect(notification.dedupeKey).toBe(
      `security.event:deviceSession:${targetSessionId}:new_device`,
    );
    expect(notification.type).toBe("security.event");
  });

  it("still returns the sign-in when the notification write fails", async () => {
    const warn = vi.fn();
    const sessions: DeviceSessionRepository = {
      bootstrapVerifiedPrivyUser: () =>
        Promise.resolve({
          account: { id: ownerUserId },
          session: { ...session(), status: "active" as const, revokedAt: null },
        }),
      create: () => Promise.reject(new Error("not used")),
      findById: () => Promise.resolve(null),
      listByOwner: () => Promise.reject(new Error("audit read down")),
      revoke: () => Promise.reject(new Error("not used")),
    };
    const notifications = notificationsFake();
    const service = createV2SessionService({
      enabled: true,
      sessions,
      notifications: notifications.repository,
      logger: { warn },
    });
    const result = await service.bootstrap({
      principal: { privyUserId: "did:privy:x" },
      metadata,
      requestId: randomUUID(),
    });
    expect(result.account.accountId).toBe(ownerUserId);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("price_alert_triggered producer", () => {
  const assetId = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const alertId = "9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
  const asset: AssetRecord = {
    assetId,
    chainId: "eip155:56",
    address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    symbol: "WBNB",
    name: "Wrapped BNB",
    decimals: 18,
    status: "verified",
    sourceKind: "chain_call",
    sourceBlockNumber: "1",
    sourceVerifiedAt: observedAt,
    updatedAt: observedAt,
  };
  const alert: PriceAlertV2Record = {
    alertId,
    ownerUserId,
    createRequestSha256: "a".repeat(64),
    assetId,
    condition: "at_or_above",
    threshold: "100",
    expiresAt: null,
    state: "active",
    triggeredAt: null,
    lastEvaluatedAt: null,
    deletedAt: null,
    recordVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  };

  function facts(): MarketFactService {
    const fact: CachedFact<TokenPairsSnapshot> = {
      value: {
        tokenAddress: asset.address ?? "",
        pairs: [
          {
            pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
            dexId: "pancakeswap",
            labels: ["v3"],
            baseTokenAddress: asset.address ?? "",
            baseTokenSymbol: "WBNB",
            quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
            quoteTokenSymbol: "USDT",
            priceUsd: "747.39",
            priceNative: null,
            liquidityUsd: "1",
            volumeH24: null,
            priceChangeH24: null,
            fdv: null,
            marketCap: null,
            buysH24: null,
            sellsH24: null,
            pairCreatedAt: null,
          },
        ],
      },
      source: "dexscreener",
      fetchedAt: observedAt,
      ttlSeconds: 30,
      quality: "fresh",
      reasonCode: null,
      rawDigest: null,
    };
    return {
      readTokenPairs: () => Promise.resolve(fact),
      recallPrimaryPairPriceChange: () => Promise.resolve(null),
      readTokenPairsBatch: () => Promise.reject(new Error("not used")),
      readPair: () => Promise.reject(new Error("not used")),
      readAssetPrice: () =>
        Promise.resolve({
          fact,
          pair: fact.value?.pairs[0] ?? null,
          proxyAsset: null,
        }),
      readAssetPrices: () => Promise.reject(new Error("not used")),
      readTokenSecurity: () => Promise.reject(new Error("not used")),
      readPoolOhlcv: () => Promise.reject(new Error("not used")),
      readNewPools: () => Promise.reject(new Error("not used")),
      readUnlistedToken: () => Promise.reject(new Error("not used")),
      candlesProviderEnabled: false,
    };
  }

  function registry(): ChainRegistryRepository {
    return {
      getChain: () => Promise.resolve(null),
      getAsset: () => Promise.resolve(asset),
      listAssets: () => Promise.resolve([asset]),
      listReadableAssets: () => Promise.resolve([asset]),
      upsertAsset: () => Promise.reject(new Error("not used")),
      listPools: () => Promise.resolve([]),
      upsertPool: () => Promise.reject(new Error("not used")),
    };
  }

  function alerts(recorded: boolean): AlertV2Repository {
    let served = false;
    return {
      create: () => Promise.reject(new Error("not used")),
      listOwned: () => Promise.reject(new Error("not used")),
      findOwned: () => Promise.reject(new Error("not used")),
      replaceOwned: () => Promise.reject(new Error("not used")),
      softDeleteOwned: () => Promise.reject(new Error("not used")),
      listEvaluable: () => {
        if (served) {
          return Promise.resolve([]);
        }
        served = true;
        return Promise.resolve([alert]);
      },
      markEvaluated: () => Promise.resolve(),
      recordTrigger: () =>
        Promise.resolve({
          outcome: "triggered" as const,
          eventId: recorded ? randomUUID() : null,
          notificationId: recorded ? randomUUID() : null,
        }),
    };
  }

  it("pushes the alert pointer, never the price or the asset address", async () => {
    const push = pushFake();
    const notifications = notificationsFake();
    const worker = createAlertEvaluatorWorker({
      alerts: alerts(true),
      notifications: notifications.repository,
      registry: registry(),
      facts: facts(),
      notificationDedupeSeconds: 3_600,
      push: push.service,
    });
    const result = await worker.runOnce();
    expect(result.triggeredCount).toBe(1);
    expect(push.owner).toHaveLength(1);
    expect(push.owner[0]).toMatchObject({
      ownerUserId,
      eventType: "price_alert_triggered",
      entityRef: `priceAlert:${alertId}`,
      contextRoute: "token",
    });
    expect(JSON.stringify(push.owner[0])).not.toContain("747.39");
    expect(JSON.stringify(push.owner[0])).not.toContain("0xbb4cdb");
  });

  it("does not push when the trigger collapsed onto an existing feed row", async () => {
    const push = pushFake();
    const notifications = notificationsFake();
    const worker = createAlertEvaluatorWorker({
      alerts: alerts(false),
      notifications: notifications.repository,
      registry: registry(),
      facts: facts(),
      notificationDedupeSeconds: 3_600,
      push: push.service,
    });
    await worker.runOnce();
    expect(push.owner).toHaveLength(0);
  });
});
