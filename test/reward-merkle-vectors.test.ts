import { describe, expect, it } from "vitest";

import {
  buildRewardMerkleBatch,
  LOOP_REWARD_SCHEMA_VERSION,
  verifyRewardProof,
} from "../src/features/mining/reward-merkle.js";

const input = {
  chainId: "56",
  distributor: "0x00000000000000000000000000000000000000d1",
  poolId: 1 as const,
  epochId: 12,
  batchId: `0x${"ab".repeat(32)}`,
  schemaVersion: LOOP_REWARD_SCHEMA_VERSION,
  leaves: [
    {
      beneficiary: "0x0000000000000000000000000000000000000002",
      amountRaw: "200",
    },
    {
      beneficiary: "0x0000000000000000000000000000000000000001",
      amountRaw: "100",
    },
  ],
};

describe("reward Merkle batch", () => {
  it("builds deterministic, domain-separated leaves and verifiable proofs", () => {
    const batch = buildRewardMerkleBatch(input);
    expect(batch.committedAmountRaw).toBe("300");
    expect(batch.root).toBe(
      "0x6dcb8b491f9ee9547f8dbff73090d157e48505b59b553c656870cb060748d722",
    );
    expect(batch.leaves.map((leaf) => leaf.leafIndex)).toEqual([0, 1]);
    expect(batch.root).toMatch(/^0x[0-9a-f]{64}$/);
    for (const leaf of batch.leaves) {
      expect(verifyRewardProof(batch.root, leaf.leafHash, leaf.proof)).toBe(
        true,
      );
    }
    expect(
      buildRewardMerkleBatch({ ...input, leaves: [...input.leaves].reverse() })
        .root,
    ).toBe(batch.root);
  });

  it("rejects duplicate beneficiaries, zero amounts, and invalid epochs", () => {
    expect(() =>
      buildRewardMerkleBatch({
        ...input,
        leaves: [input.leaves[0]!, input.leaves[0]!],
      }),
    ).toThrow("Duplicate reward beneficiary");
    expect(() =>
      buildRewardMerkleBatch({
        ...input,
        leaves: [{ ...input.leaves[0]!, amountRaw: "0" }],
      }),
    ).toThrow("Invalid reward amount");
    expect(() => buildRewardMerkleBatch({ ...input, epochId: 900 })).toThrow(
      "Invalid reward epoch",
    );
    expect(() =>
      buildRewardMerkleBatch({
        ...input,
        schemaVersion: `0x${"11".repeat(32)}`,
      }),
    ).toThrow("Unsupported reward schema version");
  });
});
