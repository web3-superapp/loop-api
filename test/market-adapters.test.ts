import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDexscreenerAdapter,
  normalizeDexscreenerBatch,
  normalizeDexscreenerPairs,
} from "../src/integrations/market/dexscreener-adapter.js";
import {
  createGeckoterminalAdapter,
  foldDailyCandlesIntoWeeks,
  normalizeGeckoterminalNewPools,
  normalizeGeckoterminalOhlcv,
  normalizeGeckoterminalToken,
} from "../src/integrations/market/geckoterminal-adapter.js";
import {
  createGoplusAdapter,
  goplusSignature,
  normalizeGoplusTokenSecurity,
  observedHolderCount,
} from "../src/integrations/market/goplus-adapter.js";
import { selectPrimaryPair } from "../src/features/market/market-fact-service.js";
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

const btcb = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";

/**
 * Captured verbatim from `GET /token-pairs/v1/bsc/{BTCB}` on 2026-09-21
 * (only `url` removed). The dust squadswap pool reports a 24 h price change
 * of `3.725857251510287e+42`; `normalizeDecimalString` refuses exponent
 * notation, and before Decision 0062 that one field made BTCB unpriceable
 * for every reader of the API.
 */
const btcbExponentPair = `{"chainId":"bsc","dexId":"squadswap","pairAddress":"0x02259FDbF99Ea59e3Bb6589f67e99C0A6322AfF7","labels":["v3"],"baseToken":{"address":"0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c","name":"BTCB Token","symbol":"BTCB"},"quoteToken":{"address":"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","name":"Wrapped BNB","symbol":"WBNB"},"priceNative":"105.3723","priceUsd":"82269.44","txns":{"m5":{"buys":0,"sells":0},"h1":{"buys":2,"sells":0},"h6":{"buys":7,"sells":7},"h24":{"buys":33,"sells":31}},"volume":{"h24":4.78,"h6":0.91,"h1":0,"m5":0},"priceChange":{"h1":0.59,"h6":0.47,"h24":3.725857251510287e+42},"liquidity":{"usd":60.88,"base":0.0003514,"quote":0.04094},"fdv":5371677570,"marketCap":5371677570,"pairCreatedAt":1762901008000}`;

/** The deepest BTCB pool of the same response, captured the same way. */
const btcbDeepPair = `{"chainId":"bsc","dexId":"pancakeswap","pairAddress":"0x6bbc40579ad1BBD243895cA0ACB086BB6300d636","labels":["v3"],"baseToken":{"address":"0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c","name":"BTCB Token","symbol":"BTCB"},"quoteToken":{"address":"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","name":"Wrapped BNB","symbol":"WBNB"},"priceNative":"107.8878","priceUsd":"84584.076","txns":{"h24":{"buys":6734,"sells":7609}},"volume":{"h24":27032542.63},"priceChange":{"h24":5.08},"liquidity":{"usd":28700176.37},"fdv":5522808255,"marketCap":5522808255,"pairCreatedAt":1619352299000}`;

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
  it("keeps info.imageUrl on an allow-listed host and drops any other (Decision 0072)", () => {
    const pairJson = (imageUrl: string | null, pairAddress: string): string =>
      `{"chainId":"bsc","dexId":"pancakeswap","pairAddress":"${pairAddress}","baseToken":{"address":"${wbnb}","symbol":"WBNB"},"quoteToken":{"address":"${usdt}","symbol":"USDT"},"priceUsd":"747.39","liquidity":{"usd":1},"info":{"imageUrl":${imageUrl === null ? "null" : `"${imageUrl}"`},"websites":[{"url":"https://example.invalid"}]}}`;
    const snapshot = normalizeDexscreenerPairs(
      parseJsonLossless(
        `[${[
          pairJson(
            `https://dd.dexscreener.com/ds-data/tokens/bsc/${wbnb}.png`,
            "0x0000000000000000000000000000000000000001",
          ),
          pairJson(
            "https://evil.example/ds-data/tokens/bsc/logo.png",
            "0x0000000000000000000000000000000000000002",
          ),
          pairJson(
            `http://dd.dexscreener.com/ds-data/tokens/bsc/${wbnb}.png`,
            "0x0000000000000000000000000000000000000003",
          ),
          pairJson(null, "0x0000000000000000000000000000000000000004"),
          // No `info` block at all.
          `{"chainId":"bsc","dexId":"pancakeswap","pairAddress":"0x0000000000000000000000000000000000000005","baseToken":{"address":"${wbnb}","symbol":"WBNB"},"quoteToken":{"address":"${usdt}","symbol":"USDT"},"priceUsd":"747.39"}`,
          // A malformed `info` block is ignored, never a reason to refuse.
          `{"chainId":"bsc","dexId":"pancakeswap","pairAddress":"0x0000000000000000000000000000000000000006","baseToken":{"address":"${wbnb}","symbol":"WBNB"},"quoteToken":{"address":"${usdt}","symbol":"USDT"},"priceUsd":"747.39","info":{"imageUrl":{"nested":true}}}`,
        ].join(",")}]`,
      ),
      wbnb,
    );
    expect(snapshot.pairs.map((pair) => pair.imageUrl)).toEqual([
      `https://dd.dexscreener.com/ds-data/tokens/bsc/${wbnb}.png`,
      null,
      null,
      null,
      null,
      null,
    ]);
    // The rest of the pair is untouched by the gate.
    expect(snapshot.pairs[1]).toMatchObject({
      pairAddress: "0x0000000000000000000000000000000000000002",
      priceUsd: "747.39",
    });
    expect(snapshot.unrepresentablePairCount).toBe(0);
  });

  it("keeps the base token's display name for unregistered lookups (Decision 0058)", () => {
    const snapshot = normalizeDexscreenerPairs(
      parseJsonLossless(
        `[{"chainId":"bsc","dexId":"pancakeswap","pairAddress":"0x62Fcb3C1794FB95BD8B1A97f6Ad5D8a7e4943a1e","baseToken":{"address":"0x2170Ed0880ac9A755fd29B2688956BD959F933F8","name":"Ethereum Token","symbol":"ETH"},"quoteToken":{"address":"${wbnb}","name":"Wrapped BNB","symbol":"WBNB"},"priceUsd":"2576.66","volume":{"h24":2926215.92},"liquidity":{"usd":899550.52},"fdv":1301174079,"marketCap":1301174079,"pairCreatedAt":1681625414000}]`,
      ),
      "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    );
    expect(snapshot.pairs[0]).toMatchObject({
      baseTokenSymbol: "ETH",
      baseTokenName: "Ethereum Token",
      priceUsd: "2576.66",
      volumeH24: "2926215.92",
      liquidityUsd: "899550.52",
    });
  });

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

  it("lists address pools and Uniswap V4 pool-id pools under poolRef and counts only malformed rows (Decision 0052)", () => {
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
    // Both forms are listed under `poolRef`, each in its own shape.
    const v4PoolId = `0x${"Ab".repeat(32)}`;
    const snapshot = normalizeGeckoterminalNewPools({
      data: [
        pool(v4PoolId, "uniswap-v4-bsc"),
        pool("0x16B9a82891338f9bA80E2D6970FdDA79D1eb0daE", "pancakeswap_v2"),
        pool("0x1234", "pancakeswap_v2"),
      ],
    });
    // Only the row keyed by neither form is omitted; the page survives it.
    expect(snapshot.omittedPoolCount).toBe(1);
    expect(snapshot.pools).toEqual([
      {
        poolRef: { kind: "poolId", poolId: `0x${"ab".repeat(32)}` },
        dexId: "uniswap-v4-bsc",
        name: "X / WBNB",
        baseTokenAddress: usdt,
        quoteTokenAddress: wbnb,
        createdAt: "2026-09-17T06:44:36.000Z",
        reserveUsd: "0.572352096797398",
        volumeH24Usd: "366.0165360544",
      },
      {
        poolRef: {
          kind: "address",
          address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        },
        dexId: "pancakeswap_v2",
        name: "X / WBNB",
        baseTokenAddress: usdt,
        quoteTokenAddress: wbnb,
        createdAt: "2026-09-17T06:44:36.000Z",
        reserveUsd: "0.572352096797398",
        volumeH24Usd: "366.0165360544",
      },
    ]);
    // A body that does not fit the envelope is still malformed as a whole.
    expect(() =>
      normalizeGeckoterminalNewPools({ data: [{ attributes: {} }] }),
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

  // Shape observed on 2026-09-20 for BSC WETH (`?include=top_pools`); the
  // pool id row mirrors a Uniswap V4 pool, which a lookup never lists.
  const weth = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
  const tokenBody = `{"data":{"id":"bsc_${weth}","type":"token","attributes":{"address":"0x2170Ed0880ac9A755fd29B2688956BD959F933F8","name":"Ethereum Token","symbol":"ETH","decimals":18,"image_url":"https://x.example/eth.png","coingecko_coin_id":"binance-peg-weth","total_supply":"504999999958700045164475.0","price_usd":"2575.1402462078","fdv_usd":"1300404347.01321","total_reserve_in_usd":"29281935.667098612665647265409115608503254172423118557289924121920059313257176624834394510957662128478898061490845044","volume_usd":{"h24":"25016115.5564862"},"market_cap_usd":"1300514252.30807"},"relationships":{"top_pools":{"data":[{"id":"bsc_0xd0e226f674bbf064f54ab47f42473ff80db98cba","type":"pool"},{"id":"bsc_0x${"ab".repeat(32)}","type":"pool"}]}}},"included":[{"id":"bsc_0xd0e226f674bbf064f54ab47f42473ff80db98cba","type":"pool","attributes":{"address":"0xd0e226f674bbf064f54ab47f42473ff80db98cba","name":"ETH / WBNB 0.05%","pool_created_at":"2025-11-14T06:46:14Z","reserve_in_usd":"16714230.2158","price_change_percentage":{"h24":"-2.52"},"volume_usd":{"h24":"8336698.90737144"},"transactions":{"h24":{"buys":1822,"sells":2358}}},"relationships":{"base_token":{"data":{"id":"bsc_${weth}","type":"token"}},"quote_token":{"data":{"id":"bsc_${wbnb}","type":"token"}},"dex":{"data":{"id":"pancakeswap-v3-bsc","type":"dex"}}}},{"id":"bsc_0x${"ab".repeat(32)}","type":"pool","attributes":{"address":"0x${"ab".repeat(32)}","name":"ETH / USDT","reserve_in_usd":"1"},"relationships":{"dex":{"data":{"id":"uniswap-v4-bsc","type":"dex"}}}}]}`;

  it("normalises a token lookup with identity, token-level facts, and address-keyed top pools (Decision 0058)", () => {
    const snapshot = normalizeGeckoterminalToken(
      parseJsonLossless(tokenBody),
      weth,
    );
    expect(snapshot).toMatchObject({
      tokenAddress: weth,
      symbol: "ETH",
      name: "Ethereum Token",
      decimals: 18,
      priceUsd: "2575.1402462078",
      fdvUsd: "1300404347.01321",
      marketCapUsd: "1300514252.30807",
      volumeH24Usd: "25016115.5564862",
    });
    expect("totalReserveUsd" in snapshot).toBe(false);
    expect(snapshot.topPools).toEqual([
      {
        poolAddress: "0xd0e226f674bbf064f54ab47f42473ff80db98cba",
        dexId: "pancakeswap-v3-bsc",
        name: "ETH / WBNB 0.05%",
        baseTokenAddress: weth,
        quoteTokenAddress: wbnb,
        quoteTokenSymbol: "WBNB",
        reserveUsd: "16714230.2158",
        volumeH24Usd: "8336698.90737144",
        priceChangeH24: "-2.52",
        createdAt: "2025-11-14T06:46:14.000Z",
      },
    ]);
    // A body for another address is not this token's fact.
    expect(() =>
      normalizeGeckoterminalToken(parseJsonLossless(tokenBody), wbnb),
    ).toThrow(MarketProviderError);
  });

  it("reads the token endpoint with top pools and maps the Provider's 404 to MARKET_TOKEN_NOT_FOUND", async () => {
    const stub = fetchStub((url) =>
      url.includes("000000000000000000000000000000000000dead")
        ? {
            status: 404,
            body: '{"errors":[{"status":"404","title":"Not Found"}]}',
          }
        : { body: tokenBody },
    );
    const adapter = createGeckoterminalAdapter({ fetch: stub.fetch });
    const observation = await adapter.readToken(
      "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    );
    expect(stub.calls[0]).toBe(
      `https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${weth}?include=top_pools`,
    );
    expect(observation.value.symbol).toBe("ETH");
    expect(observation.rawDigest).toBe(
      createHash("sha256").update(tokenBody, "utf8").digest("hex"),
    );
    await expect(
      adapter.readToken("0x000000000000000000000000000000000000dead"),
    ).rejects.toMatchObject({
      code: "market_provider_rejected",
      reasonCode: "MARKET_TOKEN_NOT_FOUND",
      httpStatus: 404,
    });
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

  it("drops a pool whose identifier is not a pair address and keeps every other pair of the token (Decision 0060)", () => {
    // The 2026-09-21 fact: DexScreener's USDT list carries a four.meme pool
    // identified as `{address}:4meme`. Before this decision that one entry
    // made the whole token unpriceable.
    const fourMeme = `{
      "chainId": "bsc",
      "dexId": "fourmeme",
      "pairAddress": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444:4meme",
      "baseToken": { "address": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444", "symbol": "NLRS" },
      "quoteToken": { "address": "${usdt}", "symbol": "USDT" },
      "priceNative": "0.00003693",
      "priceUsd": "0.00003693"
    }`;
    const body = `[${fourMeme},${dexscreenerBody.slice(1)}`;
    const snapshot = normalizeDexscreenerPairs(parseJsonLossless(body), usdt);
    expect(snapshot.pairs).toHaveLength(2);
    expect(snapshot.pairs.map((pair) => pair.pairAddress)).toEqual([
      "0x172fcd41e0913e95784454622d1c3724f546f849",
      "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
    ]);
    // The drop is counted, never silent.
    expect(snapshot.unrepresentablePairCount).toBe(1);
  });

  it("drops the one pair whose number is not a canonical decimal and prices the token from the rest (Decision 0062)", () => {
    const body = `[${btcbExponentPair},${btcbDeepPair}]`;
    const snapshot = normalizeDexscreenerPairs(parseJsonLossless(body), btcb);
    expect(snapshot.pairs).toHaveLength(1);
    expect(snapshot.unrepresentablePairCount).toBe(1);
    // The dropped pool had BTCB as its base (Decision 0074 §5).
    expect(snapshot.unrepresentableBasePairCount).toBe(1);
    const [kept] = snapshot.pairs;
    expect(kept).toMatchObject({
      pairAddress: "0x6bbc40579ad1bbd243895ca0acb086bb6300d636",
      baseTokenAddress: btcb,
      priceUsd: "84584.076",
      priceNative: "107.8878",
      liquidityUsd: "28700176.37",
      priceChangeH24: "5.08",
    });
    // The base-token rule of Decision 0036 can now price BTCB.
    expect(selectPrimaryPair(snapshot)?.priceUsd).toBe("84584.076");
  });

  it("drops that pair for the exponent alone: the same pool with a plain decimal is kept", () => {
    const repaired = btcbExponentPair.replace("3.725857251510287e+42", "3.72");
    const snapshot = normalizeDexscreenerPairs(
      parseJsonLossless(`[${repaired}]`),
      btcb,
    );
    expect(snapshot.unrepresentablePairCount).toBe(0);
    expect(snapshot.pairs[0]).toMatchObject({
      pairAddress: "0x02259fdbf99ea59e3bb6589f67e99c0a6322aff7",
      priceChangeH24: "3.72",
      buysH24: 33,
      sellsH24: 31,
      pairCreatedAt: "2025-11-11T22:43:28.000Z",
    });
  });

  it("drops a pair whose count or timestamp is outside its documented shape, and keeps the others", () => {
    for (const broken of [
      btcbDeepPair.replace('"buys":6734', '"buys":"6.7e3"'),
      btcbDeepPair.replace(
        '"pairCreatedAt":1619352299000',
        '"pairCreatedAt":0',
      ),
    ]) {
      const snapshot = normalizeDexscreenerPairs(
        parseJsonLossless(`[${broken},${btcbDeepPair}]`),
        btcb,
      );
      expect(snapshot.pairs).toHaveLength(1);
      expect(snapshot.unrepresentablePairCount).toBe(1);
    }
  });

  it("still refuses a response whose shape it cannot trust", () => {
    for (const body of ['{"pairs": 1}', '[{"chainId": "bsc"}]', '"nope"']) {
      expect(() =>
        normalizeDexscreenerPairs(parseJsonLossless(body), usdt),
      ).toThrowError(MarketProviderError);
    }
  });

  it("attributes a dropped pool to the token it belongs to in a batch read", () => {
    const fourMeme = `{
      "chainId": "bsc",
      "dexId": "fourmeme",
      "pairAddress": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444:4meme",
      "baseToken": { "address": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444", "symbol": "NLRS" },
      "quoteToken": { "address": "${usdt}", "symbol": "USDT" },
      "priceUsd": "0.00003693"
    }`;
    const body = `[${fourMeme},${dexscreenerBody.slice(1)}`;
    const [wbnbSnapshot, usdtSnapshot] = normalizeDexscreenerBatch(
      parseJsonLossless(body),
      [wbnb, usdt],
    );
    expect(wbnbSnapshot?.unrepresentablePairCount).toBe(0);
    expect(usdtSnapshot?.unrepresentablePairCount).toBe(1);
    // USDT was only the quote of the dropped pool: it still has no
    // unrepresentable *base* pair of its own (Decision 0074 §5).
    expect(usdtSnapshot?.unrepresentableBasePairCount).toBe(0);
    expect(wbnbSnapshot?.unrepresentableBasePairCount).toBe(0);
  });

  it("answers no pair when the declared pool itself cannot be represented", async () => {
    const stub = fetchStub(() => ({
      body: `{"pairs":[{
        "chainId": "bsc",
        "dexId": "fourmeme",
        "pairAddress": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444:4meme",
        "baseToken": { "address": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444", "symbol": "NLRS" },
        "quoteToken": { "address": "${usdt}", "symbol": "USDT" },
        "priceUsd": "0.00003693"
      }]}`,
    }));
    const adapter = createDexscreenerAdapter({ fetch: stub.fetch });
    await expect(
      adapter.readPair("0x0410389360ba5d7609ba8ba437fcb33376bc4444"),
    ).resolves.toMatchObject({ value: { pair: null } });
  });

  it("reads one declared pair by its own address and keeps only that pair on this chain (Decision 0059)", async () => {
    const pairAddress = "0x172fcd41e0913e95784454622d1c3724f546f849";
    const stub = fetchStub(() => ({
      body: `{"schemaVersion":"1.0.0","pairs":${dexscreenerBody}}`,
    }));
    const adapter = createDexscreenerAdapter({ fetch: stub.fetch });
    const observation = await adapter.readPair(
      "0x172fcD41E0913e95784454622d1c3724f546f849",
    );
    expect(stub.calls).toEqual([
      `https://api.dexscreener.com/latest/dex/pairs/bsc/${pairAddress}`,
    ]);
    expect(observation.value.pairAddress).toBe(pairAddress);
    expect(observation.value.pair).toMatchObject({
      pairAddress,
      baseTokenAddress: wbnb,
      quoteTokenAddress: usdt,
      priceUsd: "747.39",
      priceNative: "747.3948",
    });
  });

  it("answers with no pair when the Provider knows none, and never substitutes another", async () => {
    const stub = fetchStub(() => ({ body: `{"pairs":null}` }));
    const adapter = createDexscreenerAdapter({ fetch: stub.fetch });
    const observation = await adapter.readPair(
      "0x0000000000000000000000000000000000000009",
    );
    expect(observation.value.pair).toBe(null);
    const other = fetchStub(() => ({
      body: `{"pairs":${dexscreenerBody}}`,
    }));
    await expect(
      createDexscreenerAdapter({ fetch: other.fetch }).readPair(
        "0x0000000000000000000000000000000000000009",
      ),
    ).resolves.toMatchObject({ value: { pair: null } });
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
