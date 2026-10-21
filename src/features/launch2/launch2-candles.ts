import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import { formatLaunch2Amount } from "./launch2-contract.js";
import { launch2PriceAt } from "./launch2-curve-math.js";

/**
 * Decision 0171: `GET /v2/launch2/instances/{instanceId}/candles` — the
 * project page's K-line over one price series: curve trades (marginal price
 * after each trade, `launch2PriceAt(sold)`) and, after graduation, the
 * official-pool swaps (`price_e18` after each swap, the `pool_last_price_e18`
 * basis), in chain order. Read from the `launch2_event` lane's tables only;
 * the repository aggregates the buckets in SQL, this module fills the empty
 * buckets with the previous close and shapes the resource.
 */

export const launch2CandleIntervals = Object.freeze({
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
} as const);

export type Launch2CandleInterval = keyof typeof launch2CandleIntervals;

export const launch2CandleIntervalNames = Object.freeze(
  Object.keys(launch2CandleIntervals) as Launch2CandleInterval[],
);

export const launch2CandleDefaultInterval: Launch2CandleInterval = "5m";
export const launch2CandleDefaultLimit = 200;
export const launch2CandleMaximumLimit = 500;

/** 422 VALIDATION_FAILED reason codes of the candles route. */
export const launch2CandleReasonCodes = Object.freeze({
  intervalInvalid: "LAUNCH2_CANDLE_INTERVAL_INVALID",
  limitInvalid: "LAUNCH2_CANDLE_LIMIT_INVALID",
  beforeInvalid: "LAUNCH2_CANDLE_BEFORE_INVALID",
} as const);

/** The newest priced fact and the first one (unix seconds). */
export interface Launch2CandleBoundsRecord {
  /** Unix seconds of the oldest non-removed priced fact; null = none. */
  readonly firstAt: number | null;
  /** The newest priced fact (raw 18-decimal USD1 per MEME); null = none. */
  readonly latest: { readonly priceE18: string; readonly at: number } | null;
}

/** One bucket that holds at least one fact (SQL aggregate). */
export interface Launch2CandleBucketRecord {
  /** Bucket start, unix seconds, aligned to the interval from the epoch (UTC). */
  readonly t: number;
  /** Max / min / last of the prices after each fact (raw 18 decimals). */
  readonly highE18: string;
  readonly lowE18: string;
  readonly closeE18: string;
  /** Σ MEME amount, Σ USD1 (see the decision for the legs), fact count. */
  readonly volumeMeme: string;
  readonly volumeUsd1: string;
  readonly count: number;
  readonly hasCurve: boolean;
  readonly hasPool: boolean;
}

export interface Launch2CandleWindowRecord {
  /** The price after the last fact before `fromSeconds`; null = none. */
  readonly priorCloseE18: string | null;
  /** Whether that fact is a pool swap; null = none. */
  readonly priorPool: boolean | null;
  /** Buckets in [fromSeconds, toSeconds) that hold facts, ascending. */
  readonly buckets: readonly Launch2CandleBucketRecord[];
}

/** The repository surface this route reads (optional on the port). */
export interface Launch2CandleStore {
  readCandleBounds(input: {
    readonly instanceId: string;
  }): Promise<Launch2CandleBoundsRecord>;
  readCandleWindow(input: {
    readonly instanceId: string;
    readonly stepSeconds: number;
    readonly fromSeconds: number;
    /** Exclusive. */
    readonly toSeconds: number;
  }): Promise<Launch2CandleWindowRecord>;
}

export interface Launch2CandleQuery {
  readonly interval: Launch2CandleInterval;
  readonly stepSeconds: number;
  readonly limit: number;
  /** Unix seconds; only buckets with `t < before`. */
  readonly before: number | null;
}

function invalid(reasonCode: string): never {
  throw V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode });
}

/** Largest `before` accepted: year 9999 (keeps every bucket a safe integer). */
const maximumBefore = 253_402_300_799;

export function parseLaunch2CandleQuery(input: {
  readonly interval?: unknown;
  readonly limit?: unknown;
  readonly before?: unknown;
}): Launch2CandleQuery {
  const interval =
    input.interval === undefined
      ? launch2CandleDefaultInterval
      : input.interval;
  if (
    typeof interval !== "string" ||
    !Object.hasOwn(launch2CandleIntervals, interval)
  ) {
    invalid(launch2CandleReasonCodes.intervalInvalid);
  }
  const name = interval as Launch2CandleInterval;
  let limit = launch2CandleDefaultLimit;
  if (input.limit !== undefined) {
    const text = typeof input.limit === "string" ? input.limit : "";
    limit = /^[1-9][0-9]{0,3}$/u.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(limit) || limit > launch2CandleMaximumLimit) {
      invalid(launch2CandleReasonCodes.limitInvalid);
    }
  }
  let before: number | null = null;
  if (input.before !== undefined) {
    const text = typeof input.before === "string" ? input.before : "";
    before = /^[1-9][0-9]{0,11}$/u.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(before) || before > maximumBefore) {
      invalid(launch2CandleReasonCodes.beforeInvalid);
    }
  }
  return Object.freeze({
    interval: name,
    stepSeconds: launch2CandleIntervals[name],
    limit,
    before,
  });
}

function floorTo(seconds: number, step: number): number {
  return Math.floor(seconds / step) * step;
}

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export type Launch2CandleSeriesSource = "curve" | "pool" | "mixed";

/**
 * The window to read: the `limit` newest buckets ending at the bucket of
 * `now` (or the last bucket before `before`), never before the first fact's
 * bucket. Null when nothing falls in it.
 */
export function launch2CandleWindow(input: {
  readonly query: Launch2CandleQuery;
  readonly firstAt: number;
  readonly latestAt: number;
  readonly nowSeconds: number;
}): { readonly fromSeconds: number; readonly endBucket: number } | null {
  const step = input.query.stepSeconds;
  const first = floorTo(input.firstAt, step);
  // A fact stamped after the server clock (block time skew) still shows.
  let end = floorTo(Math.max(input.nowSeconds, input.latestAt), step);
  if (input.query.before !== null) {
    end = Math.min(end, floorTo(input.query.before - 1, step));
  }
  if (end < first) return null;
  return {
    fromSeconds: Math.max(first, end - (input.query.limit - 1) * step),
    endBucket: end,
  };
}

/**
 * Fills the window bucket by bucket: open = the previous close (the curve
 * start price before the first fact), high / low include the open, an empty
 * bucket is flat at the previous close with zero volume. `sources` = where
 * the prices of the page came from (a flat bucket counts its close's
 * source).
 */
export function fillLaunch2Candles(input: {
  readonly fromSeconds: number;
  readonly endBucket: number;
  readonly stepSeconds: number;
  readonly priorCloseE18: bigint;
  /** Where the prior close came from (the start price is the curve's). */
  readonly priorSource: "curve" | "pool";
  readonly buckets: readonly Launch2CandleBucketRecord[];
}): {
  readonly candles: readonly Record<string, unknown>[];
  readonly sources: ReadonlySet<"curve" | "pool">;
} {
  const byTime = new Map(input.buckets.map((bucket) => [bucket.t, bucket]));
  const candles: Record<string, unknown>[] = [];
  const sources = new Set<"curve" | "pool">();
  let previous = input.priorCloseE18;
  // The last fact's own source: the close of a bucket that holds both is
  // its last fact's, which is a pool swap (chain order: curve, then pool).
  let previousSource = input.priorSource;
  for (
    let t = input.fromSeconds;
    t <= input.endBucket;
    t += input.stepSeconds
  ) {
    const bucket = byTime.get(t);
    if (bucket === undefined) {
      sources.add(previousSource);
      const flat = formatLaunch2Amount(previous);
      candles.push(
        Object.freeze({
          t,
          o: flat,
          h: flat,
          l: flat,
          c: flat,
          v: "0",
          q: "0",
          n: 0,
        }),
      );
      continue;
    }
    if (bucket.hasCurve) sources.add("curve");
    if (bucket.hasPool) sources.add("pool");
    const open = previous;
    const close = BigInt(bucket.closeE18);
    candles.push(
      Object.freeze({
        t,
        o: formatLaunch2Amount(open),
        h: formatLaunch2Amount(maxOf(open, BigInt(bucket.highE18))),
        l: formatLaunch2Amount(minOf(open, BigInt(bucket.lowE18))),
        c: formatLaunch2Amount(close),
        v: formatLaunch2Amount(BigInt(bucket.volumeMeme)),
        q: formatLaunch2Amount(BigInt(bucket.volumeUsd1)),
        n: bucket.count,
      }),
    );
    previous = close;
    previousSource = bucket.hasPool ? "pool" : "curve";
  }
  return { candles, sources };
}

/** The resource of one read (the service has resolved the instance). */
export async function readLaunch2Candles(input: {
  readonly instanceId: string;
  readonly graduated: boolean;
  /** ISO time of `LaunchActivated`; null for an instance on hold. */
  readonly activatedAt: string | null;
  readonly store: Launch2CandleStore;
  readonly query: Launch2CandleQuery;
  readonly now: Date;
}): Promise<Record<string, unknown>> {
  const { query, store } = input;
  const startPrice = launch2PriceAt(0n);
  const bounds = await store.readCandleBounds({ instanceId: input.instanceId });
  const latest =
    bounds.latest !== null
      ? Object.freeze({
          price: formatLaunch2Amount(BigInt(bounds.latest.priceE18)),
          at: bounds.latest.at,
        })
      : input.activatedAt !== null
        ? Object.freeze({
            price: formatLaunch2Amount(startPrice),
            at: Math.floor(Date.parse(input.activatedAt) / 1000),
          })
        : null;
  let candles: readonly Record<string, unknown>[] = [];
  let sources: ReadonlySet<"curve" | "pool"> = new Set();
  if (bounds.firstAt !== null && bounds.latest !== null) {
    const window = launch2CandleWindow({
      query,
      firstAt: bounds.firstAt,
      latestAt: bounds.latest.at,
      nowSeconds: Math.floor(input.now.getTime() / 1000),
    });
    if (window !== null) {
      const read = await store.readCandleWindow({
        instanceId: input.instanceId,
        stepSeconds: query.stepSeconds,
        fromSeconds: window.fromSeconds,
        toSeconds: window.endBucket + query.stepSeconds,
      });
      const filled = fillLaunch2Candles({
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
        stepSeconds: query.stepSeconds,
        priorCloseE18:
          read.priorCloseE18 === null ? startPrice : BigInt(read.priorCloseE18),
        priorSource: read.priorPool === true ? "pool" : "curve",
        buckets: read.buckets,
      });
      candles = filled.candles;
      sources = filled.sources;
    }
  }
  const source: Launch2CandleSeriesSource =
    sources.size === 2
      ? "mixed"
      : sources.size === 1
        ? [...sources][0]!
        : input.graduated
          ? "pool"
          : "curve";
  return Object.freeze({
    instanceId: input.instanceId,
    interval: query.interval,
    quoteAsset: "USD1",
    source,
    candles,
    latest,
    contractVersion: v2ContractVersion,
  });
}
