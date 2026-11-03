import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import {
  anyCaseEvmAddressPatternSource,
  chainIdPatternSource,
} from "../../features/chain/chain-contract.js";
import {
  dappRpcLogsMaximumBlockSpan,
  dappRpcReadMethods,
} from "../../features/dapp-browser/rpc-read-service.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { dappReasonCodes } from "../../features/wallet-intents/intent-contract.js";
import {
  walletIntentCommandErrors,
  walletIntentReadErrors,
} from "./wallet-intents-schemas.js";

/**
 * Route schemas of the DApp browser (Decision 0197, S342): the two prepare
 * bodies, the signature report, and the read-only RPC proxy.
 */

const opaqueIdSchema = {
  type: "string",
  pattern: opaqueIdPatternSource,
} as const;

const originSchema = {
  type: "string",
  minLength: 9,
  maxLength: 256,
  description:
    "The page's origin (scheme://host[:port]). Only https is accepted: http is 422 VALIDATION_FAILED / ORIGIN_NOT_HTTPS; a path, query, fragment or credentials is INVALID_REQUEST. Normalised (lower-case host, punycode, default port dropped) before it is bound.",
} as const;

const signingChainIdSchema = {
  type: "string",
  pattern: chainIdPatternSource,
  description:
    "The launch slot's testnet (eip155:97). eip155:56 is 422 VALIDATION_FAILED / CHAIN_SIGNING_DISABLED (BSC Mainnet signing stays closed, docs/00 rule 8); any other chain is CHAIN_MISMATCH.",
} as const;

export const dappTxPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "chainId", "origin", "tx"],
  properties: {
    walletId: opaqueIdSchema,
    chainId: signingChainIdSchema,
    origin: originSchema,
    tx: {
      type: "object",
      additionalProperties: false,
      required: ["to"],
      properties: {
        to: {
          type: "string",
          pattern: anyCaseEvmAddressPatternSource,
          description:
            "Target address. Contract creation (no `to`) is not supported.",
        },
        data: {
          type: "string",
          pattern: "^0x([0-9a-fA-F]{2})*$",
          maxLength: 20_002,
          description: "Calldata, at most 10,000 bytes. Defaults to 0x.",
        },
        value: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{1,64}$",
          description:
            "Native value in wei as the JSON-RPC hex quantity the page sent. Defaults to 0x0.",
        },
      },
      description:
        "The page's eth_sendTransaction object reduced to to / data / value. from is the wallet; gas, fees and nonce are bound by the server and anything else the page sent is dropped by the client.",
    },
  },
} as const;

export const dappSignPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "chainId", "origin", "method", "payload"],
  properties: {
    walletId: opaqueIdSchema,
    chainId: signingChainIdSchema,
    origin: originSchema,
    method: {
      type: "string",
      enum: ["personal_sign", "eth_signTypedData_v4"],
      description:
        "eth_sign (raw hash) and eth_signTransaction are never accepted.",
    },
    payload: {
      type: "string",
      minLength: 1,
      maxLength: 32_768,
      description:
        "personal_sign: the message param exactly as the page sent it (0x hex = raw bytes, anything else = UTF-8 text; at most 16,384 bytes). eth_signTypedData_v4: the typed-data JSON string param. A domain.chainId different from chainId is 422 VALIDATION_FAILED / TYPED_DATA_CHAIN_MISMATCH; a payload that does not hash under EIP-712 is TYPED_DATA_INVALID.",
    },
  },
} as const;

export const signatureReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["signature"],
  properties: {
    signature: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{130}$",
      description:
        "The 65-byte signature the embedded wallet returned. The server ecrecovers it over the reviewed signatureRequest; only its SHA-256 is kept (audit event), never the signature.",
    },
  },
} as const;

export const rpcReadRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chainId", "method"],
  properties: {
    chainId: {
      type: "string",
      pattern: chainIdPatternSource,
      description:
        "eip155:56 or the launch slot's chain (eip155:97); any other chain is CHAIN_MISMATCH.",
    },
    method: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: `One of ${dappRpcReadMethods.join(", ")}; anything else is 422 VALIDATION_FAILED / ${dappReasonCodes.rpcMethodNotAllowed}.`,
    },
    params: {
      type: "array",
      maxItems: 3,
      description: `JSON-RPC params, checked per method (call objects take from / to / data / input / value / gas / fee fields only; no state overrides). eth_getLogs: blockHash alone, or fromBlock / toBlock spanning at most ${dappRpcLogsMaximumBlockSpan.toString(10)} blocks (422 VALIDATION_FAILED / ${dappReasonCodes.rpcLogRangeTooLarge}), at most 20 addresses and 4 topic positions. eth_getBlockByNumber: [block, fullTransactions?]. eth_feeHistory: [blockCount 1…1024, block, rewardPercentiles? (≤ 100 non-decreasing numbers in 0…100)]. Defaults to [].`,
    },
  },
} as const;

export const rpcReadResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["chainId", "method", "result", "error", "contractVersion"],
  properties: {
    chainId: { type: "string", pattern: chainIdPatternSource },
    method: { type: "string", enum: [...dappRpcReadMethods] },
    result: {
      description:
        "The node's JSON-RPC result verbatim (any JSON); null when error is set.",
    },
    error: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "data"],
          properties: {
            code: { type: "integer" },
            message: { type: "string", maxLength: 256 },
            data: {
              description:
                "The node's error data verbatim (for an eth_call revert, the revert bytes).",
            },
          },
        },
        { type: "null" },
      ],
      description:
        "The JSON-RPC error the node answered (e.g. code 3 execution reverted). The App hands it to the page as the EIP-1193 error.",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/** Read errors plus 429 for the per-account window. */
export const rpcReadErrors = {
  ...walletIntentReadErrors,
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

/**
 * S346 (Decision 0197 amendment): the two prepares add 409
 * RESOURCE_CONFLICT / INTENT_BUSY — a send / swap / approve / send_nft is
 * open on the wallet and a DApp prepare does not supersede it.
 */
export const dappPrepareErrors = {
  ...walletIntentCommandErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "DATA_STALE",
    "QUOTE_EXPIRED",
    "SIMULATION_FAILED",
    "SUBMISSION_UNKNOWN",
    "RESOURCE_CONFLICT",
  ]),
} as const;

/**
 * Decision 0197: `detailsSafe.reasonCode` values of the DApp browser. 422
 * VALIDATION_FAILED: CHAIN_SIGNING_DISABLED, TYPED_DATA_CHAIN_MISMATCH,
 * TYPED_DATA_INVALID, ORIGIN_NOT_HTTPS, SIGNATURE_MISMATCH,
 * RPC_METHOD_NOT_ALLOWED, RPC_LOG_RANGE_TOO_LARGE. 503
 * CAPABILITY_UNAVAILABLE: DAPP_BROWSER_DISABLED,
 * DAPP_BROWSER_CHAIN_UNAVAILABLE, RPC_UPSTREAM_LIMITED (S346). 409
 * RESOURCE_CONFLICT: INTENT_BUSY (S346).
 */
export const dappBrowserErrorReasonCodes = Object.freeze([
  dappReasonCodes.chainSigningDisabled,
  dappReasonCodes.typedDataChainMismatch,
  dappReasonCodes.typedDataInvalid,
  dappReasonCodes.originNotHttps,
  dappReasonCodes.signatureMismatch,
  dappReasonCodes.rpcMethodNotAllowed,
  dappReasonCodes.rpcLogRangeTooLarge,
  dappReasonCodes.disabled,
  dappReasonCodes.chainUnavailable,
  dappReasonCodes.rpcUpstreamLimited,
  dappReasonCodes.intentBusy,
] as const);
