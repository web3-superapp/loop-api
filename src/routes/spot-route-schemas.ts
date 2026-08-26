import { noStoreResponseHeaders } from "../core/http/schemas.js";
import {
  bindingVersionPattern,
  canonicalNonnegativeDecimalPattern,
  canonicalPositiveDecimalPattern,
  uuidPattern,
} from "./spot-http.js";

export const rfc3339Schema = {
  type: "string",
  format: "date-time",
} as const;
export const uuidSchema = { type: "string", pattern: uuidPattern } as const;
export const positiveDecimalSchema = {
  type: "string",
  maxLength: 128,
  pattern: canonicalPositiveDecimalPattern,
} as const;
export const nonnegativeDecimalSchema = {
  type: "string",
  maxLength: 128,
  pattern: canonicalNonnegativeDecimalPattern,
} as const;
export const bindingVersionSchema = {
  type: "string",
  maxLength: 19,
  pattern: bindingVersionPattern,
} as const;
export const assetDisplayIdentitySchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$",
} as const;

export const spotSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "network",
    "metadata_version",
    "fetched_at",
    "expires_at",
  ],
  properties: {
    provider: { type: "string", const: "hyperliquid" },
    network: { type: "string", const: "testnet" },
    metadata_version: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$",
    },
    fetched_at: rfc3339Schema,
    expires_at: rfc3339Schema,
  },
} as const;

const capabilitySchema = {
  type: "string",
  enum: ["available", "unavailable"],
} as const;

export const spotConfigResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["network", "markets", "capabilities", "review_policy", "source"],
  properties: {
    network: { type: "string", const: "testnet" },
    markets: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "market_id",
          "state",
          "base_display_identity",
          "quote_display_identity",
          "base_size_decimals",
        ],
        properties: {
          market_id: uuidSchema,
          state: { type: "string", enum: ["enabled", "disabled"] },
          base_display_identity: assetDisplayIdentitySchema,
          quote_display_identity: assetDisplayIdentitySchema,
          base_size_decimals: {
            type: "integer",
            minimum: 0,
            maximum: 18,
          },
        },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "market_facts",
        "balances",
        "intent_prepare",
        "intent_submit",
        "agent_authorization",
      ],
      properties: {
        market_facts: capabilitySchema,
        balances: capabilitySchema,
        intent_prepare: capabilitySchema,
        intent_submit: capabilitySchema,
        agent_authorization: capabilitySchema,
      },
    },
    review_policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "execution",
        "default_max_slippage_bps",
        "maximum_max_slippage_bps",
        "review_ttl_ms",
      ],
      properties: {
        execution: { type: "string", const: "aggressive_limit_ioc" },
        default_max_slippage_bps: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
        },
        maximum_max_slippage_bps: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
        },
        review_ttl_ms: {
          type: "integer",
          minimum: 1_000,
          maximum: 60_000,
        },
      },
    },
    source: spotSourceSchema,
  },
} as const;

const bookLevelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["price", "size"],
  properties: { price: positiveDecimalSchema, size: positiveDecimalSchema },
} as const;
const optionalPositiveFactSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: { state: { type: "string", const: "unavailable" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "value"],
      properties: {
        state: { type: "string", const: "available" },
        value: positiveDecimalSchema,
      },
    },
  ],
} as const;

export const spotMarketFactsResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "market_id",
    "enabled",
    "base_display_identity",
    "quote_display_identity",
    "base_size_decimals",
    "book",
    "limits",
    "source",
  ],
  properties: {
    market_id: uuidSchema,
    enabled: { type: "boolean", const: true },
    base_display_identity: assetDisplayIdentitySchema,
    quote_display_identity: assetDisplayIdentitySchema,
    base_size_decimals: { type: "integer", minimum: 0, maximum: 18 },
    book: {
      type: "object",
      additionalProperties: false,
      required: ["best_bid", "best_ask", "observed_at"],
      properties: {
        best_bid: bookLevelSchema,
        best_ask: bookLevelSchema,
        observed_at: rfc3339Schema,
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["minimum_base_size", "minimum_quote_notional"],
      properties: {
        minimum_base_size: optionalPositiveFactSchema,
        minimum_quote_notional: optionalPositiveFactSchema,
      },
    },
    source: spotSourceSchema,
  },
} as const;

export const spotBalancesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["binding_version", "account_kind", "items", "source"],
  properties: {
    binding_version: bindingVersionSchema,
    account_kind: { type: "string", const: "master" },
    items: {
      type: "array",
      maxItems: 512,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "asset_id",
          "display_identity",
          "total",
          "available",
          "hold",
        ],
        properties: {
          asset_id: uuidSchema,
          display_identity: assetDisplayIdentitySchema,
          total: nonnegativeDecimalSchema,
          available: nonnegativeDecimalSchema,
          hold: nonnegativeDecimalSchema,
        },
      },
    },
    source: spotSourceSchema,
  },
} as const;

export const spotIntentRequestSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["market_id", "side", "amount"],
      properties: {
        market_id: uuidSchema,
        side: { type: "string", const: "buy" },
        amount: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "value"],
          properties: {
            mode: { type: "string", const: "quote" },
            value: positiveDecimalSchema,
          },
        },
        max_slippage_bps: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["market_id", "side", "amount"],
      properties: {
        market_id: uuidSchema,
        side: { type: "string", const: "sell" },
        amount: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "value"],
          properties: {
            mode: { type: "string", const: "base" },
            value: positiveDecimalSchema,
          },
        },
        max_slippage_bps: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
        },
      },
    },
  ],
} as const;

export const spotReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "provider",
    "network",
    "market_id",
    "base_display_identity",
    "quote_display_identity",
    "side",
    "amount_mode",
    "amount_value",
    "computed_base_size",
    "reference_price",
    "reference_source_time",
    "worst_ioc_limit_price",
    "maximum_spend_or_minimum_receive",
    "fee_rate",
    "fee_estimate",
    "fee_source",
    "metadata_version",
    "policy_version",
    "binding_epoch",
    "expires_at",
    "review_digest",
  ],
  properties: {
    version: { type: "string", const: "spot_review_v1" },
    provider: { type: "string", const: "hyperliquid" },
    network: { type: "string", const: "testnet" },
    market_id: uuidSchema,
    base_display_identity: assetDisplayIdentitySchema,
    quote_display_identity: assetDisplayIdentitySchema,
    side: { type: "string", enum: ["buy", "sell"] },
    amount_mode: { type: "string", enum: ["quote", "base"] },
    amount_value: positiveDecimalSchema,
    computed_base_size: positiveDecimalSchema,
    reference_price: positiveDecimalSchema,
    reference_source_time: rfc3339Schema,
    worst_ioc_limit_price: positiveDecimalSchema,
    maximum_spend_or_minimum_receive: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "asset_display_identity", "value"],
      properties: {
        kind: {
          type: "string",
          enum: ["maximum_spend", "minimum_receive"],
        },
        asset_display_identity: assetDisplayIdentitySchema,
        value: positiveDecimalSchema,
      },
    },
    fee_rate: nonnegativeDecimalSchema,
    fee_estimate: nonnegativeDecimalSchema,
    fee_source: {
      type: "object",
      additionalProperties: false,
      required: ["dataset", "observed_at"],
      properties: {
        dataset: { type: "string", const: "user_fees" },
        observed_at: rfc3339Schema,
      },
    },
    metadata_version: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$",
    },
    policy_version: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$",
    },
    binding_epoch: {
      type: "string",
      pattern: "^[1-9][0-9]{0,18}$",
      maxLength: 19,
    },
    expires_at: rfc3339Schema,
    review_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

const nullableOrderIdSchema = {
  anyOf: [
    {
      type: "string",
      pattern: "^(?:0|[1-9][0-9]{0,19})$",
      maxLength: 20,
    },
    { type: "null" },
  ],
} as const;
const nullableReasonCodeSchema = {
  anyOf: [
    { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    { type: "null" },
  ],
} as const;
const intentResultRequired = [
  "state",
  "order_id",
  "filled_base_size",
  "average_fill_price",
  "quote_amount",
  "fee",
  "fee_asset_display_identity",
  "observed_at",
  "reason_code",
] as const;
const filledIntentResultProperties = {
  order_id: nullableOrderIdSchema,
  filled_base_size: positiveDecimalSchema,
  average_fill_price: positiveDecimalSchema,
  quote_amount: positiveDecimalSchema,
  fee: nonnegativeDecimalSchema,
  fee_asset_display_identity: assetDisplayIdentitySchema,
  observed_at: rfc3339Schema,
  reason_code: nullableReasonCodeSchema,
} as const;
const nonFillIntentResultProperties = {
  order_id: nullableOrderIdSchema,
  filled_base_size: { type: "null" },
  average_fill_price: { type: "null" },
  quote_amount: { type: "null" },
  fee: { type: "null" },
  fee_asset_display_identity: { type: "null" },
  observed_at: rfc3339Schema,
  reason_code: nullableReasonCodeSchema,
} as const;
function intentResultSchema<const State extends "filled" | "partially_filled">(
  state: State,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: intentResultRequired,
    properties: {
      state: { type: "string", const: state },
      ...filledIntentResultProperties,
    },
  } as const;
}

function nonFillIntentResultSchema<
  const State extends
    "accepted" | "not_filled" | "rejected" | "unknown" | "operator_required",
>(state: State) {
  return {
    type: "object",
    additionalProperties: false,
    required: intentResultRequired,
    properties: {
      state: { type: "string", const: state },
      ...nonFillIntentResultProperties,
    },
  } as const;
}

const spotIntentResourceRequired = [
  "intent_id",
  "state",
  "review",
  "submission",
  "result",
  "expires_at",
  "created_at",
  "updated_at",
] as const;
const spotIntentResourceBaseProperties = {
  intent_id: uuidSchema,
  review: spotReviewSchema,
  expires_at: rfc3339Schema,
  created_at: rfc3339Schema,
  updated_at: rfc3339Schema,
} as const;
const unattemptedSubmissionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { type: "string", enum: ["not_started", "ready"] },
  },
} as const;
const attemptedSubmissionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: { state: { type: "string", const: "attempted" } },
} as const;

function spotIntentResourceBranch<
  const State extends string,
  const SubmissionSchema extends object,
  const ResultSchema extends object,
>(state: State, submission: SubmissionSchema, result: ResultSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: spotIntentResourceRequired,
    properties: {
      ...spotIntentResourceBaseProperties,
      state: { type: "string", const: state },
      submission,
      result,
    },
  } as const;
}

export const spotIntentResourceSchema = {
  headers: noStoreResponseHeaders(),
  oneOf: [
    spotIntentResourceBranch("prepared", unattemptedSubmissionSchema, {
      type: "null",
    } as const),
    spotIntentResourceBranch("expired", unattemptedSubmissionSchema, {
      type: "null",
    } as const),
    spotIntentResourceBranch("submitting", attemptedSubmissionSchema, {
      type: "null",
    } as const),
    spotIntentResourceBranch(
      "accepted",
      attemptedSubmissionSchema,
      nonFillIntentResultSchema("accepted"),
    ),
    spotIntentResourceBranch(
      "filled",
      attemptedSubmissionSchema,
      intentResultSchema("filled"),
    ),
    spotIntentResourceBranch(
      "partially_filled",
      attemptedSubmissionSchema,
      intentResultSchema("partially_filled"),
    ),
    spotIntentResourceBranch(
      "not_filled",
      attemptedSubmissionSchema,
      nonFillIntentResultSchema("not_filled"),
    ),
    spotIntentResourceBranch(
      "rejected",
      attemptedSubmissionSchema,
      nonFillIntentResultSchema("rejected"),
    ),
    spotIntentResourceBranch(
      "unknown",
      attemptedSubmissionSchema,
      nonFillIntentResultSchema("unknown"),
    ),
    spotIntentResourceBranch("reconciling", attemptedSubmissionSchema, {
      oneOf: [
        nonFillIntentResultSchema("accepted"),
        nonFillIntentResultSchema("unknown"),
      ],
    } as const),
    spotIntentResourceBranch(
      "operator_required",
      attemptedSubmissionSchema,
      nonFillIntentResultSchema("operator_required"),
    ),
  ],
} as const;

const spotWalletBindingRequired = [
  "state",
  "binding_version",
  "account_kind",
  "last_verified_at",
] as const;

export const spotWalletBindingResourceSchema = {
  headers: noStoreResponseHeaders(),
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: spotWalletBindingRequired,
      properties: {
        state: { type: "string", const: "bound" },
        binding_version: {
          type: "string",
          maxLength: 19,
          pattern: "^[1-9][0-9]{0,18}$",
        },
        account_kind: { type: "string", const: "master" },
        last_verified_at: rfc3339Schema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: spotWalletBindingRequired,
      properties: {
        state: { type: "string", const: "unbound" },
        binding_version: bindingVersionSchema,
        account_kind: { type: "null" },
        last_verified_at: { type: "null" },
      },
    },
  ],
} as const;

export const spotWalletBindingMutationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_binding_version"],
  properties: { expected_binding_version: bindingVersionSchema },
} as const;

const approveAgentTypedDataFields = [
  { name: "hyperliquidChain", type: "string" },
  { name: "agentAddress", type: "address" },
  { name: "agentName", type: "string" },
  { name: "nonce", type: "uint64" },
] as const;
const eip712DomainTypedDataFields = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
const agentAddressSchema = {
  type: "string",
  pattern: "^0x[0-9a-f]{40}$",
  not: { const: "0x0000000000000000000000000000000000000000" },
} as const;
const agentNameSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$",
} as const;
const authorizationNonceSchema = {
  type: "string",
  pattern: "^(?:0|[1-9][0-9]{0,19})$",
  maxLength: 20,
} as const;
const signableDomainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "chain_id", "verifying_contract"],
  properties: {
    name: { type: "string", const: "HyperliquidSignTransaction" },
    version: { type: "string", const: "1" },
    chain_id: { type: "integer", const: 421_614 },
    verifying_contract: {
      type: "string",
      const: "0x0000000000000000000000000000000000000000",
    },
  },
} as const;

const approveAgentTypedDataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "types", "primaryType", "message"],
  properties: {
    domain: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "chainId", "verifyingContract"],
      properties: {
        name: { type: "string", const: "HyperliquidSignTransaction" },
        version: { type: "string", const: "1" },
        chainId: { type: "integer", const: 421_614 },
        verifyingContract: {
          type: "string",
          const: "0x0000000000000000000000000000000000000000",
        },
      },
    },
    types: {
      type: "object",
      additionalProperties: false,
      required: ["HyperliquidTransaction:ApproveAgent", "EIP712Domain"],
      properties: {
        "HyperliquidTransaction:ApproveAgent": {
          type: "array",
          const: approveAgentTypedDataFields,
        },
        EIP712Domain: {
          type: "array",
          const: eip712DomainTypedDataFields,
        },
      },
    },
    primaryType: {
      type: "string",
      const: "HyperliquidTransaction:ApproveAgent",
    },
    message: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "agentAddress",
        "agentName",
        "nonce",
        "signatureChainId",
        "hyperliquidChain",
      ],
      properties: {
        type: { type: "string", const: "approveAgent" },
        agentAddress: agentAddressSchema,
        agentName: agentNameSchema,
        nonce: authorizationNonceSchema,
        signatureChainId: { type: "string", const: "0x66eee" },
        hyperliquidChain: { type: "string", const: "Testnet" },
      },
    },
  },
} as const;

const spotAgentAuthorizationBaseProperties = {
  authorization_id: uuidSchema,
  binding_epoch: {
    type: "string",
    pattern: "^[1-9][0-9]{0,18}$",
    maxLength: 19,
  },
  protocol_scope_warning: {
    type: "string",
    const: "hyperliquid_agent_authorization_is_protocol_broad",
  },
  expires_at: rfc3339Schema,
  created_at: rfc3339Schema,
  updated_at: rfc3339Schema,
} as const;

const spotAgentAuthorizationRequired = [
  "authorization_id",
  "state",
  "binding_epoch",
  "signing_state",
  "protocol_scope_warning",
  "expires_at",
  "result",
  "created_at",
  "updated_at",
] as const;

function spotAgentAuthorizationResultSchema<
  const State extends
    | "accepted"
    | "active"
    | "rejected"
    | "failed"
    | "unknown"
    | "operator_required",
>(state: State) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["state", "observed_at", "reason_code"],
    properties: {
      state: { type: "string", const: state },
      observed_at: rfc3339Schema,
      reason_code: nullableReasonCodeSchema,
    },
  } as const;
}

function spotAgentAuthorizationBranch<
  const State extends string,
  const SigningState extends "required" | "consumed" | "expired",
  const ResultSchema extends object,
>(state: State, signingState: SigningState, result: ResultSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: spotAgentAuthorizationRequired,
    properties: {
      ...spotAgentAuthorizationBaseProperties,
      state: { type: "string", const: state },
      signing_state: { type: "string", const: signingState },
      result,
    },
  } as const;
}

export const spotAgentAuthorizationResourceSchema = {
  headers: noStoreResponseHeaders(),
  oneOf: [
    spotAgentAuthorizationBranch("prepared", "required", {
      type: "null",
    } as const),
    spotAgentAuthorizationBranch("submitting", "consumed", {
      type: "null",
    } as const),
    spotAgentAuthorizationBranch(
      "accepted",
      "consumed",
      spotAgentAuthorizationResultSchema("accepted"),
    ),
    spotAgentAuthorizationBranch(
      "active",
      "consumed",
      spotAgentAuthorizationResultSchema("active"),
    ),
    spotAgentAuthorizationBranch(
      "rejected",
      "consumed",
      spotAgentAuthorizationResultSchema("rejected"),
    ),
    spotAgentAuthorizationBranch(
      "failed",
      "consumed",
      spotAgentAuthorizationResultSchema("failed"),
    ),
    spotAgentAuthorizationBranch(
      "unknown",
      "consumed",
      spotAgentAuthorizationResultSchema("unknown"),
    ),
    spotAgentAuthorizationBranch("reconciling", "consumed", {
      oneOf: [
        spotAgentAuthorizationResultSchema("accepted"),
        spotAgentAuthorizationResultSchema("unknown"),
      ],
    } as const),
    spotAgentAuthorizationBranch(
      "operator_required",
      "consumed",
      spotAgentAuthorizationResultSchema("operator_required"),
    ),
    spotAgentAuthorizationBranch("expired", "expired", {
      type: "null",
    } as const),
  ],
} as const;

const spotAgentSignablePayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "agent_address",
    "agent_name",
    "nonce",
    "domain",
    "typed_data",
    "expires_at",
  ],
  properties: {
    format: { type: "string", const: "privy_eip712_json_v1" },
    agent_address: agentAddressSchema,
    agent_name: agentNameSchema,
    nonce: authorizationNonceSchema,
    domain: signableDomainSchema,
    typed_data: approveAgentTypedDataSchema,
    expires_at: rfc3339Schema,
  },
} as const;

export const spotAgentAuthorizationCreationResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...spotAgentAuthorizationRequired, "signable_payload"],
  properties: {
    ...spotAgentAuthorizationBaseProperties,
    state: { type: "string", const: "prepared" },
    signing_state: { type: "string", const: "required" },
    result: { type: "null" },
    signable_payload: spotAgentSignablePayloadSchema,
  },
  allOf: [
    {
      oneOf: [
        {
          type: "object",
          required: ["state", "signing_state", "result"],
          properties: {
            state: { type: "string", const: "prepared" },
            signing_state: { type: "string", const: "required" },
            result: { type: "null" },
          },
        },
      ],
    },
  ],
} as const;

export const spotAgentSignatureRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["signature"],
  properties: {
    signature: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      pattern: "^[\\x21-\\x7e]+$",
    },
  },
} as const;
