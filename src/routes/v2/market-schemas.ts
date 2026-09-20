import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import {
  assetIdPatternSource,
  assetStatuses,
  blockHashPatternSource,
  decimalAmountPatternSource,
  evmAddressPatternSource,
  reasonCodePatternSource,
  transactionHashPatternSource,
} from "../../features/chain/chain-contract.js";
import {
  candleIntervals,
  candleLimits,
  marketFactQualities,
  marketSources,
  marketTrendingRules,
  providerLookupSourceKind,
  signedDecimalPatternSource,
  tradeLimits,
} from "../../features/market/market-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { assetResourceSchema, unavailableSchema } from "./chain-schemas.js";

/** A 32-byte hex identifier (Uniswap V4 pool id), lower-case and 0x-prefixed. */
const bytes32PatternSource = "^0x[0-9a-f]{64}$";

/**
 * Route schemas for the V2 market surface (Decision 0034). Every number is a
 * canonical decimal string; every fact carries its source, fetch time, TTL,
 * and quality; every block can independently be `unavailable`.
 */

const reasonCodeSchema = {
  type: "string",
  pattern: reasonCodePatternSource,
} as const;

const nullableReasonCodeSchema = {
  anyOf: [reasonCodeSchema, { type: "null" }],
} as const;

const decimalSchema = {
  type: "string",
  pattern: signedDecimalPatternSource,
  description: "Canonical decimal string; never a JavaScript number.",
} as const;

const unsignedDecimalSchema = {
  type: "string",
  pattern: decimalAmountPatternSource,
} as const;

const blockNumberSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
} as const;

const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;

export const marketFactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "value",
    "source",
    "fetchedAt",
    "ttlSeconds",
    "quality",
    "reasonCode",
  ],
  properties: {
    value: { anyOf: [decimalSchema, { type: "null" }] },
    source: {
      anyOf: [{ type: "string", enum: [...marketSources] }, { type: "null" }],
    },
    fetchedAt: nullableDateTimeSchema,
    ttlSeconds: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    quality: { type: "string", enum: [...marketFactQualities] },
    reasonCode: nullableReasonCodeSchema,
  },
  description:
    "One Provider-reported fact with provenance. `unavailable` carries a null value and a reasonCode; `stale` is past its TTL but inside the grace window; `derived` is computed by LOOP from indexed chain events.",
} as const;

const assetSummarySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["symbol", "name", "decimals", "status"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 32 },
        name: { type: "string", minLength: 1, maxLength: 128 },
        decimals: { type: "integer", minimum: 0, maximum: 36 },
        status: { type: "string", enum: [...assetStatuses] },
      },
    },
    { type: "null" },
  ],
} as const;

const marketAssetRowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "asset", "price", "priceChange24h"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    asset: assetSummarySchema,
    price: marketFactSchema,
    priceChange24h: marketFactSchema,
  },
} as const;

export const marketOverviewResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "watchlist",
    "trending",
    "newPairs",
    "smartMoney",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    watchlist: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "version", "items"],
          properties: {
            status: { type: "string", const: "available" },
            version: { type: "integer", minimum: 0 },
            items: {
              type: "array",
              maxItems: 100,
              items: marketAssetRowSchema,
            },
          },
        },
        unavailableSchema,
      ],
    },
    trending: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "recommendationId", "rules", "items"],
          properties: {
            status: { type: "string", const: "available" },
            recommendationId: {
              type: "string",
              pattern: opaqueIdPatternSource,
              description:
                "Opaque ID of this ordering so a client can report which recommendation it displayed.",
            },
            rules: {
              type: "object",
              additionalProperties: false,
              required: ["configVersion", "effectiveAt", "ordering"],
              properties: {
                configVersion: {
                  type: "string",
                  const: marketTrendingRules.configVersion,
                },
                effectiveAt: dateTimeSchema,
                ordering: {
                  type: "string",
                  const: marketTrendingRules.ordering,
                },
              },
            },
            items: {
              type: "array",
              maxItems: marketTrendingRules.maximumItems,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "assetId",
                  "asset",
                  "price",
                  "priceChange24h",
                  "volume24h",
                  "liquidityUsd",
                ],
                properties: {
                  ...marketAssetRowSchema.properties,
                  volume24h: marketFactSchema,
                  liquidityUsd: marketFactSchema,
                },
              },
            },
          },
        },
        unavailableSchema,
      ],
    },
    newPairs: {
      description:
        "The new-pairs card. `available` means `GET /v2/market/new-pairs` has data right now: it is read from the same cached GeckoTerminal fact, so `omittedCount` equals that page's value (Decision 0053). When the Provider is disabled or the fact cannot be read, the block is unavailable with the same reason code the new-pairs page reports.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "omittedCount"],
          properties: {
            status: { type: "string", const: "available" },
            omittedCount: {
              type: "integer",
              minimum: 0,
              description:
                "Provider rows the new-pairs page could not list because their pool identifier is neither a contract address nor a 32-byte pool id; normally 0. Same source and value as `newPairs.omittedCount` on `GET /v2/market/new-pairs`.",
            },
          },
        },
        unavailableSchema,
      ],
    },
    smartMoney: unavailableSchema,
    observedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/**
 * An address the registry does not know, described from a Provider lookup
 * (Decision 0058). Same keys as the registry projection, plus the
 * Provider's provenance under `source`; identity fields the Provider did
 * not report are null.
 */
const unregisteredAssetProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "assetId",
    "chainId",
    "address",
    "symbol",
    "name",
    "decimals",
    "status",
    "source",
    "updatedAt",
  ],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    chainId: assetResourceSchema.properties.asset.properties.chainId,
    address: { type: "string", pattern: evmAddressPatternSource },
    symbol: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 32 },
        { type: "null" },
      ],
      description:
        "Provider-reported symbol; null when the Provider did not report one. Display the address instead; never invent a ticker.",
    },
    name: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 128 },
        { type: "null" },
      ],
    },
    decimals: {
      anyOf: [{ type: "integer", minimum: 0, maximum: 36 }, { type: "null" }],
      description:
        "Null when the Provider did not report decimals (DexScreener never does). Do not format raw amounts without it.",
    },
    status: { type: "string", const: "unregistered" },
    source: {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "provider",
        "fetchedAt",
        "ttlSeconds",
        "quality",
        "blockNumber",
        "verifiedAt",
      ],
      properties: {
        kind: { type: "string", const: providerLookupSourceKind },
        provider: { type: "string", enum: [...marketSources] },
        fetchedAt: dateTimeSchema,
        ttlSeconds: { type: "integer", minimum: 1 },
        quality: {
          type: "string",
          enum: ["fresh", "stale"],
          description:
            "`stale`: the identity is remembered from an earlier lookup inside its TTL but the Provider could not confirm it now; the price facts then carry the reason.",
        },
        blockNumber: { type: "null" },
        verifiedAt: { type: "null" },
      },
    },
    updatedAt: dateTimeSchema,
  },
} as const;

export const marketAssetResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "asset",
    "capability",
    "price",
    "priceChange24h",
    "liquidityUsd",
    "volume24h",
    "marketCap",
    "fdv",
    "primaryPair",
    "community",
    "security",
    "holderCount",
    "contractVersion",
  ],
  properties: {
    asset: {
      description:
        "Discriminate on `status`: `pending|verified|blocked` is the registry projection; `unregistered` is a Provider-described address (Decision 0058); `unavailable` is an unregistered address no Provider could describe right now (`reasonCode` says why) — render the address with the unavailable state, never a placeholder ticker.",
      anyOf: [
        assetResourceSchema.properties.asset,
        unregisteredAssetProjectionSchema,
        unavailableSchema,
      ],
    },
    capability: assetResourceSchema.properties.capability,
    price: marketFactSchema,
    priceChange24h: marketFactSchema,
    liquidityUsd: marketFactSchema,
    volume24h: marketFactSchema,
    marketCap: marketFactSchema,
    fdv: marketFactSchema,
    primaryPair: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "pairAddress",
            "dexId",
            "labels",
            "quoteTokenAddress",
            "quoteTokenSymbol",
            "pairCreatedAt",
          ],
          properties: {
            pairAddress: { type: "string", pattern: evmAddressPatternSource },
            dexId: { type: "string", minLength: 1, maxLength: 64 },
            labels: {
              type: "array",
              maxItems: 8,
              items: { type: "string", maxLength: 32 },
            },
            quoteTokenAddress: {
              type: "string",
              pattern: evmAddressPatternSource,
            },
            quoteTokenSymbol: { type: "string", maxLength: 32 },
            pairCreatedAt: nullableDateTimeSchema,
          },
        },
        { type: "null" },
      ],
      description:
        "The deepest DexScreener pair in which the asset is the base token. Price facts above refer to this pair.",
    },
    community: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "communityId", "name", "slug", "memberCount"],
          properties: {
            status: { type: "string", const: "available" },
            communityId: { type: "string", pattern: opaqueIdPatternSource },
            name: { type: "string", minLength: 1, maxLength: 40 },
            slug: { type: "string", pattern: "^[a-z0-9-]{3,32}$" },
            memberCount: { type: "integer", minimum: 0 },
          },
        },
        unavailableSchema,
      ],
    },
    security: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "source",
            "fetchedAt",
            "ttlSeconds",
            "quality",
            "reasonCode",
            "facts",
          ],
          properties: {
            status: { type: "string", const: "available" },
            source: { type: "string", enum: [...marketSources] },
            fetchedAt: dateTimeSchema,
            ttlSeconds: { type: "integer", minimum: 1 },
            quality: { type: "string", enum: ["fresh", "stale"] },
            reasonCode: nullableReasonCodeSchema,
            facts: {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["fact", "value", "source", "observedAt"],
                properties: {
                  fact: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,63}$" },
                  value: { type: "string", minLength: 1, maxLength: 96 },
                  source: { type: "string", enum: [...marketSources] },
                  observedAt: dateTimeSchema,
                },
              },
              description:
                "Labelled Provider facts only. No score, rating, or verdict is derived from them.",
            },
          },
        },
        unavailableSchema,
      ],
    },
    holderCount: marketFactSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const marketCandlesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["assetId", "interval", "candles", "contractVersion"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    interval: { type: "string", enum: [...candleIntervals] },
    candles: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "quality",
            "source",
            "fetchedAt",
            "labelKey",
            "proxyAsset",
            "pool",
            "priceUnit",
            "items",
          ],
          properties: {
            status: { type: "string", const: "available" },
            quality: {
              type: "string",
              enum: ["fresh", "stale", "derived", "proxied"],
              description:
                "`proxied`: the native asset (BNB) charted through the wrapped native token named in `proxyAsset`; `source` and `labelKey` still say whether those candles are Provider OHLCV or an on-chain swap aggregate.",
            },
            source: { type: "string", enum: [...marketSources] },
            fetchedAt: dateTimeSchema,
            labelKey: {
              anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }],
              description:
                "Localization key the client must show next to derived candles (on-chain swap aggregate); null for Provider OHLCV.",
            },
            proxyAsset: {
              anyOf: [
                { type: "string", pattern: assetIdPatternSource },
                { type: "null" },
              ],
              description:
                "Asset whose pool produced the candles when `quality` is `proxied` (WBNB for native BNB); null otherwise.",
            },
            pool: {
              type: "object",
              additionalProperties: false,
              required: ["address", "protocol", "quoteAssetId", "quoteSymbol"],
              properties: {
                address: { type: "string", pattern: evmAddressPatternSource },
                protocol: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  description:
                    "`pancakeswap_v3` for a registered pool; for an unregistered address the lookup Provider's dex id of the primary pair (e.g. `pancakeswap-v3-bsc`).",
                },
                quoteAssetId: {
                  anyOf: [
                    { type: "string", pattern: assetIdPatternSource },
                    { type: "null" },
                  ],
                },
                quoteSymbol: { type: "string", minLength: 1, maxLength: 32 },
              },
            },
            priceUnit: { type: "string", minLength: 1, maxLength: 80 },
            items: {
              type: "array",
              maxItems: candleLimits.maximum,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "openTime",
                  "closeTime",
                  "open",
                  "high",
                  "low",
                  "close",
                  "volume",
                  "swapCount",
                  "isOpen",
                ],
                properties: {
                  openTime: dateTimeSchema,
                  closeTime: dateTimeSchema,
                  open: unsignedDecimalSchema,
                  high: unsignedDecimalSchema,
                  low: unsignedDecimalSchema,
                  close: unsignedDecimalSchema,
                  volume: unsignedDecimalSchema,
                  swapCount: {
                    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                  },
                  isOpen: {
                    type: "boolean",
                    description:
                      "True for the bucket that has not closed yet; its close/high/low can still change.",
                  },
                },
              },
            },
          },
        },
        unavailableSchema,
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const marketTradesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["assetId", "trades", "contractVersion"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    trades: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "source", "items", "nextCursor", "freshness"],
          properties: {
            status: { type: "string", const: "available" },
            source: { type: "string", const: "loop_indexer" },
            items: {
              type: "array",
              maxItems: tradeLimits.maximum,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "transactionHash",
                  "logIndex",
                  "blockNumber",
                  "blockHash",
                  "blockTimestamp",
                  "confirmations",
                  "status",
                  "direction",
                  "amountAsset",
                  "amountQuote",
                  "quoteAssetId",
                  "quoteSymbol",
                  "priceAfter",
                  "poolAddress",
                  "isOwn",
                ],
                properties: {
                  transactionHash: {
                    type: "string",
                    pattern: transactionHashPatternSource,
                  },
                  logIndex: { type: "integer", minimum: 0 },
                  blockNumber: blockNumberSchema,
                  blockHash: {
                    type: "string",
                    pattern: blockHashPatternSource,
                  },
                  blockTimestamp: dateTimeSchema,
                  confirmations: {
                    anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
                  },
                  status: {
                    type: "string",
                    enum: ["confirmed", "pending", "reorged"],
                  },
                  direction: {
                    type: "string",
                    enum: ["buy", "sell"],
                    description:
                      "Relative to the asset: buy means the swap took the asset out of the pool.",
                  },
                  amountAsset: unsignedDecimalSchema,
                  amountQuote: unsignedDecimalSchema,
                  quoteAssetId: {
                    type: "string",
                    pattern: assetIdPatternSource,
                  },
                  quoteSymbol: { type: "string", minLength: 1, maxLength: 32 },
                  priceAfter: {
                    anyOf: [unsignedDecimalSchema, { type: "null" }],
                  },
                  poolAddress: {
                    type: "string",
                    pattern: evmAddressPatternSource,
                  },
                  isOwn: {
                    type: "boolean",
                    description:
                      "True when the swap's sender or recipient is one of the caller's own wallets. Counterparty addresses are never published.",
                  },
                },
              },
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
            freshness: {
              type: "object",
              additionalProperties: false,
              required: [
                "indexerBlockNumber",
                "headBlockNumber",
                "lagBlocks",
                "observedAt",
              ],
              properties: {
                indexerBlockNumber: blockNumberSchema,
                headBlockNumber: {
                  anyOf: [blockNumberSchema, { type: "null" }],
                },
                lagBlocks: {
                  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
                },
                observedAt: dateTimeSchema,
              },
            },
          },
        },
        unavailableSchema,
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const marketHoldersResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["assetId", "holderCount", "distribution", "contractVersion"],
  properties: {
    assetId: { type: "string", pattern: assetIdPatternSource },
    holderCount: marketFactSchema,
    distribution: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const marketNewPairsResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["newPairs", "riskScreening", "contractVersion"],
  properties: {
    newPairs: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "source",
            "fetchedAt",
            "ttlSeconds",
            "quality",
            "reasonCode",
            "items",
            "omittedCount",
          ],
          properties: {
            status: { type: "string", const: "available" },
            source: { type: "string", enum: [...marketSources] },
            fetchedAt: dateTimeSchema,
            ttlSeconds: { type: "integer", minimum: 1 },
            quality: { type: "string", enum: ["fresh", "stale"] },
            reasonCode: nullableReasonCodeSchema,
            omittedCount: {
              type: "integer",
              minimum: 0,
              description:
                "Provider rows whose pool identifier is neither a contract address nor a 32-byte pool id. Both known forms are listed under `poolRef` (Decision 0052), so this is the count of genuinely malformed rows and is normally 0; it is published so a page never silently drops a row.",
            },
            items: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "poolRef",
                  "dexId",
                  "name",
                  "baseTokenAddress",
                  "quoteTokenAddress",
                  "registryAssetId",
                  "createdAt",
                  "reserveUsd",
                  "volumeH24Usd",
                ],
                properties: {
                  poolRef: {
                    description:
                      "How the Provider identifies the pool. `address` is a pool contract (PancakeSwap and other V2/V3-style DEXes) and can be opened as a pair page; `poolId` is a Uniswap V4 pool inside the singleton, identified by its 32-byte pool id, which has no contract and no pair page of its own: display it, do not navigate.",
                    oneOf: [
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "address"],
                        properties: {
                          kind: { type: "string", const: "address" },
                          address: {
                            type: "string",
                            pattern: evmAddressPatternSource,
                          },
                        },
                      },
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "poolId"],
                        properties: {
                          kind: { type: "string", const: "poolId" },
                          poolId: {
                            type: "string",
                            pattern: bytes32PatternSource,
                            description:
                              "Lower-case 0x-prefixed 32-byte pool id. Not an address; never send it to an address-based endpoint.",
                          },
                        },
                      },
                    ],
                  },
                  dexId: { type: "string", minLength: 1, maxLength: 64 },
                  name: { type: "string", maxLength: 128 },
                  baseTokenAddress: {
                    anyOf: [
                      { type: "string", pattern: evmAddressPatternSource },
                      { type: "null" },
                    ],
                  },
                  quoteTokenAddress: {
                    anyOf: [
                      { type: "string", pattern: evmAddressPatternSource },
                      { type: "null" },
                    ],
                  },
                  registryAssetId: {
                    anyOf: [
                      { type: "string", pattern: assetIdPatternSource },
                      { type: "null" },
                    ],
                  },
                  createdAt: nullableDateTimeSchema,
                  reserveUsd: { anyOf: [decimalSchema, { type: "null" }] },
                  volumeH24Usd: { anyOf: [decimalSchema, { type: "null" }] },
                },
              },
            },
          },
        },
        unavailableSchema,
      ],
    },
    riskScreening: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const marketSmartMoneyResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["smartMoney", "contractVersion"],
  properties: {
    smartMoney: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const candlesQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["interval"],
  properties: {
    interval: { type: "string", enum: [...candleIntervals] },
    limit: { type: "integer", minimum: 1, maximum: candleLimits.maximum },
  },
} as const;

export const tradesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: {
      type: "string",
      minLength: 3,
      maxLength: 1_536,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
    limit: { type: "integer", minimum: 1, maximum: tradeLimits.maximum },
  },
} as const;

export const marketReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

/** Routes that admit an unregistered-address lookup also publish its quota exhaustion (Decision 0058). */
export const marketLookupReadErrors = {
  ...marketReadErrors,
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;
