import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  registerRequestAbortSignal,
  requestAbortDeadlineMilliseconds,
} from "../src/core/http/request-abort-signal.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { createUnavailableCommunityRepository } from "../src/features/community/community-repository.js";
import { createUnavailableCommunicationRepository } from "../src/features/communication/communication-repository.js";
import {
  createUnavailableV2ChatService,
  type V2ChatCommandInput,
  type V2ChatOperationResource,
  type V2ChatService,
} from "../src/features/communication/v2-chat-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetProfileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const operationId = "1d1e6b1a-6c1a-4a9e-9a4d-9f3f2f8c1d55";
const createdAt = "2026-09-08T01:00:00.000Z";
const validToken = "header.payload.signature";

function operationResource(): V2ChatOperationResource {
  return Object.freeze({
    operationId,
    kind: "directGetOrCreate" as const,
    status: "succeeded" as const,
    terminal: true,
    retryAfterMs: null,
    result: Object.freeze({
      targetPublicProfileId: targetProfileId,
      streamCid: `messaging:loop_direct_${targetProfileId.replaceAll("-", "")}`,
    }),
    error: null,
    createdAt,
    updatedAt: createdAt,
    contractVersion: "2.0" as const,
  });
}

function unavailableDatabase(): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    community: createUnavailableCommunityRepository(),
    communication: createUnavailableCommunicationRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: accountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
}

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "communication",
    V2_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    STREAM_TOKEN_QUOTA_HMAC_SECRET: "fedcba9876543210fedcba9876543210",
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  });
}

/**
 * Regression coverage for the request-signal defect found in real Stream
 * integration (S3/S4 BUG-01). It has to run over a real socket: `app.inject()`
 * never emits the `IncomingMessage` `close` event that aborted the framework
 * signal as soon as a request body had been read.
 */
describe("request abort signal over a real socket", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function listen(app: FastifyInstance): Promise<string> {
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return address;
  }

  it("keeps the signal unaborted for a POST that carries a body", async () => {
    const observed: boolean[] = [];
    const chatService: V2ChatService = {
      ...createUnavailableV2ChatService(),
      getOrCreateDirect: (input: V2ChatCommandInput) => {
        observed.push(input.signal.aborted);
        return Promise.resolve(operationResource());
      },
    };
    const app = await buildApp({
      config: testConfig(),
      contractSurface: "v2",
      database: unavailableDatabase(),
      privyAccessTokenVerifier: {
        verifyAccessToken: vi.fn(() =>
          Promise.resolve({ privyUserId: "did:privy:verified-user" }),
        ),
      },
      chatService,
      logger: false,
    });
    const address = await listen(app);

    const response = await fetch(`${address}/v2/chat/direct-channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${validToken}`,
        "content-type": "application/json",
        "idempotency-key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba",
        "x-loop-client-version": "1.2.3",
        "x-loop-contract-version": "2.0",
      },
      body: JSON.stringify({ targetPublicProfileId: targetProfileId }),
    });
    const body = (await response.json()) as { readonly operationId?: string };

    expect(response.status).toBe(200);
    expect(body.operationId).toBe(operationId);
    expect(observed).toEqual([false]);
  });

  it("aborts the signal when the deadline elapses", async () => {
    const app = Fastify({ logger: false });
    registerRequestAbortSignal(app, 200);
    app.post("/deadline", async (request) => {
      const early = request.signal.aborted;
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve();
        });
      });
      return { early, aborted: request.signal.aborted };
    });
    const address = await listen(app);

    const started = Date.now();
    const response = await fetch(`${address}/deadline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1_024) }),
    });
    const body = (await response.json()) as {
      readonly early: boolean;
      readonly aborted: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({ early: false, aborted: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("aborts the signal when the client disconnects before the response", async () => {
    const app = Fastify({ logger: false });
    registerRequestAbortSignal(app, 5_000);
    let resolveAborted: (value: boolean) => void = () => undefined;
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    let resolveEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    app.post("/disconnect", async (request) => {
      resolveEntered();
      request.signal.addEventListener("abort", () => {
        resolveAborted(true);
      });
      await aborted;
      return { ok: true };
    });
    const address = await listen(app);

    const controller = new AbortController();
    const pending = fetch(`${address}/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "y" }),
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    await expect(pending).rejects.toThrow();

    await expect(aborted).resolves.toBe(true);
  });

  it("uses a fifteen second deadline in the application", () => {
    expect(requestAbortDeadlineMilliseconds).toBe(15_000);
  });
});
