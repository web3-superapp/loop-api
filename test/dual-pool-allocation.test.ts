import { describe, expect, it } from "vitest";

import { allocateDualPoolBudget } from "../src/features/mining/dual-pool-allocation.js";

describe("allocateDualPoolBudget", () => {
  it("allocates each configured pool independently and never spends its rounding remainder", () => {
    const result = allocateDualPoolBudget({
      consensusNft: {
        budgetRaw: "100",
        weights: [
          { walletId: "wallet-a", weightRaw: "1" },
          { walletId: "wallet-b", weightRaw: "2" },
        ],
      },
      assetPower: {
        budgetRaw: "90",
        weights: [
          { walletId: "wallet-a", weightRaw: "3" },
          { walletId: "wallet-c", weightRaw: "1" },
        ],
      },
    });

    expect(result.consensusNft).toEqual({
      allocations: [
        { walletId: "wallet-a", amountRaw: "33" },
        { walletId: "wallet-b", amountRaw: "66" },
      ],
      committedRaw: "99",
      unallocatedRaw: "1",
    });
    expect(result.assetPower).toEqual({
      allocations: [
        { walletId: "wallet-a", amountRaw: "67" },
        { walletId: "wallet-c", amountRaw: "22" },
      ],
      committedRaw: "89",
      unallocatedRaw: "1",
    });
  });

  it("keeps a zero-weight pool budget unallocated instead of moving it to the other pool", () => {
    const result = allocateDualPoolBudget({
      consensusNft: { budgetRaw: "500", weights: [] },
      assetPower: {
        budgetRaw: "500",
        weights: [{ walletId: "wallet-a", weightRaw: "1" }],
      },
    });

    expect(result.consensusNft).toEqual({
      allocations: [],
      committedRaw: "0",
      unallocatedRaw: "500",
    });
    expect(result.assetPower).toEqual({
      allocations: [{ walletId: "wallet-a", amountRaw: "500" }],
      committedRaw: "500",
      unallocatedRaw: "0",
    });
  });

  it("is deterministic for input order and accepts exact integer strings beyond JS safe precision", () => {
    const common = {
      budgetRaw: "900719925474099300000000",
      weights: [
        { walletId: "wallet-a", weightRaw: "2" },
        { walletId: "wallet-b", weightRaw: "1" },
      ],
    };
    const forward = allocateDualPoolBudget({
      consensusNft: common,
      assetPower: common,
    });
    const reverse = allocateDualPoolBudget({
      consensusNft: { ...common, weights: [...common.weights].reverse() },
      assetPower: common,
    });

    expect(reverse.consensusNft).toEqual(forward.consensusNft);
    expect(forward.consensusNft.committedRaw).toBe("900719925474099300000000");
    expect(forward.consensusNft.unallocatedRaw).toBe("0");
    expect(forward.consensusNft.allocations[0]).toEqual({
      walletId: "wallet-a",
      amountRaw: "600479950316066200000000",
    });
  });

  it("rejects malformed amounts, negative weights, and duplicate wallet rows", () => {
    const base = {
      consensusNft: {
        budgetRaw: "10",
        weights: [{ walletId: "wallet-a", weightRaw: "1" }],
      },
      assetPower: { budgetRaw: "10", weights: [] },
    };

    expect(() =>
      allocateDualPoolBudget({
        ...base,
        consensusNft: { budgetRaw: "01", weights: base.consensusNft.weights },
      }),
    ).toThrow("Invalid pool budget");
    expect(() =>
      allocateDualPoolBudget({
        ...base,
        consensusNft: {
          budgetRaw: "10",
          weights: [{ walletId: "wallet-a", weightRaw: "-1" }],
        },
      }),
    ).toThrow("Invalid pool weight");
    expect(() =>
      allocateDualPoolBudget({
        ...base,
        consensusNft: {
          budgetRaw: "10",
          weights: [
            { walletId: "wallet-a", weightRaw: "1" },
            { walletId: "wallet-a", weightRaw: "2" },
          ],
        },
      }),
    ).toThrow("Duplicate wallet weight");
  });

  it("omits zero-weight rows and rejects values outside uint256", () => {
    const result = allocateDualPoolBudget({
      consensusNft: {
        budgetRaw: "7",
        weights: [
          { walletId: "wallet-zero", weightRaw: "0" },
          { walletId: "wallet-positive", weightRaw: "1" },
        ],
      },
      assetPower: { budgetRaw: "0", weights: [] },
    });

    expect(result.consensusNft.allocations).toEqual([
      { walletId: "wallet-positive", amountRaw: "7" },
    ]);
    expect(() =>
      allocateDualPoolBudget({
        consensusNft: {
          budgetRaw:
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
          weights: [],
        },
        assetPower: { budgetRaw: "0", weights: [] },
      }),
    ).toThrow("Invalid pool budget");
  });
});
