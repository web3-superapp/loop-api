import { MarketProviderError } from "../market/market-data-provider.js";
import {
  createProviderHttpKernel,
  createRateLimiter,
  nodeProviderFetch,
  type ProviderFetch,
} from "../market/provider-http.js";

/**
 * Decision 0149: the fiat FX reference rate adapter. It reads one currency
 * pair from a single named provider of the Frankfurter API (default: the
 * European Central Bank reference rate, `/v2/providers/ecb/rate/USD/CNY`;
 * no API key). The body is parsed losslessly, so the rate never passes
 * through a JavaScript `number`. Anything but one well-formed observation
 * of the requested pair fails with a `FIAT_FX_PROVIDER_*` reason code; the
 * body and URL are never logged.
 */

export const fiatFxReasonCodes = Object.freeze({
  unreachable: "FIAT_FX_PROVIDER_UNREACHABLE",
  rejected: "FIAT_FX_PROVIDER_REQUEST_REJECTED",
  rateLimited: "FIAT_FX_PROVIDER_RATE_LIMITED",
  malformed: "FIAT_FX_PROVIDER_RESPONSE_MALFORMED",
} as const);

export type FiatFxReasonCode =
  (typeof fiatFxReasonCodes)[keyof typeof fiatFxReasonCodes];

export class FiatFxProviderError extends Error {
  constructor(
    readonly reasonCode: FiatFxReasonCode,
    /** HTTP status when the provider answered; never its body or URL. */
    readonly httpStatus: number | null = null,
  ) {
    super(`Fiat FX provider request failed (${reasonCode})`);
    this.name = "FiatFxProviderError";
  }
}

/** Upper bound of a plausible quote-per-base rate (Decision 0149 §2). */
export const fiatFxMaximumRate = "1000";
/** At most this many fraction digits are accepted from the provider. */
export const fiatFxMaximumFractionDigits = 12;

export interface FiatFxObservation {
  readonly base: string;
  readonly quote: string;
  /** Canonical positive decimal string (no exponent, no trailing zeros). */
  readonly rate: string;
  /** Provider key from the URL, lower case (e.g. `ecb`). */
  readonly source: string;
  /** The provider's observation date, `YYYY-MM-DD`. */
  readonly providerAsOf: string;
}

export interface FiatFxProvider {
  readonly source: string;
  readRate(signal?: AbortSignal): Promise<FiatFxObservation>;
}

const currencyPattern = /^[A-Z]{3}$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const ratePattern = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Canonical form of a positive decimal in (0, 1000], or null. */
export function canonicalFiatFxRate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = ratePattern.exec(value);
  if (match === null) {
    return null;
  }
  const integer = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > fiatFxMaximumFractionDigits) {
    return null;
  }
  if (integer === "0" && fraction.length === 0) {
    return null;
  }
  // Integer part: at most 1000, and exactly 1000 only without a fraction.
  if (integer.length > 4 || (integer.length === 4 && integer > "1000")) {
    return null;
  }
  if (integer === "1000" && fraction.length > 0) {
    return null;
  }
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = datePattern.exec(value);
  if (match === null) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** The provider key named by `/providers/{key}/` in the URL, or null. */
export function fiatFxSourceFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /\/providers\/([A-Za-z]{2,16})\//.exec(parsed.pathname);
  return match?.[1]?.toLowerCase() ?? null;
}

function mapError(error: unknown): FiatFxProviderError {
  if (error instanceof FiatFxProviderError) {
    return error;
  }
  if (error instanceof MarketProviderError) {
    switch (error.code) {
      case "market_provider_rate_limited":
        return new FiatFxProviderError(fiatFxReasonCodes.rateLimited);
      case "market_provider_rejected":
        return new FiatFxProviderError(
          fiatFxReasonCodes.rejected,
          error.httpStatus,
        );
      case "market_provider_malformed":
        return new FiatFxProviderError(fiatFxReasonCodes.malformed);
      default:
        return new FiatFxProviderError(fiatFxReasonCodes.unreachable);
    }
  }
  return new FiatFxProviderError(fiatFxReasonCodes.unreachable);
}

export function createFrankfurterFiatFxProvider(input: {
  readonly url: string;
  readonly base: string;
  readonly quote: string;
  readonly fetch?: ProviderFetch;
  readonly timeoutMs?: number;
}): FiatFxProvider {
  const source = fiatFxSourceFromUrl(input.url);
  if (
    source === null ||
    !currencyPattern.test(input.base) ||
    !currencyPattern.test(input.quote)
  ) {
    throw new Error("Fiat FX provider is misconfigured");
  }
  const kernel = createProviderHttpKernel({
    fetch: input.fetch ?? nodeProviderFetch,
    // Hourly polling; the limiter only guards against a runaway loop.
    rateLimiter: createRateLimiter({ capacityPerMinute: 6 }),
    timeoutMs: input.timeoutMs ?? 8_000,
    maximumBodyBytes: 64_000,
  });
  return Object.freeze({
    source,
    async readRate(signal?: AbortSignal): Promise<FiatFxObservation> {
      let json: unknown;
      try {
        ({ json } = await kernel.requestJson({
          url: input.url,
          ...(signal === undefined ? {} : { signal }),
        }));
      } catch (error) {
        throw mapError(error);
      }
      // `/rate/{base}/{quote}` answers one object, `/rates?...` an array.
      const rows = Array.isArray(json) ? json : [json];
      const matching = rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" &&
          row !== null &&
          (row as Record<string, unknown>)["base"] === input.base &&
          (row as Record<string, unknown>)["quote"] === input.quote,
      );
      const row = matching.length === 1 ? matching[0] : undefined;
      const rate = canonicalFiatFxRate(row?.["rate"]);
      const date = row?.["date"];
      if (row === undefined || rate === null || !isCalendarDate(date)) {
        throw new FiatFxProviderError(fiatFxReasonCodes.malformed);
      }
      return Object.freeze({
        base: input.base,
        quote: input.quote,
        rate,
        source,
        providerAsOf: date,
      });
    },
  });
}
