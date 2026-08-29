import { createHmac } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import {
  createUnavailableControlPlaneRepository,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { STREAM_TOKEN_CAPABILITIES } from "../src/features/communication/stream-token-service.js";
import {
  StreamTokenIssuerUnavailableError,
  type StreamTokenIssuer,
  type StreamTokenProduct,
} from "../src/integrations/stream/token-issuer.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const privyUserId = "did:privy:verified-user";
const validToken = "header.payload.signature";
const streamApiKey = "stream_public_key";
const configuredStreamApiKey = "configured_stream_key";
const configuredStreamApiSecret = "configured_stream_secret";
const quotaHmacSecret = "stream-token-route-test-hmac-secret-2026";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function providerToken(product: StreamTokenProduct): string {
  return `${product}_${"t".repeat(60)}`;
}

function testConfig(
  options: {
    readonly quotaEnabled?: boolean;
    readonly streamConfigured?: boolean;
    readonly trustProxy?: boolean;
  } = {},
) {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    API_DOCS_ENABLED: "true",
    TRUST_PROXY: options.trustProxy === true ? "true" : "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...(options.quotaEnabled === false
      ? {}
      : { STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaHmacSecret }),
    ...(options.streamConfigured === true
      ? {
          STREAM_API_KEY: configuredStreamApiKey,
          STREAM_API_SECRET: configuredStreamApiSecret,
        }
      : {}),
  });
}

function decodeStreamToken(token: string): {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
} {
  const segments = token.split(".");
  expect(segments).toHaveLength(3);
  const [encodedHeader, encodedPayload, signature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    signature === undefined
  ) {
    throw new Error("Expected a three-segment Stream JWT");
  }

  expect(signature).toBe(
    createHmac("sha256", configuredStreamApiSecret)
      .update(`${encodedHeader}.${encodedPayload}`, "utf8")
      .digest("base64url"),
  );

  return {
    header: JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
    payload: JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
  };
}

function expectedSubjectHmac(
  capability: string,
  subjectKind: "user" | "ip",
  subject: string,
): string {
  return createHmac("sha256", quotaHmacSecret)
    .update("loop.stream-token-quota\0v1", "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update("\0", "utf8")
    .update("stream_token_v1", "utf8")
    .update("\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function dependencies() {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<
    Database["internalUsers"]["findByPrivyUserId"]
  >(() => Promise.resolve({ id: loopUserId }));
  const getOrCreateByPrivyUserId = vi.fn<
    Database["internalUsers"]["getOrCreateByPrivyUserId"]
  >(() => Promise.resolve({ id: loopUserId }));
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  const issueToken = vi.fn<StreamTokenIssuer["issueToken"]>((input) =>
    Promise.resolve({
      apiKey: streamApiKey,
      token: providerToken(input.product),
    }),
  );
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: {
      ...createUnavailableControlPlaneRepository(),
      consumeIssuanceQuota,
    },
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: { findByPrivyUserId, getOrCreateByPrivyUserId },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken,
  } satisfies PrivyAccessTokenVerifier;
  const streamTokenIssuer = { issueToken } satisfies StreamTokenIssuer;

  return {
    consumeIssuanceQuota,
    database,
    findByPrivyUserId,
    getOrCreateByPrivyUserId,
    issueToken,
    privyAccessTokenVerifier,
    streamTokenIssuer,
    verifyAccessToken,
  };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

function expectErrorRequestId(response: {
  json<T>(): T;
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  const payload = response.json<{ request_id: string }>();
  expect(response.headers["x-request-id"]).toBe(payload.request_id);
  expect(payload.request_id).toMatch(requestIdPattern);
}

function quotaBucket(
  input: Parameters<ControlPlaneRepository["consumeIssuanceQuota"]>[0],
  subjectKind: "user" | "ip",
) {
  const bucket = input.buckets.find(
    (candidate) => candidate.subjectKind === subjectKind,
  );
  expect(bucket).toBeDefined();
  return bucket!;
}

describe("Stream token routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    inputs = dependencies(),
    configOptions: Parameters<typeof testConfig>[0] = {},
  ) {
    const app = await buildApp({
      config: testConfig(configOptions),
      database: inputs.database,
      privyAccessTokenVerifier: inputs.privyAccessTokenVerifier,
      streamTokenIssuer: inputs.streamTokenIssuer,
      logger: false,
    });
    apps.push(app);
    return { app, ...inputs };
  }

  it("authenticates every Chat and Video request and returns only the exact one-hour token contract", async () => {
    const inputs = await createApp();

    const chat = await inputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
      remoteAddress: "198.51.100.24",
    });
    const video = await inputs.app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: { authorization: `Bearer ${validToken}` },
      remoteAddress: "198.51.100.24",
    });

    expect(chat.statusCode).toBe(200);
    expect(video.statusCode).toBe(200);
    const chatIssuerInput = inputs.issueToken.mock.calls[0]?.[0];
    const videoIssuerInput = inputs.issueToken.mock.calls[1]?.[0];
    expect(chatIssuerInput).toBeDefined();
    expect(videoIssuerInput).toBeDefined();
    if (chatIssuerInput === undefined || videoIssuerInput === undefined) {
      throw new Error("Expected both Stream token issuer calls");
    }
    expect(chat.json()).toEqual({
      api_key: streamApiKey,
      token: providerToken("chat"),
      expires_at: new Date(
        chatIssuerInput.expiresAtEpochSeconds * 1_000,
      ).toISOString(),
      user: { id: streamUserId },
    });
    expect(video.json()).toEqual({
      api_key: streamApiKey,
      token: providerToken("video"),
      expires_at: new Date(
        videoIssuerInput.expiresAtEpochSeconds * 1_000,
      ).toISOString(),
      user: { id: streamUserId },
    });
    expect(Object.keys(chat.json<object>()).sort()).toEqual([
      "api_key",
      "expires_at",
      "token",
      "user",
    ]);
    expect(Object.keys(video.json<object>()).sort()).toEqual([
      "api_key",
      "expires_at",
      "token",
      "user",
    ]);
    expectOperationalHeaders(chat);
    expectOperationalHeaders(video);

    expect(inputs.verifyAccessToken).toHaveBeenCalledTimes(2);
    expect(inputs.verifyAccessToken).toHaveBeenNthCalledWith(1, validToken);
    expect(inputs.verifyAccessToken).toHaveBeenNthCalledWith(2, validToken);
    expect(inputs.findByPrivyUserId).toHaveBeenCalledTimes(2);
    expect(inputs.findByPrivyUserId).toHaveBeenNthCalledWith(1, privyUserId);
    expect(inputs.findByPrivyUserId).toHaveBeenNthCalledWith(2, privyUserId);
    expect(inputs.issueToken).toHaveBeenCalledTimes(2);

    for (const [issuerInput, product, response] of [
      [chatIssuerInput, "chat", chat],
      [videoIssuerInput, "video", video],
    ] as const) {
      expect(issuerInput).toMatchObject({ product, streamUserId });
      expect(Object.keys(issuerInput).sort()).toEqual([
        "expiresAtEpochSeconds",
        "issuedAtEpochSeconds",
        "product",
        "signal",
        "streamUserId",
      ]);
      expect(issuerInput.issuedAtEpochSeconds).toEqual(expect.any(Number));
      expect(
        issuerInput.expiresAtEpochSeconds - issuerInput.issuedAtEpochSeconds,
      ).toBe(3_600);
      expect(issuerInput.signal).toBeInstanceOf(AbortSignal);

      expect(response.json<{ expires_at: string }>().expires_at).toBe(
        new Date(issuerInput.expiresAtEpochSeconds * 1_000).toISOString(),
      );
    }
  });

  it.each([
    ["Chat body", "/v1/chat/token", "/v1/chat/token", { product: "video" }],
    [
      "Chat query",
      "/v1/chat/token",
      "/v1/chat/token?user_id=forged",
      undefined,
    ],
    [
      "Video body",
      "/v1/video/token",
      "/v1/video/token",
      { stream_user_id: streamUserId },
    ],
    ["Video query", "/v1/video/token", "/v1/video/token?ttl=999999", undefined],
  ] as const)(
    "rejects %s before authentication or protected work",
    async (_name, _path, url, payload) => {
      const inputs = await createApp();
      const response = await inputs.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${validToken}` },
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
      expectErrorRequestId(response);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
      expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
      expect(inputs.issueToken).not.toHaveBeenCalled();
    },
  );

  it.each(["chat", "video"] as const)(
    "requires one Privy Bearer token for every %s request",
    async (product) => {
      const inputs = await createApp();
      const response = await inputs.app.inject({
        method: "POST",
        url: `/v1/${product}/token`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "authentication_required",
        message: "Authentication is required.",
      });
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="loop-api"',
      );
      expectOperationalHeaders(response);
      expectErrorRequestId(response);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
      expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
      expect(inputs.issueToken).not.toHaveBeenCalled();
    },
  );

  it("requires bootstrap after verifying the current token", async () => {
    const inputs = dependencies();
    inputs.findByPrivyUserId.mockResolvedValueOnce(null);
    const appInputs = await createApp(inputs);

    const response = await appInputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "bootstrap_required",
      message: "Bootstrap is required.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.verifyAccessToken).toHaveBeenCalledOnce();
    expect(inputs.findByPrivyUserId).toHaveBeenCalledOnce();
    expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when persistent quota configuration is absent", async () => {
    const inputs = dependencies();
    const app = await buildApp({
      config: testConfig({ quotaEnabled: false, streamConfigured: true }),
      database: inputs.database,
      privyAccessTokenVerifier: inputs.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "stream_unavailable",
      message: "Stream token issuance is unavailable.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.verifyAccessToken).toHaveBeenCalledOnce();
    expect(inputs.findByPrivyUserId).toHaveBeenCalledOnce();
    expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("fails closed after reserving quota when Stream credentials are absent", async () => {
    const inputs = dependencies();
    const app = await buildApp({
      config: testConfig(),
      database: inputs.database,
      privyAccessTokenVerifier: inputs.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "stream_unavailable",
      message: "Stream token issuance is unavailable.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("maps quota exhaustion to 429 without calling the issuer", async () => {
    const dependenciesWithExhaustedQuota = dependencies();
    dependenciesWithExhaustedQuota.consumeIssuanceQuota.mockRejectedValueOnce(
      new IssuanceQuotaExceededError(),
    );
    const inputs = await createApp(dependenciesWithExhaustedQuota);

    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "rate_limit_exceeded",
      message: "The token issuance rate limit was exceeded.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("maps an unavailable issuer to a sanitized 503 after reserving quota", async () => {
    const unavailableDependencies = dependencies();
    unavailableDependencies.issueToken.mockRejectedValueOnce(
      new StreamTokenIssuerUnavailableError(),
    );
    const inputs = await createApp(unavailableDependencies);

    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "stream_unavailable",
      message: "Stream token issuance is unavailable.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).toHaveBeenCalledOnce();
  });

  it("composes the official issuer when Stream credentials and quota are complete", async () => {
    const inputs = dependencies();
    const app = await buildApp({
      config: testConfig({ streamConfigured: true }),
      database: inputs.database,
      privyAccessTokenVerifier: inputs.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly api_key: string;
      readonly expires_at: string;
      readonly token: string;
      readonly user: { readonly id: string };
    }>();
    expect(body.api_key).toBe(configuredStreamApiKey);
    expect(body.user).toEqual({ id: streamUserId });
    expect(Object.keys(body).sort()).toEqual([
      "api_key",
      "expires_at",
      "token",
      "user",
    ]);

    const decoded = decodeStreamToken(body.token);
    expect(decoded.header).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(Object.keys(decoded.payload).sort()).toEqual([
      "exp",
      "iat",
      "user_id",
    ]);
    expect(decoded.payload["user_id"]).toBe(streamUserId);
    const issuedAt = decoded.payload["iat"];
    const expiresAt = decoded.payload["exp"];
    expect(issuedAt).toEqual(expect.any(Number));
    expect(expiresAt).toEqual(expect.any(Number));
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number") {
      throw new Error("Expected numeric Stream token timestamps");
    }
    expect(expiresAt - issuedAt).toBe(3_600);
    expect(body.expires_at).toBe(new Date(expiresAt * 1_000).toISOString());
    expectOperationalHeaders(response);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("maps an unexpected issuer error to a sanitized 500", async () => {
    const logLines: string[] = [];
    const failingDependencies = dependencies();
    failingDependencies.issueToken.mockRejectedValueOnce(
      new Error("stream-provider-secret-and-token-response"),
    );
    const app = await buildApp({
      config: testConfig(),
      database: failingDependencies.database,
      privyAccessTokenVerifier: failingDependencies.privyAccessTokenVerifier,
      streamTokenIssuer: failingDependencies.streamTokenIssuer,
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
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("stream-provider-secret");
    expect(response.body).not.toContain("token-response");
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "The request could not be completed.",
    });
    expectOperationalHeaders(response);
    expectErrorRequestId(response);
    expect(logLines.join("\n")).not.toContain("stream-provider-secret");
    expect(logLines.join("\n")).not.toContain("token-response");
    expect(failingDependencies.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(failingDependencies.issueToken).toHaveBeenCalledOnce();
  });

  it("uses separate Chat and Video capabilities with HMAC-only user and IP subjects", async () => {
    const inputs = await createApp();
    const clientIp = "198.51.100.42";

    await inputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: { authorization: `Bearer ${validToken}` },
      remoteAddress: clientIp,
    });
    await inputs.app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: { authorization: `Bearer ${validToken}` },
      remoteAddress: clientIp,
    });

    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledTimes(2);
    const chatInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    const videoInput = inputs.consumeIssuanceQuota.mock.calls[1]?.[0];
    expect(chatInput).toBeDefined();
    expect(videoInput).toBeDefined();
    expect(chatInput?.capability).toBe(STREAM_TOKEN_CAPABILITIES.chat);
    expect(videoInput?.capability).toBe(STREAM_TOKEN_CAPABILITIES.video);
    expect(chatInput?.capability).not.toBe(videoInput?.capability);

    for (const input of [chatInput!, videoInput!]) {
      expect(input.policyVersion).toBe("stream_token_v1");
      expect(input.buckets).toHaveLength(2);
      expect(input.buckets.map((bucket) => bucket.subjectKind)).toEqual([
        "user",
        "ip",
      ]);
      expect(JSON.stringify(input)).not.toContain(loopUserId);
      expect(JSON.stringify(input)).not.toContain(streamUserId);
      expect(JSON.stringify(input)).not.toContain(clientIp);
      expect(JSON.stringify(input)).not.toContain(privyUserId);
      expect(
        input.buckets.every((bucket) =>
          /^[0-9a-f]{64}$/.test(bucket.subjectHmac),
        ),
      ).toBe(true);
    }

    expect(quotaBucket(chatInput!, "user").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "user", loopUserId),
    );
    expect(quotaBucket(chatInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "ip", clientIp),
    );
    expect(quotaBucket(videoInput!, "user").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.video, "user", loopUserId),
    );
    expect(quotaBucket(videoInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.video, "ip", clientIp),
    );
    expect(quotaBucket(chatInput!, "user").subjectHmac).not.toBe(
      quotaBucket(videoInput!, "user").subjectHmac,
    );
    expect(quotaBucket(chatInput!, "ip").subjectHmac).not.toBe(
      quotaBucket(videoInput!, "ip").subjectHmac,
    );
  });

  it("ignores forged forwarding headers when proxy trust is disabled", async () => {
    const inputs = await createApp();
    const directClientIp = "192.0.2.80";
    const forgedClientIp = "203.0.113.250";

    await inputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: {
        authorization: `Bearer ${validToken}`,
        "x-forwarded-for": forgedClientIp,
      },
      remoteAddress: directClientIp,
    });

    const quotaInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    expect(quotaInput).toBeDefined();
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "ip", directClientIp),
    );
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).not.toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "ip", forgedClientIp),
    );
  });

  it("trusts only the local cloudflared hop and rejects a forged leftmost forwarding value", async () => {
    const inputs = await createApp(dependencies(), { trustProxy: true });
    const forgedLeftmostIp = "203.0.113.250";
    const nearestUntrustedClientIp = "198.51.100.40";

    await inputs.app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: {
        authorization: `Bearer ${validToken}`,
        "x-forwarded-for": `${forgedLeftmostIp}, ${nearestUntrustedClientIp}`,
      },
      remoteAddress: "127.0.0.1",
    });

    const quotaInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    expect(quotaInput).toBeDefined();
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(
        STREAM_TOKEN_CAPABILITIES.video,
        "ip",
        nearestUntrustedClientIp,
      ),
    );
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).not.toBe(
      expectedSubjectHmac(
        STREAM_TOKEN_CAPABILITIES.video,
        "ip",
        forgedLeftmostIp,
      ),
    );
  });

  it("does not trust forwarding headers from a non-local direct peer", async () => {
    const inputs = await createApp(dependencies(), { trustProxy: true });
    const directClientIp = "192.0.2.81";
    const forgedClientIp = "203.0.113.251";

    await inputs.app.inject({
      method: "POST",
      url: "/v1/chat/token",
      headers: {
        authorization: `Bearer ${validToken}`,
        "x-forwarded-for": forgedClientIp,
      },
      remoteAddress: directClientIp,
    });

    const quotaInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    expect(quotaInput).toBeDefined();
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "ip", directClientIp),
    );
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).not.toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "ip", forgedClientIp),
    );
  });

  it("does not treat CF-Connecting-IP as an independent trust source", async () => {
    const inputs = await createApp(dependencies(), { trustProxy: true });
    const cloudflareHeaderIp = "203.0.113.252";

    await inputs.app.inject({
      method: "POST",
      url: "/v1/video/token",
      headers: {
        authorization: `Bearer ${validToken}`,
        "cf-connecting-ip": cloudflareHeaderIp,
      },
      remoteAddress: "127.0.0.1",
    });

    const quotaInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    expect(quotaInput).toBeDefined();
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.video, "ip", "127.0.0.1"),
    );
    expect(quotaBucket(quotaInput!, "ip").subjectHmac).not.toBe(
      expectedSubjectHmac(
        STREAM_TOKEN_CAPABILITIES.video,
        "ip",
        cloudflareHeaderIp,
      ),
    );
  });
});
