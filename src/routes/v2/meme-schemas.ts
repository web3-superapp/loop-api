import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  evmAddressPatternSource,
  launchChainIds,
  transactionHashPatternSource,
} from "../../features/chain/chain-contract.js";
import {
  memeBestTradeWindows,
  memeCandleIntervals,
  memeIntentKinds,
  memeIntentStates,
  memeListTabs,
  memeRules,
  memeTokenStatuses,
} from "../../features/meme/meme-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { cursorSchema, nullableCursorSchema } from "./community-schemas.js";

/**
 * Route schemas of the MEME curve launchpad (Decision 0101). Every object
 * rejects unknown properties; raw amounts are 18-decimal base-unit integer
 * strings; prices, market caps, and volumes are USD1 decimal strings.
 */

const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,63}$",
} as const;
const uintStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
  description: "Raw 18-decimal base units as an integer string.",
} as const;
const nullableUintStringSchema = {
  anyOf: [uintStringSchema, { type: "null" }],
} as const;
const decimalStringSchema = {
  type: "string",
  pattern: "^-?(0|[1-9][0-9]{0,77})(\\.[0-9]{1,18})?$",
} as const;
const nullableDecimalStringSchema = {
  anyOf: [decimalStringSchema, { type: "null" }],
} as const;
const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
} as const;
const nullableAddressSchema = {
  anyOf: [addressSchema, { type: "null" }],
} as const;
const txHashSchema = {
  type: "string",
  pattern: transactionHashPatternSource,
} as const;
const nullableTxHashSchema = {
  anyOf: [txHashSchema, { type: "null" }],
} as const;
const bytes32Schema = { type: "string", pattern: "^0x[0-9a-f]{64}$" } as const;
const opaqueIdSchema = {
  type: "string",
  pattern: opaqueIdPatternSource,
} as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const contractVersionSchema = {
  type: "string",
  const: v2ContractVersion,
} as const;
const percentSchema = {
  anyOf: [
    { type: "string", pattern: "^-?(0|[1-9][0-9]{0,40})\\.[0-9]{2}$" },
    { type: "null" },
  ],
} as const;
const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "observedAt"],
  properties: {
    source: { type: "string", const: "loop_indexer" },
    observedAt: dateTimeSchema,
  },
} as const;

export const accountSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["publicProfileId", "displayName", "avatarRef"],
      properties: {
        publicProfileId: { type: "string", minLength: 1, maxLength: 64 },
        displayName: { anyOf: [{ type: "string" }, { type: "null" }] },
        avatarRef: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    { type: "null" },
  ],
  description:
    "The LOOP public profile behind the wallet, when an active one exists; null otherwise (show the wallet).",
} as const;

export const memeErrorDescription =
  "detailsSafe.reasonCode names the rule; see docs/frontend-v2-meme-api.md §6.";

export const memeReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export const memeCommandErrors = {
  ...memeReadErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "VERSION_CONFLICT",
  ]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

/**
 * Decision 0151: the two classic-launch create surfaces (draft, create
 * Intent) answer 410 while `MEME_CLASSIC_CREATE_ENABLED` is off.
 */
export const memeCreateCommandErrors = {
  ...memeCommandErrors,
  410: v2ErrorResponseSchema(["MEME_CLASSIC_LAUNCH_RETIRED"]),
} as const;

export const memeTokenIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memeTokenId"],
  properties: { memeTokenId: opaqueIdSchema },
} as const;

export const memeIntentParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memeTokenId", "memeIntentId"],
  properties: { memeTokenId: opaqueIdSchema, memeIntentId: opaqueIdSchema },
} as const;

export const memeIntentIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memeIntentId"],
  properties: { memeIntentId: opaqueIdSchema },
} as const;

const limitSchema = (maximum: number) =>
  ({ type: "integer", minimum: 1, maximum }) as const;

export const memeListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tab: { type: "string", enum: [...memeListTabs] },
    cursor: cursorSchema,
    limit: limitSchema(memeRules.listMaximumLimit),
  },
} as const;

export const memePageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: cursorSchema,
    limit: limitSchema(memeRules.pageMaximumLimit),
  },
} as const;

export const memeCandleQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interval: { type: "string", enum: Object.keys(memeCandleIntervals) },
    limit: limitSchema(memeRules.candleMaximumLimit),
  },
} as const;

const decimalInputSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,40})(\\.[0-9]{1,18})?$",
} as const;

export const memeQuoteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tokenId", "side", "amount"],
  properties: {
    tokenId: opaqueIdSchema,
    side: { type: "string", enum: ["buy", "sell"] },
    amount: {
      ...decimalInputSchema,
      description:
        "buy: USD1 to spend (fee included); sell: tokens to sell. Whole units, at most 18 decimals.",
    },
    walletId: {
      ...opaqueIdSchema,
      description:
        "Optional: the caller's wallet whose balance decides walletCapHit / walletCapRemaining.",
    },
  },
} as const;

const linksSchema = {
  type: "object",
  additionalProperties: false,
  required: ["twitter", "telegram", "website"],
  properties: {
    twitter: { anyOf: [{ type: "string" }, { type: "null" }] },
    telegram: { anyOf: [{ type: "string" }, { type: "null" }] },
    website: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

export const memeCreateRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "symbol"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
    symbol: { type: "string", pattern: "^[A-Z0-9]{2,10}$" },
    description: { type: "string", maxLength: 2_000 },
    imageMediaId: {
      ...opaqueIdSchema,
      description:
        "mediaId of a picture the caller uploaded through POST /v2/media/community-logos.",
    },
    links: {
      type: "object",
      additionalProperties: false,
      properties: {
        twitter: { type: "string", maxLength: 256 },
        telegram: { type: "string", maxLength: 256 },
        website: { type: "string", maxLength: 256 },
      },
    },
  },
} as const;

export const memeIntentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "walletId"],
  properties: {
    kind: { type: "string", enum: [...memeIntentKinds] },
    walletId: opaqueIdSchema,
    usd1Amount: {
      ...decimalInputSchema,
      description:
        "buy: required, USD1 to spend (fee included). create: optional first buy. sell: not allowed.",
    },
    tokenAmount: {
      ...decimalInputSchema,
      description: "sell: required, tokens to sell. Not allowed otherwise.",
    },
    minOut: {
      ...uintStringSchema,
      description:
        "Optional raw minimum output; mutually exclusive with slippageBps. Must not exceed the quote.",
    },
    slippageBps: {
      type: "integer",
      minimum: 0,
      maximum: memeRules.maximumSlippageBps,
      description: `Optional, default ${String(memeRules.defaultSlippageBps)}.`,
    },
    deadlineSeconds: {
      type: "integer",
      minimum: memeRules.intentMinimumDeadlineSeconds,
      maximum: memeRules.intentMaximumDeadlineSeconds,
      description: `Optional, default ${String(memeRules.intentDefaultDeadlineSeconds)}.`,
    },
  },
} as const;

export const memeIntentReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["txHash"],
  properties: {
    txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
  },
} as const;

const tokenRowProperties = {
  memeTokenId: opaqueIdSchema,
  tokenAddress: nullableAddressSchema,
  name: { type: "string" },
  symbol: { type: "string" },
  imageUrl: { anyOf: [{ type: "string", format: "uri" }, { type: "null" }] },
  creator: accountSchema,
  status: { type: "string", enum: [...memeTokenStatuses] },
  progressBps: { type: "integer", minimum: 0, maximum: 10_000 },
  priceUsd1: nullableDecimalStringSchema,
  marketCapUsd1: nullableDecimalStringSchema,
  change1hPct: percentSchema,
  volume24hUsd1: {
    ...decimalStringSchema,
    description:
      "Decision 0142: wallet-side USD1 of the curve buys and sells in the last 24 hours (now − 24 h, exclusive, to now), summed from the indexed Trade logs; reorged-out logs excluded. Curve (inner market) only: LOOP does not index DEX swaps of graduated classic MEME tokens, so a graduated token reads the curve trades of the window (usually 0 after graduation).",
  },
  holderCount: {
    type: "integer",
    minimum: 0,
    description:
      "Wallets with a positive net curve position (buys − sells); frozen at graduation; wallet-to-wallet transfers are not tracked.",
  },
  tradeCount: { type: "integer", minimum: 0 },
  createdAt: {
    ...dateTimeSchema,
    description:
      "Decision 0142: the chain creation time (the TokenCreated block time) once on chain; a draft or pending_chain token carries its draft creation time.",
  },
  graduatedAt: nullableDateTimeSchema,
  pool: nullableAddressSchema,
  priceSource: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["source", "observedAt"],
        properties: {
          source: {
            type: "string",
            enum: ["loop_curve", "dexscreener", "pool_slot0"],
            description:
              "loop_curve: the bonding-curve snapshot (not yet graduated). dexscreener: the graduated token's DexScreener pair (USD). pool_slot0 (Decision 0103): no DexScreener quote, so the price is derived from the graduated token's own PancakeSwap V3 pool slot0().sqrtPriceX96 (USD1 at par, 1.5 s cache); marketCapUsd1 is that price × 1e9.",
          },
          observedAt: dateTimeSchema,
        },
      },
      { type: "null" },
    ],
  },
  quoteUnavailable: {
    type: "object",
    additionalProperties: false,
    required: ["reasonCode"],
    properties: { reasonCode: reasonCodeSchema },
    description: "Present exactly when priceUsd1 is null.",
  },
} as const;

const tokenRowRequired = [
  "memeTokenId",
  "tokenAddress",
  "name",
  "symbol",
  "imageUrl",
  "creator",
  "status",
  "progressBps",
  "priceUsd1",
  "marketCapUsd1",
  "change1hPct",
  "volume24hUsd1",
  "holderCount",
  "tradeCount",
  "createdAt",
  "graduatedAt",
  "pool",
  "priceSource",
] as const;

export const memeTokenListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "tab",
    "items",
    "nextCursor",
    "rules",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    tab: { type: "string", enum: [...memeListTabs] },
    items: {
      type: "array",
      maxItems: memeRules.listMaximumLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...tokenRowRequired],
        properties: tokenRowProperties,
      },
    },
    nextCursor: nullableCursorSchema,
    rules: {
      type: "object",
      additionalProperties: false,
      required: [
        "configVersion",
        "effectiveAt",
        "graduatingProgressBps",
        "hotWindowSeconds",
      ],
      properties: {
        configVersion: { type: "string" },
        effectiveAt: dateTimeSchema,
        graduatingProgressBps: { type: "integer" },
        hotWindowSeconds: { type: "integer" },
      },
    },
    observedAt: dateTimeSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeTokenDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["memeToken", "contractVersion"],
  properties: {
    memeToken: {
      type: "object",
      additionalProperties: false,
      required: [
        ...tokenRowRequired,
        "description",
        "links",
        "metadataHash",
        "salt",
        "predictedAddress",
        "vanity",
        "curve",
        "contract",
        "viewer",
        "graduation",
        "source",
        "listing",
        "listingReason",
      ],
      properties: {
        ...tokenRowProperties,
        description: { type: "string" },
        links: linksSchema,
        metadataHash: bytes32Schema,
        salt: { anyOf: [bytes32Schema, { type: "null" }] },
        predictedAddress: nullableAddressSchema,
        vanity: { type: "boolean" },
        curve: {
          type: "object",
          additionalProperties: false,
          required: [
            "vUsd1",
            "vToken",
            "realUsd1",
            "sold",
            "saleSupply",
            "poolSupply",
            "totalSupply",
            "graduationUsd1Estimate",
            "tradeFeeBps",
            "walletCapTokens",
            "minBuyUsd1",
          ],
          properties: {
            vUsd1: uintStringSchema,
            vToken: uintStringSchema,
            realUsd1: uintStringSchema,
            sold: uintStringSchema,
            saleSupply: uintStringSchema,
            poolSupply: uintStringSchema,
            totalSupply: uintStringSchema,
            graduationUsd1Estimate: uintStringSchema,
            tradeFeeBps: { type: "integer" },
            walletCapTokens: uintStringSchema,
            minBuyUsd1: uintStringSchema,
          },
        },
        contract: {
          type: "object",
          additionalProperties: false,
          required: [
            "address",
            "version",
            "chainId",
            "chainReference",
            "explorerUrl",
          ],
          properties: {
            address: addressSchema,
            version: { type: "string" },
            chainId: { type: "string", enum: [...launchChainIds] },
            chainReference: { type: "integer", enum: [56, 97] },
            explorerUrl: {
              anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
            },
          },
        },
        viewer: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "walletId",
                "balance",
                "usd1Balance",
                "walletCapRemaining",
                "allowanceUsd1",
                "allowanceToken",
              ],
              properties: {
                walletId: opaqueIdSchema,
                balance: uintStringSchema,
                usd1Balance: uintStringSchema,
                walletCapRemaining: nullableUintStringSchema,
                allowanceUsd1: uintStringSchema,
                allowanceToken: uintStringSchema,
              },
            },
            { type: "null" },
          ],
        },
        viewerUnavailable: {
          type: "object",
          additionalProperties: false,
          required: ["reasonCode"],
          properties: { reasonCode: reasonCodeSchema },
          description:
            "Present when the token is on chain but the viewer block could not be read.",
        },
        graduation: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "pool",
                "lpBurnTx",
                "lpTokenId",
                "usd1ToPool",
                "tokensToPool",
                "feeUsd1",
                "at",
                "residual",
              ],
              properties: {
                pool: nullableAddressSchema,
                lpBurnTx: nullableTxHashSchema,
                lpTokenId: nullableUintStringSchema,
                usd1ToPool: nullableUintStringSchema,
                tokensToPool: nullableUintStringSchema,
                feeUsd1: nullableUintStringSchema,
                at: dateTimeSchema,
                residual: {
                  anyOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["usd1Left", "tokensLeft"],
                      properties: {
                        usd1Left: uintStringSchema,
                        tokensLeft: uintStringSchema,
                      },
                    },
                    { type: "null" },
                  ],
                  description:
                    "Decision 0103: non-null means the pool already existed at graduation and part of the funds stayed in the contract (only an operator can inject it). Rounding dust below 1 USD1 and below 1 token projects as null.",
                },
              },
            },
            { type: "null" },
          ],
        },
        source: sourceSchema,
        listing: {
          type: "string",
          enum: ["listed", "hidden"],
          description:
            "Decision 0102: `hidden` = the operator removed the token from the launchpad lists and category=meme; the detail stays readable. Show a hidden banner.",
        },
        listingReason: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["reasonCode", "reasonText"],
              properties: {
                reasonCode: {
                  anyOf: [
                    {
                      type: "string",
                      pattern: "^OPERATOR_[A-Z][A-Z0-9_]{0,63}$",
                      description:
                        "Decision 0105: the operator's reason as an upper-case catalog code, `OPERATOR_` + the console code (e.g. OPERATOR_USER_REPORTS).",
                    },
                    { type: "null" },
                  ],
                },
                reasonText: {
                  anyOf: [
                    { type: "string", minLength: 1, maxLength: 280 },
                    { type: "null" },
                  ],
                },
              },
            },
            { type: "null" },
          ],
          description:
            "Non-null exactly when `listing` is `hidden`: the operator's reason code and the user-facing sentence written in the console.",
        },
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeTradesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["memeTokenId", "items", "nextCursor", "source", "contractVersion"],
  properties: {
    memeTokenId: opaqueIdSchema,
    items: {
      type: "array",
      maxItems: memeRules.pageMaximumLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "txHash",
          "logIndex",
          "blockNumber",
          "wallet",
          "account",
          "isBuy",
          "usd1Amount",
          "tokenAmount",
          "feeUsd1",
          "priceAfter",
          "at",
        ],
        properties: {
          txHash: txHashSchema,
          logIndex: { type: "integer", minimum: 0 },
          blockNumber: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
          wallet: addressSchema,
          account: accountSchema,
          isBuy: { type: "boolean" },
          usd1Amount: {
            ...uintStringSchema,
            description:
              "Wallet side: a buy's paid USD1 (fee included, refund excluded); a sell's received USD1 (after fee).",
          },
          tokenAmount: uintStringSchema,
          feeUsd1: uintStringSchema,
          priceAfter: decimalStringSchema,
          at: dateTimeSchema,
        },
      },
    },
    nextCursor: nullableCursorSchema,
    source: sourceSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeCandlesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "memeTokenId",
    "interval",
    "items",
    "frozenAt",
    "source",
    "contractVersion",
  ],
  properties: {
    memeTokenId: opaqueIdSchema,
    interval: { type: "string", enum: Object.keys(memeCandleIntervals) },
    items: {
      type: "array",
      maxItems: memeRules.candleMaximumLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "openTime",
          "open",
          "high",
          "low",
          "close",
          "volumeUsd1",
          "tradeCount",
        ],
        properties: {
          openTime: dateTimeSchema,
          open: decimalStringSchema,
          high: decimalStringSchema,
          low: decimalStringSchema,
          close: decimalStringSchema,
          volumeUsd1: decimalStringSchema,
          tradeCount: { type: "integer", minimum: 1 },
        },
      },
    },
    frozenAt: nullableDateTimeSchema,
    source: sourceSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeHoldersResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "memeTokenId",
    "holderCount",
    "frozenAt",
    "items",
    "nextCursor",
    "source",
    "contractVersion",
  ],
  properties: {
    memeTokenId: opaqueIdSchema,
    holderCount: { type: "integer", minimum: 0 },
    frozenAt: nullableDateTimeSchema,
    items: {
      type: "array",
      maxItems: memeRules.pageMaximumLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "wallet",
          "account",
          "balance",
          "shareBps",
          "isCreator",
          "isViewer",
        ],
        properties: {
          wallet: addressSchema,
          account: accountSchema,
          balance: uintStringSchema,
          shareBps: { type: "integer", minimum: 0, maximum: 10_000 },
          isCreator: { type: "boolean" },
          isViewer: { type: "boolean" },
        },
      },
    },
    nextCursor: nullableCursorSchema,
    source: sourceSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeQuoteResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["quote", "basis", "contractVersion"],
  properties: {
    quote: {
      type: "object",
      additionalProperties: false,
      required: [
        "memeTokenId",
        "side",
        "amountIn",
        "out",
        "fee",
        "priceImpactBps",
        "priceBefore",
        "priceAfter",
        "minOutAtDefaultSlippage",
        "walletCapHit",
        "walletCapRemaining",
        "belowMinBuy",
      ],
      properties: {
        memeTokenId: opaqueIdSchema,
        side: { type: "string", enum: ["buy", "sell"] },
        amountIn: uintStringSchema,
        out: uintStringSchema,
        fee: uintStringSchema,
        refund: {
          ...uintStringSchema,
          description: "buy only: USD1 not taken when the buy fills the curve.",
        },
        priceImpactBps: { type: "integer", minimum: 0 },
        priceBefore: decimalStringSchema,
        priceAfter: decimalStringSchema,
        minOutAtDefaultSlippage: uintStringSchema,
        walletCapHit: { type: "boolean" },
        walletCapRemaining: nullableUintStringSchema,
        belowMinBuy: { type: "boolean" },
      },
    },
    basis: {
      type: "object",
      additionalProperties: false,
      required: ["source", "blockNumber", "observedAt"],
      properties: {
        source: { type: "string", enum: ["chain", "loop_indexer"] },
        blockNumber: {
          anyOf: [
            { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
            { type: "null" },
          ],
        },
        observedAt: dateTimeSchema,
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

const hexQuantityPattern = "^0x(0|[1-9a-f][0-9a-f]{0,63})$";
const nullableHexQuantitySchema = {
  anyOf: [{ type: "string", pattern: hexQuantityPattern }, { type: "null" }],
} as const;
const unsignedTransactionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "chainId",
    "to",
    "data",
    "value",
    "from",
    "gas",
    "nonce",
    "type",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "gasPrice",
  ],
  properties: {
    chainId: { type: "integer", enum: [56, 97] },
    to: addressSchema,
    data: { type: "string", pattern: "^0x([0-9a-f]{2})*$" },
    value: { type: "string", const: "0x0" },
    from: addressSchema,
    gas: { type: "string", pattern: hexQuantityPattern },
    nonce: { type: "string", pattern: hexQuantityPattern },
    type: { type: "string", enum: ["eip1559", "legacy"] },
    maxFeePerGas: nullableHexQuantitySchema,
    maxPriorityFeePerGas: nullableHexQuantitySchema,
    gasPrice: nullableHexQuantitySchema,
  },
} as const;
const calldataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to", "data", "value"],
  properties: {
    to: addressSchema,
    data: { type: "string", pattern: "^0x([0-9a-f]{2})*$" },
    value: { type: "string", const: "0" },
  },
} as const;

export const memeIntentResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["memeIntent", "contractVersion"],
  properties: {
    memeIntent: {
      type: "object",
      additionalProperties: false,
      required: [
        "memeIntentId",
        "kind",
        "state",
        "memeTokenId",
        "walletId",
        "chainId",
        "chainReference",
        "contractAddress",
        "tokenAddress",
        "usd1Amount",
        "tokenAmount",
        "expectedOut",
        "minOut",
        "fee",
        "refund",
        "deadline",
        "expiresAt",
        "createdAt",
        "calldata",
        "unsignedTransaction",
        "approval",
        "payloadDigest",
        "snapshotBlockNumber",
        "snapshotBlockHash",
        "transactionHash",
        "reasonCode",
        "simulation",
        "policy",
        "signing",
      ],
      properties: {
        memeIntentId: opaqueIdSchema,
        kind: { type: "string", enum: [...memeIntentKinds] },
        state: {
          type: "string",
          enum: [...memeIntentStates],
          description:
            "prepared → broadcast_reported → confirmed | failed | expired. An unreported Intent past expiresAt reads expired.",
        },
        memeTokenId: opaqueIdSchema,
        walletId: opaqueIdSchema,
        chainId: { type: "string", enum: [...launchChainIds] },
        chainReference: { type: "integer", enum: [56, 97] },
        contractAddress: addressSchema,
        tokenAddress: nullableAddressSchema,
        predictedAddress: {
          ...nullableAddressSchema,
          description: "create only: the CREATE2 address the token will get.",
        },
        usd1Amount: uintStringSchema,
        tokenAmount: uintStringSchema,
        expectedOut: uintStringSchema,
        minOut: uintStringSchema,
        fee: uintStringSchema,
        refund: uintStringSchema,
        deadline: dateTimeSchema,
        expiresAt: dateTimeSchema,
        createdAt: dateTimeSchema,
        calldata: calldataSchema,
        unsignedTransaction: unsignedTransactionSchema,
        approval: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "token",
                "spender",
                "amount",
                "calldata",
                "unsignedTransaction",
              ],
              properties: {
                token: addressSchema,
                spender: addressSchema,
                amount: uintStringSchema,
                calldata: calldataSchema,
                unsignedTransaction: unsignedTransactionSchema,
              },
            },
            { type: "null" },
          ],
          description:
            "Present when the allowance is short: sign this exact approve first (nonce N), then unsignedTransaction (nonce N+1).",
        },
        payloadDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        snapshotBlockNumber: {
          type: "string",
          pattern: "^(0|[1-9][0-9]{0,19})$",
        },
        snapshotBlockHash: bytes32Schema,
        transactionHash: nullableTxHashSchema,
        reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
        simulation: {
          type: "object",
          additionalProperties: false,
          required: ["status", "reasonCode"],
          properties: {
            status: {
              type: "string",
              enum: ["passed", "reverted", "unavailable"],
            },
            reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
          },
        },
        policy: {
          type: "object",
          additionalProperties: false,
          required: [
            "configVersion",
            "canaryMaxUsd",
            "valueUsd",
            "priceSource",
          ],
          properties: {
            configVersion: { type: "string" },
            canaryMaxUsd: { type: "string" },
            valueUsd: { type: "string" },
            priceSource: { type: "string" },
          },
        },
        signing: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "allowed", "reasonCode"],
          properties: {
            mode: { type: "string", const: "device_eth_send_transaction" },
            allowed: { type: "boolean" },
            reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
          },
        },
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const memeBestTradesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    window: {
      type: "string",
      enum: [...memeBestTradeWindows],
      description: "Optional, default 7d (the only window).",
    },
  },
} as const;

export const memeBestTradesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["window", "items", "observedAt", "contractVersion"],
  properties: {
    window: { type: "string", enum: [...memeBestTradeWindows] },
    items: {
      type: "array",
      maxItems: memeRules.bestTradesLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rank", "user", "token", "realizedUsd1", "observedAt"],
        properties: {
          rank: {
            type: "integer",
            minimum: 1,
            maximum: memeRules.bestTradesLimit,
          },
          user: {
            type: "object",
            additionalProperties: false,
            required: ["userId", "loopId", "alias", "avatar"],
            properties: {
              userId: {
                ...opaqueIdSchema,
                description:
                  "The public profile id (GET /v2/public-profiles/{publicProfileId}); never the internal account id.",
              },
              loopId: { type: "string", minLength: 1, maxLength: 64 },
              alias: { anyOf: [{ type: "string" }, { type: "null" }] },
              avatar: {
                anyOf: [{ type: "string" }, { type: "null" }],
                description:
                  "The stored avatarRef (avatar:media/{mediaId} or avatar:preset/*), rendered like the public profile's.",
              },
            },
          },
          token: {
            type: "object",
            additionalProperties: false,
            required: ["memeTokenId", "symbol", "logoUrl"],
            properties: {
              memeTokenId: opaqueIdSchema,
              symbol: { type: "string" },
              logoUrl: {
                anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
              },
            },
          },
          realizedUsd1: {
            ...decimalStringSchema,
            description:
              "USD1 received by the wallet's curve sells of this token in the window minus the sold tokens valued at the wallet's average curve buy price (all its buys up to observedAt, fee included; cost rounded up). Always positive.",
          },
          observedAt: {
            ...dateTimeSchema,
            description: "When the ranking was computed.",
          },
        },
      },
    },
    observedAt: dateTimeSchema,
    contractVersion: contractVersionSchema,
  },
} as const;
