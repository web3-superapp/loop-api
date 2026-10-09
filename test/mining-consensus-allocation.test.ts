import { describe, expect, it } from "vitest";

import { allocateConsensusNftEpoch } from "../src/features/mining/consensus-nft-allocation.js";

describe("allocateConsensusNftEpoch", () => {
  it("uses the configured community coefficients and an independent NFT pool budget", () => {
    const result = allocateConsensusNftEpoch({
      epochStart: "0",
      epochEnd: "100",
      budgetRaw: "101",
      segments: [
        {
          walletId: "wallet-a",
          communityId: "community-a",
          from: "0",
          to: "100",
          nftCountRaw: "1",
          communityWeightRaw: "1000000000000000000",
        },
        {
          walletId: "wallet-b",
          communityId: "community-b",
          from: "0",
          to: "100",
          nftCountRaw: "2",
          communityWeightRaw: "2000000000000000000",
        },
      ],
    });

    expect(result).toEqual({
      formulaScope: "development_baseline",
      coefficientScale: "1000000000000000000",
      weights: [
        { walletId: "wallet-a", weightRaw: "1000000000000000000" },
        { walletId: "wallet-b", weightRaw: "4000000000000000000" },
      ],
      allocations: [
        { walletId: "wallet-a", amountRaw: "20" },
        { walletId: "wallet-b", amountRaw: "80" },
      ],
      committedRaw: "100",
      unallocatedRaw: "1",
    });
  });

  it("refuses to produce any pool allocation when holding history is incomplete", () => {
    expect(() =>
      allocateConsensusNftEpoch({
        epochStart: "0",
        epochEnd: "100",
        budgetRaw: "10",
        segments: [
          {
            walletId: "wallet-a",
            communityId: "community-a",
            from: "1",
            to: "100",
            nftCountRaw: "1",
            communityWeightRaw: "1000000000000000000",
          },
        ],
      }),
    ).toThrow("Incomplete NFT holding history");
  });
});
