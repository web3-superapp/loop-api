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
  dexscreener: { enabled: true, rateLimitPerMinute: 300 },
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
  let stored = initial;
  const get = vi.fn(() => Promise.resolve(stored));
  const repository: MarketFactCacheRepository = {
    get,
    put: vi.fn((input: MarketFactCacheRecord) => {
      const record: MarketFactCacheRecord = { ...input };
      stored = record;
      return Promise.resolve(record);
    }),
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
  return { repository, get, current: () => stored };
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
});
