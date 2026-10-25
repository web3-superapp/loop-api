import { formatE18 } from "../meme/meme-curve-math.js";
import type { SparklineProjection } from "./market-sparkline.js";

/**
 * Decision 0186: the optional `sparkline24h` key on the market list rows
 * (`GET /v2/market/assets?category=…` items, `GET /v2/market/overview`
 * watchlist / trending items) — at most 24 hourly closes, oldest first, as
 * canonical decimal strings in the unit of the row's price; `null` when no
 * source has at least two points. Emitted only behind
 * `MARKET_ROW_SPARKLINE24H_EMIT=on` (default off), because the shipped
 * clients decode these rows with a closed key set.
 *
 * Sources, first that answers:
 *
 * 1. The row's own `sparkline` (Decision 0074, the worker-warmed
 *    GeckoTerminal `sparkline_1h` cache row) when it is `available`: its
 *    closes, last 24.
 * 2. The LOOP chain facts of a launchpad token (one batched SQL read):
 *    launch2 curve trades + official-pool swaps (the Decision 0171 candles
 *    series) or MEME v1 curve trades (`meme_trades.price_after_e18`),
 *    bucketed by UTC hour, close = price after the hour's last fact, an
 *    hour without facts carries the previous close (as the candles route
 *    fills it). Raw 18-decimal USD1 per token, USD1 at par.
 *
 * Nothing else: no padding, no zero, no interpolation across sources.
 */

export const marketRowSparkline24hPolicy = Object.freeze({
  /** Points published at most: one per hour of the 24 h window. */
  points: 24,
  /** Fewer points than this draw no line; the key is `null`. */
  minimumPoints: 2,
  stepSeconds: 3_600,
  /** In-process memo entries kept at most (one per asset). */
  maximumMemoEntries: 2_000,
} as const);

/** One hour that holds at least one fact. */
export interface MarketRowHourlyClose {
  /** Bucket start, unix seconds, `floor(epoch / 3600) × 3600`. */
  readonly t: number;
  /** Price after the bucket's last fact, raw 18 decimals (USD1 per token). */
  readonly closeE18: string;
}

/** The facts of one asset inside / before the requested window. */
export interface MarketRowHourlyRecord {
  /** Unix seconds of the asset's first fact ever. */
  readonly firstAt: number;
  /** Price after the last fact before the window; null = none. */
  readonly priorCloseE18: string | null;
  /** Hours of the window that hold facts, ascending. */
  readonly buckets: readonly MarketRowHourlyClose[];
}

/** The repository surface (one SQL read for many assets). */
export interface MarketRowSeriesStore {
  readHourlyCloses(input: {
    readonly assetIds: readonly string[];
    readonly fromSeconds: number;
    /** Exclusive. */
    readonly toSeconds: number;
  }): Promise<ReadonlyMap<string, MarketRowHourlyRecord>>;
}

export type MarketRowSparkline24h = readonly string[] | null;

/** The 24 h window ending with the hour of `nowSeconds`. */
export function marketRowSparklineWindow(nowSeconds: number): {
  readonly fromSeconds: number;
  readonly endBucket: number;
  readonly toSeconds: number;
} {
  const step = marketRowSparkline24hPolicy.stepSeconds;
  const endBucket = Math.floor(nowSeconds / step) * step;
  return Object.freeze({
    fromSeconds: endBucket - (marketRowSparkline24hPolicy.points - 1) * step,
    endBucket,
    toSeconds: endBucket + step,
  });
}

/** Last 24 points, or null below the two-point minimum. */
export function limitSparkline24h(
  closes: readonly string[],
): MarketRowSparkline24h {
  const points = closes.slice(-marketRowSparkline24hPolicy.points);
  return points.length < marketRowSparkline24hPolicy.minimumPoints
    ? null
    : Object.freeze(points);
}

/** Source 1: the row's own warmed sparkline, when it is available. */
export function sparkline24hFromProjection(
  projection: SparklineProjection,
): MarketRowSparkline24h {
  return projection.status === "available"
    ? limitSparkline24h(projection.closes)
    : null;
}

/**
 * Source 2: one hourly close per hour from the asset's first hour (or the
 * window start) to the current hour. An hour without facts repeats the
 * previous close; hours before the first fact are not drawn.
 */
export function fillHourlySparkline24h(input: {
  readonly record: MarketRowHourlyRecord;
  readonly fromSeconds: number;
  readonly endBucket: number;
}): MarketRowSparkline24h {
  const step = marketRowSparkline24hPolicy.stepSeconds;
  const firstBucket = Math.floor(input.record.firstAt / step) * step;
  const start = Math.max(input.fromSeconds, firstBucket);
  const byHour = new Map(
    input.record.buckets.map((bucket) => [bucket.t, bucket.closeE18]),
  );
  let previous = firstBucket < start ? input.record.priorCloseE18 : null;
  const closes: string[] = [];
  for (let t = start; t <= input.endBucket; t += step) {
    const close = byHour.get(t) ?? previous;
    if (close === null) continue;
    closes.push(formatE18(BigInt(close)));
    previous = close;
  }
  return limitSparkline24h(closes);
}

export interface MarketRowSparkline24hReader {
  /** Source-2 series for the assets that have chain facts; others null. */
  read(
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, MarketRowSparkline24h>>;
}

/**
 * Source 2 behind an in-process memo: one SQL read for every asset of a
 * request that is not memoised for the current hour inside `ttlMs` (the
 * market candles TTL). A failed read answers null for those rows and is not
 * memoised.
 */
export function createMarketRowSparkline24hReader(input: {
  readonly store: MarketRowSeriesStore | null;
  readonly ttlMs: number;
  readonly now?: () => Date;
  readonly onReadFailed?: (error: unknown) => void;
  readonly onRead?: (event: {
    readonly assets: number;
    readonly withSeries: number;
    readonly durationMs: number;
  }) => void;
}): MarketRowSparkline24hReader {
  const now = input.now ?? ((): Date => new Date());
  const memo = new Map<
    string,
    {
      readonly expiresAt: number;
      readonly endBucket: number;
      readonly value: MarketRowSparkline24h;
    }
  >();

  function remember(
    assetId: string,
    entry: {
      readonly expiresAt: number;
      readonly endBucket: number;
      readonly value: MarketRowSparkline24h;
    },
  ): void {
    memo.delete(assetId);
    memo.set(assetId, entry);
    while (memo.size > marketRowSparkline24hPolicy.maximumMemoEntries) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }

  return Object.freeze({
    async read(assetIds: readonly string[]) {
      const result = new Map<string, MarketRowSparkline24h>();
      const nowMs = now().getTime();
      const window = marketRowSparklineWindow(Math.floor(nowMs / 1_000));
      const missing: string[] = [];
      for (const assetId of new Set(assetIds)) {
        const entry = memo.get(assetId);
        if (
          entry !== undefined &&
          entry.expiresAt > nowMs &&
          entry.endBucket === window.endBucket
        ) {
          result.set(assetId, entry.value);
        } else {
          missing.push(assetId);
        }
      }
      if (missing.length === 0) {
        return result;
      }
      if (input.store === null) {
        for (const assetId of missing) result.set(assetId, null);
        return result;
      }
      const started = performance.now();
      let records: ReadonlyMap<string, MarketRowHourlyRecord>;
      try {
        records = await input.store.readHourlyCloses({
          assetIds: missing,
          fromSeconds: window.fromSeconds,
          toSeconds: window.toSeconds,
        });
      } catch (error) {
        input.onReadFailed?.(error);
        for (const assetId of missing) result.set(assetId, null);
        return result;
      }
      let withSeries = 0;
      for (const assetId of missing) {
        const record = records.get(assetId);
        const value =
          record === undefined
            ? null
            : fillHourlySparkline24h({
                record,
                fromSeconds: window.fromSeconds,
                endBucket: window.endBucket,
              });
        if (value !== null) withSeries += 1;
        result.set(assetId, value);
        remember(assetId, {
          expiresAt: nowMs + input.ttlMs,
          endBucket: window.endBucket,
          value,
        });
      }
      input.onRead?.({
        assets: missing.length,
        withSeries,
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    },
  });
}

/**
 * Adds `sparkline24h` to every row: source 1 from the row's own sparkline,
 * source 2 (one batched read) for the rest.
 */
export async function attachSparkline24h<
  Row extends {
    readonly assetId: string;
    readonly sparkline: SparklineProjection;
  },
>(
  rows: readonly Row[],
  reader: MarketRowSparkline24hReader,
): Promise<
  readonly (Row & { readonly sparkline24h: MarketRowSparkline24h })[]
> {
  const own = rows.map((row) => sparkline24hFromProjection(row.sparkline));
  const wanted = rows.flatMap((row, index) =>
    own[index] === null ? [row.assetId] : [],
  );
  const chain =
    wanted.length === 0
      ? new Map<string, MarketRowSparkline24h>()
      : await reader.read(wanted);
  return Object.freeze(
    rows.map((row, index) =>
      Object.freeze({
        ...row,
        sparkline24h: own[index] ?? chain.get(row.assetId) ?? null,
      }),
    ),
  );
}
