import { describe, expect, it } from "vitest";

import {
  compareExactUnsignedDecimalProduct,
  compareExactUnsignedDecimals,
  exactUnsignedDecimalSumEquals,
  exactUnsignedDecimalsEqual,
} from "../src/features/spot/spot-exact-decimal.js";

describe("Spot exact unsigned decimal arithmetic", () => {
  it("compares scale variants and large coefficients without Number coercion", () => {
    expect(exactUnsignedDecimalsEqual("0.2000", "0.2")).toBe(true);
    expect(
      compareExactUnsignedDecimals(
        "999999999999999999.9",
        "1000000000000000000",
      ),
    ).toBe(-1);
    expect(compareExactUnsignedDecimals("1.000000000000000001", "1")).toBe(1);
  });

  it("checks exact sums and products across independent scales", () => {
    expect(exactUnsignedDecimalSumEquals("10", "9.800", "0.2")).toBe(true);
    expect(exactUnsignedDecimalSumEquals("10.0001", "9.8", "0.2")).toBe(false);
    expect(compareExactUnsignedDecimalProduct("0.2", "50", "10.000")).toBe(0);
    expect(
      compareExactUnsignedDecimalProduct("0.200000000000000001", "50", "10"),
    ).toBe(1);
  });
});
