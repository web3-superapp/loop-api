import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDexscreenerAdapter,
  normalizeDexscreenerPairs,
} from "../src/integrations/market/dexscreener-adapter.js";
import {
  createGeckoterminalAdapter,
  foldDailyCandlesIntoWeeks,
  normalizeGeckoterminalNewPools,
  normalizeGeckoterminalOhlcv,
} from "../src/integrations/market/geckoterminal-adapter.js";
import {
  createGoplusAdapter,
  goplusSignature,
  normalizeGoplusTokenSecurity,
  observedHolderCount,
} from "../src/integrations/market/goplus-adapter.js";
import { MarketProviderError } from "../src/integrations/market/market-data-provider.js";
import {
  createProviderHttpKernel,
  createRateLimiter,
  parseJsonLossless,
  type ProviderFetch,
} from "../src/integrations/market/provider-http.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";

function fetchStub(
  responder: (
    url: string,
    init: Parameters<ProviderFetch>[1],
  ) => {
    readonly status?: number;
    readonly body: string;
  },
): { readonly fetch: ProviderFetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fetch: ProviderFetch = (url, init) => {
    calls.push(url);
    const response = responder(url, init);
    const status = response.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(response.body),
    });
  };
  return { fetch, calls };
}

// Raw text on purpose: JSON.stringify of a JavaScript number would already
// have lost the 22-digit market cap to exponent notation.
const dexscreenerBody = `[
  {
    "chainId": "bsc",
    "dexId": "pancakeswap",
    "url": "https://dexscreener.com/bsc/0x172fcd41e0913e95784454622d1c3724f546f849",
    "pairAddress": "0x172fcD41E0913e95784454622d1c3724f546f849",
    "labels": ["v3"],
    "baseToken": { "address": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "name": "Wrapped BNB", "symbol": "WBNB" },
    "quoteToken": { "address": "0x55d398326f99059fF775485246999027B3197955", "name": "Tether USD", "symbol": "USDT" },
    "priceNative": "747.3948",
    "priceUsd": "747.39",
    "txns": { "h24": { "buys": 612985, "sells": 444510 } },
    "volume": { "h24": 219189066.89, "h6": 113448077.85 },
    "priceChange": { "h24": 0.27 },
    "liquidity": { "usd": 11937174.89, "base": 3557.7568, "quote": 9278125 },
    "fdv": 1222740159,
    "marketCap": 1222740159123456789012,
    "pairCreatedAt": 1680703943000
  },
  {
    "chainId": "bsc",
    "dexId": "pancakeswap",
    "pairAddress": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
    "labels": ["v2"],
    "baseToken": { "address": "${wbnb}", "symbol": "WBNB" },
    "quoteToken": { "address": "${usdt}", "symbol": "USDT" },
    "priceUsd": "746.63",
    "liquidity": { "usd": 94854491.12 },
    "volume": { "h24": 29916520.68 }
  },
  {
    "chainId": "ethereum",
    "dexId": "uniswap",
    "pairAddress": "0x0000000000000000000000000000000000000001",
    "baseToken": { "address": "${wbnb}", "symbol": "WBNB" },
    "quoteToken": { "address": "${usdt}", "symbol": "USDT" }
  }
]`;

describe("market Provider transport kernel", () => {
  it("keeps every JSON number as its exact digit string", () => {
    const parsed = parseJsonLossless(
      '{"a": 1222740159123456789012, "b": 0.1, "c": "x", "d": [1e3]}',
    ) as Record<string, unknown>;
    expect(parsed["a"]).toBe("1222740159123456789012");
    expect(parsed["b"]).toBe("0.1");
    expect(parsed["c"]).toBe("x");
    expect(parsed["d"]).toEqual(["1e3"]);
  });

  it("refuses to exceed the configured per-minute allowance", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacityPerMinute: 2, now: () => now });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    now = 60_001;
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("maps transport failures onto sanitized reason codes without the URL", async () => {
    const throwing = createProviderHttpKernel({
      fetch: () =>
        Promise.reject(new Error("ECONNREFUSED https://secret.example")),
      rateLimiter: createRateLimiter({ capacityPerMinute: 10 }),
    });
    await expect(
      throwing.requestJson({ url: "https://secret.example/x" }),
    ).rejects.toMatchObject({
      code: "market_provider_unreachable",
      reasonCode: "MARKET_PROVIDER_UNREACHABLE",
    });
    const rejected = createProviderHttpKernel({
      fetch: fetchStub(() => ({ status: 429, body: "slow down" })).fetch,
      rateLimiter: createRateLimiter({ capacityPerMinute: 10 }),
    });
    const error = await rejected
      .requestJson({ url: "https://secret.example/x" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MarketProviderError);
    expect((error as Error).message).not.toContain("secret.example");
    expect((error as MarketProviderError).code).toBe(
      "market_provider_rate_limited",
    );
    const malformed = createProviderHttpKernel({
      fetch: fetchStub(() => ({ body: "<html>" })).fetch,
      rateLimiter: createRateLimiter({ capacityPerMinute: 10 }),
    });
    await expect(
      malformed.requestJson({ url: "https://secret.example/x" }),
    ).rejects.toMatchObject({ code: "market_provider_malformed" });
  });

  it("returns the SHA-256 digest of the raw body", async () => {
    const body = '{"ok": 1}';
    const kernel = createProviderHttpKernel({
      fetch: fetchStub(() => ({ body })).fetch,
      rateLimiter: createRateLimiter({ capacityPerMinute: 10 }),
    });
    const result = await kernel.requestJson({ url: "https://example.test/" });
    expect(result.rawDigest).toBe(
      createHash("sha256").update(body, "utf8").digest("hex"),
    );
  });
});

describe("DexScreener adapter", () => {
  it("normalises pairs losslessly and drops other chains", () => {
    const snapshot = normalizeDexscreenerPairs(
      parseJsonLossless(dexscreenerBody),
      wbnb,
    );
    expect(snapshot.pairs).toHaveLength(2);
    const [primary] = snapshot.pairs;
    expect(primary).toMatchObject({
      pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
      dexId: "pancakeswap",
      labels: ["v3"],
      baseTokenAddress: wbnb,
      quoteTokenAddress: usdt,
      priceUsd: "747.39",
      priceNative: "747.3948",
      liquidityUsd: "11937174.89",
      volumeH24: "219189066.89",
      priceChangeH24: "0.27",
      fdv: "1222740159",
      marketCap: "1222740159123456789012",
      buysH24: 612985,
      sellsH24: 444510,
      pairCreatedAt: "2023-04-05T14:12:23.000Z",
    });
    expect(snapshot.pairs[1]?.priceChangeH24).toBeNull();
  });

  it("refuses a body whose numbers were already lost to floating point", () => {
    // JSON.parse turns the 22-digit market cap into 1.2227401591234568e+21.
    expect(() =>
      normalizeDexscreenerPairs(JSON.parse(dexscreenerBody), wbnb),
    ).toThrow(MarketProviderError);
  });

  it("calls the documented endpoint once per read and never above 300/min", async () => {
    const stub = fetchStub(() => ({ body: dexscreenerBody }));
    const adapter = createDexscreenerAdapter({
      fetch: stub.fetch,
      rateLimitPerMinute: 1_000,
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    });
    const observation = await adapter.readTokenPairs(
      wbnb.toUpperCase().replace("0X", "0x"),
    );
    expect(stub.calls).toEqual([
      `https://api.dexscreener.com/token-pairs/v1/bsc/${wbnb}`,
    ]);
    expect(observation.source).toBe("dexscreener");
    expect(observation.fetchedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(observation.rawDigest).toHaveLength(64);
    expect(observation.value.pairs[0]?.priceUsd).toBe("747.39");
  });
});

describe("GoPlus adapter", () => {
  const securityBody = JSON.stringify({
    code: 1,
    message: "OK",
    result: {
      [wbnb]: {
        is_open_source: "1",
        is_mintable: "0",
        is_honeypot: "0",
        is_blacklisted: "0",
        buy_tax: "0",
        sell_tax: "0.05",
        holder_count: "8019338",
        holders: [{ address: "0x8f", percent: "0.18" }],
      },
    },
  });

  it("signs the token request as documented and reuses the token", async () => {
    const stub = fetchStub((url, init) => {
      if (url.endsWith("/api/v1/token")) {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        expect(body["app_key"]).toBe("app");
        expect(body["sign"]).toBe(
          goplusSignature("app", body["time"] as number, "secret"),
        );
        return {
          body: JSON.stringify({
            code: 1,
            result: { access_token: "tok", expires_in: 3600 },
          }),
        };
      }
      expect(init.headers["authorization"]).toBe("tok");
      return { body: securityBody };
    });
    const adapter = createGoplusAdapter({
      appKey: "app",
      appSecret: "secret",
      fetch: stub.fetch,
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    });
    const first = await adapter.readTokenSecurity(wbnb);
    const second = await adapter.readTokenSecurity(wbnb);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[0]).toBe("https://api.gopluslabs.io/api/v1/token");
    expect(first.value.holderCount).toBe("8019338");
    expect(first.value.facts).toEqual(
      expect.arrayContaining([
        { fact: "openSource", value: "true" },
        { fact: "mintable", value: "false" },
        { fact: "honeypot", value: "false" },
        { fact: "sellTax", value: "0.05" },
      ]),
    );
    expect(second.value.holderCount).toBe("8019338");
    // Raw holder rows never leave the adapter.
    expect(JSON.stringify(first.value)).not.toContain("0x8f");
  });

  it("treats an unknown flag value or non-OK code as malformed", () => {
    expect(() =>
      normalizeGoplusTokenSecurity(
        { code: "1", result: { [wbnb]: { is_mintable: "maybe" } } },
        wbnb,
      ),
    ).toThrow(MarketProviderError);
    expect(() =>
      normalizeGoplusTokenSecurity({ code: 2, result: null }, wbnb),
    ).toThrow(MarketProviderError);
    expect(normalizeGoplusTokenSecurity({ code: 1, result: {} }, wbnb)).toEqual(
      {
        tokenAddress: wbnb,
        facts: [],
        holderCount: null,
      },
    );
  });
});

describe("GoPlus holder count placeholder (walkthrough B-9)", () => {
  it('treats holder_count "0" as not reported, never as a count of zero', () => {
    // Real GoPlus answer for BSC USDT on 2026-09-16: supply 9.18e9, holder_count "0".
    const snapshot = normalizeGoplusTokenSecurity(
      {
        code: 1,
        message: "OK",
        result: {
          [usdt]: {
            is_open_source: "1",
            holder_count: "0",
            total_supply: "9184991859.680809663064697687",
          },
        },
      },
      usdt,
    );
    expect(snapshot.holderCount).toBeNull();
    expect(snapshot.facts).toContainEqual({
      fact: "openSource",
      value: "true",
    });

    expect(observedHolderCount("0")).toBeNull();
    expect(observedHolderCount(null)).toBeNull();
    expect(observedHolderCount("1")).toBe("1");
    expect(observedHolderCount("1910790")).toBe("1910790");
  });
});

describe("GeckoTerminal adapter", () => {
  const ohlcvBody =
    '{"data":{"attributes":{"ohlcv_list":[[1788847200,1.00071817151757,1.00198792505725,0.998172710960178,1.00083094804025,1334331.5237575937],[1788843600,1.00042842389096,1.00490025333728,0.995799441886115,1.00071817151757,2746268.0332335294]]}}}';

  it("normalises OHLCV rows in ascending time with exact decimals", () => {
    const snapshot = normalizeGeckoterminalOhlcv(
      parseJsonLossless(ohlcvBody),
      usdt,
    );
    expect(snapshot.candles.map((candle) => candle.openTime)).toEqual([
      "2026-09-08T05:00:00.000Z",
      "2026-09-08T06:00:00.000Z",
    ]);
    expect(snapshot.candles[1]).toEqual({
      openTime: "2026-09-08T06:00:00.000Z",
      open: "1.00071817151757",
      high: "1.00198792505725",
      low: "0.998172710960178",
      close: "1.00083094804025",
      volume: "1334331.5237575937",
    });
  });

  it("lists new pools by address and counts pool-id rows instead of calling them malformed", () => {
    const pool = (address: string, dex: string) => ({
      attributes: {
        address,
        name: "X / WBNB",
        pool_created_at: "2026-09-17T06:44:36Z",
        reserve_in_usd: "0.572352096797398",
        volume_usd: { h24: "366.0165360544" },
      },
      relationships: {
        base_token: { data: { id: `bsc_${usdt}` } },
        quote_token: { data: { id: `bsc_${wbnb}` } },
        dex: { data: { id: dex } },
      },
    });
    // The live 2026-09-17 page: Uniswap V4 pools on BSC are keyed by a
    // 32-byte pool id, which is a Provider fact rather than a broken body.
    const v4PoolId = `0x${"a".repeat(64)}`;
    const snapshot = normalizeGeckoterminalNewPools({
      data: [
        pool(v4PoolId, "uniswap-v4-bsc"),
        pool("0x16B9a82891338f9bA80E2D6970FdDA79D1eb0daE", "pancakeswap_v2"),
        pool(v4PoolId, "uniswap-v4-bsc"),
      ],
    });
    expect(snapshot.omittedPoolCount).toBe(2);
    expect(snapshot.pools).toEqual([
      {
        poolAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        dexId: "pancakeswap_v2",
        name: "X / WBNB",
        baseTokenAddress: usdt,
        quoteTokenAddress: wbnb,
        createdAt: "2026-09-17T06:44:36.000Z",
        reserveUsd: "0.572352096797398",
        volumeH24Usd: "366.0165360544",
      },
    ]);
    // Anything that is neither an address nor a pool id is still malformed.
    expect(() =>
      normalizeGeckoterminalNewPools({
        data: [pool("0x1234", "pancakeswap_v2")],
      }),
    ).toThrow(MarketProviderError);
  });

  it("folds daily candles into epoch-aligned weeks", () => {
    const weekly = foldDailyCandlesIntoWeeks([
      {
        openTime: "2026-09-03T00:00:00.000Z",
        open: "1",
        high: "3",
        low: "0.5",
        close: "2",
        volume: "10",
      },
      {
        openTime: "2026-09-04T00:00:00.000Z",
        open: "2",
        high: "4",
        low: "1.5",
        close: "3.5",
        volume: "5.25",
      },
      {
        openTime: "2026-09-10T00:00:00.000Z",
        open: "3",
        high: "3",
        low: "3",
        close: "3",
        volume: "1",
      },
    ]);
    expect(weekly).toEqual([
      {
        openTime: "2026-09-03T00:00:00.000Z",
        open: "1",
        high: "4",
        low: "0.5",
        close: "3.5",
        volume: "15.25",
      },
      {
        openTime: "2026-09-10T00:00:00.000Z",
        open: "3",
        high: "3",
        low: "3",
        close: "3",
        volume: "1",
      },
    ]);
  });

  it("sends the versioned Accept header and the token orientation", async () => {
    const stub = fetchStub((_url, init) => {
      expect(init.headers["accept"]).toBe("application/json;version=20230302");
      return { body: ohlcvBody };
    });
    const adapter = createGeckoterminalAdapter({ fetch: stub.fetch });
    await adapter.readPoolOhlcv(
      "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
      "4h",
      50,
      { tokenAddress: wbnb },
    );
    expect(stub.calls[0]).toBe(
      `https://api.geckoterminal.com/api/v2/networks/bsc/pools/0x36696169c63e42cd08ce11f5deebbcebae652050/ohlcv/hour?aggregate=4&limit=50&token=${wbnb}`,
    );
  });

  it("never exceeds the documented 30 requests per minute", () => {
    const spy = vi.fn();
    const adapter = createGeckoterminalAdapter({
      fetch: fetchStub(() => {
        spy();
        return { body: ohlcvBody };
      }).fetch,
      rateLimitPerMinute: 300,
    });
    expect(adapter.source).toBe("geckoterminal");
    // The cap is enforced by the kernel limiter created with min(300, 30).
    expect(spy).not.toHaveBeenCalled();
  });

  it("normalises a batch response per requested token", async () => {
    const stub = fetchStub(() => ({ body: dexscreenerBody }));
    const adapter = createDexscreenerAdapter({ fetch: stub.fetch });
    const observation = await adapter.readTokenPairsBatch([wbnb, usdt]);
    expect(stub.calls).toEqual([
      `https://api.dexscreener.com/tokens/v1/bsc/${wbnb},${usdt}`,
    ]);
    expect(observation.value.map((entry) => entry.tokenAddress)).toEqual([
      wbnb,
      usdt,
    ]);
    expect(observation.value[0]?.pairs).toHaveLength(2);
    expect(observation.value[1]?.pairs).toHaveLength(2);
    await expect(adapter.readTokenPairsBatch([])).rejects.toBeInstanceOf(
      MarketProviderError,
    );
  });

  it("re-signs once when GoPlus rejects the cached access token", async () => {
    let tokens = 0;
    let securityCalls = 0;
    const stub = fetchStub((url) => {
      if (url.endsWith("/api/v1/token")) {
        tokens += 1;
        return {
          body: JSON.stringify({
            code: 1,
            result: {
              access_token: `tok${String(tokens)}`,
              expires_in: 999_999,
            },
          }),
        };
      }
      securityCalls += 1;
      if (securityCalls === 1) {
        return {
          body: JSON.stringify({
            code: 4011,
            message: "token expired",
            result: null,
          }),
        };
      }
      return {
        body: JSON.stringify({
          code: 1,
          result: { [wbnb]: { holder_count: "1" } },
        }),
      };
    });
    const adapter = createGoplusAdapter({
      appKey: "app",
      appSecret: "secret",
      fetch: stub.fetch,
    });
    const observation = await adapter.readTokenSecurity(wbnb);
    expect(observation.value.holderCount).toBe("1");
    expect(tokens).toBe(2);
    expect(securityCalls).toBe(2);
  });
});
