/**
 * V2 market fact contract (Decision 0034).
 *
 * A market fact is a value a named Provider reported at a known time with a
 * known TTL. LOOP publishes the fact with its provenance and a quality flag;
 * it never blends sources, never converts a missing value to zero, and never
 * states a number without saying where it came from.
 */

export const marketFactQualities = Object.freeze([
  "fresh",
  "stale",
  "derived",
  "proxied",
  "unavailable",
] as const);

/**
 * The native asset has no token address a DEX Provider can price. Its price
 * is the wrapped native token's price, always published as `quality:
 * proxied` with the proxy asset named (main-agent ruling, Decision 0034).
 */
export const bscWrappedNativeAddress =
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as const;
export const bscWrappedNativeAssetId =
  `eip155:56:${bscWrappedNativeAddress}` as const;
export type MarketFactQuality = (typeof marketFactQualities)[number];

export const marketSources = Object.freeze([
  "dexscreener",
  "goplus",
  "geckoterminal",
  "loop_indexer",
] as const);
export type MarketSource = (typeof marketSources)[number];

export const candleIntervals = Object.freeze([
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
] as const);
export type CandleInterval = (typeof candleIntervals)[number];

export const candleIntervalSeconds: Readonly<Record<CandleInterval, number>> =
  Object.freeze({
    "15m": 900,
    "1h": 3_600,
    "4h": 14_400,
    "1d": 86_400,
    "1w": 604_800,
  });

export const candleLimits = Object.freeze({
  default: 120,
  maximum: 300,
} as const);

export const tradeLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);

export const marketReasonCodes = Object.freeze({
  dexscreenerDisabled: "MARKET_PROVIDER_DEXSCREENER_DISABLED",
  geckoterminalDisabled: "MARKET_PROVIDER_GECKOTERMINAL_DISABLED",
  goplusNotConfigured: "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
  providerRateLimited: "MARKET_PROVIDER_RATE_LIMITED",
  providerUnreachable: "MARKET_PROVIDER_UNREACHABLE",
  providerMalformed: "MARKET_PROVIDER_RESPONSE_MALFORMED",
  providerRejected: "MARKET_PROVIDER_REQUEST_REJECTED",
  pairNotFound: "MARKET_PAIR_NOT_FOUND",
  factMissing: "MARKET_FACT_NOT_REPORTED",
  nativeAssetUnsupported: "MARKET_NATIVE_ASSET_NOT_SUPPORTED",
  poolNotRegistered: "MARKET_POOL_NOT_REGISTERED",
  poolIndexerNotStarted: "BSC_POOL_INDEXER_NOT_STARTED",
  noSwapsInRange: "MARKET_NO_SWAPS_IN_RANGE",
  holderDistributionUnsupported: "HOLDER_DISTRIBUTION_NOT_SUPPORTED",
  smartMoneyDeferred: "SMART_MONEY_RUNTIME_DEFERRED",
  watchlistUnavailable: "WATCHLIST_RUNTIME_UNAVAILABLE",
  communityNotBound: "COMMUNITY_NOT_BOUND",
  cacheUnavailable: "MARKET_FACT_CACHE_UNAVAILABLE",
  /** A Provider answered affirmatively that it knows no such token (Decision 0058). */
  tokenNotFound: "MARKET_TOKEN_NOT_FOUND",
  /** The asset is not in the registry; its identity came from a Provider lookup. */
  assetNotRegistered: "ASSET_NOT_REGISTERED",
  /** A Provider reported the token but not this identity field (e.g. DexScreener has no decimals). */
  identityFieldMissing: "MARKET_IDENTITY_FIELD_NOT_REPORTED",
  /** No Provider that could answer an unregistered lookup is enabled. */
  lookupProviderDisabled: "MARKET_LOOKUP_PROVIDER_DISABLED",
} as const);

/**
 * Unregistered-address lookup policy (Decision 0058). A token that is not
 * in the registry can still be described from a Provider lookup, but the
 * lookup is an existence probe and is quota-bound per user, per IP, and per
 * user-day so the endpoint cannot be used to enumerate Provider coverage.
 */
export const unlistedTokenLookupPolicy = Object.freeze({
  capability: "unlisted_token_lookup",
  policyVersion: "unlisted_token_lookup_v1",
  userMinuteCapacity: 30,
  ipMinuteCapacity: 90,
  userDayCapacity: 600,
} as const);

/**
 * Asset status as the market surface publishes it: the registry statuses
 * plus `unregistered` for an address the registry does not know but a
 * Provider described (Decision 0058). The registry table itself never
 * stores `unregistered`.
 */
export const marketAssetStatuses = Object.freeze([
  "pending",
  "verified",
  "blocked",
  "unregistered",
] as const);
export type MarketAssetStatus = (typeof marketAssetStatuses)[number];

/** Where an unregistered asset's identity (symbol/name/decimals) came from. */
export const providerLookupSourceKind = "provider_lookup" as const;

/** Derived candles are labelled with this key so the client can say what they are. */
export const derivedCandleLabelKey = "market.candles.onChainSwapAggregate";

export const marketTrendingRules = Object.freeze({
  configVersion: "marketTrendingV1",
  effectiveAt: "2026-09-08T00:00:00.000Z",
  ordering: "dexscreener_volume_h24_desc",
  maximumItems: 20,
} as const);

/** Canonical decimal string, optionally negative, never exponent notation. */
export const signedDecimalPatternSource =
  "^-?(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$";
export const unsignedDecimalPatternSource =
  "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$";
const signedDecimalPattern = new RegExp(signedDecimalPatternSource);

export class InvalidMarketDecimalError extends Error {
  readonly code = "invalid_market_decimal";

  constructor() {
    super("The market decimal value is not canonical");
    this.name = "InvalidMarketDecimalError";
  }
}

/**
 * Normalises a Provider-reported decimal string into the canonical form: no
 * leading `+`, no exponent, no trailing fraction zeros, no `-0`. Anything a
 * JSON number could not losslessly express (exponents) is refused rather than
 * approximated.
 */
export function normalizeDecimalString(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidMarketDecimalError();
  }
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null || trimmed.length > 160) {
    throw new InvalidMarketDecimalError();
  }
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  if (magnitude === "0" || /^0(\.0*)?$/.test(magnitude)) {
    return "0";
  }
  const result = `${sign}${magnitude}`;
  if (!signedDecimalPattern.test(result)) {
    throw new InvalidMarketDecimalError();
  }
  return result;
}

export function isCanonicalDecimalString(value: unknown): value is string {
  return typeof value === "string" && signedDecimalPattern.test(value);
}

/**
 * Exact three-way comparison of canonical decimal strings using scaled
 * integer arithmetic. No floating-point value is ever produced.
 */
export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const a = scaledParts(left);
  const b = scaledParts(right);
  const scale = Math.max(a.fractionDigits, b.fractionDigits);
  const scaledA = a.digits * 10n ** BigInt(scale - a.fractionDigits);
  const scaledB = b.digits * 10n ** BigInt(scale - b.fractionDigits);
  return scaledA < scaledB ? -1 : scaledA > scaledB ? 1 : 0;
}

function scaledParts(value: string): {
  readonly digits: bigint;
  readonly fractionDigits: number;
} {
  if (!signedDecimalPattern.test(value)) {
    throw new InvalidMarketDecimalError();
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  return {
    digits: negative ? -digits : digits,
    fractionDigits: fraction.length,
  };
}

function decimalParts(value: string): {
  readonly negative: boolean;
  readonly digits: bigint;
  readonly scale: number;
} {
  const parts = scaledParts(value);
  return {
    negative: parts.digits < 0n,
    digits: parts.digits < 0n ? -parts.digits : parts.digits,
    scale: parts.fractionDigits,
  };
}

function fromScaled(digits: bigint, scale: number): string {
  const negative = digits < 0n;
  const text = (negative ? -digits : digits)
    .toString(10)
    .padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, "");
  const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

/** Exact product of two canonical decimal strings. */
export function multiplyDecimalStrings(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const sign = a.negative !== b.negative ? -1n : 1n;
  return fromScaled(sign * a.digits * b.digits, a.scale + b.scale);
}

/** Exact sum of two canonical decimal strings. */
export function addDecimalStrings(left: string, right: string): string {
  const a = scaledParts(left);
  const b = scaledParts(right);
  const scale = Math.max(a.fractionDigits, b.fractionDigits);
  return fromScaled(
    a.digits * 10n ** BigInt(scale - a.fractionDigits) +
      b.digits * 10n ** BigInt(scale - b.fractionDigits),
    scale,
  );
}

/**
 * Exact quotient of two canonical decimal strings, truncated to
 * `fractionDigits` places. `null` when the divisor is zero: a price is never
 * invented from a division that has no value.
 */
export function divideDecimalStrings(
  left: string,
  right: string,
  fractionDigits: number,
): string | null {
  const a = scaledParts(left);
  const b = scaledParts(right);
  if (b.digits === 0n) {
    return null;
  }
  return formatRational(
    a.digits * 10n ** BigInt(b.fractionDigits),
    b.digits * 10n ** BigInt(a.fractionDigits),
    fractionDigits,
  );
}

/**
 * Formats `numerator / denominator` as an exact decimal string truncated to
 * `fractionDigits` places, with trailing zeros removed. Pure integer
 * arithmetic.
 */
export function formatRational(
  numerator: bigint,
  denominator: bigint,
  fractionDigits: number,
): string {
  if (denominator === 0n) {
    throw new InvalidMarketDecimalError();
  }
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0) {
    throw new InvalidMarketDecimalError();
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const scaled =
    (absoluteNumerator * 10n ** BigInt(fractionDigits)) / absoluteDenominator;
  const digits = scaled.toString(10).padStart(fractionDigits + 1, "0");
  const whole = digits.slice(0, digits.length - fractionDigits);
  const fraction = digits
    .slice(digits.length - fractionDigits)
    .replace(/0+$/, "");
  const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return magnitude === "0" || negative === false ? magnitude : `-${magnitude}`;
}

const q192 = 2n ** 192n;
/** Fraction digits kept when a pool price is rendered as a decimal string. */
export const poolPriceFractionDigits = 18;

/**
 * Converts a Uniswap-V3-style `sqrtPriceX96` into the price of one asset in
 * units of the other, adjusted for token decimals.
 *
 * `price1per0 = sqrtPriceX96² / 2¹⁹² · 10^(decimals0 − decimals1)`. When the
 * asset of interest is token1 the inverse is returned. The result is exact
 * integer arithmetic truncated to `poolPriceFractionDigits`; a zero sqrt price
 * yields `null` rather than a division by zero.
 */
export function sqrtPriceX96ToAssetPrice(input: {
  readonly sqrtPriceX96: bigint;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly assetIsToken0: boolean;
}): string | null {
  if (input.sqrtPriceX96 <= 0n) {
    return null;
  }
  const squared = input.sqrtPriceX96 * input.sqrtPriceX96;
  const scaleUp = 10n ** BigInt(Math.max(input.decimals0 - input.decimals1, 0));
  const scaleDown =
    10n ** BigInt(Math.max(input.decimals1 - input.decimals0, 0));
  // price1per0 = squared * scaleUp / (q192 * scaleDown)
  const numerator = input.assetIsToken0 ? squared * scaleUp : q192 * scaleDown;
  const denominator = input.assetIsToken0
    ? q192 * scaleDown
    : squared * scaleUp;
  return formatRational(numerator, denominator, poolPriceFractionDigits);
}

export interface MarketFactProjection {
  readonly value: string | null;
  readonly source: MarketSource | null;
  readonly fetchedAt: string | null;
  readonly ttlSeconds: number | null;
  readonly quality: MarketFactQuality;
  readonly reasonCode: string | null;
}

export function unavailableFact(reasonCode: string): MarketFactProjection {
  return Object.freeze({
    value: null,
    source: null,
    fetchedAt: null,
    ttlSeconds: null,
    quality: "unavailable",
    reasonCode,
  });
}

export function availableFact(input: {
  readonly value: string;
  readonly source: MarketSource;
  readonly fetchedAt: string;
  readonly ttlSeconds: number;
  readonly quality: "fresh" | "stale" | "derived" | "proxied";
  readonly reasonCode?: string | null;
}): MarketFactProjection {
  return Object.freeze({
    value: input.value,
    source: input.source,
    fetchedAt: input.fetchedAt,
    ttlSeconds: input.ttlSeconds,
    quality: input.quality,
    reasonCode: input.reasonCode ?? null,
  });
}

export function isCandleInterval(value: unknown): value is CandleInterval {
  return (
    typeof value === "string" &&
    (candleIntervals as readonly string[]).includes(value)
  );
}
