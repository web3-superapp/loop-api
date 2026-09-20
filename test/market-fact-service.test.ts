import { describe, expect, it, vi } from "vitest";

import type { MarketConfig } from "../src/config.js";
import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import {
  createMarketFactService,
  selectPrimaryPair,
} from "../src/features/market/market-fact-service.js";
import {
  MarketProviderError,
  type MarketPairsProvider,
  type TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";

const config: MarketConfig = Object.freeze({
  dexscreener: {
    enabled: true,
    budgetApiPerMinute: 120,
    budgetWorkerPerMinute: 120,
  },
  geckoterminal: { enabled: false, rateLimitPerMinute: 30 },
  goplus: null,
  priceTtlSeconds: 30,
  securityTtlSeconds: 600,
  candlesTtlSeconds: 60,
  staleGraceSeconds: 900,
});

function snapshot(priceUsd: string): TokenPairsSnapshot {
  return {
    tokenAddress: wbnb,
    pairs: [
      {
        pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
        dexId: "pancakeswap",
        labels: ["v3"],
        baseTokenAddress: wbnb,
        baseTokenSymbol: "WBNB",
        quoteTokenAddress: usdt,
        quoteTokenSymbol: "USDT",
        priceUsd,
        priceNative: null,
        liquidityUsd: "11937174.89",
        volumeH24: "219189066.89",
        priceChangeH24: "0.27",
        fdv: null,
        marketCap: null,
        buysH24: null,
        sellsH24: null,
        pairCreatedAt: null,
      },
      {
        pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        dexId: "pancakeswap",
        labels: ["v2"],
        baseTokenAddress: wbnb,
        baseTokenSymbol: "WBNB",
        quoteTokenAddress: usdt,
        quoteTokenSymbol: "USDT",
        priceUsd: "746.63",
        priceNative: null,
        liquidityUsd: "94854491.12",
        volumeH24: "29916520.68",
        priceChangeH24: null,
        fdv: null,
        marketCap: null,
        buysH24: null,
        sellsH24: null,
        pairCreatedAt: null,
      },
      {
        pairAddress: "0x0000000000000000000000000000000000000009",
        dexId: "other",
        labels: [],
        baseTokenAddress: usdt,
        baseTokenSymbol: "USDT",
        quoteTokenAddress: wbnb,
        quoteTokenSymbol: "WBNB",
        priceUsd: "1",
        priceNative: null,
        liquidityUsd: "999999999",
        volumeH24: null,
        priceChangeH24: null,
        fdv: null,
        marketCap: null,
        buysH24: null,
        sellsH24: null,
        pairCreatedAt: null,
      },
    ],
  };
}

function cacheFake(initial: MarketFactCacheRecord | null = null) {
  const rows = new Map<string, MarketFactCacheRecord>();
  const keyOf = (subjectKey: string, factKind: string, source: string) =>
    `${subjectKey}|${factKind}|${source}`;
  if (initial !== null) {
    rows.set(
      keyOf(initial.subjectKey, initial.factKind, initial.source),
      initial,
    );
  }
  const get = vi.fn((subjectKey: string, factKind: string, source: string) =>
    Promise.resolve(rows.get(keyOf(subjectKey, factKind, source)) ?? null),
  );
  const repository: MarketFactCacheRepository = {
    get,
    put: vi.fn((input: MarketFactCacheRecord) => {
      const record: MarketFactCacheRecord = { ...input };
      rows.set(keyOf(input.subjectKey, input.factKind, input.source), record);
      return Promise.resolve(record);
    }),
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
  return {
    repository,
    get,
    current: () =>
      rows.get(keyOf(`token:${wbnb}`, "token_pairs", "dexscreener")) ?? null,
  };
}

function providerFake(
  behaviour: () => TokenPairsSnapshot,
  fetchedAt = "2026-09-08T00:00:00.000Z",
): MarketPairsProvider & { readonly calls: () => number } {
  let calls = 0;
  return {
    source: "dexscreener",
    calls: () => calls,
    readTokenPairs: () => {
      calls += 1;
      return Promise.resolve({
        value: behaviour(),
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "a".repeat(64),
      });
    },
    readTokenPairsBatch: (addresses) => {
      calls += 1;
      return Promise.resolve({
        value: addresses.map((tokenAddress) =>
          tokenAddress === wbnb ? behaviour() : { tokenAddress, pairs: [] },
        ),
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "b".repeat(64),
      });
    },
    readPair: (pairAddress) => {
      calls += 1;
      return Promise.resolve({
        value: { pairAddress, pair: null },
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "c".repeat(64),
      });
    },
  };
}

describe("market fact service", () => {
  it("selects the deepest pair where the asset is the base token", () => {
    expect(selectPrimaryPair(snapshot("747.39"))?.pairAddress).toBe(
      "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
    );
  });

  it("publishes a disabled Provider as unavailable without touching the cache", async () => {
    const cache = cacheFake();
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: null,
      securityProvider: null,
      candlesProvider: null,
    });
    await expect(service.readTokenPairs(wbnb)).resolves.toMatchObject({
      quality: "unavailable",
      reasonCode: "MARKET_PROVIDER_DEXSCREENER_DISABLED",
      value: null,
    });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("serves a fresh cache row inside its TTL without calling the Provider", async () => {
    const provider = providerFake(() => snapshot("747.39"));
    const cache = cacheFake({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: snapshot("700") as unknown as Record<string, unknown>,
      rawDigest: "b".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T00:00:10.000Z"),
    });
    const fact = await service.readTokenPairs(wbnb);
    expect(fact.quality).toBe("fresh");
    expect(fact.fetchedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(fact.rawDigest).toBe("b".repeat(64));
    expect(selectPrimaryPair(fact.value as TokenPairsSnapshot)?.priceUsd).toBe(
      "746.63",
    );
    expect(provider.calls()).toBe(0);
  });

  it("refetches past the TTL and records the raw digest", async () => {
    const provider = providerFake(
      () => snapshot("747.39"),
      "2026-09-08T00:01:00.000Z",
    );
    const cache = cacheFake({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: snapshot("700") as unknown as Record<string, unknown>,
      rawDigest: "b".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T00:01:00.000Z"),
    });
    const fact = await service.readTokenPairs(wbnb);
    expect(fact.quality).toBe("fresh");
    expect(fact.fetchedAt).toBe("2026-09-08T00:01:00.000Z");
    expect(cache.current()?.rawDigest).toBe("a".repeat(64));
    expect(provider.calls()).toBe(1);
  });

  it("serves stale inside the grace window when the Provider is throttled, but never to a fresh-only reader", async () => {
    const provider: MarketPairsProvider = {
      source: "dexscreener",
      readTokenPairs: () =>
        Promise.reject(
          new MarketProviderError(
            "market_provider_rate_limited",
            "MARKET_PROVIDER_RATE_LIMITED",
          ),
        ),
      readTokenPairsBatch: () => Promise.reject(new Error("not used")),
      readPair: () => Promise.reject(new Error("not used")),
    };
    const cache = cacheFake({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: snapshot("700") as unknown as Record<string, unknown>,
      rawDigest: "b".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T00:05:00.000Z"),
    });
    await expect(service.readTokenPairs(wbnb)).resolves.toMatchObject({
      quality: "stale",
      reasonCode: "MARKET_PROVIDER_RATE_LIMITED",
      fetchedAt: "2026-09-08T00:00:00.000Z",
    });
    await expect(
      service.readTokenPairs(wbnb, { requireFresh: true }),
    ).resolves.toMatchObject({
      quality: "unavailable",
      reasonCode: "MARKET_PROVIDER_RATE_LIMITED",
      value: null,
    });
  });

  it("is unavailable once the grace window has passed", async () => {
    const provider: MarketPairsProvider = {
      source: "dexscreener",
      readTokenPairs: () =>
        Promise.reject(
          new MarketProviderError(
            "market_provider_unreachable",
            "MARKET_PROVIDER_UNREACHABLE",
          ),
        ),
      readTokenPairsBatch: () => Promise.reject(new Error("not used")),
      readPair: () => Promise.reject(new Error("not used")),
    };
    const cache = cacheFake({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: snapshot("700") as unknown as Record<string, unknown>,
      rawDigest: "b".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T01:00:00.000Z"),
    });
    await expect(service.readTokenPairs(wbnb)).resolves.toMatchObject({
      quality: "unavailable",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
  });

  it("shares one in-flight Provider read between concurrent callers", async () => {
    const provider = providerFake(() => snapshot("747.39"));
    const cache = cacheFake();
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
    });
    const [first, second] = await Promise.all([
      service.readTokenPairs(wbnb),
      service.readTokenPairs(wbnb),
    ]);
    expect(first.quality).toBe("fresh");
    expect(second.quality).toBe("fresh");
    expect(provider.calls()).toBe(1);
  });

  it("reads a batch through one Provider request and serves cache hits without one", async () => {
    const provider = providerFake(() => snapshot("747.39"));
    const cache = cacheFake({
      subjectKey: `token:${usdt}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: { tokenAddress: usdt, pairs: [] } as unknown as Record<
        string,
        unknown
      >,
      rawDigest: "c".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T00:00:10.000Z"),
    });
    const facts = await service.readTokenPairsBatch([wbnb, usdt, wbnb]);
    expect(facts.size).toBe(2);
    expect(facts.get(wbnb)?.quality).toBe("fresh");
    expect(facts.get(wbnb)?.rawDigest).toBe("b".repeat(64));
    expect(facts.get(usdt)?.rawDigest).toBe("c".repeat(64));
    expect(provider.calls()).toBe(1);
  });

  it("prices the native asset through WBNB and names the proxy", async () => {
    const provider = providerFake(() => snapshot("747.39"));
    const service = createMarketFactService({
      config,
      cache: cacheFake().repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
    });
    const native = await service.readAssetPrice({
      address: null,
      status: "verified",
    });
    expect(native.proxyAsset).toBe(`eip155:56:${wbnb}`);
    expect(native.pair?.priceUsd).toBe("746.63");
    const token = await service.readAssetPrice({
      address: wbnb,
      status: "pending",
    });
    expect(token.proxyAsset).toBeNull();
    const blocked = await service.readAssetPrice({
      address: wbnb,
      status: "blocked",
    });
    expect(blocked.fact.reasonCode).toBe("ASSET_BLOCKED");
  });

  it("caches one declared pair under its own subject key and is unavailable without the Provider (Decision 0059)", async () => {
    const provider = providerFake(() => snapshot("747.39"));
    const cache = cacheFake();
    const service = createMarketFactService({
      config,
      cache: cache.repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      now: () => new Date("2026-09-08T00:00:10.000Z"),
    });
    const pairAddress = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae";
    const fact = await service.readPair(pairAddress);
    expect(fact.quality).toBe("fresh");
    expect(fact.value).toEqual({ pairAddress, pair: null });
    expect(cache.get).toHaveBeenCalledWith(
      `pair:${pairAddress}`,
      "pair",
      "dexscreener",
    );
    // A second read inside the TTL is served from the cache.
    await service.readPair(pairAddress);
    expect(provider.calls()).toBe(1);

    const withoutProvider = createMarketFactService({
      config,
      cache: cacheFake().repository,
      pairsProvider: null,
      securityProvider: null,
      candlesProvider: null,
    });
    await expect(withoutProvider.readPair(pairAddress)).resolves.toMatchObject({
      quality: "unavailable",
      value: null,
      reasonCode: "MARKET_PROVIDER_DEXSCREENER_DISABLED",
    });
  });
});
