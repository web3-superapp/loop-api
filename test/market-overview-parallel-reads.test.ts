import { describe, expect, it, vi } from "vitest";

import type { MarketConfig } from "../src/config.js";
import type { BscIndexerRepository } from "../src/database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import type { WatchlistV2Repository } from "../src/database/watchlist-v2-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createMarketFactService } from "../src/features/market/market-fact-service.js";
import { createMarketReadService } from "../src/features/market/market-read-service.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import {
  MarketProviderError,
  type CandlesProvider,
  type MarketPairsProvider,
  type TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";

/**
 * Decision 0086: the overview reads every row's Provider facts in one wave,
 * shares one answer per address inside the request, and a Provider that
 * does not answer within the overview deadline closes only the facts it
 * owns.
 */

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const observedAt = "2026-09-27T08:00:00.000Z";
const principal = {
  userId: "7f1c3c1e-2b5d-4c55-9d7e-0a1b2c3d4e5f",
  privyUserId: "did:privy:overview-user",
  streamUserId: "loop-overview-user",
};

const config: MarketConfig = Object.freeze({
  dexscreener: {
    enabled: true,
    budgetApiPerMinute: 120,
    budgetWorkerPerMinute: 120,
  },
  geckoterminal: {
    enabled: true,
    rateLimitPerMinute: 30,
    budgetWorkerPerMinute: 10,
  },
  goplus: null,
  priceTtlSeconds: 30,
  securityTtlSeconds: 600,
  candlesTtlSeconds: 60,
  sparklineTtlSeconds: 300,
  staleGraceSeconds: 900,
  unlistedPriceTtlSeconds: 60,
  unlistedMetadataTtlSeconds: 3_600,
});

function tokenAsset(address: string, symbol: string): AssetRecord {
  return Object.freeze({
    assetId: `eip155:56:${address}`,
    chainId: bscChainId,
    address,
    symbol,
    name: symbol,
    decimals: 18,
    status: "pending",
    sourceKind: "chain_call",
    sourceBlockNumber: "120000000",
    sourceVerifiedAt: observedAt,
    updatedAt: observedAt,
  });
}

const nativeAsset: AssetRecord = Object.freeze({
  ...tokenAsset(wbnb, "BNB"),
  assetId: "eip155:56:native",
  address: null,
  status: "verified",
  sourceKind: "chain_native",
  sourceBlockNumber: null,
  sourceVerifiedAt: null,
});

/** WBNB, USDT and nine more: eleven readable tokens plus the native asset. */
const tokens: readonly AssetRecord[] = [
  tokenAsset(wbnb, "WBNB"),
  tokenAsset(usdt, "USDT"),
  ...Array.from({ length: 9 }, (_, index) =>
    tokenAsset(
      `0x${(index + 0x100).toString(16).padStart(40, "0")}`,
      `T${index}`,
    ),
  ),
];
const readable: readonly AssetRecord[] = [nativeAsset, ...tokens];
const tokenAddresses = tokens.map((asset) => asset.address ?? "");

function snapshotFor(
  tokenAddress: string,
  priceChangeH24: string | null,
): TokenPairsSnapshot {
  return {
    tokenAddress,
    pairs: [
      {
        pairAddress: `0x${"9".repeat(38)}${tokenAddress.slice(-2)}`,
        dexId: "pancakeswap",
        labels: ["v2"],
        baseTokenAddress: tokenAddress,
        baseTokenSymbol: "TKN",
        quoteTokenAddress: usdt === tokenAddress ? wbnb : usdt,
        quoteTokenSymbol: "USDT",
        priceUsd: "1.25",
        priceNative: null,
        priceChangeH24,
        liquidityUsd: "1000000",
        volumeH24: "250000",
        fdv: null,
        marketCap: null,
        buysH24: 1,
        sellsH24: 1,
        pairCreatedAt: "2023-04-05T14:12:23.000Z",
      },
    ],
  };
}

function cacheFake() {
  const rows = new Map<string, MarketFactCacheRecord>();
  const keyOf = (subjectKey: string, factKind: string, source: string) =>
    `${subjectKey}|${factKind}|${source}`;
  const get = vi.fn((subjectKey: string, factKind: string, source: string) =>
    Promise.resolve(rows.get(keyOf(subjectKey, factKind, source)) ?? null),
  );
  const getMany = vi.fn(
    (subjectKeys: readonly string[], factKind: string, source: string) =>
      Promise.resolve(
        new Map(
          subjectKeys.flatMap((subjectKey) => {
            const record = rows.get(keyOf(subjectKey, factKind, source));
            return record === undefined ? [] : [[subjectKey, record] as const];
          }),
        ),
      ),
  );
  const repository: MarketFactCacheRepository = {
    get,
    getMany,
    put: vi.fn((input: MarketFactCacheRecord) => {
      const record: MarketFactCacheRecord = { ...input };
      rows.set(keyOf(input.subjectKey, input.factKind, input.source), record);
      return Promise.resolve(record);
    }),
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
  return { repository, get, getMany };
}

interface Recorder {
  inFlight: number;
  peak: number;
  readonly batches: string[][];
  singleReads: number;
  newPoolsReads: number;
}

function enter(recorder: Recorder): void {
  recorder.inFlight += 1;
  recorder.peak = Math.max(recorder.peak, recorder.inFlight);
}

function unreachable(): MarketProviderError {
  return new MarketProviderError(
    "market_provider_unreachable",
    "MARKET_PROVIDER_UNREACHABLE",
  );
}

/** Resolves after `ms`, or rejects as the HTTP kernel does when aborted. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(unreachable());
      },
      { once: true },
    );
  });
}

function pairsProvider(
  recorder: Recorder,
  options: {
    readonly omit?: string;
    readonly latencyMs?: number;
  } = {},
): MarketPairsProvider {
  return {
    source: "dexscreener",
    readTokenPairsBatch: async (addresses, readOptions = {}) => {
      recorder.batches.push([...addresses]);
      enter(recorder);
      try {
        await delay(options.latencyMs ?? 10, readOptions.signal);
      } finally {
        recorder.inFlight -= 1;
      }
      return {
        value: addresses
          .filter((address) => address !== options.omit)
          .map((address) =>
            // WBNB's pair comes back without its 24h change, so the native
            // row and the WBNB row both need the remembered one.
            snapshotFor(address, address === wbnb ? null : "0.5"),
          ),
        source: "dexscreener" as const,
        fetchedAt: new Date().toISOString(),
        rawDigest: "d".repeat(64),
      };
    },
    readTokenPairs: () => {
      recorder.singleReads += 1;
      return Promise.reject(unreachable());
    },
    readPair: () => Promise.reject(unreachable()),
  };
}

function candlesProvider(recorder: Recorder): CandlesProvider {
  return {
    source: "geckoterminal",
    readPoolOhlcv: () => Promise.reject(new Error("not used")),
    readNewPools: async (readOptions = {}) => {
      recorder.newPoolsReads += 1;
      enter(recorder);
      try {
        await delay(10, readOptions.signal);
      } finally {
        recorder.inFlight -= 1;
      }
      return {
        value: { pools: [], omittedPoolCount: 0 },
        source: "geckoterminal" as const,
        fetchedAt: new Date().toISOString(),
        rawDigest: "e".repeat(64),
      };
    },
    readPoolTrades: () => Promise.reject(new Error("not used")),
  };
}

function watchlist(assetIds: readonly string[]) {
  const get = vi.fn(() =>
    Promise.resolve({
      version: 1,
      updatedAt: observedAt,
      groups: [
        {
          key: "default",
          name: "All",
          items: assetIds.map((assetId) => ({ assetId })),
        },
      ],
    }),
  );
  const repository: WatchlistV2Repository = {
    get,
    replace: vi.fn(() => Promise.reject(new Error("not used"))),
    listDistinctAssetIds: vi.fn(() => Promise.resolve([])),
  };
  return { repository, get };
}

function subject(
  options: {
    readonly omit?: string;
    readonly pairsLatencyMs?: number;
    readonly deadlineMs?: number;
    readonly watchlistIds?: readonly string[];
  } = {},
) {
  const recorder: Recorder = {
    inFlight: 0,
    peak: 0,
    batches: [],
    singleReads: 0,
    newPoolsReads: 0,
  };
  const cache = cacheFake();
  const facts = createMarketFactService({
    config,
    cache: cache.repository,
    pairsProvider: pairsProvider(recorder, {
      ...(options.omit === undefined ? {} : { omit: options.omit }),
      ...(options.pairsLatencyMs === undefined
        ? {}
        : { latencyMs: options.pairsLatencyMs }),
    }),
    securityProvider: null,
    candlesProvider: candlesProvider(recorder),
  });
  const recall = vi.fn((address: string, pairAddress: string) =>
    facts.recallPrimaryPairPriceChange(address, pairAddress),
  );
  const registry = {
    listReadableAssets: vi.fn(() => Promise.resolve(readable)),
  } as unknown as ChainRegistryRepository;
  const watchlistRepository = watchlist(
    options.watchlistIds ?? [
      nativeAsset.assetId,
      `eip155:56:${wbnb}`,
      `eip155:56:${usdt}`,
    ],
  );
  const service = createMarketReadService({
    registry,
    facts: { ...facts, recallPrimaryPairPriceChange: recall },
    cache: cache.repository,
    indexerRepository: {} as BscIndexerRepository,
    watchlist: watchlistRepository.repository,
    wallets: null,
    readClient: {} as BscReadClient,
    cursorCodec: null,
    lookupQuota: null,
    chainId: bscChainId,
    staleGraceSeconds: config.staleGraceSeconds,
    ...(options.deadlineMs === undefined
      ? {}
      : { overviewProviderDeadlineMs: options.deadlineMs }),
  });
  return { service, recorder, recall, cache, watchlistRepository };
}

interface Row {
  readonly assetId: string;
  readonly price: { readonly quality: string; readonly reasonCode: unknown };
  readonly priceChange24h: { readonly quality: string };
}

describe("market overview reads (Decision 0086)", () => {
  it("reads eleven assets in one Provider wave, each address once, beside the new-pools read", async () => {
    const { service, recorder, recall, cache, watchlistRepository } = subject();
    const overview = await service.getOverview({ principal });

    // One batch request, every token address in it exactly once; the
    // native row is priced through WBNB and adds no address.
    expect(recorder.batches).toHaveLength(1);
    const requested = recorder.batches[0] ?? [];
    expect(requested).toHaveLength(tokenAddresses.length);
    expect(new Set(requested)).toEqual(new Set(tokenAddresses));
    expect(recorder.singleReads).toBe(0);
    // The pairs batch and the new-pools list were in flight together.
    expect(recorder.newPoolsReads).toBe(1);
    expect(recorder.peak).toBe(2);
    // One cache query for the pairs rows (and one for the sparklines),
    // never one per subject.
    // Single-row reads: the new-pools row and WBNB's remembered 24h change.
    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(cache.getMany).toHaveBeenCalledTimes(2);
    // WBNB's missing 24h change is recalled once, though two rows need it.
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0]?.[0]).toBe(wbnb);
    // The watchlist is read once.
    expect(watchlistRepository.get).toHaveBeenCalledTimes(1);

    expect(overview.watchlist.status).toBe("available");
    expect(overview.trending.status).toBe("available");
    const trending = overview.trending as unknown as {
      readonly items: readonly Row[];
    };
    expect(trending.items).toHaveLength(tokens.length);
    expect(trending.items.every((row) => row.price.quality === "fresh")).toBe(
      true,
    );
  });

  it("keeps every other row available when the Provider answers without one asset", async () => {
    const missing = tokenAddresses[4] ?? "";
    const { service } = subject({
      omit: missing,
      watchlistIds: [`eip155:56:${missing}`, `eip155:56:${usdt}`],
    });
    const overview = await service.getOverview({ principal });

    const watchRows = (
      overview.watchlist as unknown as { readonly items: readonly Row[] }
    ).items;
    expect(watchRows.map((row) => row.assetId)).toEqual([
      `eip155:56:${missing}`,
      `eip155:56:${usdt}`,
    ]);
    expect(watchRows[0]?.price).toMatchObject({
      quality: "unavailable",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
    expect(watchRows[1]?.price.quality).toBe("fresh");

    const trendRows = (
      overview.trending as unknown as { readonly items: readonly Row[] }
    ).items;
    expect(trendRows).toHaveLength(tokens.length - 1);
    expect(trendRows.map((row) => row.assetId)).not.toContain(
      `eip155:56:${missing}`,
    );
    expect(trendRows.every((row) => row.price.quality === "fresh")).toBe(true);
    expect(overview.newPairs.status).toBe("available");
  });

  it("answers inside the deadline when the pairs Provider stalls, closing only the facts it owns", async () => {
    const { service, recorder } = subject({
      pairsLatencyMs: 60_000,
      deadlineMs: 50,
    });
    const started = Date.now();
    const overview = await service.getOverview({ principal });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(recorder.batches).toHaveLength(1);
    expect(recorder.singleReads).toBe(0);
    const watchRows = (
      overview.watchlist as unknown as { readonly items: readonly Row[] }
    ).items;
    expect(watchRows.length).toBeGreaterThan(0);
    for (const row of watchRows) {
      expect(row.price).toMatchObject({
        quality: "unavailable",
        reasonCode: "MARKET_PROVIDER_UNREACHABLE",
      });
    }
    // No row has a volume to order by, so trending closes with the reason.
    expect(overview.trending).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
    // The new-pools read answered in time and is unaffected.
    expect(overview.newPairs.status).toBe("available");
  });

  it("serves the last fresh answer as stale when the Provider stalls after it", async () => {
    const warm = subject();
    await warm.service.getOverview({ principal });
    // Same cache, a stalled Provider, and the TTL passed.
    const rows = warm.cache.repository;
    const later = new Date(Date.now() + 45_000);
    const recorder: Recorder = {
      inFlight: 0,
      peak: 0,
      batches: [],
      singleReads: 0,
      newPoolsReads: 0,
    };
    const facts = createMarketFactService({
      config,
      cache: rows,
      pairsProvider: pairsProvider(recorder, { latencyMs: 60_000 }),
      securityProvider: null,
      candlesProvider: candlesProvider(recorder),
      now: () => later,
    });
    const service = createMarketReadService({
      registry: {
        listReadableAssets: vi.fn(() => Promise.resolve(readable)),
      } as unknown as ChainRegistryRepository,
      facts,
      cache: rows,
      indexerRepository: {} as BscIndexerRepository,
      watchlist: watchlist([`eip155:56:${usdt}`]).repository,
      wallets: null,
      readClient: {} as BscReadClient,
      cursorCodec: null,
      lookupQuota: null,
      chainId: bscChainId,
      staleGraceSeconds: config.staleGraceSeconds,
      overviewProviderDeadlineMs: 50,
      now: () => later,
    });
    const overview = await service.getOverview({ principal });
    const watchRows = (
      overview.watchlist as unknown as { readonly items: readonly Row[] }
    ).items;
    expect(watchRows[0]?.price).toMatchObject({
      quality: "stale",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
    expect(overview.trending.status).toBe("available");
  });
});

describe("market asset detail reads (Decision 0088)", () => {
  it("asks the pair facts, the security facts, the bound community and the 24h range together", async () => {
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const held = <T>(name: string, value: () => T): Promise<T> => {
      started.push(name);
      return new Promise<T>((resolve) => {
        gates.push(() => {
          resolve(value());
        });
      });
    };
    const cache = cacheFake();
    const facts = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: null,
      securityProvider: null,
      candlesProvider: null,
    });
    const token = tokenAsset(usdt, "USDT");
    const service = createMarketReadService({
      registry: {
        getAsset: vi.fn(() => Promise.resolve(token)),
      } as unknown as ChainRegistryRepository,
      facts: {
        ...facts,
        candlesProviderEnabled: true,
        readTokenPairs: (address: string) =>
          held("pairs", () => ({
            value: snapshotFor(address, "0.5"),
            source: "dexscreener" as const,
            fetchedAt: observedAt,
            ttlSeconds: 30,
            quality: "fresh" as const,
            reasonCode: null,
            rawDigest: null,
          })),
        readTokenSecurity: () =>
          held("security", () => ({
            value: null,
            source: "goplus" as const,
            fetchedAt: null,
            ttlSeconds: 600,
            quality: "unavailable" as const,
            reasonCode: "GOPLUS_NOT_CONFIGURED",
            rawDigest: null,
          })),
      },
      cache: {
        ...cache.repository,
        findVerifiedCommunityByAssetId: () => held("community", () => null),
        get: () => held("range", () => null),
      },
      indexerRepository: {} as BscIndexerRepository,
      watchlist: watchlist([]).repository,
      wallets: null,
      readClient: {
        verifyChain: () => Promise.resolve("verified"),
      } as unknown as BscReadClient,
      cursorCodec: null,
      lookupQuota: null,
      chainId: bscChainId,
      staleGraceSeconds: config.staleGraceSeconds,
    });
    const pending = service.getAsset({
      assetId: token.assetId,
      caller: { principal, canonicalClientIp: "203.0.113.7" },
    });
    await vi.waitFor(() => {
      expect([...started].sort()).toEqual([
        "community",
        "pairs",
        "range",
        "security",
      ]);
    });
    // None of the four has answered: none waited for another.
    for (const open of gates.splice(0, gates.length)) {
      open();
    }
    const resource = await pending;
    expect(resource.price.value).toBe("1.25");
    expect(resource.security).toMatchObject({
      status: "unavailable",
      reasonCode: "GOPLUS_NOT_CONFIGURED",
    });
    expect(resource.community).toMatchObject({ status: "unavailable" });
  });
});
