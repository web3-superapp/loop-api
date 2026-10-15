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
import { launch2ActivityKinds } from "../../features/launch2/launch2-ports.js";
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
        "The quote's deadline (quote time + LAUNCH2_QUOTE_TTL_SECONDS, the freshness check): past it the prepare is 409 QUOTE_EXPIRED, more than 600 s ahead 422 LAUNCH2_DEADLINE_TOO_FAR. Decision 0126: the encoded on-chain deadline (and the intent's deadline / expiresAt) is max(this, prepare time + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS, default 180 s), so two device signatures (approve + trade) fit.",
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
    endAt: {
      ...dateTimeSchema,
      description:
        "Decision 0119: the instance's ProjectNFT.saleEnd() verified at deployment (start + the Factory's nftSaleDuration(): 1 hour on the BSC Testnet Factory, 7 days on mainnet). Not a template constant.",
    },
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
  summary: {
    description:
      "Decision 0138: the project description (whitespace collapsed) cut to 60 Unicode characters, with … appended when longer; null when empty or no project config joins.",
    anyOf: [{ type: "string", minLength: 1, maxLength: 61 }, { type: "null" }],
  },
  links: {
    description:
      "Decision 0138: the project's saved links verbatim, http(s) URLs only, at most 5; [] when none or no project config joins.",
    type: "array",
    maxItems: 5,
    items: { type: "string", minLength: 1, maxLength: 2048 },
  },
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

const overviewActivitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "instanceId",
    "ticker",
    "name",
    "logoUrl",
    "actor",
    "amountUsd1",
    "at",
    "transactionHash",
  ],
  properties: {
    kind: { type: "string", enum: [...launch2ActivityKinds] },
    instanceId: opaqueIdSchema,
    ticker: summaryProperties.ticker,
    name: summaryProperties.name,
    logoUrl: summaryProperties.logoUrl,
    actor: {
      description:
        "The full 0x address; null for platform actions (graduated, buyback, round_activated) and for anonymous official-pool swaps (Decision 0132: not through LoopRouter / OfficialPoolRouter attribution).",
      anyOf: [addressSchema, { type: "null" }],
    },
    amountUsd1: {
      description:
        "curve_buy = USD1 paid (tax included), curve_sell = USD1 received, nft_mint = the mint price (100), buyback = USD1 spent, reward_claimed = USD1 claimed; null for graduated and round_activated.",
      anyOf: [decimalSchema, { type: "null" }],
    },
    at: dateTimeSchema,
    transactionHash: nullableTxHashSchema,
  },
} as const;

const countSchema = { type: "integer", minimum: 0 } as const;

/** Decision 0139: `GET /v2/launch2/overview`. */
/** Decision 0140: `GET /v2/launch2/campaigns`. */
export const launch2CampaignListResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "observedAt", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "campaignId",
          "title",
          "subtitle",
          "coverUrl",
          "startsAt",
          "endsAt",
          "ctaLabel",
          "link",
          "pinned",
          "sortOrder",
          "state",
        ],
        properties: {
          campaignId: { type: "string", format: "uuid" },
          title: { type: "string", minLength: 1, maxLength: 24 },
          subtitle: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 60 },
              { type: "null" },
            ],
          },
          coverUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: "string", format: "date-time" },
          ctaLabel: { type: "string", minLength: 1, maxLength: 8 },
          link: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { type: "string", enum: ["route", "url"] },
              value: { type: "string", minLength: 1, maxLength: 1024 },
            },
          },
          pinned: { type: "boolean" },
          sortOrder: { type: "integer" },
          state: { type: "string", enum: ["live", "upcoming"] },
        },
      },
    },
    observedAt: { type: "string", format: "date-time" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const launch2OverviewResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["activity", "stats", "observedAt", "contractVersion"],
  properties: {
    activity: {
      type: "array",
      maxItems: 30,
      items: overviewActivitySchema,
    },
    stats: {
      type: "object",
      additionalProperties: false,
      required: [
        "liveCount",
        "mintingCount",
        "priorityCount",
        "curveCount",
        "upcomingCount",
        "graduatedTotal",
        "graduatedThisWeek",
        "buybackUsd1Total",
        "nftMintedTotal",
      ],
      properties: {
        liveCount: {
          ...countSchema,
          description: "Instances in nft_sale, priority or public.",
        },
        mintingCount: { ...countSchema, description: "Stage nft_sale." },
        priorityCount: { ...countSchema, description: "Stage priority." },
        curveCount: { ...countSchema, description: "Stage public." },
        upcomingCount: { ...countSchema, description: "Stage upcoming." },
        graduatedTotal: { ...countSchema, description: "Stage graduated." },
        graduatedThisWeek: {
          ...countSchema,
          description:
            "Graduated instances whose graduatedAt is at or after the server's UTC Monday 00:00 of the current week.",
        },
        buybackUsd1Total: decimalSchema,
        nftMintedTotal: countSchema,
      },
    },
    observedAt: dateTimeSchema,
    contractVersion: contractVersionSchema,
  },
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
    minMemeOut: {
      description:
        "Decision 0122: the v2 (price-protected) executor's protected minimum; null for a v3 execution (no price protection, minOut 0).",
      anyOf: [decimalSchema, { type: "null" }],
    },
    referencePriceUsd1: {
      description:
        "Decision 0122: v2 executors only (30-minute reference price); null for v3.",
      anyOf: [decimalSchema, { type: "null" }],
    },
    spotPriceUsd1: {
      description: "Decision 0122: v2 executors only; null for v3.",
      anyOf: [decimalSchema, { type: "null" }],
    },
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
    keeper: {
      description:
        "Decision 0121 (optional, additive): the server-side buyback keeper's newest attempt; null before the keeper ever simulated this instance. `lastResult` rejected = the contract refused the simulation (nothing sent; `reasonCode` says why, e.g. LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE / LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION / LAUNCH2_BUYBACK_PAUSED); pending / broadcast = a transaction in flight; confirmed = final on chain (the ledger row follows from the event lane); failed = sent or prepared but not executed. `nextEligibleAt` = earliest next try (null while in flight). Advisory only: the ledger (`latest`, `executedCount`) stays the source of truth.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "lastAttemptAt",
            "lastResult",
            "reasonCode",
            "nextEligibleAt",
          ],
          properties: {
            lastAttemptAt: dateTimeSchema,
            lastResult: {
              type: "string",
              enum: ["rejected", "pending", "broadcast", "confirmed", "failed"],
            },
            reasonCode: nullableReasonCodeSchema,
            nextEligibleAt: nullableDateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
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
    nftSaleSeconds: {
      type: "integer",
      description:
        "Decision 0119: this instance's NFT sale period (nftSale.endAt − startAt): 3600 on the BSC Testnet Factory, 604800 on mainnet.",
    },
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
    "closure",
  ],
  properties: {
    status: {
      description:
        "pending = no snapshot yet; published = SnapshotPublished indexed; opened_without_holders (Decision 0122, v3 Factory) = the NFT sale ended with no mint and the public round opened without a snapshot (root / dataHash / cutoff / memberCount / signers null, earlyRoundEndsAt = the opening time).",
      type: "string",
      enum: ["pending", "published", "opened_without_holders"],
    },
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
        "Decision 0118: the latest server-side 2-of-3 publication attempt (null until the publisher started one, and null for a zero-holder opening — Decision 0122). `confirmed` = the publishing transaction is final; `verification` above stays the reproduction verdict.",
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
    closure: {
      description:
        "Deprecated (Decision 0122). Decision 0120: non-null when the NFT sale ended with no holder (ProjectNFT.totalMinted() = 0 at the confirmed cutoff block) on a v2-generation Factory instance, which cannot open without a snapshot; stage closed_no_holders (terminal). Never produced for v3 instances (see openedWithoutHolders).",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reason", "cutoffBlock", "closedAt"],
          properties: {
            reason: { type: "string", const: "no_holders" },
            cutoffBlock: uintStringSchema,
            closedAt: dateTimeSchema,
          },
        },
        { type: "null" },
      ],
    },
    openedWithoutHolders: {
      description:
        "Decision 0122 (optional in the schema, always present in answers): non-null after the indexed PublicRoundOpenedWithoutHolders (v3 Factory) — the sale ended with no mint, the public round opened at openedAt with no early round; stage public.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["openedAt", "blockNumber", "transactionHash"],
          properties: {
            openedAt: dateTimeSchema,
            blockNumber: uintStringSchema,
            transactionHash: txHashSchema,
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

/**
 * Decision 0126: the wallet's live ERC-20 balances of a graduated instance
 * (MEME and the instance's USD1), read at one block of the launch slot and
 * cached ≤ 15 s per (instance, wallet). Before graduation (curve phase)
 * the balances are null with balanceStatus not_graduated — the curve block
 * is the position there. A failed read is null with balanceStatus
 * unavailable and balanceReasonCode (never a guessed 0).
 */
const walletHoldingProperties = {
  memeBalance: {
    anyOf: [decimalSchema, { type: "null" }],
    description:
      "Decision 0126: MEME ERC-20 balanceOf(wallet) at balanceBlockNumber (graduated instances only; null otherwise or when the read failed).",
  },
  usd1Balance: {
    anyOf: [decimalSchema, { type: "null" }],
    description:
      "Decision 0126: the instance USD1 (CurveEngine.usd1()) balanceOf(wallet) at the same block; null like memeBalance.",
  },
  balanceStatus: {
    type: "string",
    enum: ["available", "not_graduated", "unavailable"],
    description:
      "available: both balances read at balanceBlockNumber; not_graduated: curve phase (balances null, use curve); unavailable: the chain read failed or the launch slot is not configured (balanceReasonCode).",
  },
  balanceReasonCode: {
    ...nullableReasonCodeSchema,
    description:
      "unavailable only: LAUNCH2_CHAIN_READ_FAILED | LAUNCH2_CHAIN_NOT_CONFIGURED; else null.",
  },
  balanceBlockNumber: nullableUintStringSchema,
  poolTradeCount: {
    ...uintStringSchema,
    description:
      'Decision 0126: the wallet\'s own official-pool trades the launch2_event lane attributed through OfficialPoolRouter Swap(payer) ("0" before graduation). Use it — not pool.tradeCount — as the confirmation signal after a pool trade.',
  },
  lastPoolTradeAt: {
    ...nullableDateTimeSchema,
    description: "Block time of the wallet's newest attributed pool trade.",
  },
} as const;
const walletHoldingRequired = Object.keys(walletHoldingProperties);

const viewerSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "walletId",
        "nft",
        "snapshot",
        "curve",
        ...walletHoldingRequired,
      ],
      properties: {
        ...walletHoldingProperties,
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

const poolSummarySchema = {
  description:
    "Decision 0124 (optional in the schema, always present in answers): the official Uniswap v4 pool after graduation, from the PoolManager Swap logs of officialPoolId the launch2_event lane indexed (every swap of the pool: the in-App router, the buyback executor and any other caller). null before graduation. Volumes are the USD1 side (buy: USD1 in; sell: USD1 out before tax); taxUsd1 is the 2 % taken from sells, taxMeme from buys (exact-output swaps may be 1 wei off, see docs/frontend-v2-launch2-api.md §pool). lastPriceUsd1 = the pool price after the latest indexed swap (null until the first swap). router = LAUNCH2_POOL_ROUTER_ADDRESS (null when not configured: pool quote / prepare are then 503). Decision 0127: tradeCount / buyCount / sellCount / buyVolumeUsd1 / sellVolumeUsd1 keep counting every swap (buybacks included); userTradeCount / userBuyVolumeUsd1 / userSellVolumeUsd1 are the same totals without the swaps the instance's buyback adapter / executor sent (market trades only; tradeCount - userTradeCount = buyback swaps indexed in the pool).",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "poolId",
        "router",
        "tradeCount",
        "buyCount",
        "sellCount",
        "buyVolumeUsd1",
        "sellVolumeUsd1",
        "volume24hUsd1",
        "taxUsd1",
        "taxMeme",
        "lastPriceUsd1",
        "lastTradeAt",
        "userTradeCount",
        "userBuyVolumeUsd1",
        "userSellVolumeUsd1",
      ],
      properties: {
        poolId: bytes32Schema,
        router: { anyOf: [addressSchema, { type: "null" }] },
        tradeCount: uintStringSchema,
        buyCount: uintStringSchema,
        sellCount: uintStringSchema,
        buyVolumeUsd1: decimalSchema,
        sellVolumeUsd1: decimalSchema,
        volume24hUsd1: decimalSchema,
        taxUsd1: decimalSchema,
        taxMeme: decimalSchema,
        lastPriceUsd1: { anyOf: [decimalSchema, { type: "null" }] },
        lastTradeAt: nullableDateTimeSchema,
        userTradeCount: uintStringSchema,
        userBuyVolumeUsd1: decimalSchema,
        userSellVolumeUsd1: decimalSchema,
      },
    },
    { type: "null" },
  ],
} as const;

/**
 * Decision 0136: a chain-wide chain guard hold (unresolved USD1 pause, or
 * one of our addresses frozen); null when none. `since` = the incident's
 * `first_seen_at`; `usd1_paused` wins when both exist.
 */
const tradingHoldSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "since"],
      properties: {
        kind: { type: "string", enum: ["usd1_paused", "address_frozen"] },
        since: dateTimeSchema,
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
  tradingHold: tradingHoldSchema,
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
      properties: { ...detailProperties, pool: poolSummarySchema },
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
            nextOrderBlockedReason: {
              description:
                "Decision 0122: null = the next order can run now. v3: BUYBACK_PAUSED | BUYBACK_NOT_GRADUATED | BUYBACK_NO_BUDGET | BUYBACK_TOO_SOON (< 10 s since the last success) | BUYBACK_PRINCIPAL_INSUFFICIENT (official-pool USD1 principal < 10,000 or order > 1 % of it) | BUYBACK_QUOTE_UNAVAILABLE (quoteNextOrder unreadable). v2-generation instances only: BUYBACK_LEGACY_PRICE_PROTECTION (reference not ready / protection would refuse). BUYBACK_PROTECTION_BLOCKED and BUYBACK_PRICE_SOURCE_UNAVAILABLE are no longer produced.",
              ...nullableReasonCodeSchema,
            },
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
          ...walletHoldingRequired,
        ],
        properties: {
          ...walletHoldingProperties,
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

// ---------------------------------------------------------------------------
// Decision 0124: official-pool (Uniswap v4) trading after graduation.
// ---------------------------------------------------------------------------

const poolSideSchema = { type: "string", enum: ["buy", "sell"] } as const;
const poolModeSchema = {
  type: "string",
  enum: ["exactIn", "exactOut"],
  description:
    "exactIn: amount = the input (buy: USD1 in, sell: MEME in); exactOut: amount = the net output after the 2 % pool tax (buy: MEME out, sell: USD1 out).",
} as const;

export const launch2PoolQuoteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["side", "mode", "amount", "walletId"],
  properties: {
    side: poolSideSchema,
    mode: poolModeSchema,
    amount: decimalSchema,
    walletId: opaqueIdSchema,
    slippageBps: { type: "string", pattern: "^(0|[1-9][0-9]{0,3})$" },
  },
} as const;

export const launch2PoolTradePrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "side", "mode", "amount", "slippageBps"],
  properties: {
    walletId: opaqueIdSchema,
    side: poolSideSchema,
    mode: poolModeSchema,
    amount: {
      ...decimalSchema,
      description:
        "Same meaning as the quote's amount for the same side / mode.",
    },
    slippageBps: {
      type: "integer",
      minimum: 0,
      maximum: 5_000,
      description:
        "exactIn: minOut = expectedOut × (1 − slippage); exactOut: maxIn = amountIn × (1 + slippage), rounded up.",
    },
  },
} as const;

const poolKeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["currency0", "currency1", "fee", "tickSpacing", "hooks"],
  properties: {
    currency0: addressSchema,
    currency1: addressSchema,
    fee: { type: "integer", const: 2_500 },
    tickSpacing: { type: "integer", const: 60 },
    hooks: addressSchema,
  },
} as const;

export const launch2PoolQuoteSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "walletId",
    "venue",
    "side",
    "mode",
    "stage",
    "requestedAmount",
    "amountIn",
    "maxIn",
    "expectedOut",
    "minOut",
    "slippageBps",
    "taxBps",
    "taxAmount",
    "taxToken",
    "taxUsd1",
    "priceBeforeUsd1",
    "averagePriceUsd1",
    "balance",
    "exceedsBalance",
    "router",
    "poolId",
    "poolKey",
    "zeroForOne",
    "deadline",
    "expiresAt",
    "quotedAt",
    "quotedAtBlock",
    "basis",
  ],
  properties: {
    instanceId: opaqueIdSchema,
    walletId: opaqueIdSchema,
    venue: { type: "string", const: "official_pool" },
    side: poolSideSchema,
    mode: poolModeSchema,
    stage: { type: "string", const: "graduated" },
    requestedAmount: decimalSchema,
    amountIn: {
      ...decimalSchema,
      description:
        "exactIn: the requested input; exactOut: the simulated input the router spends for the requested net output.",
    },
    maxIn: {
      ...decimalSchema,
      description:
        "exactIn: = amountIn; exactOut: amountIn × (1 + slippage), the maxAmountIn of swapExactOut (the router refunds the unused part).",
    },
    expectedOut: {
      ...decimalSchema,
      description:
        "Net output after the 2 % pool tax (exactOut: = the requested amount).",
    },
    minOut: {
      ...decimalSchema,
      description:
        "exactIn: expectedOut × (1 − slippage), the minAmountOut of swapExactIn; exactOut: = expectedOut.",
    },
    slippageBps: { type: "integer", minimum: 0, maximum: 5_000 },
    taxBps: {
      type: "integer",
      minimum: 0,
      maximum: 10_000,
      description:
        "The pool's base tax in bps: 200 (OfficialTaxHook 2 %; Decision 0131 LoopDynamic: buy = buyFeePpm / 100, sell = baseSellFeePpm / 100, 200 at the ruled values). A LoopDynamic sell adds the dynamic fee (dynamic.dynamicTaxBps) on top.",
    },
    taxAmount: {
      ...decimalSchema,
      description:
        "The OfficialTaxHook tax in the output token (buy: MEME, sell: USD1). exactOut: exact; exactIn: 2 % of the gross output, at most 1 wei off the hook's rounding.",
    },
    taxToken: { type: "string", enum: ["meme", "usd1"] },
    taxUsd1: {
      ...decimalSchema,
      description: "= taxAmount for a sell; 0 for a buy (taxed in MEME).",
    },
    priceBeforeUsd1: {
      ...decimalSchema,
      description:
        "Pool spot price (USD1 per MEME) from PoolManager slot0 at the quote block.",
    },
    averagePriceUsd1: {
      ...decimalSchema,
      description:
        "USD1 side ÷ MEME side of this quote (tax included on the output side).",
    },
    balance: {
      type: "object",
      additionalProperties: false,
      required: ["usd1", "meme"],
      properties: { usd1: decimalSchema, meme: decimalSchema },
    },
    exceedsBalance: {
      type: "boolean",
      description:
        "maxIn is above the wallet's input-token balance at the quote block; the prepare would be 409 INSUFFICIENT_BALANCE.",
    },
    router: addressSchema,
    poolId: bytes32Schema,
    poolKey: poolKeySchema,
    zeroForOne: {
      type: "boolean",
      description: "The input is currency0 (buy: USD1 < MEME).",
    },
    deadline: {
      ...dateTimeSchema,
      description:
        "Decision 0126: GET …/pool/quote — quote time + LAUNCH2_QUOTE_TTL_SECONDS (default 60 s, the quote's freshness; re-quote after it). In the prepare response — the deadline the router call encodes: prepare time + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS (default 180 s, ≥ the quote TTL), re-simulated at the prepare block (basis).",
    },
    expiresAt: {
      ...dateTimeSchema,
      description:
        "= deadline (quote: the freshness limit; prepare: the intent's signing limit).",
    },
    quotedAt: dateTimeSchema,
    quotedAtBlock: uintStringSchema,
    basis: {
      type: "object",
      additionalProperties: false,
      required: ["blockNumber", "blockHash"],
      properties: {
        blockNumber: uintStringSchema,
        blockHash: bytes32Schema,
      },
    },
    dynamic: {
      type: "object",
      additionalProperties: false,
      description:
        "Decision 0131: present only for a LoopDynamic instance (LoopRouter.swapExactInput; exactIn only). Absent for OfficialTax instances (their quote is unchanged).",
      required: [
        "hookKind",
        "hook",
        "priceTiming",
        "baseTaxBps",
        "baseTaxAmount",
        "dynamicTaxBps",
        "dynamicTaxAmount",
        "armed",
        "roundId",
        "rewardWeight",
      ],
      properties: {
        hookKind: { type: "string", const: "loopDynamic" },
        hook: addressSchema,
        priceTiming: { type: "string", enum: ["PRE_SWAP", "POST_SWAP"] },
        baseTaxBps: { type: "integer", minimum: 0, maximum: 10_000 },
        baseTaxAmount: {
          ...decimalSchema,
          description:
            "buy: the 2 % buy fee in MEME (from the net output, ≤ 1 wei off); sell: the base sell fee in USD1.",
        },
        dynamicTaxBps: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
          description:
            "sell: the dynamic fee over the post-base output in bps — min(the candle's drop at the Hook's priceTiming (after this trade for POST_SWAP), maxDynamicFeeWad) (Decision 0144; cap 0 = uncapped); buy: 0.",
        },
        dynamicTaxAmount: {
          ...decimalSchema,
          description:
            "sell: the dynamic fee in USD1 (exact: real simulation vs a base-fee-only simulation at the same block); buy: 0.",
        },
        armed: {
          type: "boolean",
          description:
            "A reward round is armed when this swap runs (after the candle roll the swap performs).",
        },
        roundId: { ...nullableUintStringSchema },
        rewardWeight: {
          ...decimalSchema,
          description:
            "buy: the USD1 this buy credits to the round's reward weight (= amountIn while armed, else 0); sell: 0.",
        },
      },
    },
  },
} as const;

export const launch2PoolQuoteResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quote", "contractVersion"],
  properties: {
    quote: launch2PoolQuoteSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2PoolIntentResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["launch2Intent", "quote", "contractVersion"],
  properties: {
    launch2Intent: launch2IntentResourceSchema.properties.launch2Intent,
    quote: launch2PoolQuoteSchema,
    contractVersion: contractVersionSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// Decision 0126: the wallet's own official-pool trades.
// ---------------------------------------------------------------------------

export const launch2PoolTradesQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: {
    walletId: opaqueIdSchema,
    limit: { type: "string", pattern: "^[1-9][0-9]?$" },
  },
} as const;

const poolTradeItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "poolTradeId",
    "side",
    "inputToken",
    "outputToken",
    "amountIn",
    "amountOut",
    "usd1Amount",
    "memeAmount",
    "taxAmount",
    "taxToken",
    "priceUsd1",
    "recipientAddress",
    "tradedAt",
    "transactionHash",
    "logIndex",
    "blockNumber",
  ],
  properties: {
    poolTradeId: {
      ...opaqueIdSchema,
      description:
        "Opaque id of the indexed PoolManager Swap fact (stable across re-scans).",
    },
    side: poolSideSchema,
    inputToken: { type: "string", enum: ["usd1", "meme"] },
    outputToken: { type: "string", enum: ["usd1", "meme"] },
    amountIn: {
      ...decimalSchema,
      description: "OfficialPoolRouter Swap.amountIn (input actually spent).",
    },
    amountOut: {
      ...decimalSchema,
      description:
        "OfficialPoolRouter Swap.amountOut (net output received after the 2 % pool tax).",
    },
    usd1Amount: {
      ...decimalSchema,
      description:
        "PoolManager side: buy = USD1 in, sell = USD1 out before tax.",
    },
    memeAmount: {
      ...decimalSchema,
      description:
        "PoolManager side: sell = MEME in, buy = MEME out before tax.",
    },
    taxAmount: decimalSchema,
    taxToken: { type: "string", enum: ["meme", "usd1"] },
    priceUsd1: {
      ...decimalSchema,
      description: "Pool price (USD1 per MEME) after the swap.",
    },
    recipientAddress: addressSchema,
    tradedAt: dateTimeSchema,
    transactionHash: txHashSchema,
    logIndex: { type: "integer", minimum: 0 },
    blockNumber: uintStringSchema,
  },
} as const;

export const launch2PoolTradesResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "walletId",
    "poolTradeCount",
    "lastPoolTradeAt",
    "trades",
    "contractVersion",
  ],
  properties: {
    instanceId: opaqueIdSchema,
    walletId: opaqueIdSchema,
    poolTradeCount: uintStringSchema,
    lastPoolTradeAt: nullableDateTimeSchema,
    trades: { type: "array", maxItems: 50, items: poolTradeItemSchema },
    contractVersion: contractVersionSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// Decision 0131: LoopDynamic pool, rewards and claims.
// ---------------------------------------------------------------------------

const nullableAddressSchema = {
  anyOf: [addressSchema, { type: "null" }],
} as const;
const nullableDecimalSchema = {
  anyOf: [decimalSchema, { type: "null" }],
} as const;
const nullableIntegerBpsSchema = {
  anyOf: [{ type: "integer", minimum: 0, maximum: 10_000 }, { type: "null" }],
} as const;

export const launch2DynamicCommandErrors = {
  ...launch2CommandErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "QUOTE_EXPIRED",
    "RESOURCE_CONFLICT",
    "VERSION_CONFLICT",
  ]),
} as const;

export const launch2DynamicPoolQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { walletId: opaqueIdSchema },
} as const;

const dynamicPoolProperties = {
  instanceId: opaqueIdSchema,
  hookKind: { type: "string", enum: ["officialTax", "loopDynamic"] },
  status: {
    type: "string",
    enum: ["not_applicable", "not_graduated", "active"],
    description:
      "not_applicable: OfficialTax instance (every other field null); not_graduated: LoopDynamic before graduation (no Hook yet); active: the bound Hook read at basis.",
  },
  hook: nullableAddressSchema,
  poolId: nullableBytes32Schema,
  router: {
    ...nullableAddressSchema,
    description: "LoopRouter (the App's swap and approve target).",
  },
  routerRegistry: nullableAddressSchema,
  routingPolicy: {
    anyOf: [
      { type: "string", enum: ["loopRouterOnly", "open"] },
      { type: "null" },
    ],
  },
  priceTiming: {
    anyOf: [
      { type: "string", enum: ["PRE_SWAP", "POST_SWAP"] },
      { type: "null" },
    ],
  },
  buyTaxBps: nullableIntegerBpsSchema,
  baseSellTaxBps: nullableIntegerBpsSchema,
  excludeBuybackFromRewards: { type: ["boolean", "null"] },
  armed: { type: ["boolean", "null"] },
  currentRoundId: {
    ...nullableUintStringSchema,
    description: "The armed round (null while no round is armed).",
  },
  candleId: nullableUintStringSchema,
  candleSeconds: { type: "integer", const: 300 },
  candleEndsAt: nullableDateTimeSchema,
  rollPending: {
    type: ["boolean", "null"],
    description:
      "The Hook's candle ended without a swap / poke since; the next swap, poke or claim closes it first (Decision 0144: on an S193 Hook an armed round whose pending candle did not fall — flat included — closes then).",
  },
  currentDropWad: {
    ...nullableDecimalSchema,
    description:
      "currentDropWad() as a decimal fraction (0.3 = 30 % below the candle open); 0 when not armed or a roll is pending.",
  },
  currentDropBps: nullableIntegerBpsSchema,
  maxDynamicFeeWad: {
    ...nullableDecimalSchema,
    description:
      "Decision 0144: maxDynamicFeeWad() as a decimal fraction — the dynamic sell rate is min(drop, cap); 0 = uncapped (an uncapped Factory or a pre-S193 Hook without the getter). The ruled value is 0.2 (20 %).",
  },
  maxDynamicFeeBps: nullableIntegerBpsSchema,
  currentDynamicTaxBps: {
    ...nullableIntegerBpsSchema,
    description:
      "Decision 0144: the dynamic sell rate at the current price, min(currentDropWad, maxDynamicFeeWad) in bps (0 = no dynamic fee). PRE_SWAP: what the next sell pays; POST_SWAP: before that sell's own price impact (the quote is exact).",
  },
  roundCloseRule: {
    anyOf: [
      { type: "string", enum: ["closeAtOrAboveOpen", "closeAboveOpen"] },
      { type: "null" },
    ],
    description:
      "Decision 0144: how an armed round ends. closeAtOrAboveOpen (S193 Hooks, ruled 2026-10-15): the first candle that no longer falls closes the round — close ≥ open, a flat candle included. closeAboveOpen (pre-S193 Hooks, legacy Factories): only a candle closing above its open closes it; a flat one keeps it armed. A round arms when a candle closes more than 10 % below its open.",
  },
  armedAfterRoll: {
    type: ["boolean", "null"],
    description:
      "Decision 0144 (loop-contracts 0013 §7.3): whether a round is armed once the pending candle roll runs (the next swap, poke or claim). Equals armed when rollPending is false; while a roll is pending the chain's armed() is stale — on an S193 Hook an armed round ends if the pending candle did not fall or an empty candle followed it, and a crash can activate one. Use this for the App's \"round in progress\" and dynamic-tax hints.",
  },
  potUsd1: {
    ...nullableDecimalSchema,
    description: "carry + the armed round's dynamic fees.",
  },
  carryUsd1: nullableDecimalSchema,
  roundExtraFeesUsd1: nullableDecimalSchema,
  roundTotalBuyWeightUsd1: nullableDecimalSchema,
  reservedRewardsUsd1: nullableDecimalSchema,
  priceUsd1: nullableDecimalSchema,
  viewer: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["walletId", "currentRoundWeightUsd1"],
        properties: {
          walletId: opaqueIdSchema,
          currentRoundWeightUsd1: decimalSchema,
        },
      },
      { type: "null" },
    ],
  },
  summary: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: [
          "roundCount",
          "closedRoundCount",
          "allocatedUsd1",
          "claimedUsd1",
          "dynamicFeesUsd1",
          "baseSellFeesUsd1",
          "buyFeesMeme",
        ],
        properties: {
          roundCount: { type: "integer", minimum: 0 },
          closedRoundCount: { type: "integer", minimum: 0 },
          allocatedUsd1: decimalSchema,
          claimedUsd1: decimalSchema,
          dynamicFeesUsd1: decimalSchema,
          baseSellFeesUsd1: decimalSchema,
          buyFeesMeme: decimalSchema,
        },
      },
      { type: "null" },
    ],
  },
  basis: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["blockNumber", "blockHash"],
        properties: {
          blockNumber: uintStringSchema,
          blockHash: bytes32Schema,
        },
      },
      { type: "null" },
    ],
  },
} as const;

export const launch2DynamicPoolResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dynamicPool", "contractVersion"],
  properties: {
    dynamicPool: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(dynamicPoolProperties),
      properties: dynamicPoolProperties,
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2DynamicRewardsQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: {
    walletId: opaqueIdSchema,
    limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
  },
} as const;

const dynamicRewardRoundProperties = {
  roundId: uintStringSchema,
  status: {
    type: "string",
    enum: ["open", "claimable", "claimed", "no_reward"],
  },
  weightUsd1: decimalSchema,
  totalBuyWeightUsd1: decimalSchema,
  allocationUsd1: nullableDecimalSchema,
  claimableUsd1: decimalSchema,
  claimedUsd1: nullableDecimalSchema,
  claimTransactionHash: nullableTxHashSchema,
  claimedAt: nullableDateTimeSchema,
  startCandle: uintStringSchema,
  endCandle: nullableUintStringSchema,
  activatedAt: dateTimeSchema,
  closedAt: nullableDateTimeSchema,
} as const;

export const launch2DynamicRewardsResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "walletId",
    "hookKind",
    "claimableUsd1",
    "claimedUsd1",
    "rounds",
    "contractVersion",
  ],
  properties: {
    instanceId: opaqueIdSchema,
    walletId: opaqueIdSchema,
    hookKind: { type: "string", enum: ["officialTax", "loopDynamic"] },
    claimableUsd1: decimalSchema,
    claimedUsd1: decimalSchema,
    rounds: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(dynamicRewardRoundProperties),
        properties: dynamicRewardRoundProperties,
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2DynamicClaimPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "roundId"],
  properties: {
    walletId: opaqueIdSchema,
    roundId: { type: "string", pattern: "^[1-9][0-9]{0,30}$" },
  },
} as const;

export const launch2DynamicClaimIntentResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["launch2Intent", "claim", "contractVersion"],
  properties: {
    launch2Intent: launch2IntentResourceSchema.properties.launch2Intent,
    claim: {
      type: "object",
      additionalProperties: false,
      required: ["roundId", "hook", "claimableUsd1"],
      properties: {
        roundId: uintStringSchema,
        hook: addressSchema,
        claimableUsd1: decimalSchema,
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;

export const launch2DynamicClaimReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intentId", "transactionHash"],
  properties: {
    intentId: opaqueIdSchema,
    transactionHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    walletId: {
      ...opaqueIdSchema,
      description:
        "Optional echo of the intent's wallet; a mismatch is 404 LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND.",
    },
    roundId: {
      type: "string",
      pattern: "^[1-9][0-9]{0,30}$",
      description:
        "Optional echo of the intent's round; a mismatch is 404 LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND.",
    },
  },
} as const;

export const launch2DynamicClaimReportResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dynamicClaimReport", "contractVersion"],
  properties: {
    dynamicClaimReport: {
      type: "object",
      additionalProperties: false,
      required: [
        "intentId",
        "instanceId",
        "walletId",
        "roundId",
        "transactionHash",
        "status",
        "amountUsd1",
        "claimedAt",
        "blockNumber",
        "reportedAt",
      ],
      properties: {
        intentId: opaqueIdSchema,
        instanceId: opaqueIdSchema,
        walletId: opaqueIdSchema,
        roundId: uintStringSchema,
        transactionHash: txHashSchema,
        status: {
          type: "string",
          enum: ["submitted", "confirmed"],
          description:
            "confirmed: the launch2_event lane indexed this transaction's RewardClaimed for (round, wallet); submitted: not indexed yet (report again later).",
        },
        amountUsd1: nullableDecimalSchema,
        claimedAt: nullableDateTimeSchema,
        blockNumber: nullableUintStringSchema,
        reportedAt: dateTimeSchema,
      },
    },
    contractVersion: contractVersionSchema,
  },
} as const;
