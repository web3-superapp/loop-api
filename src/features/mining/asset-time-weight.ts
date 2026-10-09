/**
 * Candidate, development-baseline time-weighted Asset Power calculator.
 * Values use raw integer strings and USD18 fixed point. Input acquisition,
 * price validation, liquidity caps, and policy approval are separate duties.
 */

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const ASSET_ID_PATTERN = /^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/;
const USD_SCALE = 10n ** 18n;
const MAX_SEGMENTS = 100_000;

export interface AssetHoldingSegment {
  readonly walletId: string;
  readonly assetId: string;
  readonly from: string;
  readonly to: string;
  /** Token smallest units. */
  readonly balanceRaw: string;
  readonly decimals: number;
  /** USD18 price per whole token. */
  readonly priceUsdRaw: string;
  /** 18-decimal fixed-point asset mining weight. */
  readonly assetWeightRaw: string;
}

export interface AssetEpochPower {
  readonly walletId: string;
  /** 18-decimal fixed-point weighted USD value. */
  readonly powerRaw: string;
}

function parseUint(value: string, max: bigint, message: string): bigint {
  if (!UINT_PATTERN.test(value)) throw new Error(message);
  const parsed = BigInt(value);
  if (parsed > max) throw new Error(message);
  return parsed;
}

/** Computes a complete epoch's account powers or rejects the whole input. */
export function computeAssetEpochPower(input: {
  readonly epochStart: string;
  readonly epochEnd: string;
  readonly segments: readonly AssetHoldingSegment[];
}): readonly AssetEpochPower[] {
  const epochStart = parseUint(
    input.epochStart,
    UINT64_MAX,
    "Invalid asset epoch",
  );
  const epochEnd = parseUint(input.epochEnd, UINT64_MAX, "Invalid asset epoch");
  if (epochEnd <= epochStart) throw new Error("Invalid asset epoch");
  if (input.segments.length > MAX_SEGMENTS) {
    throw new Error("Too many asset input segments");
  }

  const groups = new Map<string, AssetHoldingSegment[]>();
  const identities = new Set<string>();
  for (const segment of input.segments) {
    if (
      !segment.walletId ||
      segment.walletId.length > 256 ||
      !ASSET_ID_PATTERN.test(segment.assetId)
    ) {
      throw new Error("Invalid asset holding identity");
    }
    const from = parseUint(
      segment.from,
      UINT64_MAX,
      "Invalid asset input interval",
    );
    const to = parseUint(
      segment.to,
      UINT64_MAX,
      "Invalid asset input interval",
    );
    if (from < epochStart || to > epochEnd || to <= from) {
      throw new Error("Invalid asset input interval");
    }
    const balance = parseUint(
      segment.balanceRaw,
      UINT256_MAX,
      "Invalid asset balance",
    );
    const price = parseUint(
      segment.priceUsdRaw,
      UINT256_MAX,
      "Invalid asset price",
    );
    parseUint(segment.assetWeightRaw, UINT256_MAX, "Invalid asset weight");
    if (
      !Number.isInteger(segment.decimals) ||
      segment.decimals < 0 ||
      segment.decimals > 36
    ) {
      throw new Error("Invalid asset decimals");
    }
    if (balance > 0n && price === 0n)
      throw new Error("Missing price for positive asset balance");

    const identity = JSON.stringify([
      segment.walletId,
      segment.assetId,
      segment.from,
      segment.to,
    ]);
    if (identities.has(identity))
      throw new Error("Duplicate asset input segment");
    identities.add(identity);
    const key = JSON.stringify([segment.walletId, segment.assetId]);
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
      if (from < cursor) throw new Error("Overlapping asset input history");
      if (from !== cursor) throw new Error("Incomplete asset input history");
      const balance = BigInt(row.balanceRaw);
      const price = BigInt(row.priceUsdRaw);
      const weight = BigInt(row.assetWeightRaw);
      const denominator = 10n ** BigInt(row.decimals) * USD_SCALE;
      const usd18 = (balance * price * weight) / denominator;
      integrated += (to - from) * usd18;
      cursor = to;
    }
    if (cursor !== epochEnd) throw new Error("Incomplete asset input history");

    const walletId = (JSON.parse(key) as [string, string])[0];
    const current = integratedByWallet.get(walletId) ?? 0n;
    const averagePower = integrated / epochDuration;
    const next = current + averagePower;
    if (next > UINT256_MAX)
      throw new Error("Asset epoch power exceeds uint256");
    integratedByWallet.set(walletId, next);
  }

  return [...integratedByWallet.entries()]
    .map(([walletId, power]) => ({ walletId, powerRaw: power.toString() }))
    .sort((left, right) =>
      left.walletId < right.walletId
        ? -1
        : left.walletId > right.walletId
          ? 1
          : 0,
    );
}

export const assetPowerScale = USD_SCALE.toString();
