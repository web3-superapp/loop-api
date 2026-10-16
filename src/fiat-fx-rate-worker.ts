import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import type {
  FiatFxRateQuality,
  FiatFxRateRepository,
} from "./database/fiat-fx-rate-repository.js";
import {
  FiatFxProviderError,
  fiatFxReasonCodes,
  type FiatFxProvider,
  type FiatFxReasonCode,
} from "./integrations/fx/frankfurter-adapter.js";

export const fiatFxRateLane = "fiat_fx_rate";

const dayMs = 24 * 3_600_000;
/**
 * A provider date older than this at fetch time is recorded `stale`: the
 * ECB skips weekends and TARGET holidays (at most four days in a row), so
 * five days means the provider stopped publishing.
 */
export const fiatFxProviderDateStaleAfterMs = 5 * dayMs;
/** A provider date this far after the fetch day is rejected as malformed. */
const fiatFxProviderDateFutureToleranceMs = dayMs;

/** First retry after a provider failure; doubles up to the refresh interval. */
export const fiatFxProviderRetryBaseMs = 60_000;
const retryBaseDelayMs = 1_000;
const retryMaxDelayMs = 60_000;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface FiatFxRatePassResult {
  readonly written: boolean;
  /** Set when the provider read failed (nothing was written). */
  readonly reasonCode: FiatFxReasonCode | null;
  readonly quality: FiatFxRateQuality | null;
}

/**
 * Decision 0149 §2: the `fiat_fx_rate` lane. Every `refreshMs` (default one
 * hour) it reads the configured provider's rate and upserts it into
 * `fiat_fx_rates` with its source, provider date and fetch time. A provider
 * failure (unreachable, timeout, non-200, malformed body, rate outside
 * (0, 1000], a date in the future) writes nothing, is reported with its
 * reason code, and is retried after 60 s, doubling up to `refreshMs`. A
 * database error backs off 1 s → 60 s like the other lanes.
 */
export function createFiatFxRateLane(options: {
  readonly repository: Pick<FiatFxRateRepository, "recordRate">;
  readonly provider: FiatFxProvider;
  readonly refreshMs: number;
  readonly now?: () => Date;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly onPass?: (result: FiatFxRatePassResult) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane & {
  /** Delay before the next pass after `consecutiveProviderFailures`. */
  readonly nextDelayMs: (consecutiveProviderFailures: number) => number;
} {
  const now = options.now ?? ((): Date => new Date());
  const wait = options.wait ?? waitFor;

  async function pass(signal?: AbortSignal): Promise<FiatFxRatePassResult> {
    let observation;
    try {
      observation = await options.provider.readRate(signal);
    } catch (error) {
      return Object.freeze({
        written: false,
        reasonCode:
          error instanceof FiatFxProviderError
            ? error.reasonCode
            : fiatFxReasonCodes.unreachable,
        quality: null,
      });
    }
    const fetchedAt = now();
    const providerDayMs = Date.parse(`${observation.providerAsOf}T00:00:00Z`);
    const fetchDayMs = Date.parse(
      `${fetchedAt.toISOString().slice(0, 10)}T00:00:00Z`,
    );
    if (providerDayMs - fetchDayMs > fiatFxProviderDateFutureToleranceMs) {
      return Object.freeze({
        written: false,
        reasonCode: fiatFxReasonCodes.malformed,
        quality: null,
      });
    }
    const quality: FiatFxRateQuality =
      fetchDayMs - providerDayMs > fiatFxProviderDateStaleAfterMs
        ? "stale"
        : "fresh";
    // A database error propagates to the infrastructure backoff.
    await options.repository.recordRate({
      base: observation.base,
      quote: observation.quote,
      rate: observation.rate,
      source: observation.source,
      providerAsOf: observation.providerAsOf,
      fetchedAt: fetchedAt.toISOString(),
      quality,
    });
    return Object.freeze({ written: true, reasonCode: null, quality });
  }

  const tick = async (
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const result = await pass(signal);
    options.onPass?.(result);
    return { ...result };
  };

  function nextDelayMs(consecutiveProviderFailures: number): number {
    if (consecutiveProviderFailures <= 0) {
      return options.refreshMs;
    }
    return Math.min(
      fiatFxProviderRetryBaseMs *
        2 ** Math.min(consecutiveProviderFailures - 1, 20),
      options.refreshMs,
    );
  }

  return Object.freeze({
    lane: fiatFxRateLane,
    runOnce: tick,
    nextDelayMs,
    async run(signal: AbortSignal): Promise<void> {
      let infrastructureFailures = 0;
      let providerFailures = 0;
      while (!signal.aborted) {
        try {
          const result = await pass(signal);
          // A read cut short by shutdown is not a provider failure.
          if (isAborted(signal)) break;
          options.onPass?.(result);
          infrastructureFailures = 0;
          providerFailures = result.written ? 0 : providerFailures + 1;
          await wait(nextDelayMs(providerFailures), signal);
        } catch (error) {
          if (isAborted(signal)) break;
          infrastructureFailures += 1;
          const delay = Math.min(
            retryBaseDelayMs * 2 ** (infrastructureFailures - 1),
            retryMaxDelayMs,
          );
          options.onInfrastructureBackoff?.({
            lane: fiatFxRateLane,
            consecutiveFailureCount: infrastructureFailures,
            retryDelayMs: delay,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
          await wait(delay, signal);
        }
      }
    },
  });
}
