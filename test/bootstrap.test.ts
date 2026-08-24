import { createConnection } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/database/database.js";
import {
  InvalidAccessTokenError,
  type PrivyAccessTokenVerifier,
} from "../src/integrations/privy/access-token-verifier.js";

const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const validToken = "header.payload.signature";

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "true",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  });
}

function fakes() {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const getOrCreateByPrivyUserId = vi.fn(() =>
    Promise.resolve({ id: loopUserId }),
  );
  const findByPrivyUserId = vi.fn(() => Promise.resolve({ id: loopUserId }));
  const database = {
    internalUsers: { findByPrivyUserId, getOrCreateByPrivyUserId },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken,
  } satisfies PrivyAccessTokenVerifier;

  return {
    database,
    findByPrivyUserId,
    getOrCreateByPrivyUserId,
    privyAccessTokenVerifier,
    verifyAccessToken,
  };
}

describe("POST /v1/bootstrap", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(overrides = fakes()) {
    const app = await buildApp({
      config: testConfig(),
      database: overrides.database,
      privyAccessTokenVerifier: overrides.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    return { app, ...overrides };
  }

  it("requires authentication without calling the verifier or database", async () => {
    const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
      await createApp();

    const response = await app.inject({ method: "POST", url: "/v1/bootstrap" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      message: "Authentication is required.",
    });
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it.each([
    "Bearer",
    "Basic abc",
    "Bearer token with spaces",
    `Bearer ${"x".repeat(8_193)}`,
  ])(
    "rejects malformed authorization %s before persistence",
    async (authorization) => {
      const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
        await createApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/bootstrap",
        headers: { authorization },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "invalid_access_token" });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, undefined],
    [{ user_id: loopUserId }, undefined],
    ["null", "application/json"],
    ["false", "application/json"],
    ["0", "application/json"],
  ] as const)(
    "rejects request body %# before authentication",
    async (payload, contentType) => {
      const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
        await createApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/bootstrap",
        headers: {
          authorization: `Bearer ${validToken}`,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate raw Authorization header lines", async () => {
    const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
      await createApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let response = "";

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.end(
          [
            "POST /v1/bootstrap HTTP/1.1",
            "Host: 127.0.0.1",
            `Authorization: Bearer ${validToken}`,
            `authorization: Bearer ${validToken}`,
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", (chunk: string) => {
        response += chunk;
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });

    expect(rawResponse).toMatch(/^HTTP\/1\.1 401 /);
    expect(rawResponse).toContain("invalid_access_token");
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it("rejects query input before authentication", async () => {
    const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
      await createApp();

    const response = await app.inject({
      method: "POST",
      url: `/v1/bootstrap?user_id=${loopUserId}`,
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported media type", "application/octet-stream", "x"],
    ["oversized body", "text/plain", "x".repeat(1_048_577)],
  ])(
    "normalizes a %s rejection to the 400 contract",
    async (_name, contentType, payload) => {
      const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
        await createApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/bootstrap",
        headers: {
          authorization: `Bearer ${validToken}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Privy verification is not configured", async () => {
    const dependencies = fakes();
    const app = await buildApp({
      config: testConfig(),
      database: dependencies.database,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "authentication_unavailable",
    });
    expect(dependencies.getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it("maps invalid provider tokens to a sanitized 401", async () => {
    const dependencies = fakes();
    dependencies.verifyAccessToken.mockRejectedValueOnce(
      new InvalidAccessTokenError(),
    );
    const { app, getOrCreateByPrivyUserId } = await createApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(validToken);
    expect(response.body).not.toContain("did:privy");
    expect(response.json()).toMatchObject({ code: "invalid_access_token" });
    expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected verifier failures without persistence", async () => {
    const dependencies = fakes();
    dependencies.verifyAccessToken.mockRejectedValueOnce(
      new Error("provider-secret-from-unexpected-error"),
    );
    const { app, getOrCreateByPrivyUserId } = await createApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("provider-secret");
    expect(response.json()).toMatchObject({ code: "internal_error" });
    expect(getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it("returns only the server-derived LOOP and Stream IDs", async () => {
    const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
      await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: loopUserId },
      stream_user_id: streamUserId,
    });
    expect(response.body).not.toContain("did:privy");
    expect(response.body).not.toContain("session");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(verifyAccessToken).toHaveBeenCalledWith(validToken);
    expect(getOrCreateByPrivyUserId).toHaveBeenCalledWith(
      "did:privy:verified-user",
    );
  });

  it("returns the same UUID on repeated bootstrap calls", async () => {
    const { app, verifyAccessToken, getOrCreateByPrivyUserId } =
      await createApp();
    const request = {
      method: "POST" as const,
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.json()).toEqual(second.json());
    expect(verifyAccessToken).toHaveBeenCalledTimes(2);
    expect(getOrCreateByPrivyUserId).toHaveBeenCalledTimes(2);
  });

  it("sanitizes repository failures", async () => {
    const dependencies = fakes();
    dependencies.getOrCreateByPrivyUserId.mockRejectedValueOnce(
      new Error("postgres://user:secret@example.test/private did:privy:hidden"),
    );
    const { app } = await createApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("did:privy");
    expect(response.json()).toMatchObject({ code: "internal_error" });
  });

  it("publishes the Bearer-protected no-body OpenAPI contract", async () => {
    const { app } = await createApp();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json<{
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, { post: Record<string, unknown> }>;
    }>();
    const operation = document.paths["/v1/bootstrap"]?.post;

    expect(response.statusCode).toBe(200);
    expect(document.components.securitySchemes).toHaveProperty("privyBearer");
    expect(operation).toMatchObject({
      operationId: "bootstrapCurrentUser",
      security: [{ privyBearer: [] }],
    });
    expect(operation).not.toHaveProperty("requestBody");
    expect(operation).toHaveProperty("responses.200");
    expect(operation).toHaveProperty("responses.400");
    expect(operation).toHaveProperty("responses.401");
    expect(operation).toHaveProperty("responses.503");
    expect(operation).toHaveProperty("responses.500");
    expect(operation).toHaveProperty(
      "responses.200.content.application/json.schema.properties.stream_user_id.pattern",
      "^loop_[a-z0-9_-]{8,58}$",
    );
    expect(operation).toHaveProperty(
      "responses.401.content.application/json.schema.properties.code.enum",
      ["authentication_required", "invalid_access_token"],
    );
    expect(operation).toHaveProperty(
      "responses.200.headers.cache-control.schema.const",
      "no-store",
    );
    expect(operation).toHaveProperty(
      "responses.401.headers.www-authenticate.schema.const",
      'Bearer realm="loop-api"',
    );
  });
});
