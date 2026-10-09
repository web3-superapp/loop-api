import { describe, expect, it } from "vitest";

import {
  addDecimalStrings,
  subtractDecimalStrings,
  compareDecimalStrings,
  multiplyDecimalStrings,
  formatRational,
  InvalidMarketDecimalError,
  normalizeDecimalString,
  sqrtPriceX96ToAssetPrice,
} from "../src/features/market/market-contract.js";

const q96 = 2n ** 96n;

describe("market decimal contract", () => {
  it("normalises Provider decimal strings without floating point", () => {
    expect(normalizeDecimalString("747.39")).toBe("747.39");
    expect(normalizeDecimalString("0007.500")).toBe("7.5");
    expect(normalizeDecimalString("-0.0")).toBe("0");
    expect(normalizeDecimalString("+12")).toBe("12");
    expect(normalizeDecimalString("-0.27")).toBe("-0.27");
    expect(normalizeDecimalString("1222740159123456789012")).toBe(
      "1222740159123456789012",
    );
    expect(() => normalizeDecimalString("1e3")).toThrow(
      InvalidMarketDecimalError,
    );
    expect(() => normalizeDecimalString(747.39)).toThrow(
      InvalidMarketDecimalError,
    );
    expect(() => normalizeDecimalString("")).toThrow(InvalidMarketDecimalError);
  });

  it("compares decimal strings exactly", () => {
    expect(compareDecimalStrings("747.39", "747.390")).toBe(0);
    expect(compareDecimalStrings("0.1", "0.10000000000000001")).toBe(-1);
    expect(compareDecimalStrings("-1", "0")).toBe(-1);
    expect(
      compareDecimalStrings("1222740159123456789012", "1222740159123456789011"),
    ).toBe(1);
  });

  it("multiplies and adds decimal strings exactly", () => {
    expect(multiplyDecimalStrings("1.5", "747.39")).toBe("1121.085");
    expect(multiplyDecimalStrings("0.000000000000000001", "747.39")).toBe(
      "0.00000000000000074739",
    );
    expect(multiplyDecimalStrings("2", "0.5")).toBe("1");
    expect(multiplyDecimalStrings("0", "747.39")).toBe("0");
    expect(addDecimalStrings("0", "1121.085")).toBe("1121.085");
    expect(addDecimalStrings("0.1", "0.2")).toBe("0.3");
    expect(subtractDecimalStrings("25", "22.5")).toBe("2.5");
    expect(subtractDecimalStrings("4", "4.5")).toBe("-0.5");
    expect(subtractDecimalStrings("1.10", "0.1")).toBe("1");
    expect(subtractDecimalStrings("0", "0")).toBe("0");
    expect(addDecimalStrings("1121.085", "5401795.9")).toBe("5402916.985");
  });

  it("formats rationals as truncated decimal strings", () => {
    expect(formatRational(1n, 3n, 6)).toBe("0.333333");
    expect(formatRational(10n, 4n, 18)).toBe("2.5");
    expect(formatRational(0n, 4n, 18)).toBe("0");
    expect(formatRational(-10n, 4n, 2)).toBe("-2.5");
    expect(() => formatRational(1n, 0n, 2)).toThrow(InvalidMarketDecimalError);
  });

  it("converts sqrtPriceX96 into an asset price with decimal adjustment", () => {
    // sqrtPrice = 2^96 means price1per0 = 1 in raw units.
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: q96,
        decimals0: 18,
        decimals1: 18,
        assetIsToken0: true,
      }),
    ).toBe("1");
    // token0 has 18 decimals, token1 has 24: 10^6 raw token1 per raw token0
    // is exactly 1 token1 per token0 after the decimal adjustment.
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: q96 * 1_000n,
        decimals0: 18,
        decimals1: 24,
        assetIsToken0: true,
      }),
    ).toBe("1");
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: q96 * 1_000n,
        decimals0: 18,
        decimals1: 24,
        assetIsToken0: false,
      }),
    ).toBe("1");
    // Inverted orientation.
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: q96 * 2n,
        decimals0: 18,
        decimals1: 18,
        assetIsToken0: false,
      }),
    ).toBe("0.25");
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: 0n,
        decimals0: 18,
        decimals1: 18,
        assetIsToken0: true,
      }),
    ).toBeNull();
  });

  it("matches a real PancakeSwap V3 WBNB/USDT observation", () => {
    // Swap log observed on chain 2026-09-08 from pool 0x3669… (token0 USDT,
    // token1 WBNB, both 18 decimals) while DexScreener quoted ~747.5 USDT.
    const price = sqrtPriceX96ToAssetPrice({
      sqrtPriceX96: 2_897_871_225_897_311_837_660_791_230n,
      decimals0: 18,
      decimals1: 18,
      assetIsToken0: false,
    });
    expect(price).toBe("747.482453211647133359");
    expect(
      sqrtPriceX96ToAssetPrice({
        sqrtPriceX96: 2_897_871_225_897_311_837_660_791_230n,
        decimals0: 18,
        decimals1: 18,
        assetIsToken0: true,
      }),
    ).toBe("0.001337824046174436");
  });
});
