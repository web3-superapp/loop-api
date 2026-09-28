import { describe, expect, it } from "vitest";

import {
  createTokenLogoProxyService,
  ifNoneMatchSatisfied,
  sniffTokenLogoContentType,
  tokenLogoEtag,
  tokenLogoMaximumBytes,
  tokenLogoUpstreamConcurrency,
} from "../src/features/market/token-logo-proxy.js";
import {
  dexscreenerWbnb,
  memoryLogoCache,
  pairFactsWithImage,
  png,
  trustWalletNative,
  trustWalletWbnb,
  upstreamFetch,
  wbnb,
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
    expect(first).toEqual({
      kind: "image",
      bytes,
      contentType: "image/png",
      etag: tokenLogoEtag(bytes),
      durable: true,
    });
    expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
      status: "found",
      source: "trustwallet",
      sourceUrl: trustWalletWbnb,
      candidateUrl: trustWalletWbnb,
      contentType: "image/png",
      fetchedAt: start.toISOString(),
      expiresAt: "2026-10-05T08:00:00.000Z",
    });

    const second = await proxy.resolve({ chainId, address: wbnb });
    expect(second).toMatchObject({ kind: "image", etag: tokenLogoEtag(bytes) });
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
      bytes: provider,
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
      bytes: rule,
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
      bytes,
    });
  });

  it("redirects a picture over 256 KiB instead of storing it, by Content-Length or by the bytes read", async () => {
    const big = png(tokenLogoMaximumBytes + 1);
    for (const headers of [
      { "content-type": "image/png" },
      {
        "content-type": "image/png",
        "content-length": String(tokenLogoMaximumBytes + 1),
      },
    ]) {
      const cache = memoryLogoCache();
      const fetch = upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: big, headers },
      });
      const proxy = service({ fetch, cache });
      expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
        kind: "redirect",
        location: trustWalletWbnb,
      });
      expect(cache.rows.get(`${chainId}/${wbnb}`)).toMatchObject({
        status: "oversize",
        bytes: null,
        sourceUrl: trustWalletWbnb,
      });
      // The marker answers without another download for 24 h.
      expect(await proxy.resolve({ chainId, address: wbnb })).toEqual({
        kind: "redirect",
        location: trustWalletWbnb,
      });
      expect(fetch.calls).toHaveLength(1);
    }
    // Exactly 256 KiB is still proxied.
    const edge = png(tokenLogoMaximumBytes);
    expect(
      await service({
        fetch: upstreamFetch({
          [trustWalletWbnb]: { kind: "body", body: edge },
        }),
      }).resolve({ chainId, address: wbnb }),
    ).toMatchObject({ kind: "image" });
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
