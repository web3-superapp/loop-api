import { describe, expect, it } from "vitest";

import {
  parseSpotAgentAuthorizationCreationResource,
  parseSpotAgentAuthorizationResource,
  parseSpotAgentAuthorizationSignatureRequest,
} from "../src/features/spot/spot-agent-authorization-contract.js";
import { InvalidSpotContractValueError } from "../src/features/spot/spot-contract-support.js";
import {
  createSpotReview,
  digestSpotIntentRequest,
  parseSpotIntentIdempotencyKey,
  parseSpotIntentRequest,
  parseSpotIntentResult,
  parseSpotIntentResource,
  SPOT_INTENT_IDEMPOTENCY_SCOPE,
  SPOT_INTENT_REQUEST_DIGEST_VERSION,
} from "../src/features/spot/spot-intent-contract.js";
import {
  parseSpotBalancesResource,
  parseSpotConfigResource,
  parseSpotMarketFactsResource,
} from "../src/features/spot/spot-market-contract.js";
import {
  parseSpotWalletBindingMutationRequest,
  parseSpotWalletBindingResource,
} from "../src/features/spot/spot-wallet-binding-contract.js";

const marketId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const authorizationId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const fetchedAt = "2026-08-26T00:00:00.000Z";
const expiresAt = "2026-08-26T00:00:15.000Z";

function source() {
  return {
    provider: "hyperliquid",
    network: "testnet",
    metadata_version: "testnet-meta-v1",
    fetched_at: fetchedAt,
    expires_at: expiresAt,
  } as const;
}

function reviewBody() {
  return {
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
    reference_source_time: fetchedAt,
    worst_ioc_limit_price: "5.01",
    maximum_spend_or_minimum_receive: {
      kind: "maximum_spend",
      asset_display_identity: "USDC",
      value: "10",
    },
    fee_rate: "0.001",
    fee_estimate: "0.01",
    fee_source: { dataset: "user_fees", observed_at: fetchedAt },
    metadata_version: "testnet-meta-v1",
    policy_version: "spot-policy-v1",
    binding_epoch: "7",
    expires_at: expiresAt,
  } as const;
}

function filledResult(state: "filled" | "partially_filled") {
  return {
    state,
    order_id: "123",
    filled_base_size: "2.0",
    average_fill_price: "5.00",
    quote_amount: "10.0",
    fee: "0.0",
    fee_asset_display_identity: "USDC",
    observed_at: fetchedAt,
    reason_code: null,
  } as const;
}

function nonFillResult(
  state:
    "accepted" | "not_filled" | "rejected" | "unknown" | "operator_required",
) {
  return {
    state,
    order_id: null,
    filled_base_size: null,
    average_fill_price: null,
    quote_amount: null,
    fee: null,
    fee_asset_display_identity: null,
    observed_at: fetchedAt,
    reason_code: state === "accepted" ? null : "provider_outcome_unresolved",
  } as const;
}

function intentResource(input: {
  readonly state:
    | "prepared"
    | "submitting"
    | "accepted"
    | "filled"
    | "partially_filled"
    | "not_filled"
    | "rejected"
    | "unknown"
    | "reconciling"
    | "operator_required"
    | "expired";
  readonly submission: "not_started" | "ready" | "attempted";
  readonly result: unknown;
}) {
  return {
    intent_id: intentId,
    state: input.state,
    review: createSpotReview(reviewBody()),
    submission: { state: input.submission },
    result: input.result,
    expires_at: expiresAt,
    created_at: fetchedAt,
    updated_at: input.state === "expired" ? expiresAt : fetchedAt,
  } as const;
}

function statusAuthorization() {
  return {
    authorization_id: authorizationId,
    state: "prepared",
    binding_epoch: "7",
    signing_state: "required",
    protocol_scope_warning: "hyperliquid_agent_authorization_is_protocol_broad",
    expires_at: expiresAt,
    result: null,
    created_at: fetchedAt,
    updated_at: fetchedAt,
  } as const;
}

function approveAgentTypedData(
  input: {
    readonly agentAddress?: string;
    readonly agentName?: string;
    readonly nonce?: number;
  } = {},
) {
  const agentAddress = input.agentAddress ?? `0x${"11".repeat(20)}`;
  const agentName = input.agentName ?? "loop-spot-agent";
  const nonce = input.nonce ?? 1_760_000_000_789;
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
      agentAddress,
      agentName,
      nonce,
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    },
  } as const;
}

describe("Spot closed-loop contracts", () => {
  it("accepts only natural exact-input Spot pairings and lexical decimals", () => {
    expect(
      parseSpotIntentRequest({
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "10.25" },
        max_slippage_bps: 25,
      }),
    ).toBeDefined();
    expect(
      parseSpotIntentRequest({
        market_id: marketId,
        side: "sell",
        amount: { mode: "base", value: "2" },
      }),
    ).toBeDefined();
    expect(
      parseSpotIntentRequest({
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "25.00" },
      }),
    ).toBeDefined();
    expect(
      parseSpotIntentRequest({
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "1.0" },
      }),
    ).toBeDefined();

    for (const body of [
      {
        market_id: marketId,
        side: "buy",
        amount: { mode: "base", value: "1" },
      },
      {
        market_id: marketId,
        side: "sell",
        amount: { mode: "quote", value: "1" },
      },
      {
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: 1 },
      },
      {
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "1e2" },
      },
      {
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "01" },
      },
      {
        market_id: marketId,
        side: "buy",
        amount: { mode: "quote", value: "1" },
        asset: 10_000,
      },
    ]) {
      expect(() => parseSpotIntentRequest(body)).toThrow(
        InvalidSpotContractValueError,
      );
    }
  });

  it("locks permanent idempotency semantics and hashes exact requests", () => {
    expect(SPOT_INTENT_IDEMPOTENCY_SCOPE).toBe("spot_intent_prepare");
    expect(SPOT_INTENT_REQUEST_DIGEST_VERSION).toBe("spot_intent_request_v1");
    const body = {
      market_id: marketId,
      side: "buy",
      amount: { mode: "quote", value: "10" },
    };
    expect(digestSpotIntentRequest(body)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      digestSpotIntentRequest({
        ...body,
        amount: { mode: "quote", value: "1" },
      }),
    ).not.toBe(
      digestSpotIntentRequest({
        ...body,
        amount: { mode: "quote", value: "1.0" },
      }),
    );
    expect(
      parseSpotIntentIdempotencyKey([
        "Idempotency-Key",
        "55555555-5555-4555-8555-555555555555",
      ]),
    ).toBe("55555555-5555-4555-8555-555555555555");
    expect(() =>
      parseSpotIntentIdempotencyKey([
        "Idempotency-Key",
        "55555555-5555-4555-8555-555555555555",
        "idempotency-key",
        "66666666-6666-4666-8666-666666666666",
      ]),
    ).toThrow();
  });

  it("binds every immutable review field to its digest", () => {
    const review = createSpotReview(reviewBody());
    const resource = parseSpotIntentResource({
      intent_id: intentId,
      state: "prepared",
      review,
      submission: { state: "ready" },
      result: null,
      expires_at: expiresAt,
      created_at: fetchedAt,
      updated_at: fetchedAt,
    });
    expect(resource.review.review_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(resource.review.fee_source)).toBe(true);
    expect(() =>
      parseSpotIntentResource({
        ...resource,
        review: { ...resource.review, worst_ioc_limit_price: "5.02" },
      }),
    ).toThrow(InvalidSpotContractValueError);
  });

  it("requires positive fill facts and an explicit observed fee", () => {
    expect(parseSpotIntentResult(filledResult("filled"))).toBeDefined();
    expect(
      parseSpotIntentResult(filledResult("partially_filled")),
    ).toBeDefined();

    for (const result of [
      { ...filledResult("filled"), filled_base_size: "0" },
      { ...filledResult("filled"), filled_base_size: "0.0" },
      { ...filledResult("filled"), average_fill_price: "0.00" },
      { ...filledResult("filled"), quote_amount: "0.000" },
      { ...filledResult("filled"), fee: null },
      { ...filledResult("filled"), fee_asset_display_identity: null },
      { ...filledResult("filled"), observed_at: null },
    ]) {
      expect(() => parseSpotIntentResult(result)).toThrow(
        InvalidSpotContractValueError,
      );
    }
  });

  it("uses null, never a lexical zero, when no fill amount is authoritative", () => {
    for (const state of [
      "accepted",
      "not_filled",
      "rejected",
      "unknown",
      "operator_required",
    ] as const) {
      expect(parseSpotIntentResult(nonFillResult(state)).state).toBe(state);
      for (const result of [
        { ...nonFillResult(state), filled_base_size: "0" },
        { ...nonFillResult(state), filled_base_size: "0.0" },
        { ...nonFillResult(state), quote_amount: "0.00" },
        { ...nonFillResult(state), fee: "0" },
      ]) {
        expect(() => parseSpotIntentResult(result)).toThrow(
          InvalidSpotContractValueError,
        );
      }
    }
  });

  it("covers every durable intent state without overstating submission", () => {
    for (const state of [
      "accepted",
      "not_filled",
      "rejected",
      "unknown",
      "operator_required",
    ] as const) {
      expect(
        parseSpotIntentResource(
          intentResource({
            state,
            submission: "attempted",
            result: nonFillResult(state),
          }),
        ).state,
      ).toBe(state);
    }
    for (const state of ["filled", "partially_filled"] as const) {
      expect(
        parseSpotIntentResource(
          intentResource({
            state,
            submission: "attempted",
            result: filledResult(state),
          }),
        ).state,
      ).toBe(state);
    }
    expect(
      parseSpotIntentResource(
        intentResource({
          state: "reconciling",
          submission: "attempted",
          result: nonFillResult("unknown"),
        }),
      ).state,
    ).toBe("reconciling");
    expect(
      parseSpotIntentResource(
        intentResource({
          state: "reconciling",
          submission: "attempted",
          result: nonFillResult("accepted"),
        }),
      ).state,
    ).toBe("reconciling");
    expect(
      parseSpotIntentResource(
        intentResource({
          state: "submitting",
          submission: "attempted",
          result: null,
        }),
      ).state,
    ).toBe("submitting");
    expect(() =>
      parseSpotIntentResource(
        intentResource({
          state: "rejected",
          submission: "attempted",
          result: nonFillResult("unknown"),
        }),
      ),
    ).toThrow(InvalidSpotContractValueError);
  });

  it("rejects impossible intent source, expiry, and result timelines", () => {
    const prepared = intentResource({
      state: "prepared",
      submission: "ready",
      result: null,
    });
    const accepted = intentResource({
      state: "accepted",
      submission: "attempted",
      result: nonFillResult("accepted"),
    });
    const futureSourceTime = "2026-08-26T00:00:05.000Z";

    for (const invalid of [
      {
        ...prepared,
        created_at: expiresAt,
        updated_at: expiresAt,
      },
      {
        ...prepared,
        review: createSpotReview({
          ...reviewBody(),
          reference_source_time: futureSourceTime,
        }),
      },
      {
        ...prepared,
        review: createSpotReview({
          ...reviewBody(),
          fee_source: {
            dataset: "user_fees",
            observed_at: futureSourceTime,
          },
        }),
      },
      {
        ...accepted,
        result: {
          ...nonFillResult("accepted"),
          observed_at: futureSourceTime,
        },
      },
      {
        ...accepted,
        created_at: futureSourceTime,
        updated_at: futureSourceTime,
      },
    ]) {
      expect(() => parseSpotIntentResource(invalid)).toThrow(
        InvalidSpotContractValueError,
      );
    }
  });

  it("keeps unattempted prepared and expired resources distinct", () => {
    for (const state of ["prepared", "expired"] as const) {
      for (const submission of ["not_started", "ready"] as const) {
        expect(
          parseSpotIntentResource(
            intentResource({ state, submission, result: null }),
          ).submission.state,
        ).toBe(submission);
      }
      expect(() =>
        parseSpotIntentResource(
          intentResource({ state, submission: "attempted", result: null }),
        ),
      ).toThrow(InvalidSpotContractValueError);
    }
    expect(() =>
      parseSpotIntentResource(
        intentResource({
          state: "submitting",
          submission: "ready",
          result: null,
        }),
      ),
    ).toThrow(InvalidSpotContractValueError);
  });

  it("publishes no provider identifiers or wallet authority in market data", () => {
    const config = parseSpotConfigResource({
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
        agent_authorization: "unavailable",
      },
      review_policy: {
        execution: "aggressive_limit_ioc",
        default_max_slippage_bps: 25,
        maximum_max_slippage_bps: 100,
        review_ttl_ms: 15_000,
      },
      source: source(),
    });
    const facts = parseSpotMarketFactsResource({
      market_id: marketId,
      enabled: true,
      base_display_identity: "PURR",
      quote_display_identity: "USDC",
      base_size_decimals: 0,
      book: {
        best_bid: { price: "4.99", size: "10" },
        best_ask: { price: "5", size: "12" },
        observed_at: fetchedAt,
      },
      limits: {
        minimum_base_size: { state: "available", value: "1" },
        minimum_quote_notional: { state: "unavailable" },
      },
      source: source(),
    });
    const balances = parseSpotBalancesResource({
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
    });
    const serialized = JSON.stringify({ config, facts, balances });
    expect(serialized).not.toMatch(
      /token_id|token_index|pair_index|exchange_order_asset|wallet_id|account_address/,
    );
  });

  it("keeps the one-time Agent payload out of the GET/status contract", () => {
    const creation = parseSpotAgentAuthorizationCreationResource({
      ...statusAuthorization(),
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
    });
    expect(creation.signable_payload.agent_address).toMatch(/^0x/);
    expect(() => parseSpotAgentAuthorizationResource(creation)).toThrow(
      InvalidSpotContractValueError,
    );
    const status = parseSpotAgentAuthorizationResource(statusAuthorization());
    expect(JSON.stringify(status)).not.toMatch(
      /agent_address|typed_data|nonce|private_key|wallet_id|"signature":/,
    );
    expect(
      parseSpotAgentAuthorizationSignatureRequest({ signature: "0xopaque" }),
    ).toEqual({ signature: "0xopaque" });
    expect(() =>
      parseSpotAgentAuthorizationSignatureRequest({
        signature: "0xopaque",
        digest: "forbidden",
      }),
    ).toThrow();
  });

  it("keeps every Agent lifecycle state consistent with its result", () => {
    const observedAt = "2026-08-26T00:00:01.000Z";
    const terminal = [
      "accepted",
      "active",
      "rejected",
      "failed",
      "unknown",
      "operator_required",
    ] as const;
    for (const state of terminal) {
      expect(
        parseSpotAgentAuthorizationResource({
          ...statusAuthorization(),
          state,
          signing_state: "consumed",
          result: {
            state,
            observed_at: observedAt,
            reason_code: state === "active" ? null : "provider_outcome",
          },
          updated_at: observedAt,
        }).state,
      ).toBe(state);
    }
    for (const state of ["accepted", "unknown"] as const) {
      expect(
        parseSpotAgentAuthorizationResource({
          ...statusAuthorization(),
          state: "reconciling",
          signing_state: "consumed",
          result: {
            state,
            observed_at: observedAt,
            reason_code: "authoritative_read_pending",
          },
          updated_at: observedAt,
        }).state,
      ).toBe("reconciling");
    }
    expect(() =>
      parseSpotAgentAuthorizationResource({
        ...statusAuthorization(),
        state: "active",
        signing_state: "consumed",
        result: {
          state: "rejected",
          observed_at: observedAt,
          reason_code: "provider_rejected",
        },
        updated_at: observedAt,
      }),
    ).toThrow(InvalidSpotContractValueError);
  });

  it("accepts only the exact Testnet approveAgent typed data bound to its envelope", () => {
    const base = {
      ...statusAuthorization(),
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

    expect(parseSpotAgentAuthorizationCreationResource(base)).toBeDefined();

    const wrongPrimaryType = {
      ...base,
      signable_payload: {
        ...base.signable_payload,
        typed_data: {
          ...base.signable_payload.typed_data,
          primaryType: "Permit",
        },
      },
    };
    const mainnet = {
      ...base,
      signable_payload: {
        ...base.signable_payload,
        typed_data: {
          ...base.signable_payload.typed_data,
          message: {
            ...base.signable_payload.typed_data.message,
            hyperliquidChain: "Mainnet",
          },
        },
      },
    };
    const wrongAgent = {
      ...base,
      signable_payload: {
        ...base.signable_payload,
        typed_data: approveAgentTypedData({
          agentAddress: `0x${"22".repeat(20)}`,
        }),
      },
    };
    const wrongNonce = {
      ...base,
      signable_payload: {
        ...base.signable_payload,
        typed_data: approveAgentTypedData({ nonce: 1_760_000_000_790 }),
      },
    };
    const wrongDomain = {
      ...base,
      signable_payload: {
        ...base.signable_payload,
        typed_data: {
          ...base.signable_payload.typed_data,
          domain: {
            ...base.signable_payload.typed_data.domain,
            chainId: 42_161,
          },
        },
      },
    };

    for (const invalid of [
      wrongPrimaryType,
      mainnet,
      wrongAgent,
      wrongNonce,
      wrongDomain,
    ]) {
      expect(() =>
        parseSpotAgentAuthorizationCreationResource(invalid),
      ).toThrow(InvalidSpotContractValueError);
    }

    for (const nonce of [
      "1760000000789",
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        parseSpotAgentAuthorizationCreationResource({
          ...base,
          signable_payload: {
            ...base.signable_payload,
            typed_data: {
              ...base.signable_payload.typed_data,
              message: {
                ...base.signable_payload.typed_data.message,
                nonce,
              },
            },
          },
        }),
      ).toThrow(InvalidSpotContractValueError);
    }
  });

  it("keeps wallet binding address-free and strict", () => {
    expect(
      parseSpotWalletBindingMutationRequest({ expected_binding_version: "0" }),
    ).toEqual({ expected_binding_version: "0" });
    expect(
      parseSpotWalletBindingResource({
        state: "bound",
        binding_version: "7",
        account_kind: "master",
        last_verified_at: fetchedAt,
      }),
    ).toBeDefined();
    expect(() =>
      parseSpotWalletBindingResource({
        state: "bound",
        binding_version: "7",
        account_kind: "master",
        last_verified_at: fetchedAt,
        address: `0x${"11".repeat(20)}`,
      }),
    ).toThrow();
  });
});
