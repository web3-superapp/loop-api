import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import {
  launch2CandleDefaultLimit,
  launch2CandleIntervalNames,
  launch2CandleMaximumLimit,
} from "../../features/launch2/launch2-candles.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";

/** Decision 0171: `GET /v2/launch2/instances/{instanceId}/candles`. */

const decimalSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,40})(\\.[0-9]{1,18})?$",
} as const;
const unixSecondsSchema = {
  type: "integer",
  minimum: 0,
  maximum: 253_402_300_799,
} as const;

/**
 * Values are checked by the service so every bad value is 422
 * VALIDATION_FAILED with its reasonCode (an unknown key stays 400).
 */
export const launch2CandlesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interval: {
      type: "string",
      maxLength: 8,
      description: `One of ${launch2CandleIntervalNames.join(" | ")} (default 5m); else 422 LAUNCH2_CANDLE_INTERVAL_INVALID.`,
    },
    limit: {
      type: "string",
      maxLength: 8,
      description: `Buckets, 1..${launch2CandleMaximumLimit} (default ${launch2CandleDefaultLimit}); else 422 LAUNCH2_CANDLE_LIMIT_INVALID.`,
    },
    before: {
      type: "string",
      maxLength: 16,
      description:
        "Unix seconds (positive integer): only buckets with t < before (paging back). Else 422 LAUNCH2_CANDLE_BEFORE_INVALID.",
    },
  },
} as const;

const candleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["t", "o", "h", "l", "c", "v", "q", "n"],
  properties: {
    t: {
      ...unixSecondsSchema,
      description: "Bucket start, unix seconds, UTC-aligned to the interval.",
    },
    o: {
      ...decimalSchema,
      description:
        "USD1 per MEME: the previous bucket's close (the curve start price launch2PriceAt(0) before the first trade).",
    },
    h: { ...decimalSchema, description: "Max of o and the bucket's prices." },
    l: { ...decimalSchema, description: "Min of o and the bucket's prices." },
    c: { ...decimalSchema, description: "Price after the bucket's last fact." },
    v: {
      ...decimalSchema,
      description: "MEME traded in the bucket (buys + sells).",
    },
    q: {
      ...decimalSchema,
      description:
        "USD1 traded in the bucket: curve usd1_net (buy: into the reserve after tax; sell: paid out after tax) + pool swap USD1 leg.",
    },
    n: {
      type: "integer",
      minimum: 0,
      description: "Facts in the bucket; 0 = a flat filler bucket.",
    },
  },
} as const;

export const launch2CandlesResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "interval",
    "quoteAsset",
    "source",
    "candles",
    "latest",
    "contractVersion",
  ],
  properties: {
    instanceId: { type: "string", pattern: opaqueIdPatternSource },
    interval: { type: "string", enum: [...launch2CandleIntervalNames] },
    quoteAsset: { type: "string", const: "USD1" },
    source: {
      type: "string",
      enum: ["curve", "pool", "mixed"],
      description:
        "Where the returned candles' prices came from: curve trades only, pool swaps only, or both (the graduation crossing). An empty page: pool once graduated, else curve.",
    },
    candles: {
      type: "array",
      maxItems: launch2CandleMaximumLimit,
      items: candleSchema,
      description:
        "Ascending by t; dense from the first trade's bucket to the bucket of now (or the last one before `before`), empty buckets flat at the previous close. Empty before the first trade.",
    },
    latest: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["price", "at"],
          properties: {
            price: decimalSchema,
            at: unixSecondsSchema,
          },
        },
        { type: "null" },
      ],
      description:
        "The newest fact's price and time (independent of before); with no trade the curve start price at the activation time; null for an instance on hold that never activated.",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;
