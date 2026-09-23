import { describe, expect, it, vi } from "vitest";

import type {
  AssetRecord,
  ChainRegistryRepository,
  PoolRecord,
} from "../src/database/chain-registry-repository.js";
import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import type { WatchlistV2Repository } from "../src/database/watchlist-v2-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type {
  CachedFact,
  MarketFactService,
  UnlistedTokenFact,
} from "../src/features/market/market-fact-service.js";
import type { PoolOhlcvSnapshot } from "../src/integrations/market/market-data-provider.js";
import {
  createMarketSparklineWarmWorker,
  delayAfter,
  MARKET_SPARKLINE_WARM_IDLE_DELAY_MS,
  MARKET_SPARKLINE_WARM_RATE_LIMITED_DELAY_MS,
  selectTargets,
} from "../src/market-sparkline-warm-worker.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const btcb = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const usdtAssetId = `eip155:56:${usdt}`;
const btcbAssetId = `eip155:56:${btcb}`;
const nativeAssetId = "eip155:56:native";
const registeredPool = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const providerPool = "0x6bbc40579ad1bbd243895ca0acb086bb6300d636";
const observedAt = "2026-09-23T11:00:00.000Z";

function asset(overrides: Partial<AssetRecord>): AssetRecord {
  return Object.freeze({
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
    ...overrides,
  });
}

const nativeAsset = asset({
  assetId: nativeAssetId,
  address: null,
  symbol: "BNB",
  name: "BNB",
  status: "verified",
  sourceKind: "chain_native",
});
const wbnbAsset = asset({});
const usdtAsset = asset({
  assetId: usdtAssetId,
  address: usdt,
  symbol: "USDT",
  name: "Tether USD",
});
const btcbAsset = asset({
  assetId: btcbAssetId,
  address: btcb,
  symbol: "BTCB",
  name: "BTCB Token",
});
const blockedAsset = asset({
  assetId: `eip155:56:0x${"9".repeat(40)}`,
  address: `0x${"9".repeat(40)}`,
  symbol: "BAD",
  name: "Blocked",
  status: "blocked",
});

/** USDT/WBNB is registered; BTCB has no registered pool. */
const pool: PoolRecord = Object.freeze({
  poolId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  chainId: bscChainId,
  protocol: "pancakeswap_v3",
  address: registeredPool,
  token0AssetId: usdtAssetId,
  token1AssetId: wbnbAssetId,
  fee: 500,
  tickSpacing: 10,
  status: "registered",
});

function candles(count: number): PoolOhlcvSnapshot["candles"] {
  return Array.from({ length: count }, (_, index) => ({
    openTime: new Date(Date.UTC(2026, 8, 22, index)).toISOString(),
    open: String(100 + index),
    high: String(101 + index),
    low: String(99 + index),
    close: `${String(100 + index)}.5`,
    volume: "1",
  }));
}

function ohlcvFact(
  poolAddress: string,
  count = 30,
  fetchedAt = observedAt,
): CachedFact<PoolOhlcvSnapshot> {
  return {
    value: { poolAddress, candles: candles(count) },
    source: "geckoterminal",
    fetchedAt,
    ttlSeconds: 60,
    quality: "fresh",
    reasonCode: null,
    rawDigest: "c".repeat(64),
  };
}

function unavailableOhlcv(reasonCode: string): CachedFact<PoolOhlcvSnapshot> {
  return {
    value: null,
    source: "geckoterminal",
    fetchedAt: null,
    ttlSeconds: 60,
    quality: "unavailable",
    reasonCode,
    rawDigest: null,
  };
}

function lookupFact(pairAddress: string | null): UnlistedTokenFact {
  return {
    identity: {
      value: { symbol: "BTCB", name: "BTCB Token", decimals: 18 },
      source: "geckoterminal",
      fetchedAt: observedAt,
      ttlSeconds: 3_600,
      quality: "fresh",
      reasonCode: null,
      rawDigest: "e".repeat(64),
    },
    market: {
      value: {
        priceUsd: "85886.18",
        priceChangeH24: "-0.07",
        liquidityUsd: "29004992.38",
        volumeH24: "18010166.16",
        marketCap: null,
        fdv: null,
        primaryPair:
          pairAddress === null
            ? null
            : {
                pairAddress,
                dexId: "pancakeswap-v3-bsc",
                labels: [],
                quoteTokenAddress: wbnb,
                quoteTokenSymbol: "WBNB",
                pairCreatedAt: null,
              },
        imageUrl: null,
      },
      source: "geckoterminal",
      fetchedAt: observedAt,
      ttlSeconds: 60,
      quality: "fresh",
      reasonCode: null,
      rawDigest: "e".repeat(64),
    },
    notFound: false,
  };
}

function harness(
  options: {
    readonly assets?: readonly AssetRecord[];
    readonly watchlisted?: readonly string[];
    readonly ohlcv?: (poolAddress: string) => CachedFact<PoolOhlcvSnapshot>;
    readonly lookup?: () => UnlistedTokenFact;
    readonly now?: () => Date;
  } = {},
) {
  const rows = new Map<string, MarketFactCacheRecord>();
  const keyOf = (subjectKey: string, factKind: string, source: string) =>
    `${subjectKey}|${factKind}|${source}`;
  const cache: MarketFactCacheRepository = {
    get: vi.fn((subjectKey: string, factKind: string, source: string) =>
      Promise.resolve(rows.get(keyOf(subjectKey, factKind, source)) ?? null),
    ),
    getMany: vi.fn(() => Promise.resolve(new Map())),
    put: vi.fn((input: MarketFactCacheRecord) => {
      const record: MarketFactCacheRecord = { ...input };
      rows.set(keyOf(input.subjectKey, input.factKind, input.source), record);
      return Promise.resolve(record);
    }),
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
  const assets = options.assets ?? [nativeAsset, wbnbAsset, usdtAsset];
  const registry: ChainRegistryRepository = {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn((assetId: string) =>
      Promise.resolve(
        assets.find((entry) => entry.assetId === assetId) ?? null,
      ),
    ),
    listAssets: vi.fn(() => Promise.resolve(assets)),
    listReadableAssets: vi.fn(() => Promise.resolve(assets)),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve([pool])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
  const watchlist: WatchlistV2Repository = {
    get: vi.fn(() => Promise.reject(new Error("not used"))),
    replace: vi.fn(() => Promise.reject(new Error("not used"))),
    listDistinctAssetIds: vi.fn(() =>
      Promise.resolve(options.watchlisted ?? []),
    ),
  };
  const readPoolOhlcv = vi.fn<MarketFactService["readPoolOhlcv"]>((request) =>
    Promise.resolve((options.ohlcv ?? ohlcvFact)(request.poolAddress)),
  );
  const readUnlistedToken = vi.fn<MarketFactService["readUnlistedToken"]>(() =>
    Promise.resolve((options.lookup ?? (() => lookupFact(providerPool)))()),
  );
  const facts: MarketFactService = {
    readTokenPairs: vi.fn(() => Promise.reject(new Error("not used"))),
    readTokenPairsBatch: vi.fn(() => Promise.reject(new Error("not used"))),
    readPair: vi.fn(() => Promise.reject(new Error("not used"))),
    readAssetPrice: vi.fn(() => Promise.reject(new Error("not used"))),
    readAssetPrices: vi.fn(() => Promise.reject(new Error("not used"))),
    readTokenSecurity: vi.fn(() => Promise.reject(new Error("not used"))),
    readPoolOhlcv,
    readNewPools: vi.fn(() => Promise.reject(new Error("not used"))),
    readUnlistedToken,
    recallPrimaryPairPriceChange: vi.fn(() => Promise.resolve(null)),
    candlesProviderEnabled: true,
  };
  const worker = createMarketSparklineWarmWorker({
    registry,
    watchlist,
    cache,
    facts,
    chainId: bscChainId,
    intervalMs: 4_000,
    sparklineTtlSeconds: 300,
    poolRevalidationSeconds: 3_600,
    now: options.now ?? (() => new Date("2026-09-23T11:00:05.000Z")),
  });
  return {
    worker,
    rows,
    cache,
    registry,
    facts,
    readPoolOhlcv,
    readUnlistedToken,
  };
}

describe("market sparkline warm lane (Decision 0074)", () => {
  it("targets readable assets with watchlisted ones first, charts native as WBNB, and skips blocked ones", () => {
    const targets = selectTargets({
      readable: [nativeAsset, wbnbAsset, usdtAsset, btcbAsset, blockedAsset],
      watchlisted: [btcbAssetId, blockedAsset.assetId, "eip155:56:0xunknown"],
    });
    expect(targets.map((target) => target.assetId)).toEqual([
      btcbAssetId,
      nativeAssetId,
      wbnbAssetId,
      usdtAssetId,
    ]);
    expect(targets[1]?.tokenAddress).toBe(wbnb);
  });

  it("refreshes one stale asset per run from its registered pool, then skips every fresh row without a Provider call", async () => {
    const { worker, rows, readPoolOhlcv, readUnlistedToken } = harness();
    // Native → WBNB, then WBNB itself: the same address, one row.
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      assetId: nativeAssetId,
      tokenAddress: wbnb,
      poolAddress: registeredPool,
      poolOrigin: "registry",
      candleCount: 24,
      skippedFreshCount: 0,
    });
    const row = rows.get(`token:${wbnb}|sparkline_1h|geckoterminal`);
    expect(row).toMatchObject({
      fetchedAt: observedAt,
      ttlSeconds: 300,
      rawDigest: "c".repeat(64),
      value: {
        interval: "1h",
        poolOrigin: "registry",
        candleCount: 24,
        // Extremes of the kept 24 candles (indices 6..29 of the 30).
        high: "130",
        low: "105",
      },
    });
    expect((row?.value["closes"] as string[]).length).toBe(24);
    expect(readUnlistedToken).not.toHaveBeenCalled();

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      assetId: usdtAssetId,
      poolAddress: registeredPool,
      skippedFreshCount: 1,
    });
    expect(readPoolOhlcv).toHaveBeenCalledTimes(2);

    await expect(worker.runOnce()).resolves.toEqual({
      kind: "idle",
      skippedFreshCount: 3,
    });
    expect(readPoolOhlcv).toHaveBeenCalledTimes(2);
  });

  it("charts a token without a registered pool from the Provider top pool and reuses that pool inside the re-validation window", async () => {
    let clock = Date.parse("2026-09-23T11:00:05.000Z");
    const { worker, rows, readPoolOhlcv, readUnlistedToken } = harness({
      assets: [btcbAsset],
      now: () => new Date(clock),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      assetId: btcbAssetId,
      poolAddress: providerPool,
      poolOrigin: "provider",
    });
    expect(readUnlistedToken).toHaveBeenCalledTimes(1);
    expect(readPoolOhlcv).toHaveBeenLastCalledWith({
      poolAddress: providerPool,
      timeframe: "1h",
      limit: 24,
      tokenAddress: btcb,
    });
    const first = rows.get(`token:${btcb}|sparkline_1h|geckoterminal`);
    expect(first?.value["poolChosenAt"]).toBe("2026-09-23T11:00:05.000Z");

    // Past the sparkline TTL, inside the pool re-validation window: one
    // OHLCV read, no lookup.
    clock += 400_000;
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      poolAddress: providerPool,
    });
    expect(readUnlistedToken).toHaveBeenCalledTimes(1);
    expect(readPoolOhlcv).toHaveBeenCalledTimes(2);
    expect(
      rows.get(`token:${btcb}|sparkline_1h|geckoterminal`)?.value[
        "poolChosenAt"
      ],
    ).toBe("2026-09-23T11:00:05.000Z");

    // Past the re-validation window the pool is looked up again.
    clock += 3_600_000;
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
    });
    expect(readUnlistedToken).toHaveBeenCalledTimes(2);
  });

  it("reports a Provider failure with its reason, writes nothing, and moves on to the next asset", async () => {
    const { worker, rows, readPoolOhlcv } = harness({
      assets: [wbnbAsset, usdtAsset],
      ohlcv: (poolAddress) =>
        readPoolOhlcv.mock.calls.length === 1
          ? unavailableOhlcv("MARKET_PROVIDER_RATE_LIMITED")
          : ohlcvFact(poolAddress),
    });
    const failed = await worker.runOnce();
    expect(failed).toMatchObject({
      kind: "failed",
      assetId: wbnbAssetId,
      reasonCode: "MARKET_PROVIDER_RATE_LIMITED",
    });
    expect(rows.size).toBe(0);
    expect(delayAfter(failed, 4_000)).toBe(
      MARKET_SPARKLINE_WARM_RATE_LIMITED_DELAY_MS,
    );
    // The round-robin advanced past the failed asset.
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      assetId: usdtAssetId,
    });
    expect(readPoolOhlcv).toHaveBeenCalledTimes(2);
  });

  it("keeps MARKET_POOL_NOT_REGISTERED when the Provider knows no pool either, and the Provider's reason when it could not answer", async () => {
    const noPool = harness({
      assets: [btcbAsset],
      lookup: () => lookupFact(null),
    });
    await expect(noPool.worker.runOnce()).resolves.toMatchObject({
      kind: "failed",
      reasonCode: "MARKET_POOL_NOT_REGISTERED",
    });
    expect(noPool.readPoolOhlcv).not.toHaveBeenCalled();

    const unreachable = harness({
      assets: [btcbAsset],
      lookup: () => ({
        ...lookupFact(null),
        market: {
          ...lookupFact(null).market,
          value: null,
          fetchedAt: null,
          quality: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
          rawDigest: null,
        },
      }),
    });
    await expect(unreachable.worker.runOnce()).resolves.toMatchObject({
      kind: "failed",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
  });

  it("writes an empty row for a pool the Provider answered without candles so it is not asked again before the TTL", async () => {
    const { worker, rows, readPoolOhlcv } = harness({
      assets: [usdtAsset],
      ohlcv: (poolAddress) => ohlcvFact(poolAddress, 0),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "refreshed",
      candleCount: 0,
    });
    expect(
      rows.get(`token:${usdt}|sparkline_1h|geckoterminal`)?.value,
    ).toMatchObject({ closes: [], candleCount: 0, high: null, low: null });
    await expect(worker.runOnce()).resolves.toEqual({
      kind: "idle",
      skippedFreshCount: 1,
    });
    expect(readPoolOhlcv).toHaveBeenCalledTimes(1);
  });

  it("paces the loop by what the tick did", () => {
    expect(delayAfter({ kind: "idle", skippedFreshCount: 3 }, 4_000)).toBe(
      MARKET_SPARKLINE_WARM_IDLE_DELAY_MS,
    );
    expect(
      delayAfter(
        {
          kind: "refreshed",
          assetId: wbnbAssetId,
          tokenAddress: wbnb,
          poolAddress: registeredPool,
          poolOrigin: "registry",
          candleCount: 24,
          skippedFreshCount: 0,
        },
        4_000,
      ),
    ).toBe(4_000);
    expect(
      delayAfter(
        {
          kind: "failed",
          assetId: wbnbAssetId,
          tokenAddress: wbnb,
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
          skippedFreshCount: 0,
        },
        4_000,
      ),
    ).toBe(4_000);
    expect(delayAfter({ kind: "aborted", skippedFreshCount: 0 }, 4_000)).toBe(
      0,
    );
  });

  it("backs off on a repository failure and stops when aborted", async () => {
    const { worker, registry, cache, facts } = harness();
    const controller = new AbortController();
    const backoffs: number[] = [];
    await createMarketSparklineWarmWorker({
      registry: {
        ...registry,
        listReadableAssets: vi.fn(() =>
          Promise.reject(new Error("database down")),
        ),
      },
      watchlist: null,
      cache,
      facts,
      chainId: bscChainId,
      intervalMs: 4_000,
      sparklineTtlSeconds: 300,
      poolRevalidationSeconds: 3_600,
      onInfrastructureBackoff: (event) => {
        backoffs.push(event.retryDelayMs);
        controller.abort();
      },
    }).run(controller.signal);
    expect(backoffs).toEqual([1_000]);
    // A tick that starts after the abort does nothing.
    await expect(worker.runOnce(controller.signal)).resolves.toMatchObject({
      kind: "aborted",
    });
  });
});
