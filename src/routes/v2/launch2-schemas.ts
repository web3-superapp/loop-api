import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  evmAddressPatternSource,
  launchChainIds,
  transactionHashPatternSource,
} from "../../features/chain/chain-contract.js";
import {
  launch2HoldReasons,
  launch2IntentKinds,
  launch2Stages,
} from "../../features/launch2/launch2-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { cursorSchema, nullableCursorSchema } from "./community-schemas.js";

/**
 * Route schemas of the MEME v2 read model (`launch2`, Decision 0114). Every
 * object rejects unknown properties. Amounts are human decimal strings with
 * at most 18 fraction digits (USD1 and MEME both have 18 decimals); block
 * numbers and counters are integer strings; never JSON numbers for money.
 */

const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,63}$",
} as const;
const nullableReasonCodeSchema = {
  anyOf: [reasonCodeSchema, { type: "null" }],
} as const;
const decimalSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,40})(\\.[0-9]{1,18})?$",
} as const;
const uintStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
} as const;
const nullableUintStringSchema = {
  anyOf: [uintStringSchema, { type: "null" }],
} as const;
const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
} as const;
const txHashSchema = {
  type: "string",
  pattern: transactionHashPatternSource,
} as const;
const nullableTxHashSchema = {
  anyOf: [txHashSchema, { type: "null" }],
} as const;
const bytes32Schema = { type: "string", pattern: "^0x[0-9a-f]{64}$" } as const;
const nullableBytes32Schema = {
  anyOf: [bytes32Schema, { type: "null" }],
} as const;
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
const stageSchema = { type: "string", enum: [...launch2Stages] } as const;

export const launch2ErrorDescription =
  "detailsSafe.reasonCode names the rule; see docs/frontend-v2-launch2-api.md §7.";

export const launch2ReadErrors = {
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

export const launch2CommandErrors = {
  ...launch2ReadErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "QUOTE_EXPIRED",
    "VERSION_CONFLICT",
  ]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export const launch2InstanceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instanceId"],
  properties: { instanceId: opaqueIdSchema },
} as const;

export const launch2ListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stage: stageSchema,
    cursor: cursorSchema,
    limit: { type: "string", pattern: "^[1-9][0-9]?$" },
  },
} as const;

export const launch2DetailQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { walletId: opaqueIdSchema },
} as const;

export const launch2PageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: cursorSchema,
    limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
  },
} as const;

export const launch2QuoteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["side", "amount", "walletId"],
  properties: {
    side: { type: "string", enum: ["buy", "sell"] },
    amount: decimalSchema,
    walletId: opaqueIdSchema,
    slippageBps: { type: "string", pattern: "^(0|[1-9][0-9]{0,3})$" },
  },
} as const;

export const launch2NftPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: { walletId: opaqueIdSchema },
} as const;

export const launch2TradePrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "side", "amount", "minOut", "deadline"],
  properties: {
    walletId: opaqueIdSchema,
    side: { type: "string", enum: ["buy", "sell"] },
    amount: {
      ...decimalSchema,
      description: "buy: USD1 in (tax included, = maxIn); sell: MEME in.",
    },
    minOut: {
      ...decimalSchema,
      description: "From the quote: buy MEME out / sell USD1 out floor.",
    },
    deadline: {
      ...dateTimeSchema,
      description:
        "The quote's deadline; past it the prepare is 409 QUOTE_EXPIRED.",
    },
  },
} as const;

const nftSaleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["priceUsd1", "soldCount", "startAt", "endAt"],
  properties: {
    priceUsd1: decimalSchema,
    soldCount: uintStringSchema,
    startAt: dateTimeSchema,
    endAt: dateTimeSchema,
  },
} as const;

const curveSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "saleSupply",
    "soldSupply",
    "soldBps",
    "reserveUsd1",
    "graduationReserveUsd1",
    "reserveBps",
    "priceUsd1",
  ],
  properties: {
    saleSupply: decimalSchema,
    soldSupply: decimalSchema,
    soldBps: { type: "integer", minimum: 0, maximum: 10_000 },
    reserveUsd1: decimalSchema,
    graduationReserveUsd1: decimalSchema,
    reserveBps: { type: "integer", minimum: 0, maximum: 10_000 },
    priceUsd1: decimalSchema,
  },
} as const;

const summaryProperties = {
  instanceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  launchId: bytes32Schema,
  chainId: { type: "string", enum: [...launchChainIds] },
  name: { type: "string", minLength: 1, maxLength: 64 },
  ticker: { type: "string", pattern: "^[A-Z0-9]{2,12}$" },
  logoUrl: { anyOf: [{ type: "string", maxLength: 2048 }, { type: "null" }] },
  memeAddress: addressSchema,
  stage: stageSchema,
  nextChangeAt: nullableDateTimeSchema,
  holdReason: {
    anyOf: [
      { type: "string", enum: [...launch2HoldReasons] },
      { type: "null" },
    ],
  },
  activatedAt: nullableDateTimeSchema,
  nftSale: nftSaleSchema,
  curve: curveSchema,
  graduatedAt: nullableDateTimeSchema,
} as const;
const summaryRequired = Object.keys(summaryProperties);

const instanceSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: summaryRequired,
  properties: summaryProperties,
} as const;

export const launch2InstanceListResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instances", "nextCursor", "contractVersion"],
  properties: {
    instances: { type: "array", maxItems: 50, items: instanceSummarySchema },
    nextCursor: nullableCursorSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

const buybackItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "buybackId",
    "outcome",
    "reasonCode",
    "usd1Spent",
    "memeDelivered",
    "minMemeOut",
    "referencePriceUsd1",
    "spotPriceUsd1",
    "executedAt",
    "transactionHash",
    "blockNumber",
  ],
  properties: {
    buybackId: opaqueIdSchema,
    outcome: { type: "string", enum: ["executed", "rejected"] },
    reasonCode: nullableReasonCodeSchema,
    usd1Spent: decimalSchema,
    memeDelivered: decimalSchema,
    minMemeOut: decimalSchema,
    referencePriceUsd1: decimalSchema,
    spotPriceUsd1: decimalSchema,
    executedAt: dateTimeSchema,
    transactionHash: txHashSchema,
    blockNumber: uintStringSchema,
  },
} as const;

const buybackSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "recipient",
    "paused",
    "executedCount",
    "totalUsd1",
    "totalMeme",
    "lastExecutedAt",
    "escrowRecordedUsd1",
    "escrowAvailableUsd1",
    "latest",
  ],
  properties: {
    recipient: addressSchema,
    paused: { type: "boolean" },
    executedCount: uintStringSchema,
    totalUsd1: decimalSchema,
    totalMeme: decimalSchema,
    lastExecutedAt: nullableDateTimeSchema,
    escrowRecordedUsd1: decimalSchema,
    escrowAvailableUsd1: decimalSchema,
    latest: { anyOf: [buybackItemSchema, { type: "null" }] },
  },
} as const;

const tradeItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "tradeId",
    "side",
    "traderAddress",
    "memeAmount",
    "usd1Gross",
    "usd1Net",
    "taxUsd1",
    "tradedAt",
    "transactionHash",
    "blockNumber",
  ],
  properties: {
    tradeId: opaqueIdSchema,
    side: { type: "string", enum: ["buy", "sell"] },
    traderAddress: addressSchema,
    memeAmount: decimalSchema,
    usd1Gross: decimalSchema,
    usd1Net: decimalSchema,
    taxUsd1: decimalSchema,
    tradedAt: dateTimeSchema,
    transactionHash: txHashSchema,
    blockNumber: uintStringSchema,
  },
} as const;

const positionCurveSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bought",
    "sold",
    "net",
    "cumulativeBought",
    "remainingQuota",
    "usd1Spent",
    "usd1Received",
    "taxUsd1",
  ],
  properties: {
    bought: decimalSchema,
    sold: decimalSchema,
    net: decimalSchema,
    cumulativeBought: decimalSchema,
    remainingQuota: decimalSchema,
    usd1Spent: decimalSchema,
    usd1Received: decimalSchema,
    taxUsd1: decimalSchema,
  },
} as const;

const positionNftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mintedTokenId", "held"],
  properties: {
    mintedTokenId: nullableUintStringSchema,
    held: { type: "integer", minimum: 0 },
  },
} as const;

const templateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "templateVersion",
    "memeTotalSupply",
    "curveSaleSupply",
    "initialLiquiditySupply",
    "graduationReserveUsd1",
    "curveBuyTaxBps",
    "curveSellTaxBps",
    "officialPoolTaxBps",
    "lpFee",
    "tickSpacing",
    "perAddressCap",
    "perAddressCapBps",
    "nftPriceUsd1",
    "nftSaleSeconds",
    "earlyRoundSeconds",
    "buybackOrderUsd1",
    "buybackMinIntervalSeconds",
  ],
  properties: {
    templateVersion: { type: "string", const: "hooks_launch_v1" },
    memeTotalSupply: decimalSchema,
    curveSaleSupply: decimalSchema,
    initialLiquiditySupply: decimalSchema,
    graduationReserveUsd1: decimalSchema,
    curveBuyTaxBps: { type: "integer" },
    curveSellTaxBps: { type: "integer" },
    officialPoolTaxBps: { type: "integer" },
    lpFee: { type: "integer" },
    tickSpacing: { type: "integer" },
    perAddressCap: decimalSchema,
    perAddressCapBps: { type: "integer" },
    nftPriceUsd1: decimalSchema,
    nftSaleSeconds: { type: "integer" },
    earlyRoundSeconds: { type: "integer" },
    buybackOrderUsd1: decimalSchema,
    buybackMinIntervalSeconds: { type: "integer" },
  },
} as const;

const contractNames = [
  "factory",
  "meme",
  "hook",
  "nft",
  "curve",
  "gate",
  "escrow",
  "snapshots",
  "graduationAdapter",
  "buybackAdapter",
  "priceRecorder",
  "buybackExecutor",
] as const;

const contractsSchema = {
  type: "object",
  additionalProperties: false,
  required: [...contractNames],
  properties: Object.fromEntries(
    contractNames.map((name) => [name, addressSchema]),
  ),
} as const;

const snapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "verification",
    "root",
    "dataHash",
    "cutoffBlockNumber",
    "cutoffBlockHash",
    "publishedAt",
    "earlyRoundEndsAt",
    "memberCount",
    "signers",
    "publication",
  ],
  properties: {
    status: { type: "string", enum: ["pending", "published"] },
    verification: {
      anyOf: [
        { type: "string", enum: ["pending", "verified", "mismatch"] },
        { type: "null" },
      ],
    },
    root: nullableBytes32Schema,
    dataHash: nullableBytes32Schema,
    cutoffBlockNumber: nullableUintStringSchema,
    cutoffBlockHash: nullableBytes32Schema,
    publishedAt: nullableDateTimeSchema,
    earlyRoundEndsAt: nullableDateTimeSchema,
    memberCount: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    signers: {
      anyOf: [
        { type: "array", maxItems: 2, items: addressSchema },
        { type: "null" },
      ],
    },
    publication: {
      description:
        "Decision 0118: the latest server-side 2-of-3 publication attempt (null until the publisher started one). `confirmed` = the publishing transaction is final; `verification` above stays the reproduction verdict.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "txHash", "cutoffBlock", "memberCount"],
          properties: {
            status: {
              type: "string",
              enum: ["pending", "broadcast", "confirmed", "failed", "mismatch"],
            },
            txHash: nullableTxHashSchema,
            cutoffBlock: uintStringSchema,
            memberCount: { type: "integer", minimum: 1 },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const graduationSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "graduatedAt",
        "officialPoolId",
        "hookAddress",
        "lpFee",
        "tickSpacing",
        "officialPoolTaxBps",
        "transactionHash",
      ],
      properties: {
        graduatedAt: dateTimeSchema,
        officialPoolId: bytes32Schema,
        hookAddress: addressSchema,
        lpFee: { type: "integer" },
        tickSpacing: { type: "integer" },
        officialPoolTaxBps: { type: "integer" },
        transactionHash: nullableTxHashSchema,
      },
    },
    { type: "null" },
  ],
} as const;

const viewerSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["walletId", "nft", "snapshot", "curve"],
      properties: {
        walletId: opaqueIdSchema,
        nft: positionNftSchema,
        snapshot: {
          type: "object",
          additionalProperties: false,
          required: ["member", "eligibleNow"],
          properties: {
            member: { type: "boolean" },
            eligibleNow: { type: "boolean" },
          },
        },
        curve: positionCurveSchema,
      },
    },
    { type: "null" },
  ],
} as const;

const detailProperties = {
  ...summaryProperties,
  viewerIsProjectOwner: { type: "boolean" },
  projectOwnerAddress: addressSchema,
  configVersion: { type: "integer", minimum: 1 },
  configHash: bytes32Schema,
  buybackRecipient: addressSchema,
  template: templateSchema,
  contracts: contractsSchema,
  snapshot: snapshotSchema,
  graduation: graduationSchema,
  buyback: buybackSummarySchema,
  recentTrades: { type: "array", maxItems: 20, items: tradeItemSchema },
  viewer: viewerSchema,
  projectedAt: dateTimeSchema,
} as const;

export const launch2InstanceDetailResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instance", "contractVersion"],
  properties: {
    instance: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(detailProperties),
      properties: detailProperties,
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2QuoteResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quote", "contractVersion"],
  properties: {
    quote: {
      type: "object",
      additionalProperties: false,
      required: [
        "instanceId",
        "walletId",
        "side",
        "stage",
        "requestedAmount",
        "exceedsMax",
        "amountIn",
        "maxIn",
        "expectedOut",
        "minOut",
        "slippageBps",
        "taxUsd1",
        "taxBps",
        "refundUsd1",
        "priceBeforeUsd1",
        "priceAfterUsd1",
        "max",
        "quota",
        "inventory",
        "eligibility",
        "deadline",
        "quotedAt",
        "basis",
      ],
      properties: {
        instanceId: opaqueIdSchema,
        walletId: opaqueIdSchema,
        side: { type: "string", enum: ["buy", "sell"] },
        stage: stageSchema,
        requestedAmount: decimalSchema,
        exceedsMax: { type: "boolean" },
        amountIn: decimalSchema,
        maxIn: decimalSchema,
        expectedOut: decimalSchema,
        minOut: decimalSchema,
        slippageBps: { type: "integer", minimum: 0, maximum: 5_000 },
        taxUsd1: decimalSchema,
        taxBps: { type: "integer" },
        refundUsd1: decimalSchema,
        priceBeforeUsd1: decimalSchema,
        priceAfterUsd1: decimalSchema,
        max: {
          type: "object",
          additionalProperties: false,
          required: ["amountIn", "amountOut", "limitedBy"],
          properties: {
            amountIn: decimalSchema,
            amountOut: decimalSchema,
            limitedBy: {
              type: "string",
              enum: ["quota", "inventory", "balance", "sold_supply", "closed"],
            },
          },
        },
        quota: {
          type: "object",
          additionalProperties: false,
          required: ["capMeme", "usedMeme", "remainingMeme"],
          properties: {
            capMeme: decimalSchema,
            usedMeme: decimalSchema,
            remainingMeme: decimalSchema,
          },
        },
        inventory: {
          type: "object",
          additionalProperties: false,
          required: ["saleSupply", "soldSupply", "remainingMeme"],
          properties: {
            saleSupply: decimalSchema,
            soldSupply: decimalSchema,
            remainingMeme: decimalSchema,
          },
        },
        eligibility: {
          type: "object",
          additionalProperties: false,
          required: ["required", "eligible", "reasonCode"],
          properties: {
            required: { type: "boolean" },
            eligible: { anyOf: [{ type: "boolean" }, { type: "null" }] },
            reasonCode: nullableReasonCodeSchema,
          },
        },
        deadline: dateTimeSchema,
        quotedAt: dateTimeSchema,
        basis: {
          type: "object",
          additionalProperties: false,
          required: ["blockNumber", "blockHash"],
          properties: {
            blockNumber: uintStringSchema,
            blockHash: bytes32Schema,
          },
        },
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2BuybacksResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "summary",
    "live",
    "liveUnavailable",
    "buybacks",
    "nextCursor",
    "contractVersion",
  ],
  properties: {
    instanceId: opaqueIdSchema,
    summary: buybackSummarySchema,
    live: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "paused",
            "lastSuccessfulAt",
            "escrowRecordedUsd1",
            "escrowSpentUsd1",
            "escrowAvailableUsd1",
            "nextOrderUsd1",
            "nextOrderBlockedReason",
          ],
          properties: {
            paused: { type: "boolean" },
            lastSuccessfulAt: nullableDateTimeSchema,
            escrowRecordedUsd1: decimalSchema,
            escrowSpentUsd1: decimalSchema,
            escrowAvailableUsd1: decimalSchema,
            nextOrderUsd1: { anyOf: [decimalSchema, { type: "null" }] },
            nextOrderBlockedReason: nullableReasonCodeSchema,
          },
        },
        { type: "null" },
      ],
    },
    liveUnavailable: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reasonCode"],
          properties: { reasonCode: reasonCodeSchema },
        },
        { type: "null" },
      ],
    },
    buybacks: { type: "array", maxItems: 100, items: buybackItemSchema },
    nextCursor: nullableCursorSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2PositionsResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["positions", "contractVersion"],
  properties: {
    positions: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "instanceId",
          "name",
          "ticker",
          "logoUrl",
          "memeAddress",
          "stage",
          "walletId",
          "nft",
          "snapshotMember",
          "curve",
          "lastActivityAt",
        ],
        properties: {
          instanceId: opaqueIdSchema,
          name: { type: "string" },
          ticker: { type: "string" },
          logoUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
          memeAddress: addressSchema,
          stage: stageSchema,
          walletId: opaqueIdSchema,
          nft: positionNftSchema,
          snapshotMember: { type: "boolean" },
          curve: positionCurveSchema,
          lastActivityAt: nullableDateTimeSchema,
        },
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

const jsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const launch2IntentResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["launch2Intent", "contractVersion"],
  properties: {
    launch2Intent: {
      type: "object",
      additionalProperties: false,
      required: [
        "intentId",
        "kind",
        "state",
        "instanceId",
        "walletId",
        "chainId",
        "chainReference",
        "contractAddress",
        "amountIn",
        "expectedOut",
        "minOut",
        "taxUsd1",
        "refundUsd1",
        "deadline",
        "expiresAt",
        "createdAt",
        "calldata",
        "unsignedTransaction",
        "approval",
        "payloadDigest",
        "snapshotBlockNumber",
        "snapshotBlockHash",
        "simulation",
        "policy",
        "signing",
      ],
      properties: {
        intentId: opaqueIdSchema,
        kind: { type: "string", enum: [...launch2IntentKinds] },
        state: { type: "string", enum: ["prepared", "expired"] },
        instanceId: opaqueIdSchema,
        walletId: opaqueIdSchema,
        chainId: { type: "string", enum: [...launchChainIds] },
        chainReference: { type: "integer" },
        contractAddress: addressSchema,
        amountIn: decimalSchema,
        expectedOut: decimalSchema,
        minOut: decimalSchema,
        taxUsd1: decimalSchema,
        refundUsd1: decimalSchema,
        deadline: dateTimeSchema,
        expiresAt: dateTimeSchema,
        createdAt: dateTimeSchema,
        calldata: {
          type: "object",
          additionalProperties: false,
          required: ["to", "data", "value"],
          properties: {
            to: addressSchema,
            data: { type: "string", pattern: "^0x[0-9a-f]*$" },
            value: { type: "string", const: "0" },
          },
        },
        unsignedTransaction: jsonObjectSchema,
        approval: { anyOf: [jsonObjectSchema, { type: "null" }] },
        payloadDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        snapshotBlockNumber: uintStringSchema,
        snapshotBlockHash: bytes32Schema,
        simulation: {
          type: "object",
          additionalProperties: false,
          required: ["status", "reasonCode"],
          properties: {
            status: {
              type: "string",
              enum: ["passed", "reverted", "unavailable"],
            },
            reasonCode: nullableReasonCodeSchema,
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
            priceSource: { type: "string", const: "usd1_par" },
          },
        },
        signing: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "allowed", "reasonCode"],
          properties: {
            mode: { type: "string", const: "device_eth_send_transaction" },
            allowed: { type: "boolean" },
            reasonCode: nullableReasonCodeSchema,
          },
        },
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;
