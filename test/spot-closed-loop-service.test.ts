import { describe, expect, it, vi } from "vitest";

import {
  createSpotAgentAuthorizationService,
  type SpotAgentAuthorizationWorkflow,
} from "../src/features/spot/spot-agent-authorization-service.js";
import { createSpotReview } from "../src/features/spot/spot-intent-contract.js";
import {
  createSpotIntentService,
  type SpotIntentWorkflow,
} from "../src/features/spot/spot-intent-service.js";
import {
  createSpotMarketService,
  type SpotMarketReader,
} from "../src/features/spot/spot-market-service.js";
import { SpotUnavailableError } from "../src/features/spot/spot-errors.js";
import {
  createSpotWalletBindingService,
  type SpotWalletBindingLifecycle,
} from "../src/features/spot/spot-wallet-binding-service.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const marketId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const authorizationId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "66666666-6666-4666-8666-666666666666";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:spot-user",
  streamUserId: "loop_11111111111141118111111111111111",
});
const now = "2026-08-26T00:00:00.000Z";
const expiresAt = "2026-08-26T00:00:15.000Z";

function review() {
  return createSpotReview({
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
      agentName: "loop-agent",
      nonce: "1",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    },
  } as const;
}

function intentResource() {
  return {
    intent_id: intentId,
    state: "prepared",
    review: review(),
    submission: { state: "not_started" },
    result: null,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  } as const;
}

describe("Spot closed-loop services", () => {
  it("gives every market read a fresh provider request UUID", async () => {
    const ids = [
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ];
    const readConfig = vi.fn<SpotMarketReader["readConfig"]>(() =>
      Promise.resolve({
        network: "testnet",
        markets: [],
        capabilities: {
          market_facts: "unavailable",
          balances: "unavailable",
          intent_prepare: "unavailable",
          intent_submit: "unavailable",
          agent_authorization: "unavailable",
        },
        review_policy: {
          execution: "aggressive_limit_ioc",
          default_max_slippage_bps: 25,
          maximum_max_slippage_bps: 100,
          review_ttl_ms: 15_000,
        },
        source: {
          provider: "hyperliquid",
          network: "testnet",
          metadata_version: "meta-v1",
          fetched_at: now,
          expires_at: expiresAt,
        },
      }),
    );
    const reader = {
      readConfig,
      readMarketFacts: vi.fn<SpotMarketReader["readMarketFacts"]>(),
      readBalances: vi.fn<SpotMarketReader["readBalances"]>(),
    } satisfies SpotMarketReader;
    const service = createSpotMarketService({
      reader,
      createUuid: () => ids.shift() ?? "invalid",
      now: () => new Date("2026-08-26T00:00:05.000Z"),
    });
    const input = { principal, signal: new AbortController().signal };

    await service.getConfig(input);
    await service.getConfig(input);

    expect(
      readConfig.mock.calls.map(([call]) => call.providerRequestId),
    ).toEqual([
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ]);
    expect(readConfig.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId,
      privyUserId: principal.privyUserId,
    });
  });

  it("passes only canonical request authority into the Spot workflow", async () => {
    const prepare = vi.fn<SpotIntentWorkflow["prepare"]>(() =>
      Promise.resolve(intentResource()),
    );
    const workflow = {
      prepare,
      findOwned: vi.fn<SpotIntentWorkflow["findOwned"]>(() =>
        Promise.resolve(intentResource()),
      ),
      submit: vi.fn<SpotIntentWorkflow["submit"]>(() =>
        Promise.resolve(intentResource()),
      ),
    } satisfies SpotIntentWorkflow;
    const service = createSpotIntentService(workflow);
    const body = {
      market_id: marketId,
      side: "buy",
      amount: { mode: "quote", value: "10" },
    };

    await service.prepare({
      principal,
      idempotencyKey,
      requestId,
      body,
      signal: new AbortController().signal,
    });

    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId,
      idempotencyKey,
      requestId,
      request: body,
    });
    expect(prepare.mock.calls[0]?.[0].requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepare.mock.calls[0]?.[0].canonicalRequest).not.toContain(
      "account",
    );
  });

  it("refuses to expose a one-time Agent payload through GET", async () => {
    const base = {
      authorization_id: authorizationId,
      state: "prepared",
      binding_epoch: "7",
      signing_state: "required",
      protocol_scope_warning:
        "hyperliquid_agent_authorization_is_protocol_broad",
      expires_at: expiresAt,
      result: null,
      created_at: now,
      updated_at: now,
    } as const;
    const creation = {
      ...base,
      signable_payload: {
        format: "privy_eip712_json_v1",
        agent_address: `0x${"11".repeat(20)}`,
        agent_name: "loop-agent",
        nonce: "1",
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
    const workflow = {
      issue: vi.fn<SpotAgentAuthorizationWorkflow["issue"]>(() =>
        Promise.resolve(creation),
      ),
      findOwned: vi.fn<SpotAgentAuthorizationWorkflow["findOwned"]>(() =>
        Promise.resolve(creation),
      ),
      submitSignature: vi.fn<SpotAgentAuthorizationWorkflow["submitSignature"]>(
        () => Promise.resolve(base),
      ),
    } satisfies SpotAgentAuthorizationWorkflow;
    const service = createSpotAgentAuthorizationService(workflow);

    await expect(
      service.get({ principal, authorizationId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    await expect(
      service.issue({
        principal,
        requestId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(creation);

    workflow.issue.mockResolvedValueOnce({
      ...creation,
      signable_payload: {
        ...creation.signable_payload,
        typed_data: {
          ...creation.signable_payload.typed_data,
          message: {
            ...creation.signable_payload.typed_data.message,
            nonce: "2",
          },
        },
      },
    });
    await expect(
      service.issue({
        principal,
        requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });

  it("fails closed when a workflow returns a different opaque resource ID", async () => {
    const marketService = createSpotMarketService({
      createUuid: () => requestId,
      now: () => new Date("2026-08-26T00:00:05.000Z"),
      reader: {
        readConfig: vi.fn(),
        readBalances: vi.fn(),
        readMarketFacts: vi.fn(() =>
          Promise.resolve({
            market_id: authorizationId,
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
            source: {
              provider: "hyperliquid",
              network: "testnet",
              metadata_version: "meta-v1",
              fetched_at: now,
              expires_at: expiresAt,
            },
          }),
        ),
      },
    });
    await expect(
      marketService.getMarketFacts({
        principal,
        marketId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    const wrongIntent = { ...intentResource(), intent_id: authorizationId };
    const intentService = createSpotIntentService({
      prepare: vi.fn(),
      findOwned: vi.fn(() => Promise.resolve(wrongIntent)),
      submit: vi.fn(() => Promise.resolve(wrongIntent)),
    });
    await expect(
      intentService.get({ principal, intentId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    await expect(
      intentService.submit({
        principal,
        intentId,
        requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    const wrongAuthorization = {
      authorization_id: intentId,
      state: "prepared",
      binding_epoch: "7",
      signing_state: "required",
      protocol_scope_warning:
        "hyperliquid_agent_authorization_is_protocol_broad",
      expires_at: expiresAt,
      result: null,
      created_at: now,
      updated_at: now,
    } as const;
    const authorizationService = createSpotAgentAuthorizationService({
      issue: vi.fn(),
      findOwned: vi.fn(() => Promise.resolve(wrongAuthorization)),
      submitSignature: vi.fn(() => Promise.resolve(wrongAuthorization)),
    });
    await expect(
      authorizationService.get({ principal, authorizationId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    await expect(
      authorizationService.submitSignature({
        principal,
        authorizationId,
        requestId,
        body: { signature: "0xopaque" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });

  it("fails closed when a workflow returns an impossible intent timeline", async () => {
    const malformed = {
      ...intentResource(),
      state: "accepted",
      submission: { state: "attempted" },
      result: {
        state: "accepted",
        order_id: null,
        filled_base_size: null,
        average_fill_price: null,
        quote_amount: null,
        fee: null,
        fee_asset_display_identity: null,
        observed_at: "2026-08-26T00:00:05.000Z",
        reason_code: null,
      },
    } as const;
    const service = createSpotIntentService({
      prepare: vi.fn(),
      findOwned: vi.fn(() => Promise.resolve(malformed)),
      submit: vi.fn(),
    });

    await expect(service.get({ principal, intentId })).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
  });

  it("adapts the shared wallet lifecycle without accepting an address", async () => {
    const put = vi.fn<SpotWalletBindingLifecycle["put"]>(() =>
      Promise.resolve({
        state: "bound",
        binding_version: "7",
        account_kind: "master",
        last_verified_at: now,
      }),
    );
    const lifecycle = {
      get: vi.fn<SpotWalletBindingLifecycle["get"]>(),
      put,
      remove: vi.fn<SpotWalletBindingLifecycle["remove"]>(),
    } satisfies SpotWalletBindingLifecycle;
    const service = createSpotWalletBindingService(lifecycle);

    const result = await service.put({
      principal,
      body: { expected_binding_version: "6" },
      signal: new AbortController().signal,
    });

    expect(result.binding_version).toBe("7");
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId,
      privyUserId: principal.privyUserId,
      expectedBindingVersion: "6",
    });
    expect(JSON.stringify(put.mock.calls[0]?.[0])).not.toContain("address");
  });
});
