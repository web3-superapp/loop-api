/**
 * Pure preflight for reward-batch commitment limits. The caller must load all
 * historical commitments, including fully claimed batches; claiming never
 * releases the lifetime issuance cap. This does not activate a reward root.
 */

const UINT256_MAX = (1n << 256n) - 1n;
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;
const LOOP_SCALE = 10n ** 18n;
export const miningPoolOrdinaryLifetimeCapRaw = (
  450_000_000n * LOOP_SCALE
).toString();
export const miningGlobalLifetimeCapRaw = (
  900_000_000n * LOOP_SCALE
).toString();

export interface RewardCommitment {
  readonly batchId: string;
  readonly poolId: number;
  readonly epochId: number;
  readonly kind: string;
  readonly amountRaw: string;
}

export interface RewardBatchBudgetResult {
  readonly ordinaryCommittedByPool: Readonly<Record<1 | 2, string>>;
  readonly correctionCommittedRaw: string;
  readonly totalCommittedRaw: string;
}

function parseUint(value: string): bigint {
  if (!UINT_PATTERN.test(value))
    throw new Error("Invalid reward commitment amount");
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error("Invalid reward commitment amount");
  return parsed;
}

/** Checks a proposed commitment against a complete append-only history. */
export function validateRewardBatchBudget(input: {
  readonly existing: readonly RewardCommitment[];
  readonly proposed: RewardCommitment;
}): RewardBatchBudgetResult {
  const all = [...input.existing, input.proposed];
  const batchIds = new Set<string>();
  const ordinaryEpochs = new Set<string>();
  const ordinaryByPool: Record<1 | 2, bigint> = { 1: 0n, 2: 0n };
  let corrections = 0n;
  let total = 0n;

  for (const batch of all) {
    if (!BYTES32_PATTERN.test(batch.batchId) || batchIds.has(batch.batchId)) {
      throw new Error("Invalid reward commitment");
    }
    if (batch.poolId !== 1 && batch.poolId !== 2) {
      throw new Error("Invalid reward pool");
    }
    if (
      !Number.isInteger(batch.epochId) ||
      batch.epochId < 0 ||
      batch.epochId >= 900
    ) {
      throw new Error("Invalid reward epoch");
    }
    if (batch.kind !== "ordinary" && batch.kind !== "correction") {
      throw new Error("Invalid reward batch kind");
    }
    batchIds.add(batch.batchId);
    const amount = parseUint(batch.amountRaw);
    if (amount === 0n) throw new Error("Invalid reward commitment amount");
    total += amount;
    if (total > UINT256_MAX)
      throw new Error("Global mining commitment cap exceeded");

    if (batch.kind === "ordinary") {
      const epochKey = `${String(batch.poolId)}:${String(batch.epochId)}`;
      if (ordinaryEpochs.has(epochKey)) {
        throw new Error("Ordinary reward batch already exists");
      }
      ordinaryEpochs.add(epochKey);
      ordinaryByPool[batch.poolId] += amount;
      if (
        ordinaryByPool[batch.poolId] > BigInt(miningPoolOrdinaryLifetimeCapRaw)
      ) {
        throw new Error("Pool ordinary commitment cap exceeded");
      }
    } else {
      corrections += amount;
    }
  }

  if (total > BigInt(miningGlobalLifetimeCapRaw)) {
    throw new Error("Global mining commitment cap exceeded");
  }

  return Object.freeze({
    ordinaryCommittedByPool: Object.freeze({
      1: ordinaryByPool[1].toString(),
      2: ordinaryByPool[2].toString(),
    }),
    correctionCommittedRaw: corrections.toString(),
    totalCommittedRaw: total.toString(),
  });
}
