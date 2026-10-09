import { allocatePoolBudget } from "./dual-pool-allocation.js";
import {
  computeNftEpochWeights,
  nftEpochWeightScale,
} from "./nft-time-weight.js";
import type { NftHoldingSegment } from "./nft-time-weight.js";

/**
 * Candidate consensus-NFT epoch calculation. It composes complete
 * time-weighted holding history with a separately configured NFT pool budget.
 * The scope label is deliberately non-production until Mining policy and
 * reward authority are approved.
 */
export function allocateConsensusNftEpoch(input: {
  readonly epochStart: string;
  readonly epochEnd: string;
  readonly budgetRaw: string;
  readonly segments: readonly NftHoldingSegment[];
}) {
  const weights = computeNftEpochWeights(input);
  const allocation = allocatePoolBudget({
    budgetRaw: input.budgetRaw,
    weights: weights.map(({ walletId, weightRaw }) => ({
      walletId,
      weightRaw,
    })),
  });

  return Object.freeze({
    formulaScope: "development_baseline" as const,
    coefficientScale: nftEpochWeightScale,
    weights,
    allocations: allocation.allocations,
    committedRaw: allocation.committedRaw,
    unallocatedRaw: allocation.unallocatedRaw,
  });
}
