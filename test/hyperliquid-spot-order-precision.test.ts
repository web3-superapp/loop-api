import { describe, expect, it } from "vitest";

import {
  canonicalizeExactUnsignedDecimal,
  ceilExactUnsignedDecimalToScale,
  floorExactUnsignedDecimalQuotient,
  formatHyperliquidSpotIocLimitPrice,
  subtractExactUnsignedDecimals,
} from "../src/integrations/hyperliquid/spot-order-precision.js";

describe("Hyperliquid Spot order precision", () => {
  it("rounds a buy cap down and a sell floor up at five significant figures", () => {
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "4.628",
        side: "buy",
        slippageBasisPoints: 25,
        sizeDecimals: 0,
      }),
    ).toBe("4.6395");
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "4.628",
        side: "sell",
        slippageBasisPoints: 25,
        sizeDecimals: 0,
      }),
    ).toBe("4.6165");
  });

  it("also obeys the 8 - szDecimals price-decimal boundary", () => {
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "12.34",
        side: "buy",
        slippageBasisPoints: 25,
        sizeDecimals: 6,
      }),
    ).toBe("12.37");
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "12.34",
        side: "sell",
        slippageBasisPoints: 25,
        sizeDecimals: 6,
      }),
    ).toBe("12.31");
  });

  it("keeps the documented integer-price exception and strips trailing zeros", () => {
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "99999",
        side: "buy",
        slippageBasisPoints: 100,
        sizeDecimals: 0,
      }),
    ).toBe("100998");
    expect(canonicalizeExactUnsignedDecimal("001.2300")).toBeNull();
    expect(canonicalizeExactUnsignedDecimal("1.2300")).toBe("1.23");
    expect(canonicalizeExactUnsignedDecimal("0.000")).toBe("0");
  });

  it("floors non-terminating quotients directly at the requested size scale", () => {
    expect(floorExactUnsignedDecimalQuotient("10", "3", 2)).toBe("3.33");
    expect(floorExactUnsignedDecimalQuotient("1", "8", 3)).toBe("0.125");
    expect(floorExactUnsignedDecimalQuotient("1", "8", 2)).toBe("0.12");
    expect(floorExactUnsignedDecimalQuotient("0.01", "100", 0)).toBe("0");
  });

  it("subtracts exact decimals without permitting a negative result", () => {
    expect(subtractExactUnsignedDecimals("10", "0.007")).toBe("9.993");
    expect(subtractExactUnsignedDecimals("1.000", "1")).toBe("0");
    expect(subtractExactUnsignedDecimals("0.99", "1")).toBeNull();
  });

  it("rounds a fee ceiling up to the quote token atomic unit", () => {
    expect(ceilExactUnsignedDecimalToScale("0.000000001", 8)).toBe(
      "0.00000001",
    );
    expect(ceilExactUnsignedDecimalToScale("1.230000000", 8)).toBe("1.23");
    expect(ceilExactUnsignedDecimalToScale("1.01", 0)).toBe("2");
    expect(ceilExactUnsignedDecimalToScale("0", 8)).toBe("0");
  });

  it("fails closed for unsupported syntax and numeric policy inputs", () => {
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "1e2",
        side: "buy",
        slippageBasisPoints: 25,
        sizeDecimals: 0,
      }),
    ).toBeNull();
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "12345.6",
        side: "buy",
        slippageBasisPoints: 25,
        sizeDecimals: 0,
      }),
    ).toBeNull();
    expect(
      formatHyperliquidSpotIocLimitPrice({
        referencePrice: "1",
        side: "buy",
        slippageBasisPoints: 101,
        sizeDecimals: 0,
      }),
    ).toBeNull();
    expect(floorExactUnsignedDecimalQuotient("1", "0", 2)).toBeNull();
    expect(floorExactUnsignedDecimalQuotient("1", "3", 9)).toBeNull();
  });
});
