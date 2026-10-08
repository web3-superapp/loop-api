import { describe, expect, it } from "vitest";

import {
  absoluteAmount,
  bscUsdtAddress,
  classifySwap,
  swapQuoteSets,
} from "../src/features/chain/swap-classification.js";
import { bscWrappedNativeAddress } from "../src/features/market/market-contract.js";

const chainId = "eip155:56";
const token = `${chainId}:0x1111111111111111111111111111111111111111`;
const other = `${chainId}:0x2222222222222222222222222222222222222222`;
const usdt = `${chainId}:${bscUsdtAddress}`;
const wbnb = `${chainId}:${bscWrappedNativeAddress}`;
const usd1Address = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";
const { quoteAssetIds, stableAssetIds } = swapQuoteSets(chainId, usd1Address);

describe("classifySwap (Decision 0095 §3, Decision 0097)", () => {
  it("builds the quote set from WBNB, USDT, USDC and the configured USD1", () => {
    expect(quoteAssetIds.has(wbnb)).toBe(true);
    expect(quoteAssetIds.has(usdt)).toBe(true);
    expect(quoteAssetIds.has(`${chainId}:${usd1Address.toLowerCase()}`)).toBe(
      true,
    );
    expect(stableAssetIds.has(wbnb)).toBe(false);
    expect(stableAssetIds.has(usdt)).toBe(true);
    expect(swapQuoteSets(chainId, null).quoteAssetIds.size).toBe(3);
  });

  it("is a buy when the pool paid the base out (token1 is the quote)", () => {
    expect(
      classifySwap(
        {
          token0AssetId: token,
          token1AssetId: usdt,
          amount0: "-5000",
          amount1: "2000",
        },
        quoteAssetIds,
      ),
    ).toEqual({
      kind: "buy",
      baseAssetId: token,
      quoteAssetId: usdt,
      baseAmountRaw: -5000n,
      quoteAmountRaw: 2000n,
    });
  });

  it("is a sell when the base was paid into the pool (token0 is the quote)", () => {
    expect(
      classifySwap(
        {
          token0AssetId: wbnb,
          token1AssetId: token,
          amount0: -7n,
          amount1: 9n,
        },
        quoteAssetIds,
      ),
    ).toEqual({
      kind: "sell",
      baseAssetId: token,
      quoteAssetId: wbnb,
      baseAmountRaw: 9n,
      quoteAmountRaw: -7n,
    });
  });

  it("takes token0 as the base when both sides are quote assets", () => {
    const result = classifySwap(
      {
        token0AssetId: usdt,
        token1AssetId: wbnb,
        amount0: "-1",
        amount1: "3",
      },
      quoteAssetIds,
    );
    expect(result.kind).toBe("buy");
    expect(result.baseAssetId).toBe(usdt);
    expect(result.quoteAssetId).toBe(wbnb);
  });

  it("takes token0 as the base when neither side is a quote asset", () => {
    const result = classifySwap(
      {
        token0AssetId: token,
        token1AssetId: other,
        amount0: "4",
        amount1: "-4",
      },
      quoteAssetIds,
    );
    expect(result.kind).toBe("sell");
    expect(result.baseAssetId).toBe(token);
    expect(result.quoteAssetId).toBe(other);
  });

  it("returns the magnitude of a signed amount", () => {
    expect(absoluteAmount(-12n)).toBe(12n);
    expect(absoluteAmount(12n)).toBe(12n);
  });
});
