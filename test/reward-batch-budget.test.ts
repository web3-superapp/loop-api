import { describe, expect, it } from "vitest";

import { validateRewardBatchBudget } from "../src/features/mining/reward-batch.js";

const cap = 450_000_000n * 10n ** 18n;
const batch = (
  id: number,
  poolId: 1 | 2,
  epochId: number,
  kind: "ordinary" | "correction",
  amountRaw: string,
) => ({
  batchId: `0x${id.toString(16).padStart(64, "0")}`,
  poolId,
  epochId,
  kind,
  amountRaw,
});

describe("validateRewardBatchBudget", () => {
  it("enforces per-pool ordinary caps and all-commitment cap without releasing claimed amounts", () => {
    expect(
      validateRewardBatchBudget({
        existing: [batch(1, 1, 0, "ordinary", cap.toString())],
        proposed: batch(2, 2, 0, "ordinary", cap.toString()),
      }).totalCommittedRaw,
    ).toBe((cap * 2n).toString());

    expect(() =>
      validateRewardBatchBudget({
        existing: [batch(1, 1, 0, "ordinary", cap.toString())],
        proposed: batch(2, 1, 1, "ordinary", "1"),
      }),
    ).toThrow("Pool ordinary commitment cap exceeded");
  });

  it("counts corrections against the global cap and permits separate correction batches", () => {
    const ordinary = batch(1, 1, 0, "ordinary", cap.toString());
    expect(
      validateRewardBatchBudget({
        existing: [ordinary, batch(2, 1, 0, "correction", "1")],
        proposed: batch(3, 1, 0, "correction", "2"),
      }).correctionCommittedRaw,
    ).toBe("3");
    expect(() =>
      validateRewardBatchBudget({
        existing: [
          ordinary,
          batch(2, 1, 0, "correction", (cap * 2n).toString()),
        ],
        proposed: batch(3, 2, 0, "correction", "1"),
      }),
    ).toThrow("Global mining commitment cap exceeded");
  });

  it("allows only one ordinary batch per pool and epoch", () => {
    expect(() =>
      validateRewardBatchBudget({
        existing: [batch(1, 1, 20, "ordinary", "10")],
        proposed: batch(2, 1, 20, "ordinary", "10"),
      }),
    ).toThrow("Ordinary reward batch already exists");
    expect(() =>
      validateRewardBatchBudget({
        existing: [],
        proposed: batch(2, 1, 900, "ordinary", "10"),
      }),
    ).toThrow("Invalid reward epoch");
  });
});
