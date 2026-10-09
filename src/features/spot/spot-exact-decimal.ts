interface ExactUnsignedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const maximumCanonicalDecimalLength = 128;

function exactUnsignedDecimal(value: string): ExactUnsignedDecimal {
  const point = value.indexOf(".");
  const fractionalLength = point === -1 ? 0 : value.length - point - 1;
  let coefficient = BigInt(point === -1 ? value : value.replace(".", ""));
  let scale = fractionalLength;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return Object.freeze({ coefficient, scale });
}

function scaleCoefficient(
  value: ExactUnsignedDecimal,
  targetScale: number,
): bigint {
  return value.coefficient * 10n ** BigInt(targetScale - value.scale);
}

function formatExactUnsignedDecimal(
  rawCoefficient: bigint,
  rawScale: number,
): string | null {
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

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let first = left;
  let second = right;
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

export function compareExactUnsignedDecimals(
  left: string,
  right: string,
): -1 | 0 | 1 {
  const leftValue = exactUnsignedDecimal(left);
  const rightValue = exactUnsignedDecimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftCoefficient = scaleCoefficient(leftValue, scale);
  const rightCoefficient = scaleCoefficient(rightValue, scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

export function exactUnsignedDecimalsEqual(
  left: string,
  right: string,
): boolean {
  return compareExactUnsignedDecimals(left, right) === 0;
}

export function exactUnsignedDecimalSumEquals(
  total: string,
  left: string,
  right: string,
): boolean {
  const values = [total, left, right].map(exactUnsignedDecimal);
  const scale = Math.max(...values.map((value) => value.scale));
  const [scaledTotal, scaledLeft, scaledRight] = values.map((value) =>
    scaleCoefficient(value, scale),
  );
  return (
    scaledTotal !== undefined &&
    scaledLeft !== undefined &&
    scaledRight !== undefined &&
    scaledTotal === scaledLeft + scaledRight
  );
}

export function compareExactUnsignedDecimalProduct(
  left: string,
  right: string,
  expected: string,
): -1 | 0 | 1 {
  const leftValue = exactUnsignedDecimal(left);
  const rightValue = exactUnsignedDecimal(right);
  const expectedValue = exactUnsignedDecimal(expected);
  const productScale = leftValue.scale + rightValue.scale;
  const commonScale = Math.max(productScale, expectedValue.scale);
  const productCoefficient =
    leftValue.coefficient *
    rightValue.coefficient *
    10n ** BigInt(commonScale - productScale);
  const expectedCoefficient = scaleCoefficient(expectedValue, commonScale);
  return productCoefficient < expectedCoefficient
    ? -1
    : productCoefficient > expectedCoefficient
      ? 1
      : 0;
}

export function addExactUnsignedDecimals(
  values: readonly string[],
): string | null {
  let total: ExactUnsignedDecimal = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    const next = exactUnsignedDecimal(value);
    const scale = Math.max(total.scale, next.scale);
    total = {
      coefficient:
        scaleCoefficient(total, scale) + scaleCoefficient(next, scale),
      scale,
    };
  }
  return formatExactUnsignedDecimal(total.coefficient, total.scale);
}

export function multiplyExactUnsignedDecimals(
  left: string,
  right: string,
): string | null {
  const leftValue = exactUnsignedDecimal(left);
  const rightValue = exactUnsignedDecimal(right);
  return formatExactUnsignedDecimal(
    leftValue.coefficient * rightValue.coefficient,
    leftValue.scale + rightValue.scale,
  );
}

/** Returns null when the exact quotient is non-terminating or exceeds v1. */
export function divideExactUnsignedDecimals(
  numerator: string,
  denominator: string,
): string | null {
  const numeratorValue = exactUnsignedDecimal(numerator);
  const denominatorValue = exactUnsignedDecimal(denominator);
  if (denominatorValue.coefficient === 0n) {
    return null;
  }
  if (numeratorValue.coefficient === 0n) {
    return "0";
  }

  let reducedNumerator =
    numeratorValue.coefficient * 10n ** BigInt(denominatorValue.scale);
  let reducedDenominator =
    denominatorValue.coefficient * 10n ** BigInt(numeratorValue.scale);
  const divisor = greatestCommonDivisor(reducedNumerator, reducedDenominator);
  reducedNumerator /= divisor;
  reducedDenominator /= divisor;

  let twos = 0;
  while (reducedDenominator % 2n === 0n) {
    reducedDenominator /= 2n;
    twos += 1;
  }
  let fives = 0;
  while (reducedDenominator % 5n === 0n) {
    reducedDenominator /= 5n;
    fives += 1;
  }
  if (reducedDenominator !== 1n) {
    return null;
  }

  const scale = Math.max(twos, fives);
  const coefficient =
    reducedNumerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  return formatExactUnsignedDecimal(coefficient, scale);
}
