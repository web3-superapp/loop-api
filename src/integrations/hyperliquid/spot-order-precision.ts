interface ExactUnsignedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const maximumCanonicalDecimalLength = 128;
const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function parseExactUnsignedDecimal(
  value: unknown,
): ExactUnsignedDecimal | null {
  if (
    typeof value !== "string" ||
    value.length > maximumCanonicalDecimalLength ||
    !unsignedDecimalPattern.test(value)
  ) {
    return null;
  }
  const point = value.indexOf(".");
  const scale = point === -1 ? 0 : value.length - point - 1;
  return Object.freeze({
    coefficient: BigInt(point === -1 ? value : value.replace(".", "")),
    scale,
  });
}

function formatExactUnsignedDecimal(
  rawCoefficient: bigint,
  rawScale: number,
): string | null {
  if (rawCoefficient < 0n || !Number.isSafeInteger(rawScale) || rawScale < 0) {
    return null;
  }
  let coefficient = rawCoefficient;
  let scale = rawScale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  let digits = coefficient.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    const splitAt = digits.length - scale;
    digits = `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
  }
  return digits.length <= maximumCanonicalDecimalLength ? digits : null;
}

function compareExactUnsignedDecimals(
  left: ExactUnsignedDecimal,
  right: ExactUnsignedDecimal,
): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient =
    right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

function isValidHyperliquidPrice(
  value: string,
  maximumDecimalPlaces: number,
): boolean {
  const point = value.indexOf(".");
  if (point === -1) {
    // Hyperliquid explicitly exempts integer prices from the five-significant-
    // figure rule.
    return true;
  }
  const decimalPlaces = value.length - point - 1;
  const significantDigits = value.replace(".", "").replace(/^0+/, "").length;
  return decimalPlaces <= maximumDecimalPlaces && significantDigits <= 5;
}

export function isHyperliquidSpotWirePrice(
  value: unknown,
  sizeDecimals: number,
): boolean {
  if (
    !Number.isSafeInteger(sizeDecimals) ||
    sizeDecimals < 0 ||
    sizeDecimals > 8
  ) {
    return false;
  }
  const canonical = canonicalizeExactUnsignedDecimal(value);
  return (
    canonical !== null &&
    canonical !== "0" &&
    isValidHyperliquidPrice(canonical, 8 - sizeDecimals)
  );
}

export function hasAtMostExactUnsignedDecimalPlaces(
  value: unknown,
  maximumDecimalPlaces: number,
): boolean {
  if (
    !Number.isSafeInteger(maximumDecimalPlaces) ||
    maximumDecimalPlaces < 0 ||
    maximumDecimalPlaces > 8
  ) {
    return false;
  }
  const canonical = canonicalizeExactUnsignedDecimal(value);
  if (canonical === null) {
    return false;
  }
  const point = canonical.indexOf(".");
  return point === -1 || canonical.length - point - 1 <= maximumDecimalPlaces;
}

export function canonicalizeExactUnsignedDecimal(
  value: unknown,
): string | null {
  const parsed = parseExactUnsignedDecimal(value);
  return parsed === null
    ? null
    : formatExactUnsignedDecimal(parsed.coefficient, parsed.scale);
}

/**
 * Formats the v1 slippage boundary in the direction that cannot silently make
 * the IOC more aggressive: buy rounds down, sell rounds up.
 */
export function formatHyperliquidSpotIocLimitPrice(
  input: Readonly<{
    referencePrice: string;
    side: "buy" | "sell";
    slippageBasisPoints: number;
    sizeDecimals: number;
  }>,
): string | null {
  const reference = parseExactUnsignedDecimal(input.referencePrice);
  if (
    reference === null ||
    reference.coefficient === 0n ||
    !Number.isSafeInteger(input.slippageBasisPoints) ||
    input.slippageBasisPoints < 0 ||
    input.slippageBasisPoints > 100 ||
    !Number.isSafeInteger(input.sizeDecimals) ||
    input.sizeDecimals < 0 ||
    input.sizeDecimals > 8
  ) {
    return null;
  }

  const maximumDecimalPlaces = 8 - input.sizeDecimals;
  const canonicalReference = formatExactUnsignedDecimal(
    reference.coefficient,
    reference.scale,
  );
  if (
    canonicalReference === null ||
    !isValidHyperliquidPrice(canonicalReference, maximumDecimalPlaces)
  ) {
    return null;
  }
  const multiplier =
    input.side === "buy"
      ? 10_000 + input.slippageBasisPoints
      : 10_000 - input.slippageBasisPoints;
  const ratioNumerator = reference.coefficient * BigInt(multiplier);
  const ratioDenominator = 10_000n * 10n ** BigInt(reference.scale);

  for (
    let decimalPlaces = maximumDecimalPlaces;
    decimalPlaces >= 0;
    decimalPlaces -= 1
  ) {
    const scaledNumerator = ratioNumerator * 10n ** BigInt(decimalPlaces);
    const quotient = scaledNumerator / ratioDenominator;
    const remainder = scaledNumerator % ratioDenominator;
    const roundedCoefficient =
      input.side === "sell" && remainder !== 0n ? quotient + 1n : quotient;
    if (roundedCoefficient === 0n) {
      continue;
    }
    const candidate = formatExactUnsignedDecimal(
      roundedCoefficient,
      decimalPlaces,
    );
    if (
      candidate === null ||
      !isValidHyperliquidPrice(candidate, maximumDecimalPlaces)
    ) {
      continue;
    }
    const parsedCandidate = parseExactUnsignedDecimal(candidate);
    if (
      parsedCandidate !== null &&
      (input.side === "buy"
        ? compareExactUnsignedDecimals(parsedCandidate, reference) >= 0
        : compareExactUnsignedDecimals(parsedCandidate, reference) <= 0)
    ) {
      return candidate;
    }
  }
  return null;
}

/** Floors numerator / denominator directly at a base-size decimal scale. */
export function floorExactUnsignedDecimalQuotient(
  numerator: string,
  denominator: string,
  scale: number,
): string | null {
  const parsedNumerator = parseExactUnsignedDecimal(numerator);
  const parsedDenominator = parseExactUnsignedDecimal(denominator);
  if (
    parsedNumerator === null ||
    parsedDenominator === null ||
    parsedDenominator.coefficient === 0n ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > 8
  ) {
    return null;
  }
  const scaledNumerator =
    parsedNumerator.coefficient *
    10n ** BigInt(parsedDenominator.scale + scale);
  const scaledDenominator =
    parsedDenominator.coefficient * 10n ** BigInt(parsedNumerator.scale);
  return formatExactUnsignedDecimal(scaledNumerator / scaledDenominator, scale);
}

/** Rounds a nonnegative amount up to the selected token atomic-unit scale. */
export function ceilExactUnsignedDecimalToScale(
  value: string,
  scale: number,
): string | null {
  const parsed = parseExactUnsignedDecimal(value);
  if (
    parsed === null ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > 18
  ) {
    return null;
  }
  if (parsed.scale <= scale) {
    return formatExactUnsignedDecimal(parsed.coefficient, parsed.scale);
  }
  const divisor = 10n ** BigInt(parsed.scale - scale);
  const quotient = parsed.coefficient / divisor;
  const remainder = parsed.coefficient % divisor;
  return formatExactUnsignedDecimal(
    remainder === 0n ? quotient : quotient + 1n,
    scale,
  );
}

export function subtractExactUnsignedDecimals(
  minuend: string,
  subtrahend: string,
): string | null {
  const left = parseExactUnsignedDecimal(minuend);
  const right = parseExactUnsignedDecimal(subtrahend);
  if (left === null || right === null) {
    return null;
  }
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient =
    right.coefficient * 10n ** BigInt(scale - right.scale);
  if (leftCoefficient < rightCoefficient) {
    return null;
  }
  return formatExactUnsignedDecimal(leftCoefficient - rightCoefficient, scale);
}
