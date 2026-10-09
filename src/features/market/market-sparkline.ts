import { z } from "zod";

import {
  MarketFactCacheUnavailableError,
  type MarketFactCacheRecord,
  type MarketFactCacheRepository,
} from "../../database/market-fact-cache-repository.js";
import type { PoolOhlcvSnapshot } from "../../integrations/market/market-data-provider.js";
import {
  compareDecimalStrings,
  isCanonicalDecimalString,
  marketReasonCodes,
  marketSparklinePolicy,
  type MarketSource,
} from "./market-contract.js";

/**
 * Row sparkline (Decision 0074): the last 24 hourly closes of one pool,
 * kept as one `market_fact_cache` row per token by the worker lane and
 * projected by the overview from that row alone. The request path never
 * reads the Provider for it; a row that is not there is `unavailable`.
 */

export const sparklineSource: MarketSource = "geckoterminal";

const sparklineRowSchema = z
  .object({
    interval: z.literal(marketSparklinePolicy.interval),
    poolAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    poolOrigin: z.enum(["registry", "provider"]),
    poolChosenAt: z.string().datetime(),
    closes: z
      .array(z.string().refine(isCanonicalDecimalString))
      .max(marketSparklinePolicy.pointLimit),
    candleCount: z.number().int().min(0),
    /** Highest `high` and lowest `low` of the same candles; null without candles. */
    high: z.string().refine(isCanonicalDecimalString).nullable(),
    low: z.string().refine(isCanonicalDecimalString).nullable(),
  })
  .strict();

export type SparklineRowValue = {
  readonly interval: typeof marketSparklinePolicy.interval;
  readonly poolAddress: string;
  readonly poolOrigin: "registry" | "provider";
  readonly poolChosenAt: string;
  readonly closes: readonly string[];
  readonly candleCount: number;
  readonly high: string | null;
  readonly low: string | null;
};

/**
 * The asset page's 24h high / low (Decision 0074 §1b): the extremes of the
 * same cached hourly candles the row sparkline is drawn from. `bars` says
 * how many candles the range covers, so a token with less than 24 hours of
 * history is published with what exists rather than withheld.
 */
export type Range24hProjection =
  | {
      readonly status: "available";
      readonly high: string;
      readonly low: string;
      readonly bars: number;
      readonly observedAt: string;
      readonly source: MarketSource;
      readonly quality: "fresh" | "stale" | "proxied";
    }
  | UnavailableSparklineProjection;

/** The unavailable variant both projections of the row share. */
export type UnavailableSparklineProjection = {
  readonly status: "unavailable";
  readonly reasonCode: string;
};

export type SparklineProjection =
  | {
      readonly status: "available";
      readonly interval: typeof marketSparklinePolicy.interval;
      /** 1–24 canonical decimal strings, oldest first; the last is the open hour. */
      readonly closes: readonly string[];
      /** When the OHLCV fact behind the row was fetched. */
      readonly observedAt: string;
      readonly source: MarketSource;
      readonly quality: "fresh" | "stale" | "proxied";
    }
  | UnavailableSparklineProjection;

export function sparklineSubjectKey(tokenAddress: string): string {
  return `token:${tokenAddress}`;
}

/** The cache row value a lane refresh writes for one token. */
export function sparklineRowFromCandles(input: {
  readonly poolAddress: string;
  readonly poolOrigin: "registry" | "provider";
  readonly poolChosenAt: string;
  readonly snapshot: PoolOhlcvSnapshot;
}): SparklineRowValue {
  const candles = input.snapshot.candles.slice(
    -marketSparklinePolicy.pointLimit,
  );
  let high: string | null = null;
  let low: string | null = null;
  for (const candle of candles) {
    high =
      high === null || compareDecimalStrings(candle.high, high) > 0
        ? candle.high
        : high;
    low =
      low === null || compareDecimalStrings(candle.low, low) < 0
        ? candle.low
        : low;
  }
  return Object.freeze({
    interval: marketSparklinePolicy.interval,
    poolAddress: input.poolAddress,
    poolOrigin: input.poolOrigin,
    poolChosenAt: input.poolChosenAt,
    closes: Object.freeze(candles.map((candle) => candle.close)),
    candleCount: candles.length,
    high,
    low,
  });
}

/** A cached row parsed back, or `null` when the row is not this codec. */
export function parseSparklineRow(
  record: MarketFactCacheRecord,
): SparklineRowValue | null {
  const parsed = sparklineRowSchema.safeParse(record.value);
  return parsed.success ? parsed.data : null;
}

export function unavailableSparkline(
  reasonCode: string,
): UnavailableSparklineProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}

/**
 * Freshness is decided here, the same way `market-fact-service` decides it
 * for every other row: inside the TTL is `fresh`, inside the grace window
 * is `stale`, past it the row is not published. A proxied row (the native
 * asset reading WBNB's) is labelled `proxied` and never also `stale`, as
 * its price fact is.
 */
export function projectSparkline(input: {
  readonly record: MarketFactCacheRecord | null;
  readonly nowMs: number;
  readonly staleGraceSeconds: number;
  readonly proxied: boolean;
}): SparklineProjection {
  const { record } = input;
  if (record === null) {
    return unavailableSparkline(marketReasonCodes.sparklineNotCached);
  }
  const row = parseSparklineRow(record);
  if (row === null) {
    return unavailableSparkline(marketReasonCodes.sparklineNotCached);
  }
  const ageSeconds = (input.nowMs - Date.parse(record.fetchedAt)) / 1_000;
  if (
    !(ageSeconds >= 0) ||
    ageSeconds >= record.ttlSeconds + input.staleGraceSeconds
  ) {
    return unavailableSparkline(marketReasonCodes.sparklineExpired);
  }
  if (row.closes.length === 0) {
    return unavailableSparkline(marketReasonCodes.sparklineEmpty);
  }
  return Object.freeze({
    status: "available",
    interval: marketSparklinePolicy.interval,
    closes: row.closes,
    observedAt: record.fetchedAt,
    source: record.source,
    quality: input.proxied
      ? "proxied"
      : ageSeconds < record.ttlSeconds
        ? "fresh"
        : "stale",
  });
}

/**
 * The 24h range from the same row (Decision 0074 §1b); freshness exactly as
 * `projectSparkline`, and the same reason codes, because it is the same row.
 */
export function projectRange24h(input: {
  readonly record: MarketFactCacheRecord | null;
  readonly nowMs: number;
  readonly staleGraceSeconds: number;
  readonly proxied: boolean;
}): Range24hProjection {
  const { record } = input;
  if (record === null) {
    return unavailableSparkline(marketReasonCodes.sparklineNotCached);
  }
  const row = parseSparklineRow(record);
  if (row === null) {
    return unavailableSparkline(marketReasonCodes.sparklineNotCached);
  }
  const ageSeconds = (input.nowMs - Date.parse(record.fetchedAt)) / 1_000;
  if (
    !(ageSeconds >= 0) ||
    ageSeconds >= record.ttlSeconds + input.staleGraceSeconds
  ) {
    return unavailableSparkline(marketReasonCodes.sparklineExpired);
  }
  if (row.high === null || row.low === null || row.candleCount === 0) {
    return unavailableSparkline(marketReasonCodes.sparklineEmpty);
  }
  return Object.freeze({
    status: "available",
    high: row.high,
    low: row.low,
    bars: row.candleCount,
    observedAt: record.fetchedAt,
    source: record.source,
    quality: input.proxied
      ? "proxied"
      : ageSeconds < record.ttlSeconds
        ? "fresh"
        : "stale",
  });
}

/**
 * The sparkline rows of many tokens in one cache read. A cache that cannot
 * be read answers `null`, and the caller publishes every row as
 * `MARKET_FACT_CACHE_UNAVAILABLE`.
 */
export async function readSparklineRows(
  cache: MarketFactCacheRepository,
  tokenAddresses: readonly string[],
): Promise<ReadonlyMap<string, MarketFactCacheRecord> | null> {
  if (tokenAddresses.length === 0) {
    return new Map();
  }
  try {
    const records = await cache.getMany(
      tokenAddresses.map(sparklineSubjectKey),
      marketSparklinePolicy.factKind,
      sparklineSource,
    );
    const byAddress = new Map<string, MarketFactCacheRecord>();
    for (const address of tokenAddresses) {
      const record = records.get(sparklineSubjectKey(address));
      if (record !== undefined) {
        byAddress.set(address, record);
      }
    }
    return byAddress;
  } catch (error) {
    if (error instanceof MarketFactCacheUnavailableError) {
      return null;
    }
    throw error;
  }
}

export async function readSparklineRow(
  cache: MarketFactCacheRepository,
  tokenAddress: string,
): Promise<MarketFactCacheRecord | null> {
  return cache.get(
    sparklineSubjectKey(tokenAddress),
    marketSparklinePolicy.factKind,
    sparklineSource,
  );
}

export async function writeSparklineRow(
  cache: MarketFactCacheRepository,
  input: {
    readonly tokenAddress: string;
    readonly value: SparklineRowValue;
    readonly rawDigest: string;
    readonly fetchedAt: string;
    readonly ttlSeconds: number;
  },
): Promise<MarketFactCacheRecord> {
  return cache.put({
    subjectKey: sparklineSubjectKey(input.tokenAddress),
    factKind: marketSparklinePolicy.factKind,
    source: sparklineSource,
    value: input.value,
    rawDigest: input.rawDigest,
    fetchedAt: input.fetchedAt,
    ttlSeconds: input.ttlSeconds,
  });
}
