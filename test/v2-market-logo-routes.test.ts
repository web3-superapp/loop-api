import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import type { MarketFactCacheRepository } from "../src/database/market-fact-cache-repository.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { tokenLogoEtag } from "../src/features/market/token-logo-proxy.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import { createUnavailablePrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import sharp from "sharp";

import {
  dexscreenerWbnb,
  logoPng,
  memoryLogoCache,
  pairFactsWithImage,
  png,
  trustWalletNative,
  trustWalletWbnb,
  upstreamFetch,
  wbnb,
} from "./token-logo-fakes.js";

/**
 * `GET /v2/market/logos/{chainId}/{file}` (Decision 0089): a public,
 * CDN-cacheable image route. No Bearer and no LOOP headers are sent in any of
 * these requests, as an image loader sends none.
 */

const path = `/v2/market/logos/eip155:56/${wbnb}.png`;
const errorFields = [
  "code",
  "category",
  "retryable",
  "userMessageKey",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
];

function database(
  cache = memoryLogoCache(),
  facts: Pick<MarketFactCacheRepository, "getMany"> = pairFactsWithImage(null),
): Database {
  const unavailable = () => Promise.reject(new Error("not used"));
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    tokenLogoCache: cache,
    marketFacts: {
      get: unavailable,
      put: unavailable,
      getMany: facts.getMany,
      findVerifiedCommunityByAssetId: unavailable,
    },
    internalUsers: {
      findByPrivyUserId: unavailable,
      getOrCreateByPrivyUserId: unavailable,
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe("GET /v2/market/logos/{chainId}/{file} (Decision 0089)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(options: {
    readonly fetch: typeof fetch;
    readonly database?: Database;
    readonly modules?: string;
  }) {
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        V2_MODULES_ENABLED: options.modules ?? "market",
        DATABASE_URL:
          "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      }),
      contractSurface: "v2",
      database: options.database ?? database(),
      privyAccessTokenVerifier: createUnavailablePrivyAccessTokenVerifier(),
      tokenLogoFetch: options.fetch,
      tokenLogoUpstreamTimeoutMs: 30,
      logger: false,
    });
    apps.push(app);
    return app;
  }

  it("serves the normalised 128 x 128 WebP under the .png name with CDN caching, a strong ETag, and nosniff, without any auth or LOOP header", async () => {
    const bytes = await logoPng({ width: 256, height: 256, alpha: 0.5 });
    const cache = memoryLogoCache();
    const app = await createApp({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: bytes },
      }),
      database: database(cache),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(response.headers["etag"]).toBe(tokenLogoEtag(response.rawPayload));
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const metadata = await sharp(response.rawPayload).metadata();
    expect(metadata).toMatchObject({
      format: "webp",
      width: 128,
      height: 128,
      hasAlpha: true,
    });
    expect(cache.rows.get(`eip155:56/${wbnb}`)?.contentType).toBe("image/webp");
    // `.webp` names the same resource.
    const webp = await app.inject({
      method: "GET",
      url: `/v2/market/logos/eip155:56/${wbnb}.webp`,
    });
    expect(webp.statusCode).toBe(200);
    expect(webp.headers["etag"]).toBe(response.headers["etag"]);
  });

  it("answers 304 to a matching If-None-Match and 200 to a stale one", async () => {
    const bytes = await logoPng();
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: bytes },
    });
    const app = await createApp({ fetch });
    const first = await app.inject({ method: "GET", url: path });
    const etag = String(first.headers["etag"]);
    const notModified = await app.inject({
      method: "GET",
      url: path,
      headers: { "if-none-match": etag },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers["etag"]).toBe(etag);
    expect(notModified.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    const changed = await app.inject({
      method: "GET",
      url: path,
      headers: { "if-none-match": '"an-older-picture-tag"' },
    });
    expect(changed.statusCode).toBe(200);
    // Both answered from one upstream fetch (cache hit on the second).
    expect(fetch.calls).toEqual([trustWalletWbnb]);
  });

  it("normalises a checksummed address to the same cached picture, and serves native.png", async () => {
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: await logoPng() },
      [trustWalletNative]: { kind: "body", body: await logoPng({ red: 9 }) },
    });
    const cache = memoryLogoCache();
    const app = await createApp({ fetch, database: database(cache) });
    const upper = await app.inject({
      method: "GET",
      url: "/v2/market/logos/eip155:56/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c.png",
    });
    const lower = await app.inject({ method: "GET", url: path });
    expect(upper.statusCode).toBe(200);
    expect(lower.headers["etag"]).toBe(upper.headers["etag"]);
    const native = await app.inject({
      method: "GET",
      url: "/v2/market/logos/eip155:56/native.png",
    });
    expect(native.statusCode).toBe(200);
    expect(fetch.calls).toEqual([trustWalletWbnb, trustWalletNative]);
    expect([...cache.rows.keys()].sort()).toEqual([
      "eip155:56/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "eip155:56/native",
    ]);
  });

  it("answers 404 NOT_FOUND in the seven-field envelope when no origin has a picture", async () => {
    const app = await createApp({ fetch: upstreamFetch({}) });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.json())).toEqual(errorFields);
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      detailsSafe: null,
      providerReferenceSafe: null,
    });
  });

  it("answers 502 PROVIDER_UNREACHABLE on an upstream timeout", async () => {
    const cache = memoryLogoCache();
    const app = await createApp({
      fetch: upstreamFetch({ [trustWalletWbnb]: { kind: "hang" } }),
      database: database(cache),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(502);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.json())).toEqual(errorFields);
    expect(response.json()).toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      category: "availability",
      retryable: true,
      userMessageKey: "errors.provider.unreachable",
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("serves a large upstream picture itself instead of redirecting (no 302 since Decision 0161)", async () => {
    // Random pixels do not compress: the PNG stays far above 256 KiB.
    const noise = randomBytes(1024 * 1024 * 3);
    const large = await sharp(noise, {
      raw: { width: 1024, height: 1024, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(large.length).toBeGreaterThan(256 * 1024);
    const app = await createApp({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: large },
      }),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["location"]).toBeUndefined();
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.rawPayload.length).toBeLessThan(64 * 1024);
  });

  it("answers 404 for an upstream picture that cannot be decoded", async () => {
    const app = await createApp({
      fetch: upstreamFetch({
        [trustWalletWbnb]: { kind: "body", body: png(200) },
      }),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads Ethereum and Base logos from their own Trust Wallet folder", async () => {
    const fetch = upstreamFetch({
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png":
        { kind: "body", body: await logoPng() },
      [`https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png`]:
        { kind: "body", body: await logoPng() },
    });
    const app = await createApp({ fetch });
    for (const url of [
      "/v2/market/logos/eip155:1/native.png",
      `/v2/market/logos/eip155:8453/${wbnb}.png`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toBe("image/webp");
    }
  });

  it("lets a CDN keep a picture from a lower origin for five minutes only when a higher one failed", async () => {
    const app = await createApp({
      fetch: upstreamFetch({
        [dexscreenerWbnb]: { kind: "hang" },
        [trustWalletWbnb]: { kind: "body", body: await logoPng() },
      }),
      database: database(
        memoryLogoCache(),
        pairFactsWithImage(dexscreenerWbnb),
      ),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("refuses anything but 0x + 40 hex or native on a known chain, and any query, before an upstream is asked", async () => {
    const fetch = upstreamFetch({});
    const app = await createApp({ fetch });
    for (const url of [
      "/v2/market/logos/eip155:56/0x1234.png",
      `/v2/market/logos/eip155:56/${wbnb}.svg`,
      `/v2/market/logos/eip155:56/${wbnb}`,
      `/v2/market/logos/eip155:56/${wbnb}zz.png`,
      "/v2/market/logos/eip155:56/..%2F..%2Fetc%2Fpasswd.png",
      "/v2/market/logos/eip155:56/https%3A%2F%2Fevil.example%2Fx.png",
      `/v2/market/logos/eip155:10/${wbnb}.png`,
      `/v2/market/logos/eip155:97/${wbnb}.png`,
      `/v2/market/logos/eip155:56/${wbnb}.gif`,
      `/v2/market/logos/56/${wbnb}.png`,
      `${path}?url=https://evil.example/x.png`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetch.calls).toEqual([]);
  });

  it("is not registered when the market module is off", async () => {
    const app = await createApp({
      fetch: upstreamFetch({}),
      modules: "chain",
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
