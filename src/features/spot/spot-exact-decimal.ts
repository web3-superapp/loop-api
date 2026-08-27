interface ExactUnsignedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

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
