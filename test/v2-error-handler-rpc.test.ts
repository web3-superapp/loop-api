import type { FastifyInstance } from "fastify";
import { HttpRequestError, TimeoutError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  errorLogStackFrameLimit,
  redactErrorText,
  summarizeErrorForLog,
} from "../src/core/http/error-log.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { LaunchChainRepositoryUnavailableError } from "../src/features/launch/launch-chain-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import {
  BscReadUnavailableError,
  isBscRpcTransportError,
} from "../src/integrations/bsc/rpc-client.js";

/**
 * Decision 0082: an unclassified chain read on a V2 read route is the
 * capability being unavailable, and an internal error leaves its cause in
 * the server log (redacted) instead of one bare "Request failed" line.
 */

const rpcKeyPath = "/v1/secret-rpc-key-0123456789";
const address = "0x00000000000000000000000000000000000000a1";

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    API_DOCS_ENABLED: "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  });
}

function database(): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
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
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

function rpcTimeout(): TimeoutError {
  return new TimeoutError({
    body: { method: "eth_getBlockByNumber", params: ["latest", false] },
    url: `https://rpc.example.com${rpcKeyPath}`,
  });
}

describe("V2 error handler: chain reads and internal errors (Decision 0082)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(logLines?: string[]) {
    const app = await buildApp({
      config: testConfig(),
      database: database(),
      logger:
        logLines === undefined
          ? false
          : {
              level: "info",
              stream: {
                write(line: string): void {
                  logLines.push(line);
                },
              },
            },
    });
    app.get("/v2/test-rpc-timeout", () => {
      throw rpcTimeout();
    });
    app.get("/v2/test-rpc-http", () => {
      throw new Error("wrapped", {
        cause: new HttpRequestError({
          url: `https://rpc.example.com${rpcKeyPath}`,
          status: 502,
        }),
      });
    });
    app.get("/v2/test-bsc-unavailable", () => {
      throw new BscReadUnavailableError("BSC_LOG_RANGE_TOO_WIDE");
    });
    app.post("/v2/test-rpc-timeout", () => {
      throw rpcTimeout();
    });
    app.get("/v2/test-internal", () => {
      throw new TypeError(
        `boom at https://user:pw@rpc.example.com${rpcKeyPath}?apikey=abc123 for ${address} with Bearer eyJhbGciOi.payload.sig`,
      );
    });
    app.get("/v2/test-internal-caused", () => {
      throw new LaunchChainRepositoryUnavailableError({
        cause: new RangeError(
          "relation failed at postgres://loop:pw@db.example.com/loop",
        ),
      });
    });
    apps.push(app);
    return app;
  }

  it("maps a viem timeout on a read route to 503 CAPABILITY_UNAVAILABLE", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/test-rpc-timeout",
    });
    expect(response.statusCode).toBe(503);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      "category",
      "code",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
      "retryable",
      "userMessageKey",
    ]);
    expect(body).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
      userMessageKey: "errors.capability.unavailable",
      detailsSafe: { reasonCode: "BSC_RPC_UNREACHABLE" },
      providerReferenceSafe: null,
    });
    expect(typeof body["correlationId"]).toBe("string");
    expect(response.body).not.toContain("rpc.example.com");
  });

  it("maps a wrapped HTTP failure and an unclassified BSC read the same way", async () => {
    const app = await createApp();
    const http = await app.inject({ method: "GET", url: "/v2/test-rpc-http" });
    expect(http.statusCode).toBe(503);
    expect(http.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "BSC_RPC_UNREACHABLE" },
    });
    const bsc = await app.inject({
      method: "GET",
      url: "/v2/test-bsc-unavailable",
    });
    expect(bsc.statusCode).toBe(503);
    expect(bsc.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "BSC_LOG_RANGE_TOO_WIDE" },
    });
  });

  it("leaves write routes to their own classification", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/test-rpc-timeout",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("logs an INTERNAL_ERROR's name, redacted message, and first frames at error level", async () => {
    const logLines: string[] = [];
    const app = await createApp(logLines);
    const response = await app.inject({
      method: "GET",
      url: "/v2/test-internal",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      detailsSafe: null,
    });
    expect(response.body).not.toContain("boom");

    const entries = logLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const failure = entries.find(
      (entry) => entry["msg"] === "Unhandled error in V2 request",
    );
    expect(failure).toBeDefined();
    expect(failure?.["level"]).toBe(50);
    expect(failure?.["errorName"]).toBe("TypeError");
    expect(failure?.["requestId"]).toBe(
      response.json<{ readonly correlationId: string }>().correlationId,
    );
    const message = failure?.["errorMessage"] as string;
    expect(message).toContain("boom at https://rpc.example.com/[redacted]");
    expect(message).toContain("0x[redacted]");
    expect(message).toContain("Bearer [redacted]");
    const stack = failure?.["errorStack"] as string[];
    expect(stack.length).toBeGreaterThan(0);
    expect(stack.length).toBeLessThanOrEqual(errorLogStackFrameLimit);

    const serialized = logLines.join("");
    expect(serialized).not.toContain(rpcKeyPath);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("user:pw");
    expect(serialized).not.toContain(address);
    expect(serialized).not.toContain("eyJhbGciOi");
  });

  it("logs the cause of a repository-unavailable error without changing the response (S104)", async () => {
    const logLines: string[] = [];
    const app = await createApp(logLines);
    const response = await app.inject({
      method: "GET",
      url: "/v2/test-internal-caused",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      detailsSafe: null,
    });
    expect(response.body).not.toContain("relation failed");
    const failure = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["msg"] === "Unhandled error in V2 request");
    expect(failure?.["errorName"]).toBe(
      "LaunchChainRepositoryUnavailableError",
    );
    expect(failure?.["errorCause"]).toEqual([
      {
        errorName: "RangeError",
        errorMessage: "relation failed at postgres://db.example.com/[redacted]",
      },
    ]);
    expect(logLines.join("")).not.toContain("loop:pw");
  });

  it("does not log a mapped read failure as an internal error", async () => {
    const logLines: string[] = [];
    const app = await createApp(logLines);
    await app.inject({ method: "GET", url: "/v2/test-rpc-timeout" });
    expect(logLines.join("")).not.toContain("Unhandled error in V2 request");
  });
});

describe("error log redaction and transport classification", () => {
  it("keeps the host of a URL and drops its path, query, and userinfo", () => {
    expect(
      redactErrorText("URL: https://k:s@bsc.example.org/abc/def?key=1 done"),
    ).toBe("URL: https://bsc.example.org/[redacted] done");
  });

  it("redacts key/token pairs and long hex payloads, and bounds the length", () => {
    expect(redactErrorText('apiKey="abc" token=xyz')).toBe(
      'apiKey="[redacted]" token=[redacted]',
    );
    expect(redactErrorText(`0x${"ab".repeat(40)}`)).toBe("0x[redacted]");
    expect(redactErrorText("x".repeat(2_000)).length).toBeLessThanOrEqual(601);
  });

  it("summarizes a non-Error value without a message", () => {
    expect(summarizeErrorForLog("plain")).toEqual({
      errorName: "string",
      errorMessage: "",
      errorStack: [],
    });
  });

  it("summarizes the cause chain by name and redacted message only (S104)", () => {
    const root = new TypeError(
      "connect failed https://db.example.com/secret?password=hunter2",
    );
    const middle = new Error("middle", { cause: root });
    const outer = new Error("The Launch chain repository is unavailable", {
      cause: middle,
    });
    const summary = summarizeErrorForLog(outer);
    expect(summary.errorCause).toEqual([
      { errorName: "Error", errorMessage: "middle" },
      {
        errorName: "TypeError",
        errorMessage: "connect failed https://db.example.com/[redacted]",
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain("hunter2");
    expect(summarizeErrorForLog(new Error("no cause"))).not.toHaveProperty(
      "errorCause",
    );
    const looped = new Error("a");
    const other = new Error("b", { cause: looped });
    (looped as { cause?: unknown }).cause = other;
    expect(summarizeErrorForLog(looped).errorCause).toEqual([
      { errorName: "Error", errorMessage: "b" },
    ]);
    expect(
      summarizeErrorForLog(new Error("x", { cause: "text" })).errorCause,
    ).toEqual([{ errorName: "string", errorMessage: "" }]);
  });

  it("recognizes viem transport failures anywhere in the cause chain", () => {
    expect(isBscRpcTransportError(rpcTimeout())).toBe(true);
    expect(
      isBscRpcTransportError(new Error("outer", { cause: rpcTimeout() })),
    ).toBe(true);
    expect(isBscRpcTransportError(new Error("plain"))).toBe(false);
    expect(
      isBscRpcTransportError(
        new BscReadUnavailableError("BSC_RPC_UNREACHABLE"),
      ),
    ).toBe(false);
  });
});
