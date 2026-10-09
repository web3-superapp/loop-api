import { describe, expect, it } from "vitest";

import { allocateAssetPowerEpoch } from "../src/features/mining/asset-power-allocation.js";

const ASSET = "eip155:56:0x1111111111111111111111111111111111111111";
const ONE = "1000000000000000000";

describe("allocateAssetPowerEpoch", () => {
  it("allocates only the asset pool budget by time-weighted power", () => {
    const result = allocateAssetPowerEpoch({
      epochStart: "0",
      epochEnd: "100",
      budgetRaw: "101",
      segments: [
        {
          walletId: "wallet-a",
          assetId: ASSET,
          from: "0",
          to: "100",
          balanceRaw: "1",
          decimals: 0,
          priceUsdRaw: ONE,
          assetWeightRaw: ONE,
        },
        {
          walletId: "wallet-b",
          assetId: ASSET,
          from: "0",
          to: "100",
          balanceRaw: "3",
          decimals: 0,
          priceUsdRaw: ONE,
          assetWeightRaw: ONE,
        },
      ],
    });

    expect(result).toEqual({
      formulaScope: "development_baseline",
      powerScale: ONE,
      powers: [
        { walletId: "wallet-a", powerRaw: ONE },
        { walletId: "wallet-b", powerRaw: "3000000000000000000" },
      ],
      allocations: [
        { walletId: "wallet-a", amountRaw: "25" },
        { walletId: "wallet-b", amountRaw: "75" },
      ],
      committedRaw: "100",
      unallocatedRaw: "1",
    });
  });

  it("rejects incomplete input before allocating any budget", () => {
    expect(() =>
      allocateAssetPowerEpoch({
        epochStart: "0",
        epochEnd: "100",
        budgetRaw: "10",
        segments: [
          {
            walletId: "wallet-a",
            assetId: ASSET,
            from: "1",
            to: "100",
            balanceRaw: "1",
            decimals: 0,
            priceUsdRaw: ONE,
            assetWeightRaw: ONE,
          },
        ],
      }),
    ).toThrow("Incomplete asset input history");
  });
});
