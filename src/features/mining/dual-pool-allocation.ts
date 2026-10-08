/**
 * Development-baseline allocation for independent consensus-NFT and asset
 * power budgets. Inputs and outputs are smallest-unit integer strings. This
 * function does not approve a Mining formula, create rewards, or make an
 * amount claimable; a reviewed formula version and activated root are still
 * required by the production service.
 */

const UINT256_MAX = (1n << 256n) - 1n;
const UINT256_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const MAX_WEIGHT_ROWS = 100_000;

export interface PoolWeightInput {
  readonly walletId: string;
  readonly weightRaw: string;
}

export interface PoolBudgetInput {
  /** Reward-token smallest units, never a JavaScript number. */
  readonly budgetRaw: string;
  readonly weights: readonly PoolWeightInput[];
}

export interface PoolAllocation {
  readonly walletId: string;
  readonly amountRaw: string;
}

export interface PoolAllocationResult {
  readonly allocations: readonly PoolAllocation[];
  readonly committedRaw: string;
  readonly unallocatedRaw: string;
}

export interface DualPoolAllocationResult {
  readonly consensusNft: PoolAllocationResult;
  readonly assetPower: PoolAllocationResult;
}

function parseUint256(value: string, error: string): bigint {
  if (!UINT256_PATTERN.test(value)) throw new Error(error);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(error);
  return parsed;
}

export function allocatePoolBudget(
  input: PoolBudgetInput,
): PoolAllocationResult {
  const budget = parseUint256(input.budgetRaw, "Invalid pool budget");
  if (input.weights.length > MAX_WEIGHT_ROWS) {
    throw new Error("Too many pool weight rows");
  }

  const seen = new Set<string>();
  const normalized = input.weights.map(({ walletId, weightRaw }) => {
    if (!walletId || walletId.length > 256 || seen.has(walletId)) {
      throw new Error("Duplicate wallet weight");
    }
    seen.add(walletId);
    return { walletId, weight: parseUint256(weightRaw, "Invalid pool weight") };
  });

  const totalWeight = normalized.reduce((total, row) => total + row.weight, 0n);
  if (totalWeight === 0n) {
    return {
      allocations: [],
      committedRaw: "0",
      unallocatedRaw: budget.toString(),
    };
  }

  const allocations = normalized
    .filter((row) => row.weight > 0n)
    .map(({ walletId, weight }) => ({
      walletId,
      amountRaw: ((budget * weight) / totalWeight).toString(),
    }))
    .sort((left, right) =>
      left.walletId < right.walletId
        ? -1
        : left.walletId > right.walletId
          ? 1
          : 0,
    );
  const committed = allocations.reduce(
    (total, row) => total + BigInt(row.amountRaw),
    0n,
  );

  if (committed > budget) throw new Error("Pool allocation exceeds budget");
  return {
    allocations,
    committedRaw: committed.toString(),
    unallocatedRaw: (budget - committed).toString(),
  };
}

/** Each pool has its own denominator and cap; unused budget never crosses pools. */
export function allocateDualPoolBudget(input: {
  readonly consensusNft: PoolBudgetInput;
  readonly assetPower: PoolBudgetInput;
}): DualPoolAllocationResult {
  return {
    consensusNft: allocatePoolBudget(input.consensusNft),
    assetPower: allocatePoolBudget(input.assetPower),
  };
}
