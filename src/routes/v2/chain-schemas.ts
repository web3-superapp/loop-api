import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { hasIdempotencyKeyHeader } from "../../features/community/community-contract.js";
import {
  assetIdPatternSource,
  assetStatuses,
  blockHashPatternSource,
  chainIdPatternSource,
  decimalAmountPatternSource,
  launchChainIds,
  evmAddressPatternSource,
  rawAmountPatternSource,
  reasonCodePatternSource,
  transactionHashPatternSource,
  walletKinds,
} from "../../features/chain/chain-contract.js";
import {
  chainVerificationStates,
  endpointHealthStates,
} from "../../integrations/bsc/rpc-client.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  parseV2CommonRequestMetadata,
  parseV2WriteRequestMetadata,
  v2CommonHeadersSchema,
} from "../../features/session/session-contract.js";
import {
  walletActivityLimits,
  walletGasReserveConfigVersion,
} from "../../features/wallet/wallet-read-service.js";
import { indexerLanes } from "../../database/bsc-indexer-repository.js";
import { marketSources } from "../../features/market/market-contract.js";
import {
  watchlistV2GroupKeyPatternSource,
  watchlistV2MaximumGroups,
  watchlistV2MaximumItems,
} from "../../database/watchlist-v2-repository.js";
import { watchlistV2MaximumNameCodePoints } from "../../features/watchlist/watchlist-v2-service.js";

/**
 * Route schemas for the V2 chain, wallet, and watchlist surfaces. Route
 * schemas are the OpenAPI source, so every bounded object rejects unknown
 * properties and every amount is a canonical string, never a JSON number.
 */

const blockNumberSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
  description:
    "Block height as a canonical decimal string; heights are never JavaScript numbers.",
} as const;

const reasonCodeSchema = {
  type: "string",
  pattern: reasonCodePatternSource,
} as const;

const nullableReasonCodeSchema = {
  anyOf: [reasonCodeSchema, { type: "null" }],
} as const;

export const unavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: reasonCodeSchema,
  },
} as const;

export const assetIdSchema = {
  type: "string",
  pattern: assetIdPatternSource,
  description:
    "Canonical CAIP asset ID: eip155:<chainId>:<0x lowercase address>, or eip155:<chainId>:native. Tickers and symbols are never identifiers.",
} as const;

const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
  description:
    "Normalised lowercase public chain address. It is a chain fact, never a LOOP identity or authorization key.",
} as const;

const assetProjectionSchema = {
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
    assetId: assetIdSchema,
    chainId: { type: "string", pattern: chainIdPatternSource },
    address: { anyOf: [addressSchema, { type: "null" }] },
    symbol: { type: "string", minLength: 1, maxLength: 32 },
    name: { type: "string", minLength: 1, maxLength: 128 },
    decimals: { type: "integer", minimum: 0, maximum: 36 },
    status: { type: "string", enum: [...assetStatuses] },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "blockNumber", "verifiedAt"],
      properties: {
        kind: {
          type: "string",
          enum: ["chain_call", "chain_native", "operator_block"],
        },
        blockNumber: { anyOf: [blockNumberSchema, { type: "null" }] },
        verifiedAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
    },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const assetResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["asset", "capability", "contractVersion"],
  properties: {
    asset: assetProjectionSchema,
    capability: {
      type: "object",
      additionalProperties: false,
      required: ["viewable", "swappable", "value", "reasonCode"],
      properties: {
        viewable: { type: "boolean" },
        swappable: {
          type: "boolean",
          const: false,
          description:
            "Always false until the Swap module is delivered. A registry row is never evidence that an asset can be traded.",
        },
        value: {
          type: "string",
          enum: ["viewable", "swappable", "temporarily_unavailable", "blocked"],
        },
        reasonCode: nullableReasonCodeSchema,
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const endpointHealthSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "endpointRef",
    "status",
    "latencyMs",
    "blockNumber",
    "blockLagBlocks",
    "chainVerification",
    "observedAt",
  ],
  properties: {
    endpointRef: {
      type: "string",
      pattern: "^rpc-[0-9a-f]{12}$",
      description:
        "Opaque, non-reversible endpoint reference. Provider URLs are never published.",
    },
    status: { type: "string", enum: [...endpointHealthStates] },
    latencyMs: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
    blockNumber: { anyOf: [blockNumberSchema, { type: "null" }] },
    blockLagBlocks: { anyOf: [{ type: "integer" }, { type: "null" }] },
    chainVerification: {
      type: "string",
      enum: [...chainVerificationStates],
    },
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

const chainHeadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blockNumber", "blockHash", "observedAt"],
  properties: {
    blockNumber: blockNumberSchema,
    blockHash: { type: "string", pattern: blockHashPatternSource },
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

/**
 * The `launch` chain slot (Decision 0038). Published only when it differs
 * from the primary slot; no endpoint list, no URL.
 */
const launchChainStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "chainId",
    "chainReference",
    "verification",
    "confirmations",
    "reorgDepthBlocks",
    "head",
    "reasonCode",
  ],
  properties: {
    chainId: { type: "string", enum: [...launchChainIds] },
    chainReference: { type: "integer", minimum: 1 },
    verification: { type: "string", enum: [...chainVerificationStates] },
    confirmations: { type: "integer", minimum: 1 },
    reorgDepthBlocks: { type: "integer", minimum: 1 },
    head: { anyOf: [chainHeadSchema, { type: "null" }] },
    reasonCode: nullableReasonCodeSchema,
  },
  description:
    "The launch chain slot (LAUNCH_CHAIN_ID). Absent while the slot equals the primary chain; otherwise its own verification, head, and reason code, without endpoint details.",
} as const;

export const chainStatusResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["chain", "rpc", "indexer", "registry", "contractVersion"],
  properties: {
    chain: {
      type: "object",
      additionalProperties: false,
      required: [
        "chainId",
        "name",
        "reference",
        "nativeAssetId",
        "confirmations",
        "reorgDepthBlocks",
      ],
      properties: {
        chainId: { type: "string", pattern: chainIdPatternSource },
        name: { type: "string", minLength: 1, maxLength: 64 },
        reference: { type: "integer", minimum: 1 },
        nativeAssetId: assetIdSchema,
        confirmations: { type: "integer", minimum: 1 },
        reorgDepthBlocks: { type: "integer", minimum: 1 },
      },
    },
    rpc: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode", "verification", "head", "endpoints"],
      properties: {
        status: { type: "string", enum: ["available", "unavailable"] },
        reasonCode: nullableReasonCodeSchema,
        verification: { type: "string", enum: [...chainVerificationStates] },
        head: { anyOf: [chainHeadSchema, { type: "null" }] },
        endpoints: { type: "array", maxItems: 8, items: endpointHealthSchema },
      },
    },
    indexer: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "lane",
          "status",
          "reasonCode",
          "lastBlockNumber",
          "lastBlockHash",
          "lagBlocks",
          "reorgCount",
          "updatedAt",
        ],
        properties: {
          lane: { type: "string", enum: [...indexerLanes] },
          status: { type: "string", enum: ["available", "unavailable"] },
          reasonCode: nullableReasonCodeSchema,
          lastBlockNumber: { anyOf: [blockNumberSchema, { type: "null" }] },
          lastBlockHash: {
            anyOf: [
              { type: "string", pattern: blockHashPatternSource },
              { type: "null" },
            ],
          },
          lagBlocks: { anyOf: [{ type: "integer" }, { type: "null" }] },
          reorgCount: {
            anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          },
          updatedAt: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
          },
        },
      },
    },
    registry: {
      type: "object",
      additionalProperties: false,
      required: ["readableAssetCount", "registeredPoolCount"],
      properties: {
        readableAssetCount: { type: "integer", minimum: 0 },
        registeredPoolCount: { type: "integer", minimum: 0 },
      },
    },
    launchChain: launchChainStatusSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const walletProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "walletId",
    "provider",
    "address",
    "kind",
    "status",
    "isActive",
    "firstSeenAt",
    "lastSeenAt",
  ],
  properties: {
    walletId: {
      type: "string",
      pattern: opaqueIdPatternSource,
      description:
        "Opaque LOOP wallet ID. It is the only identifier a request may name; the address below is never accepted as one.",
    },
    provider: { type: "string", const: "privy" },
    address: addressSchema,
    kind: { type: "string", enum: [...walletKinds] },
    status: { type: "string", enum: ["active", "archived"] },
    isActive: { type: "boolean" },
    firstSeenAt: { type: "string", format: "date-time" },
    lastSeenAt: { type: "string", format: "date-time" },
  },
} as const;

export const walletListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["wallets", "activeWalletId", "source", "contractVersion"],
  properties: {
    wallets: { type: "array", maxItems: 50, items: walletProjectionSchema },
    activeWalletId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "observedAt"],
      properties: {
        provider: { type: "string", const: "privy" },
        observedAt: { type: "string", format: "date-time" },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const setActiveWalletRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "expectedActiveWalletId"],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    expectedActiveWalletId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
      description:
        "The wallet the caller believed was active, or null when it believed none was. A concurrent switch from another device is VERSION_CONFLICT, never a silent overwrite.",
    },
  },
} as const;

const rawAmountSchema = {
  type: "string",
  pattern: rawAmountPatternSource,
  description: "Integer amount in the asset's smallest unit, as a string.",
} as const;

const decimalAmountSchema = {
  type: "string",
  pattern: decimalAmountPatternSource,
  description: "Exact decimal string; never a JavaScript floating-point value.",
} as const;

/**
 * The wallet's native coin on the launch chain slot (Decision 0038): one
 * balance at one block, with the primary gas-reserve rule. No registry,
 * pending, valuation, or cross-check facts exist for this slot.
 */
const launchChainBalanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chainId", "availability", "reasonCode", "nativeBalance"],
  properties: {
    chainId: { type: "string", enum: [...launchChainIds] },
    availability: { type: "string", enum: ["available", "unavailable"] },
    reasonCode: nullableReasonCodeSchema,
    nativeBalance: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "assetId",
            "symbol",
            "decimals",
            "rawValue",
            "displayBalance",
            "availableBalance",
            "spendableBalance",
            "gasReserve",
            "snapshot",
          ],
          properties: {
            assetId: assetIdSchema,
            symbol: { type: "string", minLength: 1, maxLength: 32 },
            decimals: { type: "integer", minimum: 0, maximum: 36 },
            rawValue: rawAmountSchema,
            displayBalance: decimalAmountSchema,
            availableBalance: decimalAmountSchema,
            spendableBalance: decimalAmountSchema,
            gasReserve: decimalAmountSchema,
            snapshot: {
              type: "object",
              additionalProperties: false,
              required: [
                "blockNumber",
                "blockHash",
                "observedAt",
                "confirmations",
              ],
              properties: {
                blockNumber: blockNumberSchema,
                blockHash: {
                  type: "string",
                  pattern: blockHashPatternSource,
                },
                observedAt: { type: "string", format: "date-time" },
                confirmations: { type: "integer", minimum: 1 },
              },
            },
          },
        },
        { type: "null" },
      ],
    },
  },
  description:
    "The wallet's native coin on the launch chain slot (LAUNCH_CHAIN_ID). Absent while the slot equals the primary chain. A launch-slot failure is reported here and never fails the primary balances.",
} as const;

export const walletBalancesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "snapshot",
    "gasReservePolicy",
    "balances",
    "netWorth",
    "contractVersion",
  ],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    snapshot: {
      type: "object",
      additionalProperties: false,
      required: ["blockNumber", "blockHash", "observedAt", "confirmations"],
      properties: {
        blockNumber: blockNumberSchema,
        blockHash: { type: "string", pattern: blockHashPatternSource },
        observedAt: { type: "string", format: "date-time" },
        confirmations: { type: "integer", minimum: 1 },
      },
    },
    gasReservePolicy: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "nativeReserveRaw", "nativeReserve"],
      properties: {
        configVersion: {
          type: "string",
          const: walletGasReserveConfigVersion,
        },
        nativeReserveRaw: rawAmountSchema,
        nativeReserve: decimalAmountSchema,
      },
    },
    balances: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "assetId",
          "symbol",
          "name",
          "decimals",
          "address",
          "balance",
          "pending",
          "valuation",
          "crossCheck",
        ],
        properties: {
          assetId: assetIdSchema,
          symbol: { type: "string", minLength: 1, maxLength: 32 },
          name: { type: "string", minLength: 1, maxLength: 128 },
          decimals: { type: "integer", minimum: 0, maximum: 36 },
          address: { anyOf: [addressSchema, { type: "null" }] },
          balance: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "status",
                  "rawValue",
                  "displayBalance",
                  "availableBalance",
                  "spendableBalance",
                  "gasReserve",
                ],
                properties: {
                  status: { type: "string", const: "available" },
                  rawValue: rawAmountSchema,
                  displayBalance: decimalAmountSchema,
                  availableBalance: decimalAmountSchema,
                  spendableBalance: decimalAmountSchema,
                  gasReserve: decimalAmountSchema,
                },
              },
              unavailableSchema,
            ],
            description:
              "Every readable registry asset always yields a row. A failed per-asset chain call reports the amounts as unavailable instead of dropping the asset.",
          },
          pending: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["status", "rawValue", "displayValue"],
                properties: {
                  status: { type: "string", const: "available" },
                  rawValue: rawAmountSchema,
                  displayValue: decimalAmountSchema,
                },
              },
              unavailableSchema,
            ],
          },
          valuation: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "status",
                  "priceSource",
                  "fetchedAt",
                  "quality",
                  "reasonCode",
                  "proxyAsset",
                  "priceUsd",
                  "valueUsd",
                ],
                properties: {
                  status: { type: "string", const: "available" },
                  priceSource: { type: "string", enum: [...marketSources] },
                  fetchedAt: { type: "string", format: "date-time" },
                  quality: {
                    type: "string",
                    enum: ["fresh", "stale", "proxied"],
                    description:
                      "proxied: the native asset valued through proxyAsset (WBNB); reasonCode carries a stale underlying price.",
                  },
                  reasonCode: nullableReasonCodeSchema,
                  proxyAsset: { anyOf: [assetIdSchema, { type: "null" }] },
                  priceUsd: decimalAmountSchema,
                  valueUsd: decimalAmountSchema,
                },
                description:
                  "USD valuation from a fresh or stale Provider price of the asset itself. Display information only; never a spendable amount.",
              },
              unavailableSchema,
            ],
          },
          crossCheck: {
            type: "object",
            additionalProperties: false,
            required: ["source", "status", "reasonCode", "blockDelta"],
            properties: {
              source: { type: "string", const: "privy" },
              status: {
                type: "string",
                enum: ["matched", "unaligned", "disputed", "unavailable"],
                description:
                  "Cross-check only. A difference that cannot be aligned to one block is `unaligned`; nothing here ever changes the authoritative RPC balance.",
              },
              reasonCode: nullableReasonCodeSchema,
              blockDelta: {
                anyOf: [{ type: "integer" }, { type: "null" }],
                description:
                  "Block distance between the two observations, or null when the cross-check source does not report its block.",
              },
            },
          },
        },
      },
    },
    netWorth: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "valuationCurrency",
            "valueUsd",
            "unavailableCount",
            "quality",
            "priceSource",
            "asOf",
            "isSpendable",
          ],
          properties: {
            status: {
              type: "string",
              enum: ["available", "partial"],
              description:
                "available only when every row is valued; partial excludes unavailableCount rows from the total.",
            },
            valuationCurrency: { type: "string", const: "USD" },
            valueUsd: decimalAmountSchema,
            unavailableCount: { type: "integer", minimum: 0 },
            quality: { type: "string", enum: ["fresh", "stale"] },
            priceSource: { type: "string", enum: [...marketSources] },
            asOf: { type: "string", format: "date-time" },
            isSpendable: {
              type: "boolean",
              const: false,
              description:
                "A net worth is display information, never a balance.",
            },
          },
        },
        unavailableSchema,
      ],
    },
    launchChain: launchChainBalanceSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const walletActivityResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "items",
    "nextCursor",
    "freshness",
    "nativeTransfers",
    "crossChain",
    "contractVersion",
  ],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    items: {
      type: "array",
      maxItems: walletActivityLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "assetId",
          "symbol",
          "decimals",
          "direction",
          "counterpartyAddress",
          "rawValue",
          "displayValue",
          "transactionHash",
          "logIndex",
          "blockNumber",
          "blockHash",
          "confirmations",
          "status",
          "observedAt",
        ],
        properties: {
          assetId: assetIdSchema,
          symbol: { type: "string", maxLength: 32 },
          decimals: { type: "integer", minimum: 0, maximum: 36 },
          direction: { type: "string", enum: ["in", "out", "self"] },
          counterpartyAddress: addressSchema,
          rawValue: rawAmountSchema,
          displayValue: decimalAmountSchema,
          transactionHash: {
            type: "string",
            pattern: transactionHashPatternSource,
          },
          logIndex: { type: "integer", minimum: 0 },
          blockNumber: blockNumberSchema,
          blockHash: { type: "string", pattern: blockHashPatternSource },
          confirmations: {
            anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          },
          status: {
            type: "string",
            enum: ["confirmed", "pending", "reorged"],
            description:
              "A reorged row is kept and reported so a client can reconcile what it already displayed.",
          },
          observedAt: { type: "string", format: "date-time" },
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
        headBlockNumber: { anyOf: [blockNumberSchema, { type: "null" }] },
        lagBlocks: {
          anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
        },
        observedAt: { type: "string", format: "date-time" },
      },
    },
    nativeTransfers: unavailableSchema,
    crossChain: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const walletReceiveResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["walletId", "networks", "contractVersion"],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    networks: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chainId", "name", "address", "uri", "warningKey"],
        properties: {
          chainId: { type: "string", pattern: chainIdPatternSource },
          name: { type: "string", minLength: 1, maxLength: 64 },
          address: addressSchema,
          uri: {
            type: "string",
            pattern: "^ethereum:0x[0-9a-f]{40}@[1-9][0-9]{0,9}$",
            description:
              "EIP-681 request for a plain transfer target. It carries no amount, calldata, or Provider URL.",
          },
          warningKey: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const watchlistGroupNameSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern:
    "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])\\S(?:[\\s\\S]*\\S)?$",
  description: `Trimmed to 1-${watchlistV2MaximumNameCodePoints} Unicode code points without control or invisible formatting characters.`,
} as const;

export const watchlistResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "updatedAt", "groups", "contractVersion"],
  properties: {
    version: { type: "integer", minimum: 0 },
    updatedAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    groups: {
      type: "array",
      maxItems: watchlistV2MaximumGroups,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "items"],
        properties: {
          key: { type: "string", pattern: watchlistV2GroupKeyPatternSource },
          name: watchlistGroupNameSchema,
          items: {
            type: "array",
            maxItems: watchlistV2MaximumItems,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId", "asset", "reasonCode"],
              properties: {
                assetId: assetIdSchema,
                asset: {
                  anyOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["symbol", "name", "decimals", "status"],
                      properties: {
                        symbol: { type: "string", minLength: 1, maxLength: 32 },
                        name: { type: "string", minLength: 1, maxLength: 128 },
                        decimals: {
                          type: "integer",
                          minimum: 0,
                          maximum: 36,
                        },
                        status: { type: "string", enum: [...assetStatuses] },
                      },
                    },
                    { type: "null" },
                  ],
                },
                reasonCode: nullableReasonCodeSchema,
              },
            },
          },
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const replaceWatchlistRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "groups"],
  properties: {
    expectedVersion: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    groups: {
      type: "array",
      maxItems: watchlistV2MaximumGroups,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "items"],
        properties: {
          key: { type: "string", pattern: watchlistV2GroupKeyPatternSource },
          name: watchlistGroupNameSchema,
          items: {
            type: "array",
            maxItems: watchlistV2MaximumItems,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId"],
              properties: { assetId: assetIdSchema },
            },
          },
        },
      },
    },
  },
} as const;

export const assetIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId"],
  properties: { assetId: assetIdSchema },
} as const;

export const walletIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const activityQuerySchema = {
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
      maximum: walletActivityLimits.maximum,
    },
  },
} as const;

export const chainReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "RESOURCE_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "INDEXING_DELAYED",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export const chainWriteErrors = {
  ...chainReadErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "RESOURCE_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH", "VALIDATION_FAILED"]),
} as const;

/**
 * Reads accept no `Idempotency-Key`, and a compare-and-swap write is
 * idempotent through its expected version, so a client key is rejected rather
 * than mistaken for a durable command replay (Decision 0030).
 */
export const validateChainHeaders: onRequestHookHandler = (
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
 * Compare-and-swap writes: no `Idempotency-Key`, but `X-Loop-Platform` and
 * `X-Loop-Device-ID` are accepted and validated when present.
 */
export const validateChainWriteHeaders: onRequestHookHandler = (
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

/**
 * V2 amount, price, and threshold fields must arrive as JSON strings. AJV
 * type coercion runs after this hook, so a JSON number is refused here
 * before it can be turned into a string (main-agent ruling, Decision 0034).
 */
export function assertDecimalStringFields(
  fields: readonly string[],
): (request: FastifyRequest) => Promise<void> {
  return (request) => {
    const body = request.body;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      for (const field of fields) {
        const value = readPath(body, field.split("."));
        if (value !== undefined && typeof value !== "string") {
          throw V2ApiError.invalidRequest();
        }
      }
    }
    return Promise.resolve();
  };
}

/** Reads a dot path (`allowance.amount`); a missing segment is `undefined`. */
function readPath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function assertNoBodyOrQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (request.body !== undefined || Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function assertNoBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function assertNoQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export { v2CommonHeadersSchema };
