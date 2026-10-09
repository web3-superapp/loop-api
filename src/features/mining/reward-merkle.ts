import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toBytes,
  type Address,
  type Hex,
} from "viem";

const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_REWARD_LEAVES = 100_000;
export const LOOP_REWARD_SCHEMA_VERSION = keccak256(
  toBytes("loop.dual-mining.reward-leaf.v1"),
);

const rewardLeafParameters = parseAbiParameters(
  "bytes32 schemaVersion, uint256 chainId, address distributor, uint8 poolId, uint16 epochId, bytes32 batchId, uint32 leafIndex, address beneficiary, uint256 amountRaw",
);

export interface RewardLeafInput {
  readonly beneficiary: string;
  readonly amountRaw: string;
}

export interface RewardBatchInput {
  readonly schemaVersion: string;
  readonly chainId: string;
  readonly distributor: string;
  readonly poolId: number;
  readonly epochId: number;
  readonly batchId: string;
  readonly leaves: readonly RewardLeafInput[];
}

export interface RewardMerkleLeaf {
  readonly leafIndex: number;
  readonly beneficiary: string;
  readonly amountRaw: string;
  readonly leafHash: string;
  readonly proof: readonly string[];
}

export interface RewardMerkleBatch {
  readonly schemaVersion: string;
  readonly chainId: string;
  readonly distributor: string;
  readonly poolId: 1 | 2;
  readonly epochId: number;
  readonly batchId: string;
  readonly root: string;
  readonly committedAmountRaw: string;
  readonly leaves: readonly RewardMerkleLeaf[];
}

function parseUint(value: string, error: string): bigint {
  if (!UINT_PATTERN.test(value)) throw new Error(error);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(error);
  return parsed;
}

function normalizeAddress(value: string): Address {
  if (!ADDRESS_PATTERN.test(value)) throw new Error("Invalid reward address");
  return value.toLowerCase() as Address;
}

function normalizeBytes32(value: string, error: string): Hex {
  if (!BYTES32_PATTERN.test(value)) throw new Error(error);
  return value.toLowerCase() as Hex;
}

/**
 * Builds an OpenZeppelin StandardMerkleTree-compatible double-hashed leaf
 * over a fully domain-separated reward record. This is a candidate batch
 * builder only; it does not approve, fund, submit, or activate rewards.
 */
export function buildRewardMerkleBatch(
  input: RewardBatchInput,
): RewardMerkleBatch {
  const schemaVersion = normalizeBytes32(
    input.schemaVersion,
    "Invalid reward schema version",
  );
  if (schemaVersion !== LOOP_REWARD_SCHEMA_VERSION) {
    throw new Error("Unsupported reward schema version");
  }
  const batchId = normalizeBytes32(input.batchId, "Invalid reward batch ID");
  const chainId = parseUint(input.chainId, "Invalid reward chain ID");
  if (chainId === 0n) throw new Error("Invalid reward chain ID");
  const distributor = normalizeAddress(input.distributor);
  if (input.poolId !== 1 && input.poolId !== 2) {
    throw new Error("Invalid reward pool");
  }
  if (
    !Number.isInteger(input.epochId) ||
    input.epochId < 0 ||
    input.epochId >= 900
  ) {
    throw new Error("Invalid reward epoch");
  }
  if (input.leaves.length === 0 || input.leaves.length > MAX_REWARD_LEAVES) {
    throw new Error("Invalid reward leaf count");
  }

  const beneficiaries = new Set<string>();
  const rows = input.leaves
    .map((leaf) => {
      const beneficiary = normalizeAddress(leaf.beneficiary);
      if (beneficiaries.has(beneficiary)) {
        throw new Error("Duplicate reward beneficiary");
      }
      beneficiaries.add(beneficiary);
      const amount = parseUint(leaf.amountRaw, "Invalid reward amount");
      if (amount === 0n) throw new Error("Invalid reward amount");
      return { beneficiary, amount };
    })
    .sort((left, right) => left.beneficiary.localeCompare(right.beneficiary));

  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  if (total > UINT256_MAX)
    throw new Error("Reward batch total exceeds uint256");

  const records = rows.map((row, leafIndex) => {
    const encoded = encodeAbiParameters(rewardLeafParameters, [
      schemaVersion,
      chainId,
      distributor,
      input.poolId,
      input.epochId,
      batchId,
      leafIndex,
      row.beneficiary,
      row.amount,
    ]);
    const leafHash = keccak256(keccak256(encoded));
    return { ...row, leafIndex, leafHash };
  });

  const layers: Hex[][] = [records.map(({ leafHash }) => leafHash)];
  while ((layers.at(-1)?.length ?? 0) > 1) {
    const current = layers.at(-1) as Hex[];
    const next: Hex[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index] as Hex;
      const right = current[index + 1];
      next.push(right === undefined ? left : hashSortedPair(left, right));
    }
    layers.push(next);
  }
  const root = (layers.at(-1)?.[0] ?? "") as Hex;

  const leaves = records.map((row) => {
    let index = row.leafIndex;
    const proof: Hex[] = [];
    for (let level = 0; level < layers.length - 1; level += 1) {
      const layer = layers[level] as Hex[];
      const sibling = index % 2 === 0 ? layer[index + 1] : layer[index - 1];
      if (sibling !== undefined) proof.push(sibling);
      index = Math.floor(index / 2);
    }
    return Object.freeze({
      leafIndex: row.leafIndex,
      beneficiary: row.beneficiary,
      amountRaw: row.amount.toString(),
      leafHash: row.leafHash,
      proof: Object.freeze(proof),
    });
  });

  return Object.freeze({
    schemaVersion,
    chainId: chainId.toString(),
    distributor,
    poolId: input.poolId,
    epochId: input.epochId,
    batchId,
    root,
    committedAmountRaw: total.toString(),
    leaves: Object.freeze(leaves),
  });
}

export function hashSortedPair(left: Hex, right: Hex): Hex {
  const [first, second] =
    left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left];
  return keccak256(concat([first, second]));
}

export function verifyRewardProof(
  root: string,
  leafHash: string,
  proof: readonly string[],
): boolean {
  if (!BYTES32_PATTERN.test(root) || !BYTES32_PATTERN.test(leafHash))
    return false;
  let computed = leafHash.toLowerCase() as Hex;
  for (const node of proof) {
    if (!BYTES32_PATTERN.test(node)) return false;
    computed = hashSortedPair(computed, node.toLowerCase() as Hex);
  }
  return computed === root.toLowerCase();
}
