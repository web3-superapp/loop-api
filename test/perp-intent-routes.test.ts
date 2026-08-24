import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PerpIntentResource } from "../src/features/perp/perp-intent-contract.js";
import {
  PerpIntentClaimRateLimitedError,
  PerpIntentIdempotencyConflictError,
  PerpIntentNotFoundError,
  PerpIntentStaleError,
  PerpIntentUnavailableError,
  PerpIntentWalletBindingRequiredError,
  PerpMutationDisabledError,
  type PerpIntentService,
} from "../src/features/perp/perp-intent-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerPerpIntentRoutes } from "../src/routes/perp-intents.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:perp-intent-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const intentId = "c1d69ec4-f905-4ed2-bf1a-35cd1a49c306";
const idempotencyKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const validAccessToken = "header.payload.signature";
const clientOrderId = `0x${"ab".repeat(16)}`;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const limitOrder = {
  action: "order",
  coin: "BTC",
  side: "buy",
  order_type: "limit",
  size: "0.01",
  limit_price: "64000.00",
  time_in_force: "gtc",
  reduce_only: false,
} as const;
const resource = Object.freeze({
  intent_id: intentId,
  action: "order",
  state: "prepared",
  review: {
    version: "perp_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    action: { ...limitOrder, client_order_id: clientOrderId },
    source: {
      fetched_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:00:02.000Z",
    },
  },
  expires_at: "2026-08-25T00:00:02.000Z",
  submission: { state: "disabled" },
  result: null,
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
} as const satisfies PerpIntentResource);

function dependencies() {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: ownerUserId }),
  );
  const prepare = vi.fn<PerpIntentService["prepare"]>(() =>
    Promise.resolve(resource),
  );
  const get = vi.fn<PerpIntentService["get"]>(() => Promise.resolve(resource));
  const submit = vi.fn<PerpIntentService["submit"]>(() =>
    Promise.reject(new PerpMutationDisabledError()),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;

  return {
    findByPrivyUserId,
    get,
    internalUsers,
    prepare,
    service: { prepare, get, submit } satisfies PerpIntentService,
    submit,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

async function createApp(input = dependencies()) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    logger: false,
    requestIdHeader: false,
  });
  const auth = registerAuthenticationHooks(
    app,
    createAuthenticationService(input.verifier, input.internalUsers),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
  });
  registerPerpIntentRoutes(app, auth.authenticateLoopBearer, input.service);
  app.setErrorHandler(async (error, request, reply) => {
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const mapped = validation ? ApiError.invalidRequest() : error;

    if (mapped instanceof ApiError) {
      if (mapped.includeBearerChallenge) {
        reply.header("www-authenticate", 'Bearer realm="loop-api"');
      }
      return reply.code(mapped.statusCode).send({
        code: mapped.code,
        message: mapped.safeMessage,
        request_id: request.id,
      });
    }
    return reply.code(500).send({
      code: "internal_error",
      message: "The request failed.",
      request_id: request.id,
    });
  });
  await app.ready();
  return { app, ...input };
}

function authHeaders(extra: Record<string, string | string[]> = {}) {
  return {
    authorization: `Bearer ${validAccessToken}`,
    ...extra,
  };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("Perp intent routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("authenticates and passes one canonical idempotency key into prepare", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/perp/intents",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      payload: limitOrder,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resource);
    expectOperationalHeaders(response);
    expect(inputs.verifyAccessToken).toHaveBeenCalledWith(validAccessToken);
    expect(inputs.findByPrivyUserId).toHaveBeenCalledWith(privyUserId);
    expect(inputs.prepare).toHaveBeenCalledOnce();
    const serviceInput = inputs.prepare.mock.calls[0]?.[0];
    expect(serviceInput).toMatchObject({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      idempotencyKey,
      body: limitOrder,
    });
    expect(serviceInput?.requestId).toMatch(requestIdPattern);
    expect(serviceInput?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["missing", {}],
    ["uppercase", { "idempotency-key": idempotencyKey.toUpperCase() }],
    ["duplicate", { "idempotency-key": [idempotencyKey, idempotencyKey] }],
  ])(
    "rejects a %s idempotency header before authentication",
    async (_name, header) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method: "POST",
        url: "/v1/perp/intents",
        headers: authHeaders(header),
        payload: limitOrder,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "unknown authority",
      { ...limitOrder, accountAddress: `0x${"12".repeat(20)}` },
    ],
    ["numeric size", { ...limitOrder, size: 0.01 }],
    ["forbidden leverage", { ...limitOrder, leverage: "5" }],
    ["mainnet", { ...limitOrder, network: "mainnet" }],
    ["exponent", { ...limitOrder, size: "1e-2" }],
  ])(
    "rejects strict prepare body with %s before authentication",
    async (_name, payload) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method: "POST",
        url: "/v1/perp/intents",
        headers: authHeaders({ "idempotency-key": idempotencyKey }),
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "bounded market slippage",
      {
        action: "order",
        coin: "ETH",
        side: "sell",
        order_type: "market",
        size: "0.2",
        max_slippage_percent: "0.50",
        reduce_only: false,
      },
    ],
    [
      "nonzero isolated margin delta",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "-0.000001",
      },
    ],
    [
      "isolated margin delta with trailing fractional zeroes",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "0.100000",
      },
    ],
    [
      "maximum uint64 order target",
      {
        action: "cancel",
        coin: "BTC",
        target: {
          kind: "order_id",
          order_id: "18446744073709551615",
        },
      },
    ],
  ])("accepts a strict %s request shape", async (_name, payload) => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/perp/intents",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(inputs.prepare).toHaveBeenCalledOnce();
    expect(inputs.prepare.mock.calls[0]?.[0].body).toEqual(payload);
  });

  it.each([
    [
      "slippage over one percent",
      {
        action: "order",
        coin: "ETH",
        side: "buy",
        order_type: "market",
        size: "1",
        max_slippage_percent: "1.01",
        reduce_only: false,
      },
    ],
    [
      "zero margin delta",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "0",
      },
    ],
    [
      "negative zero margin delta",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "-0.000000",
      },
    ],
    [
      "order target above uint64",
      {
        action: "cancel",
        coin: "BTC",
        target: {
          kind: "order_id",
          order_id: "18446744073709551616",
        },
      },
    ],
  ])("rejects %s at the strict HTTP boundary", async (_name, payload) => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/perp/intents",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("returns an owner-only persisted resource from GET", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "GET",
      url: `/v1/perp/intents/${intentId}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resource);
    expect(inputs.get).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      intentId,
    });
    expectOperationalHeaders(response);
  });

  it.each([
    ["GET query", "GET", `/v1/perp/intents/${intentId}?owner=x`, undefined],
    ["GET body", "GET", `/v1/perp/intents/${intentId}`, { owner: "x" }],
    [
      "submit query",
      "POST",
      `/v1/perp/intents/${intentId}/submit?x=1`,
      undefined,
    ],
    ["submit body", "POST", `/v1/perp/intents/${intentId}/submit`, {}],
  ] as const)(
    "rejects %s before auth and service work",
    async (_name, method, url, payload) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method,
        url,
        headers: authHeaders(),
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(400);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.get).not.toHaveBeenCalled();
      expect(inputs.submit).not.toHaveBeenCalled();
    },
  );

  it("maps the default submit kill switch to a stable 403 with no success claim", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "POST",
      url: `/v1/perp/intents/${intentId}/submit`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    const payload = response.json<{ code: string; request_id: string }>();
    expect(payload.code).toBe("perp_mutation_disabled");
    expect(payload.request_id).toMatch(requestIdPattern);
    expectOperationalHeaders(response);
    expect(inputs.submit).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "idempotency conflict",
      "prepare",
      new PerpIntentIdempotencyConflictError(),
      409,
      "idempotency_conflict",
    ],
    [
      "binding required",
      "prepare",
      new PerpIntentWalletBindingRequiredError(),
      409,
      "wallet_binding_required",
    ],
    [
      "pending claim budget exhausted",
      "prepare",
      new PerpIntentClaimRateLimitedError(),
      429,
      "perp_intent_claim_rate_limited",
    ],
    [
      "stale review",
      "prepare",
      new PerpIntentStaleError(),
      409,
      "perp_intent_stale",
    ],
    [
      "review unavailable",
      "prepare",
      new PerpIntentUnavailableError(),
      503,
      "perp_unavailable",
    ],
    [
      "missing intent",
      "get",
      new PerpIntentNotFoundError(),
      404,
      "perp_intent_not_found",
    ],
  ] as const)(
    "maps %s without exposing provider details",
    async (_name, method, error, status, code) => {
      const input = dependencies();
      input[method].mockRejectedValueOnce(error);
      const inputs = await harness(input);
      const response =
        method === "prepare"
          ? await inputs.app.inject({
              method: "POST",
              url: "/v1/perp/intents",
              headers: authHeaders({ "idempotency-key": idempotencyKey }),
              payload: limitOrder,
            })
          : await inputs.app.inject({
              method: "GET",
              url: `/v1/perp/intents/${intentId}`,
              headers: authHeaders(),
            });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(JSON.stringify(response.json())).not.toContain(
        "hyperliquid response",
      );
      expectOperationalHeaders(response);
    },
  );

  it("keeps foreign and missing intent lookups indistinguishable", async () => {
    const input = dependencies();
    input.get.mockRejectedValue(new PerpIntentNotFoundError());
    input.submit.mockRejectedValue(new PerpIntentNotFoundError());
    const inputs = await harness(input);

    for (const [method, url] of [
      ["GET", `/v1/perp/intents/${intentId}`],
      ["POST", `/v1/perp/intents/${intentId}/submit`],
    ] as const) {
      const response = await inputs.app.inject({
        method,
        url,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "perp_intent_not_found" });
    }
  });

  it("does not expose hidden HEAD aliases", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "HEAD",
      url: `/v1/perp/intents/${intentId}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(404);
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.get).not.toHaveBeenCalled();
  });
});
