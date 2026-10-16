import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { decimalAmountPatternSource } from "../../features/chain/chain-contract.js";
import { signedDecimalPatternSource } from "../../features/market/market-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  walletNetWorthHistoryMaxPoints,
  walletNetWorthHistoryRanges,
} from "../../features/wallet/wallet-networth-history.js";
import { walletNetWorthQualities } from "../../database/wallet-networth-snapshot-repository.js";

/**
 * Decision 0145: `GET /v2/wallets/:walletId/networth/history`. Every
 * amount is an exact decimal string, never a JSON number.
 */

const usdSchema = {
  type: "string",
  pattern: decimalAmountPatternSource,
  description: "USD as an exact decimal string; display information only.",
} as const;

const signedUsdSchema = {
  type: "string",
  pattern: signedDecimalPatternSource,
} as const;

const qualitySchema = {
  type: "string",
  enum: [...walletNetWorthQualities],
  description:
    "fresh / stale: every registry row valued (stale: a stale underlying price). partial: at least one row unvalued; the value excludes it.",
} as const;

const extremeSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["at", "netWorthUsd"],
      properties: {
        at: { type: "string", format: "date-time" },
        netWorthUsd: usdSchema,
      },
    },
    { type: "null" },
  ],
} as const;

export const walletNetWorthHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["range"],
  properties: {
    range: { type: "string", enum: [...walletNetWorthHistoryRanges] },
  },
} as const;

export const walletNetWorthHistoryResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "walletId",
    "range",
    "points",
    "current",
    "change24h",
    "high",
    "low",
    "fiat",
    "source",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    range: { type: "string", enum: [...walletNetWorthHistoryRanges] },
    points: {
      type: "array",
      maxItems: walletNetWorthHistoryMaxPoints,
      description:
        "Hourly snapshots downsampled to the last snapshot of each slot (1d: 1 h, 7d: 4 h, 30d: 1 day, 180d: 3 days, 360d: 7 days), oldest first. Empty before the first snapshot; current is not repeated here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "netWorthUsd", "quality"],
        properties: {
          at: {
            type: "string",
            format: "date-time",
            description: "Start of the snapshot slot (the top of the hour).",
          },
          netWorthUsd: usdSchema,
          quality: qualitySchema,
        },
      },
    },
    current: {
      type: "object",
      additionalProperties: false,
      required: ["netWorthUsd", "at", "quality", "origin"],
      properties: {
        netWorthUsd: usdSchema,
        at: { type: "string", format: "date-time" },
        quality: qualitySchema,
        origin: {
          type: "string",
          enum: ["live", "snapshot"],
          description:
            "live: valued for this response like GET /v2/wallets/:walletId/balances netWorth; snapshot: the live read was unavailable and this is the newest snapshot (quality at best stale).",
        },
      },
    },
    change24h: {
      description:
        "current minus the newest snapshot between 48 h and 24 h before current.at; null without such a snapshot. pct is null when that snapshot is zero.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["usd", "pct", "baselineAt"],
          properties: {
            usd: signedUsdSchema,
            pct: { anyOf: [signedUsdSchema, { type: "null" }] },
            baselineAt: { type: "string", format: "date-time" },
          },
        },
        { type: "null" },
      ],
    },
    high: {
      ...extremeSchema,
      description:
        "Highest non-partial snapshot in the range, or current when higher and not partial.",
    },
    low: {
      ...extremeSchema,
      description:
        "Lowest non-partial snapshot in the range, or current when lower and not partial.",
    },
    fiat: {
      description:
        "Decision 0149: current.netWorthUsd in CNY at the latest recorded reference rate (amount 2 places, half away from zero) with its provenance; null when no rate has ever been recorded or the rate read failed.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "currency",
            "rate",
            "amount",
            "source",
            "asOf",
            "fetchedAt",
            "quality",
          ],
          properties: {
            currency: { type: "string", const: "CNY" },
            rate: { ...usdSchema, description: "CNY per 1 USD." },
            amount: {
              ...usdSchema,
              description: "CNY as an exact decimal string (2 places).",
            },
            source: {
              type: "string",
              pattern: "^[a-z]{2,16}$",
              description:
                "Rate provider key (ecb = European Central Bank reference rate).",
            },
            asOf: {
              type: "string",
              format: "date",
              description: "The provider's observation date.",
            },
            fetchedAt: { type: "string", format: "date-time" },
            quality: {
              type: "string",
              enum: ["fresh", "stale"],
              description:
                "fresh: fetched within the last 26 hours; stale: older, or the provider's date was already more than five days old at fetch time.",
            },
          },
        },
        { type: "null" },
      ],
    },
    source: { type: "string", const: "dexscreener" },
    observedAt: { type: "string", format: "date-time" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;
