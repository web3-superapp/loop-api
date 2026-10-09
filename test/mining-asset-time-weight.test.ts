import { describe, expect, it } from "vitest";

import { computeAssetEpochPower } from "../src/features/mining/asset-time-weight.js";

const ONE = "1000000000000000000";

describe("computeAssetEpochPower", () => {
  it("time-integrates balances, accepted prices, and asset weights without floating point", () => {
    const result = computeAssetEpochPower({
      epochStart: "0",
      epochEnd: "100",
      segments: [
        {
          walletId: "wallet-a",
          assetId: "eip155:56:0x1111111111111111111111111111111111111111",
          from: "0",
          to: "50",
          balanceRaw: "10",
          decimals: 0,
          priceUsdRaw: "2000000000000000000",
          assetWeightRaw: ONE,
        },
        {
          walletId: "wallet-a",
          assetId: "eip155:56:0x1111111111111111111111111111111111111111",
          from: "50",
          to: "100",
          balanceRaw: "5",
          decimals: 0,
          priceUsdRaw: "2000000000000000000",
          assetWeightRaw: "2000000000000000000",
        },
      ],
    });

    expect(result).toEqual([
      { walletId: "wallet-a", powerRaw: "20000000000000000000" },
    ]);
  });

  it("rejects incomplete balance or price history for a positive holding", () => {
    expect(() =>
      computeAssetEpochPower({
        epochStart: "0",
        epochEnd: "100",
        segments: [
          {
            walletId: "wallet-a",
            assetId: "eip155:56:0x1111111111111111111111111111111111111111",
            from: "1",
            to: "100",
            balanceRaw: "1",
            decimals: 18,
            priceUsdRaw: "1000000000000000000",
            assetWeightRaw: ONE,
          },
        ],
      }),
    ).toThrow("Incomplete asset input history");

    expect(() =>
      computeAssetEpochPower({
        epochStart: "0",
        epochEnd: "100",
        segments: [
          {
            walletId: "wallet-a",
            assetId: "eip155:56:0x1111111111111111111111111111111111111111",
            from: "0",
            to: "100",
            balanceRaw: "1",
            decimals: 18,
            priceUsdRaw: "",
            assetWeightRaw: ONE,
          },
        ],
      }),
    ).toThrow("Invalid asset price");
  });
});
