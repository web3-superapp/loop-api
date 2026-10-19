import { describe, expect, it } from "vitest";

import type { TokenLogoCacheRecord } from "../src/database/token-logo-cache-repository.js";
import {
  createTokenLogoProxyService,
  ifNoneMatchSatisfied,
  sniffTokenLogoContentType,
  tokenLogoEtag,
  tokenLogoMaximumUpstreamBytes,
  tokenLogoUpstreamConcurrency,
} from "../src/features/market/token-logo-proxy.js";
import {
  dexscreenerWbnb,
  fakeNormalize,
  memoryLogoCache,
  normalized,
  pairFactsWithImage,
  png,
  trustWalletNative,
  trustWalletWbnb,
  upstreamFetch,
  wbnb,
  wbnbChecksum,
} from "./token-logo-fakes.js";

/**
 * Decision 0089: the token logo proxy fetches by the 0072 origin rules,
 * caches in `token_logo_cache`, and never trusts the request for a URL.
 */

const chainId = "eip155:56";
const start = new Date("2026-09-28T08:00:00.000Z");

function service(options: {
  readonly fetch: typeof fetch;
  readonly cache?: ReturnType<typeof memoryLogoCache> | null;
  readonly facts?: ReturnType<typeof pairFactsWithImage> | null;
  readonly now?: () => Date;
  readonly upstreamTimeoutMs?: number;
}) {
  return createTokenLogoProxyService({
    cache: options.cache === undefined ? memoryLogoCache() : options.cache,
    facts: options.facts ?? null,
    fetch: options.fetch,
    now: options.now ?? (() => start),
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? 50,
    normalize: fakeNormalize,
  });
}

describe("token logo proxy service (Decision 0089)", () => {
  it("fetches the Trust Wallet file on a miss, stores it for 7 days, and serves the next request from the cache", async () => {
    const bytes = png(128);
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: bytes },
    });
    const cache = memoryLogoCache();
    const proxy = service({ fetch, cache });

    const first = await proxy.resolve({ chainId, address: wbnb });
    const stored = normalized(bytes);
    expect(first).toEqual({
      kind: "image",
      bytes: stored,
      contentType: "image/webp",
      etag: tokenLogoEtag(stored),
      durable: true,
    });
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      status: "found",
      source: "trustwallet",
      sourceUrl: trustWalletWbnb,
      candidateUrl: trustWalletWbnb,
      contentType: "image/webp",
      fetchedAt: start.toISOString(),
      expiresAt: "2026-10-05T08:00:00.000Z",
    });

    const second = await proxy.resolve({ chainId, address: wbnb });
    expect(second).toMatchObject({
      kind: "image",
      etag: tokenLogoEtag(stored),
    });
    expect(fetch.calls).toEqual([trustWalletWbnb]);
  });

  it("prefers the DexScreener image cached with the pair fact, then falls back to Trust Wallet when it is missing", async () => {
    const provider = png(64, 2);
    const fetch = upstreamFetch({
      [dexscreenerWbnb]: { kind: "body", body: provider },
    });
    const cache = memoryLogoCache();
    const proxy = service({
      fetch,
      cache,
      facts: pairFactsWithImage(dexscreenerWbnb),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      bytes: normalized(provider),
    });
    expect(fetch.calls).toEqual([dexscreenerWbnb]);
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      source: "dexscreener",
      candidateUrl: dexscreenerWbnb,
    });

    const rule = png(64, 3);
    const fallback = upstreamFetch({
      [dexscreenerWbnb]: { kind: "status", status: 404 },
      [trustWalletWbnb]: { kind: "body", body: rule },
    });
    const other = service({
      fetch: fallback,
      facts: pairFactsWithImage(dexscreenerWbnb, `tokenbatch:${wbnb}`),
    });
    expect(await other.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      bytes: normalized(rule),
      durable: true,
    });
    expect(fallback.calls).toEqual([dexscreenerWbnb, trustWalletWbnb]);
  });

  it("never fetches a Provider image off the allow-list", async () => {
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: png() },
    });
    const proxy = service({
      fetch,
      facts: pairFactsWithImage("https://evil.example/logo.png"),
    });
    await proxy.resolve({ chainId, address: wbnb });
    expect(fetch.calls).toEqual([trustWalletWbnb]);
  });

  it("serves the native coin from the Trust Wallet info file", async () => {
    const fetch = upstreamFetch({
      [trustWalletNative]: { kind: "body", body: png() },
    });
    const cache = memoryLogoCache();
    expect(
      await service({ fetch, cache }).resolve({ chainId, address: null }),
    ).toMatchObject({ kind: "image" });
    expect(cache.rows.has(`${chainId}/native`)).toBe(true);
  });

  it("remembers 'no picture' for 24 h when every origin answers 404, then asks again", async () => {
    const fetch = upstreamFetch({});
    const cache = memoryLogoCache();
    let now = start;
    const proxy = service({ fetch, cache, now: () => now });

    expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
      kind: "missing",
    });
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      status: "missing",
      bytes: null,
      expiresAt: "2026-09-29T08:00:00.000Z",
    });
    now = new Date("2026-09-29T07:59:59.000Z");
    expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
      kind: "missing",
    });
    expect(fetch.calls).toHaveLength(1);
    now = new Date("2026-09-29T08:00:01.000Z");
    await proxy.resolve({ chainId, address: wbnb });
    expect(fetch.calls).toHaveLength(2);
  });

  it("refetches a remembered 'no picture' early once a Provider image appears", async () => {
    const cache = memoryLogoCache();
    await service({ fetch: upstreamFetch({}), cache }).resolve({
      chainId,
      address: wbnb,
    });
    const fetch = upstreamFetch({
      [dexscreenerWbnb]: { kind: "body", body: png() },
    });
    const proxy = service({
      fetch,
      cache,
      facts: pairFactsWithImage(dexscreenerWbnb),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
    });
    expect(fetch.calls).toEqual([dexscreenerWbnb]);
  });

  it("answers unreachable on a timeout and writes nothing", async () => {
    const fetch = upstreamFetch({ [trustWalletWbnb]: { kind: "hang" } });
    const cache = memoryLogoCache();
    const proxy = service({ fetch, cache, upstreamTimeoutMs: 20 });
    expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
      kind: "unreachable",
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("treats 5xx, 408, 429, and a network error as unreachable, never as 'no picture'", async () => {
    for (const behaviour of [
      { kind: "status", status: 500 },
      { kind: "status", status: 503 },
      { kind: "status", status: 408 },
      { kind: "status", status: 429 },
      { kind: "error" },
    ] as const) {
      const cache = memoryLogoCache();
      const proxy = service({
        fetch: upstreamFetch({ [trustWalletWbnb]: behaviour }),
        cache,
      });
      expect(
        await proxy.resolve({ chainId, address: wbnb }),
        JSON.stringify(behaviour),
      ).toEqual({ kind: "unreachable" });
      expect(cache.put).not.toHaveBeenCalled();
    }
  });

  it("serves a lower origin when a higher one failed, but neither stores it nor lets a CDN keep it long", async () => {
    const cache = memoryLogoCache();
    const proxy = service({
      fetch: upstreamFetch({
        [dexscreenerWbnb]: { kind: "status", status: 502 },
        [trustWalletWbnb]: { kind: "body", body: png() },
      }),
      cache,
      facts: pairFactsWithImage(dexscreenerWbnb),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      durable: false,
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("keeps serving expired bytes when the refetch fails", async () => {
    const cache = memoryLogoCache();
    const bytes = png();
    await service({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: bytes },
      }),
      cache,
    }).resolve({ chainId, address: wbnb });
    const later = service({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "status", status: 503 },
      }),
      cache,
      now: () => new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(await later.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      bytes: normalized(bytes),
    });
  });

  it("stores a large upstream picture normalised (no 302 any more), and refuses one over 4 MiB as 'no picture' remembered 24 h", async () => {
    // Decision 0161: anything up to the read limit is decoded and stored.
    const large = png(512 * 1024);
    const cache = memoryLogoCache();
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: large },
    });
    expect(
      await service({ fetch, cache }).resolve({ chainId, address: wbnb }),
    ).toMatchObject({ kind: "image", contentType: "image/webp" });
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      status: "found",
      bytes: normalized(large),
    });

    const big = png(tokenLogoMaximumUpstreamBytes + 1);
    for (const headers of [
      { "content-type": "image/png" },
      {
        "content-type": "image/png",
        "content-length": String(tokenLogoMaximumUpstreamBytes + 1),
      },
    ]) {
      const bigCache = memoryLogoCache();
      const bigFetch = upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: big, headers },
      });
      const proxy = service({ fetch: bigFetch, cache: bigCache });
      expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
        kind: "missing",
      });
      expect(bigCache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
        status: "oversize",
        bytes: null,
        sourceUrl: trustWalletWbnb,
        expiresAt: "2026-09-29T08:00:00.000Z",
      });
      // The marker answers 404 (never a redirect) without another
      // download for 24 h.
      expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
        kind: "missing",
      });
      expect(bigFetch.calls).toHaveLength(1);
    }
  });

  it("treats a picture that cannot be decoded as 'no picture' at that origin and tries the next one", async () => {
    const cache = memoryLogoCache();
    const corrupt = Buffer.concat([png(16), Buffer.from("UNDECODABLE")]);
    const rule = png(64, 4);
    const fetch = upstreamFetch({
      [dexscreenerWbnb]: { kind: "body", body: corrupt },
      [trustWalletWbnb]: { kind: "body", body: rule },
    });
    const proxy = service({
      fetch,
      cache,
      facts: pairFactsWithImage(dexscreenerWbnb),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      bytes: normalized(rule),
      durable: true,
    });
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      source: "trustwallet",
      candidateUrl: dexscreenerWbnb,
    });

    const alone = memoryLogoCache();
    expect(
      await service({
        fetch: upstreamFetch({
          [trustWalletWbnb]: { kind: "body", body: corrupt },
        }),
        cache: alone,
      }).resolve({ chainId, address: wbnb }),
    ).toEqual({ kind: "missing" });
    expect(alone.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      status: "missing",
    });
  });

  it("refetches a row stored before normalisation (not WebP) even inside its 7 days", async () => {
    const cache = memoryLogoCache();
    const legacy = png(32, 9);
    cache.rows.set(`${chainId}/${wbnb}`, {
      chainId,
      address: wbnb,
      status: "found",
      bytes: legacy,
      contentType: "image/png",
      etag: tokenLogoEtag(legacy),
      source: "trustwallet",
      sourceUrl: trustWalletWbnb,
      candidateUrl: trustWalletWbnb,
      fetchedAt: start.toISOString(),
      expiresAt: "2026-10-05T08:00:00.000Z",
    });
    const fresh = png(64, 5);
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: fresh },
    });
    expect(
      await service({ fetch, cache }).resolve({ chainId, address: wbnb }),
    ).toMatchObject({ kind: "image", contentType: "image/webp" });
    expect(fetch.calls).toEqual([trustWalletWbnb]);
  });

  it("serves a manual picture without asking any upstream, and neither resolve nor warm overwrites it", async () => {
    const cache = memoryLogoCache();
    const manual: TokenLogoCacheRecord = {
      chainId,
      address: wbnb,
      status: "found",
      bytes: Buffer.from("MANUAL"),
      contentType: "image/webp",
      etag: tokenLogoEtag(Buffer.from("MANUAL")),
      source: "manual",
      sourceUrl: null,
      candidateUrl: null,
      fetchedAt: start.toISOString(),
      // Even a past expiry does not make a manual row due.
      expiresAt: "2026-09-28T08:00:01.000Z",
    };
    cache.rows.set(`${chainId}/${wbnb}`, manual);
    const fetch = upstreamFetch({
      [dexscreenerWbnb]: { kind: "body", body: png() },
      [trustWalletWbnb]: { kind: "body", body: png() },
    });
    const proxy = service({
      fetch,
      cache,
      facts: pairFactsWithImage(dexscreenerWbnb),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      bytes: Buffer.from("MANUAL"),
      durable: true,
    });
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("manual");
    expect(await proxy.warm({ chainId, address: wbnb, state: manual })).toBe(
      "manual",
    );
    expect(fetch.calls).toEqual([]);
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toBe(manual);
  });

  it("reads Ethereum and Base from their own Trust Wallet folder and never consults the BSC pair facts there", async () => {
    const facts = pairFactsWithImage(dexscreenerWbnb);
    for (const [chain, folder] of [
      ["eip155:1", "ethereum"],
      ["eip155:8453", "base"],
    ] as const) {
      const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${wbnbChecksum}/logo.png`;
      const native = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/info/logo.png`;
      const cache = memoryLogoCache();
      const fetch = upstreamFetch({
        [url]: { kind: "body", body: png() },
        [native]: { kind: "body", body: png() },
      });
      const proxy = service({ fetch, cache, facts });
      expect(
        await proxy.resolve({ chainId: chain, address: wbnb }),
      ).toMatchObject({ kind: "image" });
      expect(
        await proxy.resolve({ chainId: chain, address: null }),
      ).toMatchObject({ kind: "image" });
      expect(fetch.calls).toEqual([url, native]);
      expect(cache.rows.has(`${chain}/${wbnb}`)).toBe(true);
    }
    expect(facts.getMany).not.toHaveBeenCalled();
    // A chain without a folder has no origin at all.
    const none = upstreamFetch({});
    expect(
      await service({ fetch: none }).resolve({
        chainId: "eip155:10",
        address: wbnb,
      }),
    ).toEqual({ kind: "missing" });
    expect(
      await service({ fetch: none }).warm({
        chainId: "eip155:10",
        address: wbnb,
      }),
    ).toBe("unsupported");
    expect(none.calls).toEqual([]);
  });

  it("shares one upstream fetch between concurrent requests for the same token", async () => {
    const fetch = upstreamFetch(
      { [trustWalletWbnb]: { kind: "body", body: png() } },
      { delayMs: 20 },
    );
    const cache = memoryLogoCache();
    const proxy = service({ fetch, cache, upstreamTimeoutMs: 1_000 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        proxy.resolve({ chainId, address: wbnb }),
      ),
    );
    expect(results.every((result) => result.kind === "image")).toBe(true);
    expect(fetch.calls).toEqual([trustWalletWbnb]);
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("fetches at most eight tokens upstream at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const proxy = service({ fetch, upstreamTimeoutMs: 1_000 });
    const addresses = Array.from(
      { length: 20 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const results = await Promise.all(
      addresses.map((address) => proxy.resolve({ chainId, address })),
    );
    expect(results.every((result) => result.kind === "missing")).toBe(true);
    expect(peak).toBe(tokenLogoUpstreamConcurrency);
  });

  it("follows a redirect only onto an allow-listed host", async () => {
    const moved = `https://cdn.dexscreener.com/cms/images/${wbnb}.png`;
    const ok = upstreamFetch({
      [trustWalletWbnb]: {
        kind: "status",
        status: 302,
        headers: { location: moved },
      },
      [moved]: { kind: "body", body: png() },
    });
    expect(
      await service({ fetch: ok }).resolve({ chainId, address: wbnb }),
    ).toMatchObject({ kind: "image" });
    expect(ok.calls).toEqual([trustWalletWbnb, moved]);

    const offList = upstreamFetch({
      [trustWalletWbnb]: {
        kind: "status",
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      },
    });
    expect(
      await service({ fetch: offList }).resolve({ chainId, address: wbnb }),
    ).toEqual({ kind: "missing" });
    expect(offList.calls).toEqual([trustWalletWbnb]);
  });

  it("refuses bytes that are not a raster image (SVG, HTML) as 'no picture'", async () => {
    for (const body of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      Buffer.from("<html>not found</html>"),
      Buffer.alloc(0),
    ]) {
      const proxy = service({
        fetch: upstreamFetch({
          [trustWalletWbnb]: {
            kind: "body",
            body,
            headers: { "content-type": "image/png" },
          },
        }),
      });
      expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
        kind: "missing",
      });
    }
  });

  it("still serves without a database, storing nothing", async () => {
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: png() },
    });
    const proxy = service({ fetch, cache: null });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
    });
  });
});

describe("token logo proxy warm (Decision 0161 §2)", () => {
  it("stores on a miss, is fresh until a day before expiry, then refreshes", async () => {
    const cache = memoryLogoCache();
    let now = start;
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: png() },
    });
    const proxy = service({ fetch, cache, now: () => now });
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("stored");
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("fresh");
    // Expires 2026-10-05T08:00Z; a day ahead it is due again.
    now = new Date("2026-10-04T07:59:00.000Z");
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("fresh");
    now = new Date("2026-10-04T08:00:01.000Z");
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("stored");
    expect(fetch.calls).toHaveLength(2);
    // An on-demand request inside the last day is still served from cache.
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
    });
    expect(fetch.calls).toHaveLength(2);
  });

  it("keeps the stored picture when a refresh fails (state given without bytes)", async () => {
    const cache = memoryLogoCache();
    await service({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: png() },
      }),
      cache,
    }).warm({ chainId, address: wbnb });
    const stored = cache.rows.get(`${chainId}/${wbnb}`);
    const later = service({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "status", status: 503 },
      }),
      cache,
      now: () => new Date("2026-10-06T00:00:00.000Z"),
    });
    const states = await cache.listStates(chainId, [wbnb]);
    expect(states.get(wbnb)?.bytes).toBeNull();
    expect(
      await later.warm({
        chainId,
        address: wbnb,
        state: states.get(wbnb) ?? null,
      }),
    ).toBe("kept");
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toBe(stored);
  });

  it("reports missing, failed and degraded without storing a failure", async () => {
    const missingCache = memoryLogoCache();
    expect(
      await service({ fetch: upstreamFetch({}), cache: missingCache }).warm({
        chainId,
        address: wbnb,
      }),
    ).toBe("missing");
    expect(missingCache.rows.get(`${chainId}/${wbnb}`)?.status).toBe("missing");

    const failedCache = memoryLogoCache();
    expect(
      await service({
        fetch: upstreamFetch({ [trustWalletWbnb]: { kind: "error" } }),
        cache: failedCache,
      }).warm({ chainId, address: wbnb }),
    ).toBe("failed");
    expect(failedCache.put).not.toHaveBeenCalled();

    const degradedCache = memoryLogoCache();
    expect(
      await service({
        fetch: upstreamFetch({
          [dexscreenerWbnb]: { kind: "status", status: 500 },
          [trustWalletWbnb]: { kind: "body", body: png() },
        }),
        cache: degradedCache,
        facts: pairFactsWithImage(dexscreenerWbnb),
      }).warm({ chainId, address: wbnb }),
    ).toBe("degraded");
    expect(degradedCache.put).not.toHaveBeenCalled();
  });
});

describe("token logo helpers (Decision 0089)", () => {
  it("sniffs PNG, JPEG, GIF, and WebP signatures and nothing else", () => {
    expect(sniffTokenLogoContentType(png())).toBe("image/png");
    expect(
      sniffTokenLogoContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    ).toBe("image/jpeg");
    expect(sniffTokenLogoContentType(Buffer.from("GIF89a...."))).toBe(
      "image/gif",
    );
    expect(sniffTokenLogoContentType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe(
      "image/webp",
    );
    expect(sniffTokenLogoContentType(Buffer.from("<svg/>"))).toBeNull();
  });

  it("matches If-None-Match by strong or weak tag, in a list, or *", () => {
    const etag = tokenLogoEtag(png());
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfied(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfied("*", etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"other"', etag)).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
  });
});
