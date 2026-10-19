import { describe, expect, it, vi } from "vitest";

import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { bscMainstreamTokenLogos } from "../src/features/market/token-logo-mainstream.js";
import {
  collectTokenLogoPrewarmTargets,
  runTokenLogoPrewarmPass,
} from "../src/features/market/token-logo-prewarm.js";
import { createTokenLogoProxyService } from "../src/features/market/token-logo-proxy.js";
import type {
  NewPoolSnapshot,
  TopPoolsProvider,
} from "../src/integrations/market/market-data-provider.js";
import { MarketProviderError } from "../src/integrations/market/market-data-provider.js";
import {
  createTokenLogoPrewarmWorker,
  tokenLogoPrewarmRetryDelayMs,
} from "../src/token-logo-prewarm-worker.js";
import {
  fakeNormalize,
  memoryLogoCache,
  png,
  trustWalletNative,
  upstreamFetch,
  wbnb,
} from "./token-logo-fakes.js";

/** Decision 0161 §2: the token logo pre-warm list and pass. */

const chainId = "eip155:56";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const cake = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const meme = `0x${"ab".repeat(20)}`;
const hotOnly = `0x${"cd".repeat(20)}`;

function asset(
  address: string | null,
  status: AssetRecord["status"] = "verified",
  chain = chainId,
): Pick<AssetRecord, "assetId" | "chainId" | "address" | "status"> {
  return {
    assetId: `${chain}:${address ?? "native"}`,
    chainId: chain,
    address,
    status,
  };
}

function pool(base: string | null): NewPoolSnapshot {
  return {
    poolRef: { kind: "address", address: `0x${"11".repeat(20)}` },
    dexId: "pancakeswap",
    name: "X / WBNB",
    baseTokenAddress: base,
    quoteTokenAddress: wbnb,
    createdAt: null,
    reserveUsd: null,
    volumeH24Usd: null,
  };
}

function topPools(
  pages: readonly (readonly NewPoolSnapshot[] | "error" | "reject")[],
  options: { readonly rateLimitedFirst?: number } = {},
): TopPoolsProvider & { readonly calls: () => number } {
  let rateLimited = options.rateLimitedFirst ?? 0;
  const readTopPools = vi.fn((page: number) => {
    if (rateLimited > 0) {
      rateLimited -= 1;
      return Promise.reject(
        new MarketProviderError(
          "market_provider_rate_limited",
          "MARKET_PROVIDER_RATE_LIMITED",
        ),
      );
    }
    const value = pages[page - 1];
    if (value === undefined) {
      return Promise.resolve({
        value: { pools: [], omittedPoolCount: 0 },
        source: "geckoterminal" as const,
        fetchedAt: "2026-10-19T00:00:00.000Z",
        rawDigest: "a".repeat(64),
      });
    }
    if (value === "error") {
      return Promise.reject(
        new MarketProviderError("market_provider_rate_limited", "RATE"),
      );
    }
    if (value === "reject") {
      return Promise.reject(
        new MarketProviderError(
          "market_provider_rejected",
          "MARKET_PROVIDER_REQUEST_REJECTED",
          401,
        ),
      );
    }
    return Promise.resolve({
      value: { pools: value, omittedPoolCount: 0 },
      source: "geckoterminal" as const,
      fetchedAt: "2026-10-19T00:00:00.000Z",
      rawDigest: "a".repeat(64),
    });
  });
  return {
    source: "geckoterminal",
    readTopPools,
    calls: () => readTopPools.mock.calls.length,
  };
}

describe("collectTokenLogoPrewarmTargets", () => {
  it("orders native, mainstream, registry, watchlist, hot and keeps one target per address", () => {
    const targets = collectTokenLogoPrewarmTargets({
      chainId,
      mainstream: [
        { symbol: "WBNB", address: wbnb },
        { symbol: "USDT", address: usdt.toUpperCase().replace("0X", "0x") },
      ],
      registryAssets: [
        asset(null),
        asset(usdt),
        asset(cake),
        asset(meme, "blocked"),
        asset(`0x${"ee".repeat(20)}`, "verified", "eip155:1"),
      ],
      watchlistedAssetIds: [
        `${chainId}:${cake}`,
        `${chainId}:${meme}`,
        `eip155:1:${hotOnly}`,
        `${chainId}:native`,
      ],
      hotAddresses: [hotOnly, wbnb, "not-an-address", meme],
    });
    expect(
      targets.map((target) => [target.address ?? "native", target.origin]),
    ).toEqual([
      ["native", "native"],
      [wbnb, "mainstream"],
      [usdt, "mainstream"],
      [cake, "registry"],
      [meme, "watchlist"],
      [hotOnly, "hot"],
    ]);
    expect(targets.every((target) => target.chainId === chainId)).toBe(true);
  });

  it("caps the list", () => {
    const targets = collectTokenLogoPrewarmTargets({
      chainId,
      mainstream: bscMainstreamTokenLogos,
      registryAssets: [],
      watchlistedAssetIds: [],
      hotAddresses: [],
      maximumTargets: 5,
    });
    expect(targets).toHaveLength(5);
  });

  it("keeps the mainstream list lowercase, valid and free of duplicates", () => {
    const addresses = bscMainstreamTokenLogos.map((token) => token.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const address of addresses) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    }
    for (const symbol of [
      "WBNB",
      "BTCB",
      "ETH",
      "USDT",
      "USDC",
      "USD1",
      "FDUSD",
      "CAKE",
      "DOGE",
      "SHIB",
      "XRP",
      "ADA",
      "DOT",
      "LINK",
      "UNI",
      "LTC",
      "TRX",
      "TON",
      "PEPE",
    ]) {
      expect(
        bscMainstreamTokenLogos.some((token) => token.symbol === symbol),
        symbol,
      ).toBe(true);
    }
  });
});

describe("runTokenLogoPrewarmPass", () => {
  const twUrl = (address: string) =>
    `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${
      // EIP-55 of the fixtures.
      {
        [wbnb]: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        [usdt]: "0x55d398326f99059fF775485246999027B3197955",
      }[address] ?? address
    }/logo.png`;

  it("warms every target once, seeds DexScreener pairs for the due ones only, and leaves manual rows alone", async () => {
    const cache = memoryLogoCache();
    cache.rows.set(`${chainId}/${usdt}`, {
      chainId,
      address: usdt,
      status: "found",
      bytes: Buffer.from("MANUAL"),
      contentType: "image/webp",
      etag: '"manual-picture-etag-0001"',
      source: "manual",
      sourceUrl: null,
      candidateUrl: null,
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z",
    });
    const fetch = upstreamFetch({
      [trustWalletNative]: { kind: "body", body: png() },
      [twUrl(wbnb)]: { kind: "body", body: png() },
    });
    const proxy = createTokenLogoProxyService({
      cache,
      facts: null,
      fetch,
      normalize: fakeNormalize,
      upstreamTimeoutMs: 50,
      now: () => new Date("2026-10-19T00:00:00.000Z"),
    });
    const seeded: (readonly string[])[] = [];
    const readTokenPairsBatch = vi.fn((addresses: readonly string[]) => {
      seeded.push(addresses);
      return Promise.resolve(new Map<string, never>());
    });
    const hot = topPools([[pool(hotOnly), pool(wbnb), pool(null)]]);
    const summary = await runTokenLogoPrewarmPass({
      chainId,
      proxy,
      cache,
      mainstream: [
        { symbol: "WBNB", address: wbnb },
        { symbol: "USDT", address: usdt },
      ],
      registry: {
        listReadableAssets: () =>
          Promise.resolve([asset(cake) as unknown as AssetRecord]),
      },
      watchlist: {
        listDistinctAssetIds: () => Promise.resolve([`${chainId}:${meme}`]),
      },
      topPools: hot,
      hotLimit: 200,
      pairs: { readTokenPairsBatch },
      now: () => new Date("2026-10-19T00:00:00.000Z"),
    });
    expect(summary).toMatchObject({
      targetCount: 6,
      byOrigin: { native: 1, mainstream: 2, registry: 1, watchlist: 1, hot: 1 },
      outcomes: { stored: 2, manual: 1, missing: 3, failed: 0 },
      hotListed: 2,
      hotReasonCode: null,
      pairSeedReasonCode: null,
      aborted: false,
    });
    // One page answered fewer than 20 pools: no second page.
    expect(hot.calls()).toBe(1);
    // The manual USDT row is settled; the native coin has no pair fact.
    expect(readTokenPairsBatch).toHaveBeenCalledTimes(1);
    expect(seeded[0]).toEqual([wbnb, cake, meme, hotOnly]);
    expect(cache.rows.get(`${chainId}/${usdt}`)?.source).toBe("manual");
    expect(fetch.calls).not.toContain(twUrl(usdt));

    // A second pass finds everything fresh: no upstream request at all.
    const before = fetch.calls.length;
    const again = await runTokenLogoPrewarmPass({
      chainId,
      proxy,
      cache,
      mainstream: [
        { symbol: "WBNB", address: wbnb },
        { symbol: "USDT", address: usdt },
      ],
      registry: null,
      watchlist: null,
      topPools: null,
      hotLimit: 0,
      pairs: null,
      now: () => new Date("2026-10-19T00:00:00.000Z"),
    });
    expect(again.outcomes).toMatchObject({ fresh: 2, manual: 1 });
    expect(again.pairSeedReasonCode).toBe("TOKEN_LOGO_PAIR_SEED_UNAVAILABLE");
    expect(again.hotReasonCode).toBeNull();
    expect(fetch.calls.length).toBe(before);
  });

  it("waits out a rate refusal, uses what the hot list returned before a lasting failure, and reports it", async () => {
    const proxy = {
      resolve: vi.fn(),
      warm: vi.fn(() => Promise.resolve("fresh" as const)),
    };
    const fullPage = Array.from({ length: 20 }, (_, index) =>
      pool(`0x${(index + 1).toString(16).padStart(40, "0")}`),
    );
    const base = {
      chainId,
      proxy,
      cache: null,
      mainstream: [],
      registry: null,
      watchlist: null,
      hotLimit: 200,
      pairs: null,
      hotRetryDelayMs: 0,
    } as const;
    // A refused page (the Provider's 401 past page 10, say) ends the list.
    const rejected = topPools([fullPage, "reject"]);
    const summary = await runTokenLogoPrewarmPass({
      ...base,
      topPools: rejected,
    });
    expect(summary.hotListed).toBe(20);
    expect(summary.hotReasonCode).toBe("TOKEN_LOGO_HOT_LIST_FAILED");
    expect(summary.targetCount).toBe(21);
    expect(rejected.calls()).toBe(2);

    // Rate refusals are retried (here twice, then the page answers).
    const throttled = topPools([fullPage, []], { rateLimitedFirst: 2 });
    const recovered = await runTokenLogoPrewarmPass({
      ...base,
      topPools: throttled,
    });
    expect(recovered.hotReasonCode).toBeNull();
    expect(recovered.hotListed).toBe(20);
    expect(throttled.calls()).toBe(4);

    // A lasting rate refusal gives up after ten retries.
    const stuck = topPools([fullPage, "error"]);
    const gaveUp = await runTokenLogoPrewarmPass({ ...base, topPools: stuck });
    expect(gaveUp.hotReasonCode).toBe("TOKEN_LOGO_HOT_LIST_FAILED");
    expect(stuck.calls()).toBe(1 + 11);

    const capped = await runTokenLogoPrewarmPass({
      chainId,
      proxy,
      cache: null,
      mainstream: [],
      registry: null,
      watchlist: null,
      topPools: topPools([fullPage, fullPage]),
      hotLimit: 5,
      pairs: null,
    });
    expect(capped.hotListed).toBe(5);

    const none = await runTokenLogoPrewarmPass({
      chainId,
      proxy,
      cache: null,
      mainstream: [],
      registry: null,
      watchlist: null,
      topPools: null,
      hotLimit: 200,
      pairs: null,
    });
    expect(none.hotReasonCode).toBe("TOKEN_LOGO_HOT_LIST_UNAVAILABLE");
  });

  it("runs at most eight warms at once and stops when aborted", async () => {
    let active = 0;
    let peak = 0;
    const controller = new AbortController();
    let calls = 0;
    const proxy = {
      resolve: vi.fn(),
      warm: vi.fn(async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (calls === 20) controller.abort();
        return "stored" as const;
      }),
    };
    const summary = await runTokenLogoPrewarmPass({
      chainId,
      proxy,
      cache: null,
      mainstream: bscMainstreamTokenLogos,
      registry: null,
      watchlist: null,
      topPools: null,
      hotLimit: 0,
      pairs: null,
      signal: controller.signal,
    });
    expect(peak).toBe(8);
    expect(summary.aborted).toBe(true);
    expect(calls).toBeLessThan(bscMainstreamTokenLogos.length + 1);
  });
});

describe("token_logo_prewarm lane", () => {
  it("runs a pass, reports it, sleeps the interval, and backs off when a pass throws", async () => {
    const controller = new AbortController();
    const summaries: unknown[] = [];
    const backoffs: unknown[] = [];
    let attempt = 0;
    const lane = createTokenLogoPrewarmWorker({
      intervalMs: 5,
      pass: () => {
        attempt += 1;
        if (attempt === 2) {
          return Promise.reject(new Error("registry down"));
        }
        if (attempt === 3) controller.abort();
        return Promise.resolve({
          targetCount: 1,
          byOrigin: {
            native: 1,
            mainstream: 0,
            registry: 0,
            watchlist: 0,
            hot: 0,
          },
          outcomes: {
            fresh: 1,
            manual: 0,
            stored: 0,
            missing: 0,
            kept: 0,
            failed: 0,
            degraded: 0,
            unsupported: 0,
          },
          hotListed: 0,
          hotReasonCode: null,
          pairSeedReasonCode: null,
          aborted: false,
        });
      },
      onRunResult: (summary) => summaries.push(summary),
      onInfrastructureBackoff: (event) => {
        backoffs.push(event);
      },
    });
    expect(lane.lane).toBe("token_logo_prewarm");
    vi.useFakeTimers();
    try {
      const running = lane.run(controller.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(summaries).toHaveLength(2);
    expect(backoffs).toEqual([
      {
        reasonCode: "token_logo_prewarm_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: 5_000,
      },
    ]);
    expect(tokenLogoPrewarmRetryDelayMs(20)).toBe(15 * 60 * 1_000);
  });
});
