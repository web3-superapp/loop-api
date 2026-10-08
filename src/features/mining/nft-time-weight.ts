/**
 * Candidate, development-baseline NFT consensus weighting.
 *
 * A complete history is required for each wallet/community pair: intervals
 * are half-open [from,to), contiguous, and cover the whole epoch. The result
 * is an 18-decimal fixed-point average of NFT count × community coefficient.
 * This pure calculator does not make the rule approved or rewards claimable.
 */

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const FIXED_SCALE = 10n ** 18n;
const MAX_SEGMENTS = 100_000;

export interface NftHoldingSegment {
  readonly walletId: string;
  readonly communityId: string;
  readonly from: string;
  readonly to: string;
  readonly nftCountRaw: string;
  /** Community-specific NFT coefficient at 18-decimal precision. */
  readonly communityWeightRaw: string;
}

export interface NftEpochWeight {
  readonly walletId: string;
  /** Fixed-point 18-decimal weight for this epoch. */
  readonly weightRaw: string;
}

function parseUint(value: string, max: bigint, message: string): bigint {
  if (!UINT_PATTERN.test(value)) throw new Error(message);
  const parsed = BigInt(value);
  if (parsed > max) throw new Error(message);
  return parsed;
}

/** Computes a complete epoch weight or rejects the entire input. */
export function computeNftEpochWeights(input: {
  readonly epochStart: string;
  readonly epochEnd: string;
  readonly segments: readonly NftHoldingSegment[];
}): readonly NftEpochWeight[] {
  const epochStart = parseUint(
    input.epochStart,
    UINT64_MAX,
    "Invalid NFT epoch",
  );
  const epochEnd = parseUint(input.epochEnd, UINT64_MAX, "Invalid NFT epoch");
  if (epochEnd <= epochStart) throw new Error("Invalid NFT epoch");
  if (input.segments.length > MAX_SEGMENTS) {
    throw new Error("Too many NFT holding segments");
  }

  const groups = new Map<string, NftHoldingSegment[]>();
  const identities = new Set<string>();
  for (const segment of input.segments) {
    if (
      !segment.walletId ||
      segment.walletId.length > 256 ||
      !segment.communityId ||
      segment.communityId.length > 256
    ) {
      throw new Error("Invalid NFT holding identity");
    }
    const from = parseUint(
      segment.from,
      UINT64_MAX,
      "Invalid NFT holding interval",
    );
    const to = parseUint(
      segment.to,
      UINT64_MAX,
      "Invalid NFT holding interval",
    );
    if (from < epochStart || to > epochEnd || to <= from) {
      throw new Error("Invalid NFT holding interval");
    }
    parseUint(segment.nftCountRaw, UINT256_MAX, "Invalid NFT count");
    parseUint(
      segment.communityWeightRaw,
      UINT256_MAX,
      "Invalid NFT community weight",
    );
    const identity = JSON.stringify([
      segment.walletId,
      segment.communityId,
      segment.from,
      segment.to,
    ]);
    if (identities.has(identity))
      throw new Error("Duplicate NFT holding segment");
    identities.add(identity);
    const key = JSON.stringify([segment.walletId, segment.communityId]);
    const rows = groups.get(key) ?? [];
    rows.push(segment);
    groups.set(key, rows);
  }

  const integratedByWallet = new Map<string, bigint>();
  const epochDuration = epochEnd - epochStart;
  for (const [key, rows] of groups) {
    rows.sort((left, right) => {
      const a = BigInt(left.from);
      const b = BigInt(right.from);
      return a < b ? -1 : a > b ? 1 : 0;
    });

    let cursor = epochStart;
    let integrated = 0n;
    for (const row of rows) {
      const from = BigInt(row.from);
      const to = BigInt(row.to);
      if (from < cursor) throw new Error("Overlapping NFT holding history");
      if (from !== cursor) throw new Error("Incomplete NFT holding history");
      integrated +=
        (to - from) * BigInt(row.nftCountRaw) * BigInt(row.communityWeightRaw);
      cursor = to;
    }
    if (cursor !== epochEnd) throw new Error("Incomplete NFT holding history");

    const walletId = JSON.parse(key) as [string, string];
    const current = integratedByWallet.get(walletId[0]) ?? 0n;
    const averageWeight = integrated / epochDuration;
    const next = current + averageWeight;
    if (next > UINT256_MAX) throw new Error("NFT epoch weight exceeds uint256");
    integratedByWallet.set(walletId[0], next);
  }

  return [...integratedByWallet.entries()]
    .map(([walletId, weight]) => ({ walletId, weightRaw: weight.toString() }))
    .sort((left, right) =>
      left.walletId < right.walletId
        ? -1
        : left.walletId > right.walletId
          ? 1
          : 0,
    );
}

export const nftEpochWeightScale = FIXED_SCALE.toString();
