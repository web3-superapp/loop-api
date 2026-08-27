import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type preHandlerAsyncHookHandler,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import type { SpotAgentAuthorizationService } from "../src/features/spot/spot-agent-authorization-service.js";
import { createSpotReview } from "../src/features/spot/spot-intent-contract.js";
import {
  SpotIntentExpiredError,
  type SpotIntentService,
} from "../src/features/spot/spot-intent-service.js";
import type { SpotMarketService } from "../src/features/spot/spot-market-service.js";
import { SpotUnavailableError } from "../src/features/spot/spot-errors.js";
import type { SpotWalletBindingService } from "../src/features/spot/spot-wallet-binding-service.js";
import { registerSpotAgentAuthorizationRoutes } from "../src/routes/spot-agent-authorizations.js";
import { registerSpotIntentRoutes } from "../src/routes/spot-intents.js";
import { registerSpotMarketDataRoutes } from "../src/routes/spot-market-data.js";
import { registerSpotWalletBindingRoutes } from "../src/routes/spot-wallet-binding.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const marketId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const authorizationId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const now = "2026-08-26T00:00:00.000Z";
const expiresAt = "2026-08-26T00:00:15.000Z";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:spot-route-user",
  streamUserId: "loop_11111111111141118111111111111111",
}) satisfies AuthenticatedLoopPrincipal;

function source() {
  return {
    provider: "hyperliquid",
    network: "testnet",
    metadata_version: "meta-v1",
    fetched_at: now,
    expires_at: expiresAt,
  } as const;
}

function intentResource() {
  const review = createSpotReview({
    version: "spot_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market_id: marketId,
    base_display_identity: "PURR",
    quote_display_identity: "USDC",
    side: "buy",
    amount_mode: "quote",
    amount_value: "10",
    computed_base_size: "2",
    reference_price: "5",
    reference_source_time: now,
    worst_ioc_limit_price: "5.01",
    maximum_spend_or_minimum_receive: {
      kind: "maximum_spend",
      asset_display_identity: "USDC",
      value: "10",
    },
    fee_rate: "0.001",
    fee_estimate: "0.01",
    fee_source: { dataset: "user_fees", observed_at: now },
    metadata_version: "meta-v1",
    policy_version: "policy-v1",
    binding_epoch: "7",
    expires_at: expiresAt,
  });
  return {
    intent_id: intentId,
    state: "prepared",
    review,
    submission: { state: "not_started" },
    result: null,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  } as const;
}

function authorizationStatus() {
  return {
    authorization_id: authorizationId,
    state: "prepared",
    binding_epoch: "7",
    signing_state: "required",
    protocol_scope_warning: "hyperliquid_agent_authorization_is_protocol_broad",
    expires_at: expiresAt,
    result: null,
    created_at: now,
    updated_at: now,
  } as const;
}

function approveAgentTypedData() {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421_614,
      verifyingContract: `0x${"0".repeat(40)}`,
    },
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      type: "approveAgent",
      agentAddress: `0x${"11".repeat(20)}`,
      agentName: "loop-spot-agent",
      nonce: "1760000000789",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    },
  } as const;
}

function authorizationCreation() {
  return {
    ...authorizationStatus(),
    signable_payload: {
      format: "privy_eip712_json_v1",
      agent_address: `0x${"11".repeat(20)}`,
      agent_name: "loop-spot-agent",
      nonce: "1760000000789",
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chain_id: 421_614,
        verifying_contract: `0x${"0".repeat(40)}`,
      },
      typed_data: approveAgentTypedData(),
      expires_at: expiresAt,
    },
  } as const;
}

function dependencies() {
  const config = {
    network: "testnet",
    markets: [
      {
        market_id: marketId,
        state: "enabled",
        base_display_identity: "PURR",
        quote_display_identity: "USDC",
        base_size_decimals: 0,
      },
    ],
    capabilities: {
      market_facts: "available",
      balances: "available",
      intent_prepare: "available",
      intent_submit: "unavailable",
      agent_authorization: "available",
    },
    review_policy: {
      execution: "aggressive_limit_ioc",
      default_max_slippage_bps: 25,
      maximum_max_slippage_bps: 100,
      review_ttl_ms: 15_000,
    },
    source: source(),
  } as const;
  const facts = {
    market_id: marketId,
    enabled: true,
    base_display_identity: "PURR",
    quote_display_identity: "USDC",
    base_size_decimals: 0,
    book: {
      best_bid: { price: "4.99", size: "10" },
      best_ask: { price: "5", size: "12" },
      observed_at: now,
    },
    limits: {
      minimum_base_size: { state: "available", value: "1" },
      minimum_quote_notional: { state: "unavailable" },
    },
    source: source(),
  } as const;
  const balances = {
    binding_version: "7",
    account_kind: "master",
    items: [
      {
        asset_id: assetId,
        display_identity: "USDC",
        total: "10",
        available: "8",
        hold: "2",
      },
    ],
    source: source(),
  } as const;
  const binding = {
    state: "bound",
    binding_version: "7",
    account_kind: "master",
    last_verified_at: now,
  } as const;
  const status = authorizationStatus();
  const creation = authorizationCreation();
  const resource = intentResource();
  const marketService = {
    getConfig: vi.fn<SpotMarketService["getConfig"]>(() =>
      Promise.resolve(config),
    ),
    getMarketFacts: vi.fn<SpotMarketService["getMarketFacts"]>(() =>
      Promise.resolve(facts),
    ),
    getBalances: vi.fn<SpotMarketService["getBalances"]>(() =>
      Promise.resolve(balances),
    ),
  } satisfies SpotMarketService;
  const intentService = {
    prepare: vi.fn<SpotIntentService["prepare"]>(() =>
      Promise.resolve(resource),
    ),
    get: vi.fn<SpotIntentService["get"]>(() => Promise.resolve(resource)),
    submit: vi.fn<SpotIntentService["submit"]>(() => Promise.resolve(resource)),
  } satisfies SpotIntentService;
  const walletService = {
    get: vi.fn<SpotWalletBindingService["get"]>(() => Promise.resolve(binding)),
    put: vi.fn<SpotWalletBindingService["put"]>(() => Promise.resolve(binding)),
    delete: vi.fn<SpotWalletBindingService["delete"]>(() =>
      Promise.resolve(binding),
    ),
  } satisfies SpotWalletBindingService;
  const authorizationService = {
    issue: vi.fn<SpotAgentAuthorizationService["issue"]>(() =>
      Promise.resolve(creation),
    ),
    get: vi.fn<SpotAgentAuthorizationService["get"]>(() =>
      Promise.resolve(status),
    ),
    submitSignature: vi.fn<SpotAgentAuthorizationService["submitSignature"]>(
      () => Promise.resolve(status),
    ),
  } satisfies SpotAgentAuthorizationService;
  return {
    authorizationService,
    intentService,
    marketService,
    walletService,
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
  app.decorateRequest("authenticatedLoopPrincipal", null);
  const authenticate = vi.fn<preHandlerAsyncHookHandler>((request) => {
    request.setDecorator("authenticatedLoopPrincipal", principal);
    return Promise.resolve();
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
  });
  registerSpotMarketDataRoutes(app, authenticate, input.marketService);
  registerSpotIntentRoutes(app, authenticate, input.intentService);
  registerSpotWalletBindingRoutes(app, authenticate, input.walletService);
  registerSpotAgentAuthorizationRoutes(
    app,
    authenticate,
    input.authorizationService,
  );
  app.setErrorHandler(async (error, request, reply) => {
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const mapped = validation ? ApiError.invalidRequest() : error;
    if (mapped instanceof ApiError) {
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
  return { app, authenticate, ...input };
}

describe("Spot closed-loop routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("registers all twelve exact routes with 201/200 success semantics", async () => {
    const input = await harness();
    const requests = [
      { method: "GET", url: "/v1/spot/config", expected: 200 },
      {
        method: "GET",
        url: `/v1/spot/markets/${marketId}/facts`,
        expected: 200,
      },
      { method: "GET", url: "/v1/spot/balances", expected: 200 },
      {
        method: "POST",
        url: "/v1/spot/intents",
        expected: 201,
        headers: { "idempotency-key": idempotencyKey },
        payload: {
          market_id: marketId,
          side: "buy",
          amount: { mode: "quote", value: "10" },
        },
      },
      {
        method: "GET",
        url: `/v1/spot/intents/${intentId}`,
        expected: 200,
      },
      {
        method: "POST",
        url: `/v1/spot/intents/${intentId}/submit`,
        expected: 200,
      },
      { method: "GET", url: "/v1/spot/wallet-binding", expected: 200 },
      {
        method: "PUT",
        url: "/v1/spot/wallet-binding",
        expected: 200,
        payload: { expected_binding_version: "7" },
      },
      {
        method: "DELETE",
        url: "/v1/spot/wallet-binding?expected_binding_version=7",
        expected: 200,
      },
      {
        method: "POST",
        url: "/v1/spot/agent-authorizations",
        expected: 201,
      },
      {
        method: "GET",
        url: `/v1/spot/agent-authorizations/${authorizationId}`,
        expected: 200,
      },
      {
        method: "POST",
        url: `/v1/spot/agent-authorizations/${authorizationId}/signatures`,
        expected: 200,
        payload: { signature: "0xopaque" },
      },
    ] as const;

    for (const request of requests) {
      const response = await input.app.inject({
        method: request.method,
        url: request.url,
        ...("headers" in request ? { headers: request.headers } : {}),
        ...("payload" in request ? { payload: request.payload } : {}),
      });
      expect(
        response.statusCode,
        `${request.method} ${request.url}: ${response.body}; auth=${input.authenticate.mock.calls.length}; delete=${input.walletService.delete.mock.calls.length}`,
      ).toBe(request.expected);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(input.authenticate).toHaveBeenCalledTimes(12);
    expect(input.authorizationService.issue).toHaveBeenCalledOnce();
    expect(input.authorizationService.get).toHaveBeenCalledOnce();
    expect(input.authorizationService.submitSignature).toHaveBeenCalledOnce();
  });

  it("never returns the one-time Agent payload from status GET", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: `/v1/spot/agent-authorizations/${authorizationId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(
      /signable_payload|typed_data|agent_address|nonce|0x111111/,
    );
  });

  it("returns the exact four-field approveAgent EIP-712 domain contract", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "POST",
      url: "/v1/spot/agent-authorizations",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      signable_payload: {
        typed_data: {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
          },
        },
      },
    });
  });

  it("rejects impossible Spot response-state combinations at serialization", async () => {
    const invalidIntentDependencies = dependencies();
    invalidIntentDependencies.intentService.get.mockResolvedValueOnce({
      ...intentResource(),
      state: "rejected",
      submission: { state: "attempted" },
      result: {
        state: "unknown",
        order_id: null,
        filled_base_size: null,
        average_fill_price: null,
        quote_amount: null,
        fee: null,
        fee_asset_display_identity: null,
        observed_at: now,
        reason_code: "provider_outcome_unresolved",
      },
    } as never);
    const invalidIntent = await harness(invalidIntentDependencies);

    const invalidAuthorizationDependencies = dependencies();
    invalidAuthorizationDependencies.authorizationService.get.mockResolvedValueOnce(
      {
        ...authorizationStatus(),
        state: "active",
        signing_state: "consumed",
        result: {
          state: "rejected",
          observed_at: now,
          reason_code: "provider_rejected",
        },
      } as never,
    );
    const invalidAuthorization = await harness(
      invalidAuthorizationDependencies,
    );

    const invalidCreationDependencies = dependencies();
    invalidCreationDependencies.authorizationService.issue.mockResolvedValueOnce(
      {
        ...authorizationCreation(),
        state: "submitting",
        signing_state: "consumed",
      } as never,
    );
    const invalidCreation = await harness(invalidCreationDependencies);

    const invalidBindingDependencies = dependencies();
    invalidBindingDependencies.walletService.get.mockResolvedValueOnce({
      state: "unbound",
      binding_version: "7",
      account_kind: "master",
      last_verified_at: now,
    } as never);
    const invalidBinding = await harness(invalidBindingDependencies);

    const responses = await Promise.all([
      invalidIntent.app.inject({
        method: "GET",
        url: `/v1/spot/intents/${intentId}`,
      }),
      invalidAuthorization.app.inject({
        method: "GET",
        url: `/v1/spot/agent-authorizations/${authorizationId}`,
      }),
      invalidCreation.app.inject({
        method: "POST",
        url: "/v1/spot/agent-authorizations",
      }),
      invalidBinding.app.inject({
        method: "GET",
        url: "/v1/spot/wallet-binding",
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects client authority before authentication", async () => {
    const input = await harness();
    const invalidRequests = [
      {
        method: "POST",
        url: "/v1/spot/intents",
        headers: { "idempotency-key": idempotencyKey },
        payload: {
          market_id: marketId,
          side: "buy",
          amount: { mode: "base", value: "10" },
        },
      },
      {
        method: "POST",
        url: "/v1/spot/agent-authorizations",
        payload: { agent_address: `0x${"11".repeat(20)}` },
      },
      {
        method: "GET",
        url: "/v1/spot/config",
        headers: { "idempotency-key": idempotencyKey },
      },
      {
        method: "DELETE",
        url: "/v1/spot/wallet-binding?expected_binding_version=7&expected_binding_version=7",
      },
    ] as const;

    for (const request of invalidRequests) {
      const response = await input.app.inject({
        method: request.method,
        url: request.url,
        ...("headers" in request ? { headers: request.headers } : {}),
        ...("payload" in request ? { payload: request.payload } : {}),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(input.authenticate).not.toHaveBeenCalled();
    expect(input.intentService.prepare).not.toHaveBeenCalled();
    expect(input.authorizationService.issue).not.toHaveBeenCalled();
  });

  it("maps unavailable adapters truthfully without borrowing Perp errors", async () => {
    const dependenciesWithFailure = dependencies();
    dependenciesWithFailure.marketService.getConfig.mockRejectedValueOnce(
      new SpotUnavailableError(),
    );
    const input = await harness(dependenciesWithFailure);
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/spot/config",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "spot_unavailable" });
    expect(response.body).not.toContain("perp_unavailable");
  });

  it("publishes and maps a prepare-time expiry race", async () => {
    const dependenciesWithExpiry = dependencies();
    dependenciesWithExpiry.intentService.prepare.mockRejectedValueOnce(
      new SpotIntentExpiredError(),
    );
    const input = await harness(dependenciesWithExpiry);

    const response = await input.app.inject({
      method: "POST",
      url: "/v1/spot/intents",
      headers: { "idempotency-key": idempotencyKey },
      payload: {
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "10" },
        max_slippage_bps: 25,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "spot_intent_expired" });
  });
});
