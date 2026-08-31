import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import {
  createUnavailablePerpWalletBindingRepository,
  type PerpWalletBindingRepository,
} from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";

function testConfig(apiDocsEnabled = true) {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    API_DOCS_ENABLED: apiDocsEnabled ? "true" : "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  });
}

function fakeDatabase(ping: Database["ping"] = vi.fn(() => Promise.resolve())) {
  return {
    database: {
      alerts: createUnavailableAlertRepository(),
      agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
      controlPlane: createUnavailableControlPlaneRepository(),
      perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
      perpIntents: createUnavailablePerpIntentRepository(),
      profiles: createUnavailableProfileRepository(),
      watchlists: createUnavailableWatchlistRepository(),
      internalUsers: {
        findByPrivyUserId: vi.fn(() =>
          Promise.resolve({ id: "6d12a86e-4134-47e6-9312-c5ef75a30f55" }),
        ),
        getOrCreateByPrivyUserId: vi.fn(() =>
          Promise.resolve({ id: "6d12a86e-4134-47e6-9312-c5ef75a30f55" }),
        ),
      },
      ping,
      close: vi.fn(() => Promise.resolve()),
    } satisfies Database,
  };
}

describe("LOOP API foundation", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    vi.unstubAllGlobals();
  });

  it("reports liveness without touching PostgreSQL", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "client-controlled" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "loop-api",
      version: "0.1.0",
    });
    expect(database.ping).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers["x-request-id"]).not.toBe("client-controlled");
  });

  it("reports readiness only after PostgreSQL responds", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { database: "up" },
    });
    expect(database.ping).toHaveBeenCalledOnce();
  });

  it("returns a sanitized 503 when PostgreSQL is unavailable", async () => {
    const ping = vi.fn(() =>
      Promise.reject(new Error("postgres://user:secret@example.com/private")),
    );
    const { database } = fakeDatabase(ping);
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { database: "down" },
    });
  });

  it("generates an OpenAPI 3.1 contract from route schemas", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths).toHaveProperty("/health/live");
    expect(document.paths).toHaveProperty("/health/ready");
    expect(document.paths).toHaveProperty("/v1/perp/wallet-binding");
    expect(document.paths).toHaveProperty("/v1/discovery/users");
    expect(document.paths).toHaveProperty("/v1/chat/groups/resolve");
    expect(document.paths).toHaveProperty("/v1/chat/groups");
    expect(document.paths).toHaveProperty("/v1/chat/direct-channels");
    expect(document.paths).toHaveProperty("/v1/chat/operations/{operation_id}");
    expect(document.paths).toHaveProperty(
      "/v1/chat/groups/{group_id}/me/alias",
    );
    expect(document.paths).toHaveProperty("/v1/chat/groups/{group_id}/aliases");
    expect(document.paths).toHaveProperty("/v1/profile/social-privacy");
    expect(document.paths).toHaveProperty("/v1/friends");
    expect(document.paths).toHaveProperty("/v1/friends/search");
    expect(document.paths).toHaveProperty("/v1/friend-requests");
    expect(document.paths).toHaveProperty(
      "/v1/friend-requests/{friend_request_id}/decision",
    );
    expect(document.paths).toHaveProperty(
      "/v1/social/operations/{operation_id}",
    );
    expect(document.paths).toHaveProperty("/v1/spot/config");
    expect(document.paths).toHaveProperty(
      "/v1/spot/intents/{intent_id}/submit",
    );
    expect(document.paths["/health/live"]).toHaveProperty("get.responses.500");
    expect(document.paths["/health/ready"]).toHaveProperty("get.responses.503");
    expect(document.paths).not.toHaveProperty("/openapi.json");
  });

  it("composes the transfer surface as authenticated and unavailable", async () => {
    const { database } = fakeDatabase();
    const verifyAccessToken = vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:transfer-app-user" }),
    );
    const app = await buildApp({
      config: testConfig(),
      database,
      privyAccessTokenVerifier: { verifyAccessToken },
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfer/reviews",
      headers: { authorization: "Bearer header.payload.signature" },
      payload: {
        preflight_handle: "unresolved-handle",
        amount_decimal: "1.25",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "transfer_unavailable",
      message: "Transfer operations are unavailable.",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(verifyAccessToken).toHaveBeenCalledOnce();
    expect(database.internalUsers.findByPrivyUserId).toHaveBeenCalledWith(
      "did:privy:transfer-app-user",
    );
  });

  it("mounts social and backend-created Chat channels as authenticated and default-closed", async () => {
    const { database } = fakeDatabase();
    const verifyAccessToken = vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:social-app-user" }),
    );
    const app = await buildApp({
      config: testConfig(),
      database,
      privyAccessTokenVerifier: { verifyAccessToken },
      logger: false,
    });
    apps.push(app);

    const social = await app.inject({
      method: "GET",
      url: "/v1/profile/social-privacy",
      headers: { authorization: "Bearer header.payload.signature" },
    });
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/direct-channels",
      headers: {
        authorization: "Bearer header.payload.signature",
        "idempotency-key": "55555555-5555-4555-8555-555555555555",
      },
      payload: {
        target_public_profile_id: "22222222-2222-4222-8222-222222222222",
      },
    });

    expect(social.statusCode).toBe(503);
    expect(social.json<{ code: string }>().code).toBe("social_unavailable");
    expect(chat.statusCode).toBe(503);
    expect(chat.json<{ code: string }>().code).toBe("chat_unavailable");
    expect(verifyAccessToken).toHaveBeenCalledTimes(2);
  });

  it("composes the exact Spot surface as authenticated and default-closed", async () => {
    const { database } = fakeDatabase();
    const verifyAccessToken = vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:spot-app-user" }),
    );
    const app = await buildApp({
      config: testConfig(),
      database,
      privyAccessTokenVerifier: { verifyAccessToken },
      logger: false,
    });
    apps.push(app);

    const marketId = "22222222-2222-4222-8222-222222222222";
    const intentId = "33333333-3333-4333-8333-333333333333";
    const authorizationId = "44444444-4444-4444-8444-444444444444";
    const idempotencyKey = "55555555-5555-4555-8555-555555555555";
    const requests = [
      { method: "GET", url: "/v1/spot/config" },
      { method: "GET", url: `/v1/spot/markets/${marketId}/facts` },
      { method: "GET", url: "/v1/spot/balances" },
      {
        method: "POST",
        url: "/v1/spot/intents",
        headers: { "idempotency-key": idempotencyKey },
        payload: {
          market_id: marketId,
          side: "buy",
          amount: { mode: "quote", value: "10" },
        },
      },
      { method: "GET", url: `/v1/spot/intents/${intentId}` },
      { method: "POST", url: `/v1/spot/intents/${intentId}/submit` },
      { method: "GET", url: "/v1/spot/wallet-binding" },
      {
        method: "PUT",
        url: "/v1/spot/wallet-binding",
        payload: { expected_binding_version: "7" },
      },
      {
        method: "DELETE",
        url: "/v1/spot/wallet-binding?expected_binding_version=7",
      },
      { method: "POST", url: "/v1/spot/agent-authorizations" },
      {
        method: "GET",
        url: `/v1/spot/agent-authorizations/${authorizationId}`,
      },
      {
        method: "POST",
        url: `/v1/spot/agent-authorizations/${authorizationId}/signatures`,
        payload: { signature: "0xopaque" },
      },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: {
          authorization: "Bearer header.payload.signature",
          ...("headers" in request ? request.headers : {}),
        },
        ...("payload" in request ? { payload: request.payload } : {}),
      });

      expect(
        response.statusCode,
        `${request.method} ${request.url}: ${response.body}`,
      ).toBe(503);
      expect(response.json()).toMatchObject({
        code: "spot_unavailable",
        message: "Spot is unavailable.",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(verifyAccessToken).toHaveBeenCalledTimes(requests.length);
    expect(database.internalUsers.findByPrivyUserId).toHaveBeenCalledTimes(
      requests.length,
    );
    for (const call of database.internalUsers.findByPrivyUserId.mock.calls) {
      expect(call).toEqual(["did:privy:spot-app-user"]);
    }
    expect(
      database.internalUsers.getOrCreateByPrivyUserId,
    ).not.toHaveBeenCalled();
  });

  it("keeps OpenAPI retrieval disabled when configured off", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(false),
      database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const payload = response.json<{ request_id: string }>();

    expect(response.statusCode).toBe(404);
    expect(payload).toMatchObject({
      code: "not_found",
      message: "The requested resource does not exist.",
    });
    expect(response.headers["x-request-id"]).toBe(payload.request_id);
  });

  it("preserves non-bootstrap client error status codes", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    app.get("/test-rate-limit", () => {
      throw Object.assign(new Error("provider detail"), { statusCode: 429 });
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/test-rate-limit",
    });

    expect(response.statusCode).toBe(429);
    expect(response.body).not.toContain("provider detail");
    expect(response.json()).toMatchObject({ code: "internal_error" });
  });

  it("enforces the application handler deadline with a sanitized 503", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });
    app.get(
      "/test-handler-timeout",
      { handlerTimeout: 10 },
      async (_request, reply) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return reply.send({ too_late: true });
      },
    );
    apps.push(app);

    expect(
      (
        app.initialConfig as unknown as {
          readonly handlerTimeout?: number;
        }
      ).handlerTimeout,
    ).toBe(15_000);
    const response = await app.inject({
      method: "GET",
      url: "/test-handler-timeout",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "request_timeout",
      message: "The request timed out.",
    });
    expect(response.body).not.toContain("FST_ERR_HANDLER_TIMEOUT");
  });

  it("logs only the route template and never raw query authorities or cursors", async () => {
    const logLines: string[] = [];
    const walletAddress = "0x11111111111111111111111111111111111111aa";
    const opaqueCursor = `${"A".repeat(80)}.${"B".repeat(43)}`;
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: {
        level: "info",
        stream: {
          write(line: string): void {
            logLines.push(line);
          },
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/perp/account?address=${walletAddress}&cursor=${opaqueCursor}`,
    });

    expect(response.statusCode).toBe(400);
    const serializedLogs = logLines.join("");
    expect(serializedLogs).not.toContain(walletAddress);
    expect(serializedLogs).not.toContain(opaqueCursor);
    expect(serializedLogs).not.toContain("?address=");
    expect(serializedLogs).not.toContain("cursor=");

    const entries = logLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const received = entries.find(
      (entry) => entry["msg"] === "Request received",
    );
    expect(received).toBeDefined();
    expect(received?.["method"]).toBe("GET");
    expect(received?.["route"]).toBe("/v1/perp/account");
    expect(typeof received?.["requestId"]).toBe("string");
    expect(received?.["requestId"] as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(entries.some((entry) => Object.hasOwn(entry, "req"))).toBe(false);
  });

  it("does not auto-expose HEAD aliases for the exact private-read GET surface", async () => {
    const { database } = fakeDatabase();
    const verifyAccessToken = vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    );
    const resolve = vi.fn(() => Promise.reject(new Error("must not resolve")));
    const read = vi.fn(() => Promise.reject(new Error("must not read")));
    const app = await buildApp({
      config: testConfig(),
      database,
      privyAccessTokenVerifier: { verifyAccessToken },
      perpWalletBindingResolver: { resolve },
      hyperliquidPrivateReader: { read },
      logger: false,
    });
    apps.push(app);

    for (const path of [
      "/v1/perp/config",
      "/v1/perp/account",
      "/v1/perp/positions",
      "/v1/perp/orders",
      "/v1/perp/fills",
      "/v1/perp/funding",
      "/v1/spot/config",
      "/v1/spot/markets/22222222-2222-4222-8222-222222222222/facts",
      "/v1/spot/balances",
      "/v1/spot/intents/33333333-3333-4333-8333-333333333333",
      "/v1/spot/wallet-binding",
      "/v1/spot/agent-authorizations/44444444-4444-4444-8444-444444444444",
    ]) {
      const response = await app.inject({
        method: "HEAD",
        url: path,
        headers: { authorization: "Bearer header.payload.signature" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "not_found" });
    }

    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(database.internalUsers.findByPrivyUserId).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("composes enabled private reads through binding, quota, and the fixed Testnet transport", async () => {
    const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
    const privyUserId = "did:privy:composition-user";
    const accountAddress = "0x1111111111111111111111111111111111111111";
    const { database } = fakeDatabase();
    const get = vi.fn<PerpWalletBindingRepository["get"]>(() =>
      Promise.resolve({
        ownerUserId,
        privyUserId,
        state: "bound",
        walletId: "wallet-a",
        accountAddress,
        accountKind: "master",
        bindingVersion: "1",
        lastVerifiedAt: "2026-08-25T04:00:00.000Z",
        createdAt: "2026-08-25T04:00:00.000Z",
        updatedAt: "2026-08-25T04:00:00.000Z",
      }),
    );
    const consumeIssuanceQuota = vi.fn<
      Database["controlPlane"]["consumeIssuanceQuota"]
    >(() => Promise.resolve([]));
    const composedDatabase = {
      ...database,
      controlPlane: { ...database.controlPlane, consumeIssuanceQuota },
      perpWalletBindings: {
        get,
        putVerifiedBinding:
          vi.fn<PerpWalletBindingRepository["putVerifiedBinding"]>(),
        unbind: vi.fn<PerpWalletBindingRepository["unbind"]>(),
      },
    } satisfies Database;
    const readCurrentUser = vi.fn(() =>
      Promise.resolve({
        id: privyUserId,
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "ethereum",
            wallet_client_type: "privy",
            connector_type: "embedded",
            id: "wallet-a",
            address: accountAddress,
          },
        ],
      }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            universe: [
              {
                szDecimals: 5,
                name: "BTC",
                maxLeverage: 40,
                marginTableId: 0,
              },
              {
                szDecimals: 4,
                name: "ETH",
                maxLeverage: 25,
                marginTableId: 0,
              },
              {
                szDecimals: 2,
                name: "SOL",
                maxLeverage: 20,
                marginTableId: 0,
              },
            ],
            marginTables: [
              [
                0,
                {
                  description: "",
                  marginTiers: [{ lowerBound: "0.0", maxLeverage: 40 }],
                },
              ],
            ],
            collateralToken: 0,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({
      NODE_ENV: "test",
      API_DOCS_ENABLED: "true",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      PRIVY_APP_ID: "test-privy-app",
      PRIVY_APP_SECRET: "test-privy-app-secret",
      PERP_READ_CURSOR_HMAC_SECRET: "c".repeat(32),
      HYPERLIQUID_PRIVATE_READS_ENABLED: "true",
      HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: "q".repeat(32),
    });
    const app = await buildApp({
      config,
      database: composedDatabase,
      privyAccessTokenVerifier: {
        verifyAccessToken: vi.fn(() => Promise.resolve({ privyUserId })),
      },
      privyUserReader: { readCurrentUser },
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/perp/config",
      headers: { authorization: "Bearer header.payload.signature" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: { network: "testnet", coins: ["BTC", "ETH", "SOL"] },
      capabilities: {
        private_reads: "available",
        trading_mutations: "disabled",
      },
    });
    expect(get).toHaveBeenCalledWith({ ownerUserId, privyUserId });
    expect(readCurrentUser).toHaveBeenCalledOnce();
    expect(consumeIssuanceQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "hyperliquid_info",
        cost: 20,
      }),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.hyperliquid-testnet.xyz/info",
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ type: "meta", dex: "" }),
    );
  });

  it("closes the database pool with the application", async () => {
    const { database } = fakeDatabase();
    const app = await buildApp({
      config: testConfig(),
      database,
      logger: false,
    });

    await app.close();

    expect(database.close).toHaveBeenCalledOnce();
  });
});
