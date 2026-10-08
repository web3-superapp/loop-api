import { allocatePoolBudget } from "./dual-pool-allocation.js";
import {
  assetPowerScale,
  computeAssetEpochPower,
} from "./asset-time-weight.js";
import type { AssetHoldingSegment } from "./asset-time-weight.js";

/**
 * Candidate asset-power epoch calculation. It uses only the asset pool's
 * budget and refuses partial history. It does not activate Mining rewards.
 */
export function allocateAssetPowerEpoch(input: {
  readonly epochStart: string;
  readonly epochEnd: string;
  readonly budgetRaw: string;
  readonly segments: readonly AssetHoldingSegment[];
}) {
  const powers = computeAssetEpochPower(input);
  const allocation = allocatePoolBudget({
    budgetRaw: input.budgetRaw,
    weights: powers.map(({ walletId, powerRaw }) => ({
      walletId,
      weightRaw: powerRaw,
    })),
  });

  return Object.freeze({
    formulaScope: "development_baseline" as const,
    powerScale: assetPowerScale,
    powers,
    allocations: allocation.allocations,
    committedRaw: allocation.committedRaw,
    unallocatedRaw: allocation.unallocatedRaw,
  });
}
