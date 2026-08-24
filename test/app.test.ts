import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/database/database.js";

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
    expect(document.paths["/health/live"]).toHaveProperty("get.responses.500");
    expect(document.paths["/health/ready"]).toHaveProperty("get.responses.503");
    expect(document.paths).not.toHaveProperty("/openapi.json");
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
