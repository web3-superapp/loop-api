import { describe, expect, it } from "vitest";

import { computeNftEpochWeights } from "../src/features/mining/nft-time-weight.js";

const ONE = "1000000000000000000";

describe("computeNftEpochWeights", () => {
  it("time-weights transfers and community coefficients within the same epoch", () => {
    const result = computeNftEpochWeights({
      epochStart: "0",
      epochEnd: "100",
      segments: [
        {
          walletId: "wallet-a",
          communityId: "community-a",
          from: "0",
          to: "50",
          nftCountRaw: "10",
          communityWeightRaw: ONE,
        },
        {
          walletId: "wallet-a",
          communityId: "community-a",
          from: "50",
          to: "100",
          nftCountRaw: "5",
          communityWeightRaw: "2000000000000000000",
        },
        {
          walletId: "wallet-b",
          communityId: "community-a",
          from: "0",
          to: "50",
          nftCountRaw: "0",
          communityWeightRaw: ONE,
        },
        {
          walletId: "wallet-b",
          communityId: "community-a",
          from: "50",
          to: "100",
          nftCountRaw: "5",
          communityWeightRaw: "2000000000000000000",
        },
      ],
    });

    expect(result).toEqual([
      { walletId: "wallet-a", weightRaw: "10000000000000000000" },
      { walletId: "wallet-b", weightRaw: "5000000000000000000" },
    ]);
  });

  it("does not backfill a wallet that registers after the epoch started", () => {
    expect(
      computeNftEpochWeights({
        epochStart: "0",
        epochEnd: "100",
        segments: [
          {
            walletId: "wallet-late",
            communityId: "community-a",
            from: "0",
            to: "60",
            nftCountRaw: "0",
            communityWeightRaw: ONE,
          },
          {
            walletId: "wallet-late",
            communityId: "community-a",
            from: "60",
            to: "100",
            nftCountRaw: "1",
            communityWeightRaw: ONE,
          },
        ],
      }),
    ).toEqual([{ walletId: "wallet-late", weightRaw: "400000000000000000" }]);
  });

  it("rejects gaps, overlaps, invalid intervals, and missing weights", () => {
    const segment = {
      walletId: "wallet-a",
      communityId: "community-a",
      from: "0",
      to: "100",
      nftCountRaw: "1",
      communityWeightRaw: ONE,
    };
    const base = { epochStart: "0", epochEnd: "100", segments: [segment] };

    expect(() =>
      computeNftEpochWeights({
        ...base,
        segments: [
          { ...segment, to: "40" },
          { ...segment, from: "60" },
        ],
      }),
    ).toThrow("Incomplete NFT holding history");
    expect(() =>
      computeNftEpochWeights({
        ...base,
        segments: [
          { ...segment, to: "60" },
          { ...segment, from: "50" },
        ],
      }),
    ).toThrow("Overlapping NFT holding history");
    expect(() =>
      computeNftEpochWeights({
        ...base,
        segments: [{ ...segment, from: "10", to: "10" }],
      }),
    ).toThrow("Invalid NFT holding interval");
    expect(() =>
      computeNftEpochWeights({
        ...base,
        segments: [{ ...segment, communityWeightRaw: "" }],
      }),
    ).toThrow("Invalid NFT community weight");
  });
});
