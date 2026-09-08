import { describe, expect, it, vi } from "vitest";

import {
  conditionSatisfied,
  createAlertEvaluatorWorker,
  priceAlertDedupeKey,
} from "../src/alert-evaluator-worker.js";
import type {
  AlertV2Repository,
  PriceAlertV2Record,
  RecordPriceAlertTriggerInput,
} from "../src/database/alert-v2-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import type { NotificationRepository } from "../src/database/notification-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type {
  CachedFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import type { TokenPairsSnapshot } from "../src/integrations/market/market-data-provider.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const owner = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const alertId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const observedAt = "2026-09-08T00:00:00.000Z";

const asset: AssetRecord = Object.freeze({
  assetId: wbnbAssetId,
  chainId: bscChainId,
  address: wbnb,
  symbol: "WBNB",
  name: "Wrapped BNB",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "1",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

function alert(
  overrides: Partial<PriceAlertV2Record> = {},
): PriceAlertV2Record {
  return Object.freeze({
    alertId,
    ownerUserId: owner,
    createRequestSha256: "a".repeat(64),
    assetId: wbnbAssetId,
    condition: "at_or_above",
    threshold: "700",
    expiresAt: null,
    state: "active",
    triggeredAt: null,
    lastEvaluatedAt: null,
    deletedAt: null,
    recordVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  });
}

function pairsFact(
  priceUsd: string | null,
  quality: CachedFact<TokenPairsSnapshot>["quality"],
): CachedFact<TokenPairsSnapshot> {
  return {
    value:
      priceUsd === null
        ? null
        : {
            tokenAddress: wbnb,
            pairs: [
              {
                pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
                dexId: "pancakeswap",
                labels: ["v3"],
                baseTokenAddress: wbnb,
                baseTokenSymbol: "WBNB",
                quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
                quoteTokenSymbol: "USDT",
                priceUsd,
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
    fetchedAt: priceUsd === null ? null : observedAt,
    ttlSeconds: 30,
    quality,
    reasonCode: quality === "fresh" ? null : "MARKET_PROVIDER_RATE_LIMITED",
    rawDigest: null,
  };
}

function harness(options: {
  readonly alerts: readonly PriceAlertV2Record[];
  readonly fact: CachedFact<TokenPairsSnapshot>;
  readonly preferenceEnabled?: boolean;
  readonly nativeAsset?: boolean;
  readonly batchSize?: number;
}) {
  const triggers: RecordPriceAlertTriggerInput[] = [];
  const evaluated: string[][] = [];
  const listEvaluable = vi.fn(
    (input: {
      readonly limit: number;
      readonly excludeIds: readonly string[];
    }) =>
      Promise.resolve(
        options.alerts
          .filter((alert) => !input.excludeIds.includes(alert.alertId))
          .slice(0, options.batchSize ?? input.limit),
      ),
  );
  const alerts: AlertV2Repository = {
    create: vi.fn(() => Promise.reject(new Error("not used"))),
    listOwned: vi.fn(() => Promise.reject(new Error("not used"))),
    findOwned: vi.fn(() => Promise.reject(new Error("not used"))),
    replaceOwned: vi.fn(() => Promise.reject(new Error("not used"))),
    softDeleteOwned: vi.fn(() => Promise.reject(new Error("not used"))),
    listEvaluable,
    markEvaluated: vi.fn((ids: readonly string[]) => {
      evaluated.push([...ids]);
      return Promise.resolve();
    }),
    recordTrigger: vi.fn((input: RecordPriceAlertTriggerInput) => {
      triggers.push(input);
      return Promise.resolve({
        outcome: "triggered" as const,
        eventId: "1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        notificationId:
          input.notification === null
            ? null
            : "2c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      });
    }),
  };
  const notifications: NotificationRepository = {
    listFeed: vi.fn(() => Promise.reject(new Error("not used"))),
    listRecentByType: vi.fn(() => Promise.reject(new Error("not used"))),
    markRead: vi.fn(() => Promise.reject(new Error("not used"))),
    getPreferences: vi.fn(() => Promise.reject(new Error("not used"))),
    replacePreferences: vi.fn(() => Promise.reject(new Error("not used"))),
    isCategoryEnabled: vi.fn(() =>
      Promise.resolve(options.preferenceEnabled ?? true),
    ),
  };
  const registry: ChainRegistryRepository = {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn(() =>
      Promise.resolve(
        options.nativeAsset === true
          ? {
              ...asset,
              assetId: "eip155:56:native",
              address: null,
              symbol: "BNB",
            }
          : asset,
      ),
    ),
    listAssets: vi.fn(() => Promise.resolve([asset])),
    listReadableAssets: vi.fn(() => Promise.resolve([asset])),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve([])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
  const readTokenPairs = vi.fn(() => Promise.resolve(options.fact));
  const readAssetPrice = vi.fn((target: { readonly address: string | null }) =>
    Promise.resolve({
      fact: options.fact,
      pair:
        options.fact.value === null
          ? null
          : (options.fact.value.pairs[0] ?? null),
      proxyAsset: target.address === null ? wbnbAssetId : null,
    }),
  );
  const facts: MarketFactService = {
    readTokenPairs,
    readTokenPairsBatch: vi.fn(() => Promise.reject(new Error("not used"))),
    readAssetPrice,
    readTokenSecurity: vi.fn(() => Promise.reject(new Error("not used"))),
    readPoolOhlcv: vi.fn(() => Promise.reject(new Error("not used"))),
    readNewPools: vi.fn(() => Promise.reject(new Error("not used"))),
    candlesProviderEnabled: false,
  };
  const worker = createAlertEvaluatorWorker({
    alerts,
    notifications,
    registry,
    facts,
    notificationDedupeSeconds: 3_600,
    now: () => new Date("2026-09-08T00:00:05.000Z"),
  });
  return {
    worker,
    triggers,
    evaluated,
    readTokenPairs,
    readAssetPrice,
    listEvaluable,
  };
}

describe("alert evaluator lane", () => {
  it("compares decimal strings exactly per condition", () => {
    expect(conditionSatisfied("above", "700.01", "700")).toBe(true);
    expect(conditionSatisfied("above", "700", "700")).toBe(false);
    expect(conditionSatisfied("at_or_above", "700", "700.0")).toBe(true);
    expect(conditionSatisfied("below", "699.999999999999999999", "700")).toBe(
      true,
    );
    expect(
      conditionSatisfied("at_or_below", "700.000000000000000001", "700"),
    ).toBe(false);
  });

  it("buckets the dedupe key by the configured window", () => {
    expect(
      priceAlertDedupeKey(alertId, "2026-09-08T00:30:00.000Z", 3_600),
    ).toBe(priceAlertDedupeKey(alertId, "2026-09-08T00:59:59.000Z", 3_600));
    expect(
      priceAlertDedupeKey(alertId, "2026-09-08T00:30:00.000Z", 3_600),
    ).not.toBe(priceAlertDedupeKey(alertId, "2026-09-08T01:00:00.000Z", 3_600));
  });

  it("triggers on a fresh price and writes the context notification", async () => {
    const { worker, triggers, readTokenPairs } = harness({
      alerts: [alert()],
      fact: pairsFact("747.39", "fresh"),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "evaluated",
      evaluatedCount: 1,
      triggeredCount: 1,
      skippedCount: 0,
    });
    expect(readTokenPairs).not.toHaveBeenCalled();
    expect(triggers[0]).toMatchObject({
      alertId,
      ownerUserId: owner,
      valueDecimal: "747.39",
      source: "dexscreener",
      sourceFactRef: "dexscreener:0x172fcd41e0913e95784454622d1c3724f546f849",
      observedAt,
      notification: {
        type: "trade.priceAlert",
        entityRef: `priceAlert:${alertId}`,
        contextRoute: "token",
        contextParams: { assetId: wbnbAssetId },
        payload: {
          assetId: wbnbAssetId,
          symbol: "WBNB",
          condition: "at_or_above",
          threshold: "700",
          observedValue: "747.39",
          source: "dexscreener",
          observedAt,
          proxyAsset: null,
        },
        dedupeKey: priceAlertDedupeKey(alertId, observedAt, 3_600),
      },
    });
  });

  it("never triggers on a stale or missing price", async () => {
    const stale = harness({
      alerts: [alert()],
      fact: pairsFact("747.39", "stale"),
    });
    await expect(stale.worker.runOnce()).resolves.toMatchObject({
      kind: "evaluated",
      triggeredCount: 0,
      skippedCount: 1,
      skippedReasonCodes: ["MARKET_PROVIDER_RATE_LIMITED"],
    });
    expect(stale.triggers).toEqual([]);
    const missing = harness({
      alerts: [alert()],
      fact: pairsFact(null, "unavailable"),
    });
    await expect(missing.worker.runOnce()).resolves.toMatchObject({
      skippedCount: 1,
    });
    expect(missing.triggers).toEqual([]);
  });

  it("records the evaluation without triggering when the condition is not met", async () => {
    const { worker, triggers, evaluated } = harness({
      alerts: [alert({ threshold: "800" })],
      fact: pairsFact("747.39", "fresh"),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      evaluatedCount: 1,
      triggeredCount: 0,
    });
    expect(triggers).toEqual([]);
    expect(evaluated).toEqual([[alertId]]);
  });

  it("evaluates a native-asset alert through the WBNB proxy and records it", async () => {
    const nativeId = "eip155:56:native";
    const { worker, triggers } = harness({
      alerts: [alert({ assetId: nativeId })],
      fact: pairsFact("747.39", "fresh"),
      nativeAsset: true,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      triggeredCount: 1,
    });
    expect(triggers[0]).toMatchObject({
      sourceFactRef: `dexscreener:0x172fcd41e0913e95784454622d1c3724f546f849:proxy:${wbnb}`,
      notification: { payload: { proxyAsset: wbnbAssetId } },
    });
  });

  it("pages through every active alert in one tick", async () => {
    const many = Array.from({ length: 3 }, (_, index) =>
      alert({
        alertId: `0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4${String(index)}`,
        threshold: "800",
      }),
    );
    const { worker, evaluated, listEvaluable } = harness({
      alerts: many,
      fact: pairsFact("747.39", "fresh"),
      batchSize: 1,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      evaluatedCount: 3,
    });
    expect(evaluated[0]).toHaveLength(3);
    expect(listEvaluable).toHaveBeenCalledTimes(4);
  });

  it("records the trigger but no notification when the owner disabled the category", async () => {
    const { worker, triggers } = harness({
      alerts: [alert()],
      fact: pairsFact("747.39", "fresh"),
      preferenceEnabled: false,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      triggeredCount: 1,
    });
    expect(triggers[0]?.notification).toBeNull();
  });

  it("is idle with nothing to evaluate", async () => {
    const { worker, readTokenPairs } = harness({
      alerts: [],
      fact: pairsFact("747.39", "fresh"),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ kind: "idle" });
    expect(readTokenPairs).not.toHaveBeenCalled();
  });
});
