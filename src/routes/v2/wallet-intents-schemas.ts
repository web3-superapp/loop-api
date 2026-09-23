import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import {
  hasIdempotencyKeyHeader,
  parseV2CommandMetadata,
  v2CommandHeadersSchema,
} from "../../features/community/community-contract.js";
import {
  anyCaseEvmAddressPatternSource,
  assetIdPatternSource,
  blockHashPatternSource,
  chainIdPatternSource,
  decimalAmountPatternSource,
  evmAddressPatternSource,
  rawAmountPatternSource,
  reasonCodePatternSource,
  transactionHashPatternSource,
} from "../../features/chain/chain-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  parseV2CommonRequestMetadata,
  parseV2WriteRequestMetadata,
  v2CommonHeadersSchema,
} from "../../features/session/session-contract.js";
import {
  bscWriteCanaryPolicyVersion,
  exposureBases,
  firstRecipientBasis,
  signingModes,
  simulationSources,
  simulationStatuses,
  swapPolicy,
  walletIntentKinds,
  walletIntentListLimits,
  walletIntentRefusalReasonCodes,
  walletIntentStates,
} from "../../features/wallet-intents/intent-contract.js";

/**
 * Route schemas for the V2 wallet-intent, swap, and approvals surfaces
 * (Decision 0035). Every amount is a string, every quantity inside the
 * unsigned transaction is a 0x hex string, and every bounded object rejects
 * unknown properties.
 */

const hexQuantitySchema = {
  type: "string",
  pattern: "^0x(0|[1-9a-f][0-9a-f]*)$",
  description: "JSON-RPC quantity as a 0x hex string.",
} as const;

const hexDataSchema = {
  type: "string",
  pattern: "^0x([0-9a-f]{2})*$",
  maxLength: 20_000,
} as const;

const rawAmountSchema = {
  type: "string",
  pattern: rawAmountPatternSource,
} as const;

const decimalAmountSchema = {
  type: "string",
  pattern: decimalAmountPatternSource,
} as const;

const displayAmountSchema = {
  anyOf: [decimalAmountSchema, { type: "string", const: "unlimited" }],
} as const;

const reasonCodeSchema = {
  type: "string",
  pattern: reasonCodePatternSource,
} as const;

const nullableReasonCodeSchema = {
  anyOf: [reasonCodeSchema, { type: "null" }],
} as const;

const nullableString = (schema: Record<string, unknown>) =>
  ({ anyOf: [schema, { type: "null" }] }) as const;

const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
} as const;

const checksumAddressSchema = {
  type: "string",
  pattern: anyCaseEvmAddressPatternSource,
} as const;

const blockNumberSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
} as const;

const dateTimeSchema = { type: "string", format: "date-time" } as const;

const opaqueIdSchema = {
  type: "string",
  pattern: opaqueIdPatternSource,
} as const;

const assetSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "address", "symbol", "decimals"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    address: nullableString(addressSchema),
    symbol: { type: "string", minLength: 1, maxLength: 32 },
    decimals: { type: "integer", minimum: 0, maximum: 36 },
  },
} as const;

const amountSchema = {
  type: "object",
  additionalProperties: false,
  required: ["raw", "display"],
  properties: { raw: rawAmountSchema, display: displayAmountSchema },
} as const;

const unavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: reasonCodeSchema,
  },
} as const;

const recipientReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "address",
    "checksumAddress",
    "isContract",
    "isFirstRecipient",
    "basis",
    "screening",
  ],
  properties: {
    address: addressSchema,
    checksumAddress: checksumAddressSchema,
    isContract: { type: "boolean" },
    isFirstRecipient: {
      type: "boolean",
      description:
        "True when the wallet has no indexed outgoing transfer to this address.",
    },
    basis: { type: "string", const: firstRecipientBasis },
    screening: unavailableSchema,
  },
} as const;

const spenderReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["address", "checksumAddress", "isContract", "isUnlimited"],
  properties: {
    address: addressSchema,
    checksumAddress: checksumAddressSchema,
    isContract: { type: "boolean" },
    isUnlimited: { type: "boolean" },
  },
} as const;

const decodedCallSchema = {
  type: "object",
  additionalProperties: false,
  required: ["functionName", "selector", "args"],
  properties: {
    functionName: { type: "string", enum: ["transfer", "approve"] },
    selector: { type: "string", pattern: "^0x[0-9a-f]{8}$" },
    args: {
      type: "object",
      additionalProperties: { type: "string", maxLength: 128 },
      maxProperties: 4,
    },
  },
} as const;

const feeFactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "gasLimit",
    "type",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "gasPrice",
    "maximumFeeRaw",
    "maximumFee",
    "observedAt",
  ],
  properties: {
    gasLimit: rawAmountSchema,
    type: { type: "string", enum: ["eip1559", "legacy"] },
    maxFeePerGas: nullableString(rawAmountSchema),
    maxPriorityFeePerGas: nullableString(rawAmountSchema),
    gasPrice: nullableString(rawAmountSchema),
    maximumFeeRaw: rawAmountSchema,
    maximumFee: decimalAmountSchema,
    observedAt: dateTimeSchema,
  },
} as const;

const balanceFactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "blockNumber",
    "blockHash",
    "observedAt",
    "rawBalance",
    "displayBalance",
    "rawNativeBalance",
    "gasReserveRaw",
  ],
  properties: {
    blockNumber: blockNumberSchema,
    blockHash: { type: "string", pattern: blockHashPatternSource },
    observedAt: dateTimeSchema,
    rawBalance: rawAmountSchema,
    displayBalance: decimalAmountSchema,
    rawNativeBalance: rawAmountSchema,
    gasReserveRaw: rawAmountSchema,
  },
} as const;

const priceImpactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "value",
    "decision",
    "reasonCode",
    "marketValueUsd",
    "estimatedOutputValueUsd",
    "priceSource",
  ],
  properties: {
    status: { type: "string", enum: ["available", "unavailable"] },
    value: nullableString(decimalAmountSchema),
    decision: { type: "string", enum: ["allowed", "confirm", "blocked"] },
    reasonCode: nullableReasonCodeSchema,
    marketValueUsd: nullableString(decimalAmountSchema),
    estimatedOutputValueUsd: nullableString(decimalAmountSchema),
    priceSource: nullableString({ type: "string", maxLength: 32 }),
  },
} as const;

const swapPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "status",
    "defaultSlippageBps",
    "maximumSlippageBps",
    "hardBlockPriceImpact",
    "confirmPriceImpact",
    "quoteTtlSeconds",
  ],
  properties: {
    configVersion: { type: "string", const: swapPolicy.configVersion },
    status: { type: "string", const: swapPolicy.status },
    defaultSlippageBps: {
      type: "integer",
      const: swapPolicy.defaultSlippageBps,
    },
    maximumSlippageBps: {
      type: "integer",
      const: swapPolicy.maximumSlippageBps,
    },
    hardBlockPriceImpact: {
      type: "string",
      const: swapPolicy.hardBlockPriceImpact,
    },
    confirmPriceImpact: {
      type: "string",
      const: swapPolicy.confirmPriceImpact,
    },
    quoteTtlSeconds: { type: "integer", const: swapPolicy.quoteTtlSeconds },
  },
} as const;

const swapQuoteSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "quoteId",
    "provider",
    "amountType",
    "inputAmount",
    "estimatedOutputAmount",
    "minimumOutputAmount",
    "slippageBps",
    "gasEstimateRaw",
    "quotedAt",
    "expiresAt",
    "priceImpact",
    "platformFeeBps",
  ],
  properties: {
    quoteId: opaqueIdSchema,
    provider: { type: "string", const: "privy" },
    amountType: { type: "string", const: "exact_input" },
    inputAmount: amountSchema,
    estimatedOutputAmount: amountSchema,
    minimumOutputAmount: amountSchema,
    slippageBps: {
      type: "integer",
      minimum: 1,
      maximum: swapPolicy.maximumSlippageBps,
    },
    gasEstimateRaw: rawAmountSchema,
    quotedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    priceImpact: priceImpactSchema,
    platformFeeBps: {
      anyOf: [{ type: "integer", minimum: 1, maximum: 1000 }, { type: "null" }],
    },
  },
} as const;

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "asset",
    "amount",
    "recipient",
    "spender",
    "decodedCall",
    "fee",
    "balance",
    "swap",
  ],
  properties: {
    kind: { type: "string", enum: [...walletIntentKinds] },
    asset: assetSnapshotSchema,
    amount: amountSchema,
    recipient: { anyOf: [recipientReviewSchema, { type: "null" }] },
    spender: { anyOf: [spenderReviewSchema, { type: "null" }] },
    decodedCall: { anyOf: [decodedCallSchema, { type: "null" }] },
    fee: { anyOf: [feeFactSchema, { type: "null" }] },
    balance: balanceFactSchema,
    swap: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["destinationAsset", "quote", "policy"],
          properties: {
            destinationAsset: assetSnapshotSchema,
            quote: swapQuoteSnapshotSchema,
            policy: swapPolicySchema,
          },
        },
        { type: "null" },
      ],
    },
  },
  description:
    "Projection of the signed canonical payload. Every field shown here is bound into reviewSha256.",
} as const;

const unsignedTransactionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "chainId",
    "from",
    "to",
    "data",
    "value",
    "gas",
    "nonce",
    "type",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "gasPrice",
  ],
  properties: {
    chainId: { type: "integer", const: 56 },
    from: addressSchema,
    to: addressSchema,
    data: hexDataSchema,
    value: hexQuantitySchema,
    gas: hexQuantitySchema,
    nonce: hexQuantitySchema,
    type: { type: "string", enum: ["eip1559", "legacy"] },
    maxFeePerGas: nullableString(hexQuantitySchema),
    maxPriorityFeePerGas: nullableString(hexQuantitySchema),
    gasPrice: nullableString(hexQuantitySchema),
  },
  description:
    "The exact JSON-RPC transaction the device passes to Privy eth_sendTransaction. The client must not alter any field.",
} as const;

const authorizationPayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "method", "url", "body", "headers"],
  properties: {
    version: { type: "integer", const: 1 },
    method: { type: "string", const: "POST" },
    url: { type: "string", format: "uri", maxLength: 512 },
    body: {
      type: "object",
      additionalProperties: false,
      required: [
        "base_amount",
        "source",
        "destination",
        "amount_type",
        "slippage_bps",
      ],
      properties: {
        base_amount: rawAmountSchema,
        source: {
          type: "object",
          additionalProperties: false,
          required: ["asset_address", "caip2"],
          properties: {
            asset_address: { type: "string", maxLength: 64 },
            caip2: { type: "string", pattern: chainIdPatternSource },
          },
        },
        destination: {
          type: "object",
          additionalProperties: false,
          required: ["asset_address", "caip2"],
          properties: {
            asset_address: { type: "string", maxLength: 64 },
            caip2: { type: "string", pattern: chainIdPatternSource },
          },
        },
        amount_type: { type: "string", const: "exact_input" },
        slippage_bps: {
          type: "integer",
          minimum: 1,
          maximum: swapPolicy.maximumSlippageBps,
        },
        fee_configuration: {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: {
            type: { type: "string", const: "total_fee_bps" },
            value: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    headers: {
      type: "object",
      additionalProperties: false,
      required: [
        "privy-app-id",
        "privy-idempotency-key",
        "privy-request-expiry",
      ],
      properties: {
        "privy-app-id": { type: "string", maxLength: 255 },
        "privy-idempotency-key": opaqueIdSchema,
        "privy-request-expiry": {
          type: "string",
          pattern: "^[1-9][0-9]{0,15}$",
        },
      },
    },
  },
  description:
    "The exact Privy request the user authorizes with generateAuthorizationSignature. Byte-exact conformance with Privy's canonical form is pending device evidence.",
} as const;

export const walletIntentResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "intentId",
    "kind",
    "state",
    "walletId",
    "chainId",
    "review",
    "reviewSha256",
    "factsObservedAt",
    "expiresAt",
    "simulation",
    "policy",
    "signing",
    "unsignedTransaction",
    "authorizationPayload",
    "result",
    "version",
    "createdAt",
    "updatedAt",
    "contractVersion",
  ],
  properties: {
    intentId: opaqueIdSchema,
    kind: { type: "string", enum: [...walletIntentKinds] },
    state: { type: "string", enum: [...walletIntentStates] },
    walletId: opaqueIdSchema,
    chainId: { type: "string", pattern: chainIdPatternSource },
    review: reviewSchema,
    reviewSha256: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description:
        "SHA-256 of the canonical payload. The client checks the displayed review against this digest before invoking the signer.",
    },
    factsObservedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    simulation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "source", "observedAt", "reasonCode"],
      properties: {
        status: { type: "string", enum: [...simulationStatuses] },
        source: { type: "string", enum: [...simulationSources] },
        observedAt: dateTimeSchema,
        reasonCode: nullableReasonCodeSchema,
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: [
        "configVersion",
        "canaryMaxUsd",
        "exposureBasis",
        "exposureRaw",
        "exposureBlockNumber",
        "valueUsd",
        "priceSource",
        "priceFetchedAt",
      ],
      properties: {
        configVersion: { type: "string", const: bscWriteCanaryPolicyVersion },
        canaryMaxUsd: decimalAmountSchema,
        exposureBasis: {
          type: "string",
          enum: [...exposureBases],
          description:
            "amount: the transferred/swapped amount; balance_at_prepare: min(allowance, balance) at the snapshot block for an approve; none: a revoke.",
        },
        exposureRaw: nullableString(rawAmountSchema),
        exposureBlockNumber: nullableString(blockNumberSchema),
        valueUsd: nullableString(decimalAmountSchema),
        priceSource: nullableString({ type: "string", maxLength: 32 }),
        priceFetchedAt: nullableString(dateTimeSchema),
      },
    },
    signing: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "allowed", "reasonCode"],
      properties: {
        mode: { type: "string", enum: [...signingModes] },
        allowed: {
          type: "boolean",
          description:
            "True only in awaiting_signature before expiry. The signing sheet's confirm button follows this flag.",
        },
        reasonCode: nullableReasonCodeSchema,
      },
    },
    unsignedTransaction: {
      anyOf: [unsignedTransactionSchema, { type: "null" }],
    },
    authorizationPayload: {
      anyOf: [authorizationPayloadSchema, { type: "null" }],
    },
    result: {
      type: "object",
      additionalProperties: false,
      required: [
        "transactionHash",
        "providerActionId",
        "reasonCode",
        "receipt",
      ],
      properties: {
        transactionHash: nullableString({
          type: "string",
          pattern: transactionHashPatternSource,
        }),
        providerActionId: nullableString({ type: "string", maxLength: 128 }),
        reasonCode: nullableReasonCodeSchema,
        receipt: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "status",
                "blockNumber",
                "blockHash",
                "gasUsed",
                "effectiveGasPrice",
                "confirmations",
                "observedAt",
              ],
              properties: {
                status: { type: "string", enum: ["success", "reverted"] },
                blockNumber: blockNumberSchema,
                blockHash: { type: "string", pattern: blockHashPatternSource },
                gasUsed: rawAmountSchema,
                effectiveGasPrice: rawAmountSchema,
                confirmations: {
                  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
                },
                observedAt: dateTimeSchema,
              },
            },
            { type: "null" },
          ],
        },
      },
    },
    version: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const walletIntentListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: walletIntentListLimits.maximum,
      items: walletIntentResourceSchema,
    },
    nextCursor: {
      anyOf: [
        {
          type: "string",
          minLength: 3,
          maxLength: 1_536,
          pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
        },
        { type: "null" },
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const walletIntentListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: {
      type: "string",
      minLength: 3,
      maxLength: 1_536,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: walletIntentListLimits.maximum,
    },
  },
} as const;

export const intentIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intentId"],
  properties: { intentId: opaqueIdSchema },
} as const;

const optionalChainIdProperty = {
  chainId: {
    type: "string",
    pattern: chainIdPatternSource,
    description: "Optional; anything other than eip155:56 is CHAIN_MISMATCH.",
  },
} as const;

export const sendPreflightRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "address"],
  properties: {
    walletId: opaqueIdSchema,
    address: {
      type: "string",
      pattern: anyCaseEvmAddressPatternSource,
      description:
        "Recipient address. A mixed-case value must be a valid EIP-55 checksum; a wrong checksum is INVALID_REQUEST.",
    },
    ...optionalChainIdProperty,
  },
} as const;

export const sendPreflightResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "chainId",
    "recipient",
    "basis",
    "warnings",
    "contractVersion",
  ],
  properties: {
    walletId: opaqueIdSchema,
    chainId: { type: "string", pattern: chainIdPatternSource },
    recipient: recipientReviewSchema,
    basis: {
      type: "string",
      const: firstRecipientBasis,
      description:
        "isFirstRecipient is derived only from indexed ERC-20 transfers out of this wallet.",
    },
    warnings: {
      type: "array",
      maxItems: 8,
      items: { type: "string", pattern: "^[a-z][A-Za-z0-9.]{0,63}$" },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const sendPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "assetId", "amount", "recipientAddress"],
  properties: {
    walletId: opaqueIdSchema,
    assetId: { type: "string", pattern: assetIdPatternSource },
    amount: {
      type: "string",
      pattern: decimalAmountPatternSource,
      description: "Positive decimal string in the asset's display unit.",
    },
    recipientAddress: {
      type: "string",
      pattern: anyCaseEvmAddressPatternSource,
    },
    ...optionalChainIdProperty,
  },
} as const;

export const approvePrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "assetId", "spenderAddress", "allowance"],
  properties: {
    walletId: opaqueIdSchema,
    assetId: { type: "string", pattern: assetIdPatternSource },
    spenderAddress: { type: "string", pattern: anyCaseEvmAddressPatternSource },
    allowance: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "amount"],
          properties: {
            mode: { type: "string", const: "exact" },
            amount: { type: "string", pattern: decimalAmountPatternSource },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { type: "string", const: "unlimited" } },
        },
      ],
    },
    acknowledgeUnlimited: {
      type: "boolean",
      description:
        "Required true for allowance.mode = unlimited: the guard has shown the unlimited notice and the user confirmed a second time (VALIDATION_FAILED otherwise). The canary ceiling is enforced on min(allowance, balance).",
    },
  },
} as const;

export const revokePrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "assetId", "spenderAddress"],
  properties: {
    walletId: opaqueIdSchema,
    assetId: { type: "string", pattern: assetIdPatternSource },
    spenderAddress: { type: "string", pattern: anyCaseEvmAddressPatternSource },
  },
} as const;

export const broadcastReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["txHash"],
  properties: {
    txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
  },
} as const;

export const swapQuoteRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "sourceAssetId", "destinationAssetId", "amount"],
  properties: {
    walletId: opaqueIdSchema,
    sourceAssetId: { type: "string", pattern: assetIdPatternSource },
    destinationAssetId: { type: "string", pattern: assetIdPatternSource },
    amount: { type: "string", pattern: decimalAmountPatternSource },
    slippageBps: {
      type: "integer",
      minimum: 1,
      maximum: swapPolicy.maximumSlippageBps,
      description: `Defaults to ${String(swapPolicy.defaultSlippageBps)}; above ${String(swapPolicy.maximumSlippageBps)} is INVALID_REQUEST.`,
    },
  },
} as const;

export const swapQuoteResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "sourceAsset",
    "destinationAsset",
    "quote",
    "policy",
    "canary",
    "contractVersion",
  ],
  properties: {
    walletId: opaqueIdSchema,
    sourceAsset: assetSnapshotSchema,
    destinationAsset: assetSnapshotSchema,
    quote: swapQuoteSnapshotSchema,
    policy: swapPolicySchema,
    canary: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "canaryMaxUsd", "inputValueUsd"],
      properties: {
        configVersion: { type: "string", const: bscWriteCanaryPolicyVersion },
        canaryMaxUsd: decimalAmountSchema,
        inputValueUsd: decimalAmountSchema,
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const swapPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "quoteId"],
  properties: {
    walletId: opaqueIdSchema,
    quoteId: opaqueIdSchema,
    confirmPriceImpact: {
      type: "boolean",
      description:
        "Required true when the quote's priceImpact.decision is confirm (1–5%).",
    },
  },
} as const;

export const swapExecuteRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authorizationSignature"],
  properties: {
    authorizationSignature: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      description:
        "Opaque signature the device produced over authorizationPayload with Privy generateAuthorizationSignature. Forwarded verbatim; never logged.",
    },
  },
} as const;

const approvalRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "assetId",
    "symbol",
    "decimals",
    "spender",
    "allowance",
    "lastApproval",
    "riskFacts",
  ],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    symbol: { type: "string", minLength: 1, maxLength: 32 },
    decimals: { type: "integer", minimum: 0, maximum: 36 },
    spender: {
      type: "object",
      additionalProperties: false,
      required: ["address", "checksumAddress"],
      properties: {
        address: addressSchema,
        checksumAddress: checksumAddressSchema,
      },
    },
    allowance: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "rawValue",
            "displayValue",
            "isUnlimited",
            "blockNumber",
            "blockHash",
            "observedAt",
          ],
          properties: {
            status: { type: "string", const: "available" },
            rawValue: rawAmountSchema,
            displayValue: displayAmountSchema,
            isUnlimited: { type: "boolean" },
            blockNumber: blockNumberSchema,
            blockHash: { type: "string", pattern: blockHashPatternSource },
            observedAt: dateTimeSchema,
          },
        },
        unavailableSchema,
      ],
    },
    lastApproval: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "transactionHash",
            "blockNumber",
            "rawValue",
            "observedAt",
          ],
          properties: {
            transactionHash: {
              type: "string",
              pattern: transactionHashPatternSource,
            },
            blockNumber: blockNumberSchema,
            rawValue: rawAmountSchema,
            observedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    riskFacts: unavailableSchema,
  },
} as const;

export const approvalListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["walletId", "items", "summary", "freshness", "contractVersion"],
  properties: {
    walletId: opaqueIdSchema,
    items: { type: "array", maxItems: 500, items: approvalRowSchema },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["activeCount", "unlimitedCount"],
      properties: {
        activeCount: { type: "integer", minimum: 0 },
        unlimitedCount: { type: "integer", minimum: 0 },
      },
    },
    freshness: {
      type: "object",
      additionalProperties: false,
      required: [
        "indexerBlockNumber",
        "approvalCoverageFromBlockNumber",
        "headBlockNumber",
        "observedAt",
      ],
      properties: {
        indexerBlockNumber: blockNumberSchema,
        approvalCoverageFromBlockNumber: {
          ...blockNumberSchema,
          description:
            "First block from which Approval logs are stored contiguously up to indexerBlockNumber. The list is INDEXING_DELAYED while this is unknown or above the wallet's earliest indexed activity.",
        },
        headBlockNumber: blockNumberSchema,
        observedAt: dateTimeSchema,
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const approvalDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["walletId", "item", "contractVersion"],
  properties: {
    walletId: opaqueIdSchema,
    item: approvalRowSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const approvalsQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: { walletId: opaqueIdSchema },
} as const;

export const approvalDetailParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "spender"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    spender: addressSchema,
  },
} as const;

/**
 * The `detailsSafe.reasonCode` values a money-action `403 POLICY_BLOCKED`
 * may carry (Decisions 0035, 0065, 0071). The client picks its copy by this
 * code; the decimal-string figures are present only for the rules that
 * compared them.
 */
export const policyBlockedReasonCodes = [
  walletIntentRefusalReasonCodes.counterpartyNotInCanaryAllowlist,
  walletIntentRefusalReasonCodes.canaryCeilingExceeded,
  walletIntentRefusalReasonCodes.canaryDailyCeilingExceeded,
  walletIntentRefusalReasonCodes.assetNotInCanaryAllowlist,
  walletIntentRefusalReasonCodes.assetBlocked,
  walletIntentRefusalReasonCodes.unlimitedExposureExceedsCeiling,
  walletIntentRefusalReasonCodes.priceImpactBlocked,
] as const;

const policyBlockedErrorBase = v2ErrorResponseSchema(["POLICY_BLOCKED"]);

/**
 * `403 POLICY_BLOCKED` with a typed `detailsSafe`: the seven-field envelope
 * is unchanged, but the reason slot enumerates every rule that can refuse a
 * send, approval, revoke, or swap so the enumeration is part of the OpenAPI
 * surface rather than prose. `null` remains the shape of a 403 that no
 * money-action rule produced (for example a wallet-binding refusal).
 */
export const policyBlockedErrorSchema = {
  ...policyBlockedErrorBase,
  properties: {
    ...policyBlockedErrorBase.properties,
    detailsSafe: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reasonCode"],
          properties: {
            reasonCode: {
              type: "string",
              enum: [...policyBlockedReasonCodes],
              description:
                "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST: the send recipient or approve spender is outside the Development canary allowlist. CANARY_CEILING_EXCEEDED: one intent is worth more than ceilingUsd. CANARY_DAILY_CEILING_EXCEEDED: the rolling 24-hour total would exceed ceilingUsd; spentUsd and remainingUsd say how much is used and left. ASSET_NOT_IN_CANARY_ALLOWLIST: the asset is registered but not in the canary. ASSET_BLOCKED: the registry blocks the asset. UNLIMITED_EXPOSURE_EXCEEDS_CEILING: an unlimited approval, valued at the current balance, exceeds ceilingUsd. PRICE_IMPACT_BLOCKED: swap price impact at or above the hard limit.",
            },
            exposureUsd: {
              ...decimalAmountSchema,
              description:
                "USD value the rule compared: this intent's value (per-intent ceiling), the day's total including this intent (daily ceiling), or the unlimited approval's balance-based exposure.",
            },
            ceilingUsd: {
              ...decimalAmountSchema,
              description: "The ceiling that refused it, in USD.",
            },
            spentUsd: {
              ...decimalAmountSchema,
              description:
                "Daily ceiling only: USD already counted in the rolling 24-hour window before this intent.",
            },
            remainingUsd: {
              ...decimalAmountSchema,
              description:
                "Daily ceiling only: ceilingUsd minus spentUsd, floored at 0.",
            },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

export const walletIntentReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  403: policyBlockedErrorSchema,
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH", "VALIDATION_FAILED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "INDEXING_DELAYED",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export const walletIntentCommandErrors = {
  ...walletIntentReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "DATA_STALE",
    "QUOTE_EXPIRED",
    "SIMULATION_FAILED",
    "SUBMISSION_UNKNOWN",
  ]),
} as const;

/** Reads reject an Idempotency-Key. */
export const validateIntentReadHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2CommonRequestMetadata(request.raw.rawHeaders);
    if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

/**
 * A quote is a POST because it carries a body, but it creates no durable
 * state, so it takes the write metadata and rejects an Idempotency-Key.
 */
export const validateQuoteHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2WriteRequestMetadata(request.raw.rawHeaders);
    if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

/** Commands require exactly one canonical UUIDv4 Idempotency-Key. */
export const validateIntentCommandHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2CommandMetadata(request.raw.rawHeaders);
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

export function commandIdempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

export { v2CommandHeadersSchema, v2CommonHeadersSchema };
