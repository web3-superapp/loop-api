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
  type TokenLookupProvider,
  type TokenLookupSnapshot,
  type TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";

const weth = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";

function lookupSnapshot(): TokenLookupSnapshot {
  return {
    tokenAddress: weth,
    symbol: "ETH",
    name: "Ethereum Token",
    decimals: 18,
    priceUsd: "2575.14",
    fdvUsd: "1300404347.01",
    marketCapUsd: "1300514252.3",
    volumeH24Usd: "25016115.55",
    topPools: [
      {
        poolAddress: "0xd0e226f674bbf064f54ab47f42473ff80db98cba",
        dexId: "pancakeswap-v3-bsc",
        name: "ETH / WBNB 0.05%",
        baseTokenAddress: weth,
        quoteTokenAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        quoteTokenSymbol: "WBNB",
        reserveUsd: "16714230.21",
        volumeH24Usd: "8336698.9",
        priceChangeH24: "-2.52",
        createdAt: "2025-11-14T06:46:14.000Z",
      },
    ],
  };
}

function lookupProviderFake(
  behaviour: () => TokenLookupSnapshot,
  fetchedAt = new Date().toISOString(),
): TokenLookupProvider & { readonly calls: () => number } {
  let calls = 0;
  return {
    source: "geckoterminal",
    calls: () => calls,
    readToken: () => {
      calls += 1;
      return Promise.resolve({
        value: behaviour(),
        source: "geckoterminal" as const,
        fetchedAt,
        rawDigest: "e".repeat(64),
      });
    },
  };
}

function wethPairs(): TokenPairsSnapshot {
  return {
    tokenAddress: weth,
    pairs: [
      {
        pairAddress: "0x62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e",
        dexId: "pancakeswap",
        labels: ["v2"],
        baseTokenAddress: weth,
        baseTokenSymbol: "ETH",
        baseTokenName: "Ethereum Token",
        quoteTokenAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        quoteTokenSymbol: "WBNB",
        priceUsd: "2576.66",
        priceNative: null,
        liquidityUsd: "899550.52",
        volumeH24: "2926215.92",
        priceChangeH24: "-2.4",
        fdv: "1301174079",
        marketCap: "1301174079",
        buysH24: null,
        sellsH24: null,
        pairCreatedAt: "2023-04-16T05:30:14.000Z",
      },
    ],
  };
}

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";

const config: MarketConfig = Object.freeze({
  dexscreener: {
    enabled: true,
    budgetApiPerMinute: 120,
    budgetWorkerPerMinute: 120,
  },
  geckoterminal: {
    enabled: false,
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
  const put = vi.fn((input: MarketFactCacheRecord) => {
    const record: MarketFactCacheRecord = { ...input };
    rows.set(keyOf(input.subjectKey, input.factKind, input.source), record);
    return Promise.resolve(record);
  });
  const repository: MarketFactCacheRepository = {
    get,
    getMany: vi.fn(() => Promise.resolve(new Map())),
    put,
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
  return {
    repository,
    get,
    put,
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

  it("reads many asset prices at once, in order, and never more than four at a time (Decision 0063)", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const addresses = Array.from(
      { length: 9 },
      (_unused, index) => `0x${String(index).repeat(40)}`,
    );
    const release: (() => void)[] = [];
    const provider: MarketPairsProvider = {
      source: "dexscreener",
      readTokenPairs: (tokenAddress) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        return new Promise((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve({
              value: { tokenAddress, pairs: [], unrepresentablePairCount: 0 },
              source: "dexscreener" as const,
              fetchedAt: "2026-09-08T00:00:00.000Z",
              rawDigest: "a".repeat(64),
            });
          });
        });
      },
      readTokenPairsBatch: () => Promise.reject(new Error("not used")),
      readPair: () => Promise.reject(new Error("not used")),
    };
    const service = createMarketFactService({
      config,
      cache: cacheFake().repository,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
    });

    const pending = service.readAssetPrices(
      addresses.map((address) => ({ address, status: "verified" as const })),
    );
    // Drain the queue a wave at a time; the bound must hold throughout. Nine
    // reads four at a time is three waves, and a few spare turns let the last
    // one settle.
    for (let turn = 0; turn < 8; turn += 1) {
      for (const next of release.splice(0, release.length)) {
        next();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const facts = await pending;

    expect(peakInFlight).toBe(4);
    expect(facts).toHaveLength(addresses.length);
    expect(facts.map((entry) => entry.fact.value?.tokenAddress)).toEqual(
      addresses,
    );
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

  describe("unregistered token lookup (Decision 0058)", () => {
    it("carries the DexScreener image of the token's own base pair into the market fact and never one from GeckoTerminal (Decision 0072)", async () => {
      const image = `https://dd.dexscreener.com/ds-data/tokens/bsc/${weth}.png`;
      const withImage = (): TokenPairsSnapshot => {
        const base = wethPairs();
        return {
          ...base,
          pairs: [
            // The asset is only the quote here: this picture is WBNB's.
            {
              ...base.pairs[0]!,
              pairAddress: "0x0000000000000000000000000000000000000abc",
              baseTokenAddress: wbnb,
              quoteTokenAddress: weth,
              liquidityUsd: "999999999",
              imageUrl:
                "https://dd.dexscreener.com/ds-data/tokens/bsc/wbnb.png",
            },
            { ...base.pairs[0]!, imageUrl: image },
          ],
        };
      };
      const viaDexscreener = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: providerFake(withImage),
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: null,
      });
      await expect(
        viaDexscreener.readUnlistedToken(weth),
      ).resolves.toMatchObject({
        market: { value: { imageUrl: image }, source: "dexscreener" },
      });

      const viaGeckoTerminal = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: providerFake(withImage),
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: lookupProviderFake(lookupSnapshot),
      });
      await expect(
        viaGeckoTerminal.readUnlistedToken(weth),
      ).resolves.toMatchObject({
        market: { value: { imageUrl: null }, source: "geckoterminal" },
      });
    });

    it("describes the token from GeckoTerminal, caching the market snapshot for 60s and the identity for 1h", async () => {
      const cache = cacheFake();
      const lookup = lookupProviderFake(lookupSnapshot);
      const pairs = providerFake(() => wethPairs());
      const service = createMarketFactService({
        config,
        cache: cache.repository,
        pairsProvider: pairs,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: lookup,
      });
      const fact = await service.readUnlistedToken(weth);
      expect(fact.notFound).toBe(false);
      expect(fact.identity).toMatchObject({
        value: { symbol: "ETH", name: "Ethereum Token", decimals: 18 },
        source: "geckoterminal",
        quality: "fresh",
        ttlSeconds: 3_600,
      });
      expect(fact.market).toMatchObject({
        value: {
          priceUsd: "2575.14",
          priceChangeH24: "-2.52",
          liquidityUsd: "16714230.21",
          volumeH24: "25016115.55",
          marketCap: "1300514252.3",
          fdv: "1300404347.01",
          primaryPair: {
            pairAddress: "0xd0e226f674bbf064f54ab47f42473ff80db98cba",
            dexId: "pancakeswap-v3-bsc",
            quoteTokenSymbol: "WBNB",
          },
        },
        ttlSeconds: 60,
        quality: "fresh",
      });
      // DexScreener is never consulted while GeckoTerminal answers.
      expect(pairs.calls()).toBe(0);
      expect(cache.put).toHaveBeenCalledWith(
        expect.objectContaining({
          factKind: "token_identity",
          source: "geckoterminal",
          ttlSeconds: 3_600,
        }),
      );
      expect(cache.put).toHaveBeenCalledWith(
        expect.objectContaining({ factKind: "token_lookup", ttlSeconds: 60 }),
      );
      // A second read inside the TTL is served from the cache.
      await service.readUnlistedToken(weth);
      expect(lookup.calls()).toBe(1);
    });

    it("falls back to DexScreener when GeckoTerminal is disabled and leaves decimals null", async () => {
      const cache = cacheFake();
      const pairs = providerFake(() => wethPairs());
      const service = createMarketFactService({
        config,
        cache: cache.repository,
        pairsProvider: pairs,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: null,
      });
      const fact = await service.readUnlistedToken(weth);
      expect(fact.notFound).toBe(false);
      expect(fact.identity).toMatchObject({
        value: { symbol: "ETH", name: "Ethereum Token", decimals: null },
        source: "dexscreener",
        quality: "fresh",
      });
      expect(fact.market).toMatchObject({
        value: {
          priceUsd: "2576.66",
          primaryPair: {
            pairAddress: "0x62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e",
          },
        },
        source: "dexscreener",
        ttlSeconds: 60,
      });
      expect(cache.put).toHaveBeenCalledWith(
        expect.objectContaining({
          factKind: "token_pairs",
          source: "dexscreener",
          ttlSeconds: 60,
        }),
      );
    });

    it("reports notFound only when every enabled Provider affirmatively knows no such token", async () => {
      const notFound: TokenLookupProvider = {
        source: "geckoterminal",
        readToken: () =>
          Promise.reject(
            new MarketProviderError(
              "market_provider_rejected",
              "MARKET_TOKEN_NOT_FOUND",
              404,
            ),
          ),
      };
      const empty = providerFake(() => ({ tokenAddress: weth, pairs: [] }));
      const both = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: empty,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: notFound,
      });
      await expect(both.readUnlistedToken(weth)).resolves.toMatchObject({
        notFound: true,
        identity: {
          quality: "unavailable",
          reasonCode: "MARKET_TOKEN_NOT_FOUND",
        },
      });

      // GeckoTerminal unreachable + DexScreener empty: not an answer.
      const unreachable: TokenLookupProvider = {
        source: "geckoterminal",
        readToken: () =>
          Promise.reject(
            new MarketProviderError(
              "market_provider_unreachable",
              "MARKET_PROVIDER_UNREACHABLE",
            ),
          ),
      };
      const partial = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: empty,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: unreachable,
      });
      await expect(partial.readUnlistedToken(weth)).resolves.toMatchObject({
        notFound: false,
        identity: {
          quality: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        },
        market: { quality: "unavailable" },
      });

      // No lookup Provider at all.
      const none = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: null,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: null,
      });
      await expect(none.readUnlistedToken(weth)).resolves.toMatchObject({
        notFound: false,
        identity: {
          quality: "unavailable",
          reasonCode: "MARKET_LOOKUP_PROVIDER_DISABLED",
        },
      });
    });

    it("serves a remembered identity as stale when the Providers cannot be reached", async () => {
      const cache = cacheFake({
        subjectKey: `token:${weth}`,
        factKind: "token_identity",
        source: "geckoterminal",
        value: { symbol: "ETH", name: "Ethereum Token", decimals: 18 },
        rawDigest: "e".repeat(64),
        fetchedAt: new Date(Date.now() - 600_000).toISOString(),
        ttlSeconds: 3_600,
      });
      const unreachable: TokenLookupProvider = {
        source: "geckoterminal",
        readToken: () =>
          Promise.reject(
            new MarketProviderError(
              "market_provider_unreachable",
              "MARKET_PROVIDER_UNREACHABLE",
            ),
          ),
      };
      const service = createMarketFactService({
        config,
        cache: cache.repository,
        pairsProvider: null,
        securityProvider: null,
        candlesProvider: null,
        tokenLookupProvider: unreachable,
      });
      const fact = await service.readUnlistedToken(weth);
      expect(fact.notFound).toBe(false);
      expect(fact.identity).toMatchObject({
        value: { symbol: "ETH", decimals: 18 },
        quality: "stale",
        reasonCode: "MARKET_PROVIDER_UNREACHABLE",
      });
      expect(fact.market).toMatchObject({
        value: null,
        quality: "unavailable",
        reasonCode: "MARKET_PROVIDER_UNREACHABLE",
      });
    });
  });

  describe("a 24h change the Provider skipped (Decision 0074 §4)", () => {
    const deepest = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae";
    /** The deepest base pair reports `priceChange.h24`, as it usually does. */
    function reporting(priceChangeH24: string | null): TokenPairsSnapshot {
      const base = snapshot("747.39");
      return {
        ...base,
        pairs: base.pairs.map((pair) =>
          pair.pairAddress === deepest ? { ...pair, priceChangeH24 } : pair,
        ),
      };
    }

    it("remembers the primary pair's change on a fresh read and recalls it as the same pair's, inside the grace window only", async () => {
      let reported: string | null = "-0.31";
      const provider = providerFake(
        () => reporting(reported),
        "2026-09-08T00:00:00.000Z",
      );
      const cache = cacheFake();
      let clock = "2026-09-08T00:00:00.000Z";
      const service = createMarketFactService({
        config,
        cache: cache.repository,
        pairsProvider: provider,
        securityProvider: null,
        candlesProvider: null,
        now: () => new Date(clock),
      });
      await service.readTokenPairs(wbnb);
      await expect(
        cache.repository.get(
          `token:${wbnb}`,
          "pair_price_change_h24",
          "dexscreener",
        ),
      ).resolves.toMatchObject({
        source: "dexscreener",
        fetchedAt: "2026-09-08T00:00:00.000Z",
        ttlSeconds: 30,
        value: { pairAddress: deepest, priceChangeH24: "-0.31" },
      });

      // 100 s later the Provider answers the same pair without the field:
      // the fresh snapshot is cached, the memory is left as it was.
      clock = "2026-09-08T00:01:40.000Z";
      reported = null;
      const skipped = await service.readTokenPairs(wbnb);
      expect(
        selectPrimaryPair(skipped.value as TokenPairsSnapshot)?.priceChangeH24,
      ).toBeNull();
      await expect(
        service.recallPrimaryPairPriceChange(wbnb, deepest),
      ).resolves.toEqual({
        value: "-0.31",
        fetchedAt: "2026-09-08T00:00:00.000Z",
        ttlSeconds: 30,
      });
      // Another pair's number is never borrowed.
      await expect(
        service.recallPrimaryPairPriceChange(
          wbnb,
          "0x172fcd41e0913e95784454622d1c3724f546f849",
        ),
      ).resolves.toBeNull();
      // Past TTL + grace (30 s + 900 s) the memory is not published.
      clock = "2026-09-08T00:15:31.000Z";
      await expect(
        service.recallPrimaryPairPriceChange(wbnb, deepest),
      ).resolves.toBeNull();
    });

    it("remembers the change from a batch read as well, and nothing without a Provider", async () => {
      const provider = providerFake(
        () => reporting("0.42"),
        "2026-09-08T00:00:00.000Z",
      );
      const cache = cacheFake();
      const service = createMarketFactService({
        config,
        cache: cache.repository,
        pairsProvider: provider,
        securityProvider: null,
        candlesProvider: null,
        now: () => new Date("2026-09-08T00:00:01.000Z"),
      });
      await service.readTokenPairsBatch([wbnb]);
      await expect(
        service.recallPrimaryPairPriceChange(wbnb, deepest),
      ).resolves.toMatchObject({ value: "0.42" });

      const disabled = createMarketFactService({
        config,
        cache: cacheFake().repository,
        pairsProvider: null,
        securityProvider: null,
        candlesProvider: null,
      });
      await expect(
        disabled.recallPrimaryPairPriceChange(wbnb, deepest),
      ).resolves.toBeNull();
    });
  });
});
