import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";

/**
 * Decision 0128 route schemas: `GET` / `POST /v2/testnet/faucet`. Amounts
 * are decimal strings (`"0.02"` tBNB, `"500"` USD1), never JSON numbers.
 */

const opaqueIdSchema = {
  type: "string",
  pattern: opaqueIdPatternSource,
} as const;
const addressSchema = {
  type: "string",
  pattern: "^0x[0-9a-f]{40}$",
} as const;
const txHashSchema = {
  type: "string",
  pattern: "^0x[0-9a-f]{64}$",
} as const;
const nullableTxHashSchema = {
  anyOf: [txHashSchema, { type: "null" }],
} as const;
const decimalSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,18})?$",
} as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const testnetFaucetQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: { walletId: opaqueIdSchema },
} as const;

export const testnetFaucetGrantRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: { walletId: opaqueIdSchema },
} as const;

export const testnetFaucetStatusResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "address",
    "bnbAmount",
    "usd1Amount",
    "cooldownSeconds",
    "available",
    "nextAvailableAt",
    "lastGrant",
  ],
  properties: {
    walletId: opaqueIdSchema,
    address: addressSchema,
    bnbAmount: decimalSchema,
    usd1Amount: decimalSchema,
    cooldownSeconds: { type: "integer", minimum: 60, maximum: 2_592_000 },
    available: {
      type: "boolean",
      description:
        "Cooldown only: false while a grant of this address (pending, granted, partial, unknown) is younger than cooldownSeconds, while an attempted failed grant is younger than TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS (S169), or once the owner has 5 attempted failures in the UTC day. Operator funds and the global daily caps are checked by the POST.",
    },
    nextAvailableAt: {
      anyOf: [dateTimeSchema, { type: "null" }],
      description: "null while available.",
    },
    lastGrant: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["grantedAt", "bnbTransactionHash", "usd1TransactionHash"],
          properties: {
            grantedAt: dateTimeSchema,
            bnbTransactionHash: txHashSchema,
            usd1TransactionHash: {
              ...nullableTxHashSchema,
              description:
                "null when the USD1 mint of that grant did not go out (TESTNET_FAUCET_PARTIAL / TESTNET_FAUCET_SUBMISSION_UNKNOWN).",
            },
          },
        },
        { type: "null" },
      ],
      description:
        "The newest grant of this address whose tBNB transfer was sent; null when none.",
    },
  },
} as const;

const legSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "transactionHash"],
  properties: { amount: decimalSchema, transactionHash: txHashSchema },
} as const;

export const testnetFaucetGrantResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "address",
    "bnb",
    "usd1",
    "grantedAt",
    "nextAvailableAt",
  ],
  properties: {
    walletId: opaqueIdSchema,
    address: addressSchema,
    bnb: legSchema,
    usd1: legSchema,
    grantedAt: dateTimeSchema,
    nextAvailableAt: dateTimeSchema,
  },
} as const;

export const testnetFaucetReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  403: v2ErrorResponseSchema(["PERMISSION_DENIED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export const testnetFaucetCommandErrors = {
  ...testnetFaucetReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "RESOURCE_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
  502: v2ErrorResponseSchema(["PROVIDER_UNREACHABLE"]),
} as const;
