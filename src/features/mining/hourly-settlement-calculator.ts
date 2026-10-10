import { allocatePoolBudget } from "./dual-pool-allocation.js";
import {
  type MiningAssetPowerBasis,
  miningBpsDenominator,
  miningFixedScale,
  miningReferralLevels,
  miningSettlementReasonCodes,
} from "./hourly-settlement-contract.js";

/**
 * Decision 0116: the pure hourly two-track settlement. Inputs are already
 * attributed to LOOP users (opaque IDs) and clipped to the hour; every
 * quantity is a bigint. Power is integrated over time ("power-seconds",
 * 1e18 fixed point), so a holding that changes inside the hour, a parameter
 * slice, and a referral edge that starts or ends inside the hour are all
 * counted for exactly the time they were in force. The function never
 * reads a clock, a database, or a network.
 */

export class MiningSettlementInputError extends Error {
  readonly reasonCode: string;
  readonly detail: string;

  constructor(reasonCode: string, detail: string) {
    super(`${reasonCode}: ${detail}`);
    this.name = "MiningSettlementInputError";
    this.reasonCode = reasonCode;
    this.detail = detail;
  }
}

export interface MiningParameterSlice {
  readonly from: bigint;
  readonly to: bigint;
  readonly versionId: string;
  /**
   * communityId → coefficient (1e18). Absent → `defaultCoefficient`; an
   * instance bound to no single community → 0.
   */
  readonly coefficients: ReadonlyMap<string, bigint>;
  /**
   * Decision 0123: coefficient of an unlisted community (1e18). 1.0 for
   * documents approved under 0123, 0 for the 0116 ones.
   */
  readonly defaultCoefficient: bigint;
  /** assetId → weight (1e18). Absent → 0 (not admitted). */
  readonly assetWeights: ReadonlyMap<string, bigint>;
  /**
   * Decision 0123: `quantity` → power/s = balance × weight (no price);
   * `valuation` (0116 replay only) → balance × price × weight.
   */
  readonly assetPowerBasis: MiningAssetPowerBasis;
}

export interface MiningNftHoldingSegment {
  readonly userId: string;
  readonly instanceId: string;
  /** null when no single community is bound to the instance's asset. */
  readonly communityId: string | null;
  readonly from: bigint;
  readonly to: bigint;
  readonly count: bigint;
}

export interface MiningAssetHoldingSegment {
  readonly userId: string;
  readonly assetId: string;
  readonly from: bigint;
  readonly to: bigint;
  /** Smallest units (18 decimals). */
  readonly balanceRaw: bigint;
}

/** Decision 0116 replay only: read by `valuation` slices. */
export interface MiningPriceSegment {
  readonly assetId: string;
  readonly from: bigint;
  readonly to: bigint;
  /** USD (USD1 at par) per whole token, 1e18. */
  readonly priceE18: bigint;
}

export interface MiningReferralEdge {
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  /** 1..5 */
  readonly depth: number;
  readonly from: bigint;
  /** null = still in force. */
  readonly to: bigint | null;
}

export interface MiningHourlySettlementInput {
  readonly hourStart: bigint;
  readonly hourEnd: bigint;
  readonly budgetNftRaw: bigint;
  readonly budgetAssetRaw: bigint;
  readonly referralRatiosBps: readonly number[];
  readonly parameterSlices: readonly MiningParameterSlice[];
  readonly nftHoldings: readonly MiningNftHoldingSegment[];
  readonly assetHoldings: readonly MiningAssetHoldingSegment[];
  /** Only `valuation` slices read prices; empty for quantity-only hours. */
  readonly prices: readonly MiningPriceSegment[];
  readonly referralEdges: readonly MiningReferralEdge[];
}

export interface MiningReferralLevelResult {
  readonly level: number;
  readonly ratioBps: number;
  /** Invitees at this depth with self power > 0 while the edge was in force. */
  readonly effectiveMembers: number;
  /** Hour-average referral power from this level (1e18). */
  readonly nftPower: bigint;
  readonly assetPower: bigint;
  /** Equivalent NFT units by source community (1e18), "unbound" for null. */
  readonly nftUnitsByCommunity: ReadonlyMap<string, bigint>;
}

export interface MiningNftHoldingDetail {
  readonly instanceId: string;
  readonly communityId: string | null;
  readonly countAtEnd: bigint;
  /** Hour-average weighted power of this holding (1e18). */
  readonly power: bigint;
}

export interface MiningAssetHoldingDetail {
  readonly assetId: string;
  readonly balanceAtEndRaw: bigint;
  /** Hour-average weighted power of this holding (1e18). */
  readonly power: bigint;
}

export interface MiningUserSettlement {
  readonly userId: string;
  readonly nftSelfPower: bigint;
  readonly assetSelfPower: bigint;
  readonly nftReferralPower: bigint;
  readonly assetReferralPower: bigint;
  readonly nftTotalPower: bigint;
  readonly assetTotalPower: bigint;
  readonly levels: readonly MiningReferralLevelResult[];
  readonly nftHoldings: readonly MiningNftHoldingDetail[];
  readonly assetHoldings: readonly MiningAssetHoldingDetail[];
  readonly nftRewardRaw: bigint;
  readonly assetRewardRaw: bigint;
  readonly totalRewardRaw: bigint;
}

export interface MiningTrackResult {
  readonly budgetRaw: bigint;
  /** Σ hour-average total power of the track (1e18). */
  readonly denominatorPower: bigint;
  readonly allocatedRaw: bigint;
  readonly unallocatedRaw: bigint;
}

export interface MiningHourlySettlementResult {
  readonly users: readonly MiningUserSettlement[];
  readonly nft: MiningTrackResult;
  readonly asset: MiningTrackResult;
}

interface PowerPiece {
  readonly from: bigint;
  readonly to: bigint;
  /** Power per second, 1e18. */
  readonly power: bigint;
}

interface CountPiece {
  readonly from: bigint;
  readonly to: bigint;
  readonly community: string;
  readonly count: bigint;
}

const unboundCommunity = "unbound";

function invalid(detail: string): never {
  throw new MiningSettlementInputError(
    miningSettlementReasonCodes.inputInvalid,
    detail,
  );
}

function overlap(
  from: bigint,
  to: bigint,
  windowFrom: bigint,
  windowTo: bigint,
): bigint {
  const start = from > windowFrom ? from : windowFrom;
  const end = to < windowTo ? to : windowTo;
  return end > start ? end - start : 0n;
}

function integrate(
  pieces: readonly PowerPiece[] | undefined,
  windowFrom: bigint,
  windowTo: bigint,
): bigint {
  if (pieces === undefined) return 0n;
  let total = 0n;
  for (const piece of pieces) {
    total += overlap(piece.from, piece.to, windowFrom, windowTo) * piece.power;
  }
  return total;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [value]);
  else rows.push(value);
}

function checkSegment(
  from: bigint,
  to: bigint,
  start: bigint,
  end: bigint,
  label: string,
): void {
  if (from < start || to > end || to <= from) invalid(label);
}

/** Splits [from,to) on the parameter slice boundaries. */
function slicesOver(
  slices: readonly MiningParameterSlice[],
  from: bigint,
  to: bigint,
): Array<{ from: bigint; to: bigint; slice: MiningParameterSlice }> {
  const out: Array<{ from: bigint; to: bigint; slice: MiningParameterSlice }> =
    [];
  for (const slice of slices) {
    const a = slice.from > from ? slice.from : from;
    const b = slice.to < to ? slice.to : to;
    if (b > a) out.push({ from: a, to: b, slice });
  }
  return out;
}

export function settleMiningHour(
  input: MiningHourlySettlementInput,
): MiningHourlySettlementResult {
  const start = input.hourStart;
  const end = input.hourEnd;
  const duration = end - start;
  if (duration <= 0n) invalid("hour");
  if (input.budgetNftRaw < 0n || input.budgetAssetRaw < 0n) invalid("budget");
  if (
    input.referralRatiosBps.length !== miningReferralLevels ||
    input.referralRatiosBps.some(
      (ratio) => !Number.isInteger(ratio) || ratio < 0 || ratio > 10_000,
    )
  ) {
    invalid("referralRatiosBps");
  }

  // Parameter slices must tile the hour exactly.
  const slices = [...input.parameterSlices].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  let cursor = start;
  for (const slice of slices) {
    if (slice.from !== cursor || slice.to <= slice.from) invalid("slices");
    cursor = slice.to;
  }
  if (cursor !== end) invalid("slices");

  // Prices by asset, sorted.
  const prices = new Map<string, MiningPriceSegment[]>();
  for (const price of input.prices) {
    checkSegment(price.from, price.to, start, end, "price");
    if (price.priceE18 < 0n) invalid("price");
    pushTo(prices, price.assetId, price);
  }

  const nftSelf = new Map<string, PowerPiece[]>();
  const assetSelf = new Map<string, PowerPiece[]>();
  const nftCounts = new Map<string, CountPiece[]>();
  const nftDetail = new Map<
    string,
    Map<
      string,
      { communityId: string | null; countAtEnd: bigint; integral: bigint }
    >
  >();
  const assetDetail = new Map<
    string,
    Map<string, { balanceAtEnd: bigint; integral: bigint }>
  >();

  for (const holding of input.nftHoldings) {
    checkSegment(holding.from, holding.to, start, end, "nftHolding");
    if (holding.count < 0n) invalid("nftHolding");
    const community = holding.communityId ?? unboundCommunity;
    pushTo(nftCounts, holding.userId, {
      from: holding.from,
      to: holding.to,
      community,
      count: holding.count,
    });
    let integral = 0n;
    for (const part of slicesOver(slices, holding.from, holding.to)) {
      const coefficient =
        holding.communityId === null
          ? 0n
          : (part.slice.coefficients.get(holding.communityId) ??
            part.slice.defaultCoefficient);
      const power = holding.count * coefficient;
      if (power > 0n) {
        pushTo(nftSelf, holding.userId, {
          from: part.from,
          to: part.to,
          power,
        });
        integral += (part.to - part.from) * power;
      }
    }
    const byInstance =
      nftDetail.get(holding.userId) ??
      new Map<
        string,
        { communityId: string | null; countAtEnd: bigint; integral: bigint }
      >();
    nftDetail.set(holding.userId, byInstance);
    const row = byInstance.get(holding.instanceId) ?? {
      communityId: holding.communityId,
      countAtEnd: 0n,
      integral: 0n,
    };
    row.integral += integral;
    if (holding.to === end) row.countAtEnd = holding.count;
    byInstance.set(holding.instanceId, row);
  }

  for (const holding of input.assetHoldings) {
    checkSegment(holding.from, holding.to, start, end, "assetHolding");
    if (holding.balanceRaw < 0n) invalid("assetHolding");
    let integral = 0n;
    for (const part of slicesOver(slices, holding.from, holding.to)) {
      const weight = part.slice.assetWeights.get(holding.assetId) ?? 0n;
      if (weight === 0n || holding.balanceRaw === 0n) continue;
      if (part.slice.assetPowerBasis === "quantity") {
        // Decision 0123: token quantity × Mining Weight, no price.
        const power = (holding.balanceRaw * weight) / miningFixedScale;
        if (power > 0n) {
          pushTo(assetSelf, holding.userId, {
            from: part.from,
            to: part.to,
            power,
          });
          integral += (part.to - part.from) * power;
        }
        continue;
      }
      // Decision 0116 (valuation, replay of pre-0123 hours): every second of a weighted, positive holding must be priced.
      let covered = 0n;
      for (const price of prices.get(holding.assetId) ?? []) {
        const length = overlap(price.from, price.to, part.from, part.to);
        if (length === 0n) continue;
        covered += length;
        const usd = (holding.balanceRaw * price.priceE18) / miningFixedScale;
        const power = (usd * weight) / miningFixedScale;
        if (power > 0n) {
          const a = price.from > part.from ? price.from : part.from;
          pushTo(assetSelf, holding.userId, { from: a, to: a + length, power });
          integral += length * power;
        }
      }
      if (covered !== part.to - part.from) {
        throw new MiningSettlementInputError(
          miningSettlementReasonCodes.priceMissing,
          holding.assetId,
        );
      }
    }
    const byAsset =
      assetDetail.get(holding.userId) ??
      new Map<string, { balanceAtEnd: bigint; integral: bigint }>();
    assetDetail.set(holding.userId, byAsset);
    const row = byAsset.get(holding.assetId) ?? {
      balanceAtEnd: 0n,
      integral: 0n,
    };
    row.integral += integral;
    if (holding.to === end) row.balanceAtEnd = holding.balanceRaw;
    byAsset.set(holding.assetId, row);
  }

  // Five-level referral: only the invitee's self power, by edge window.
  interface LevelAccumulator {
    members: Set<string>;
    nft: bigint;
    asset: bigint;
    units: Map<string, bigint>;
  }
  const referral = new Map<string, LevelAccumulator[]>();
  const levelsOf = (userId: string): LevelAccumulator[] => {
    let levels = referral.get(userId);
    if (levels === undefined) {
      levels = Array.from({ length: miningReferralLevels }, () => ({
        members: new Set<string>(),
        nft: 0n,
        asset: 0n,
        units: new Map<string, bigint>(),
      }));
      referral.set(userId, levels);
    }
    return levels;
  };
  for (const edge of input.referralEdges) {
    if (
      !Number.isInteger(edge.depth) ||
      edge.depth < 1 ||
      edge.depth > miningReferralLevels
    ) {
      // Beyond the fifth level nothing is contributed (and the graph
      // never stores it); refuse silently-wrong input rather than skip.
      invalid("referralDepth");
    }
    if (edge.inviterUserId === edge.inviteeUserId) invalid("referralSelf");
    const from = edge.from > start ? edge.from : start;
    const edgeEnd = edge.to === null ? end : edge.to;
    const to = edgeEnd < end ? edgeEnd : end;
    if (to <= from) continue;
    const ratio = BigInt(input.referralRatiosBps[edge.depth - 1] as number);
    const nftIntegral = integrate(nftSelf.get(edge.inviteeUserId), from, to);
    const assetIntegral = integrate(
      assetSelf.get(edge.inviteeUserId),
      from,
      to,
    );
    if (nftIntegral === 0n && assetIntegral === 0n) continue;
    const level = levelsOf(edge.inviterUserId)[
      edge.depth - 1
    ] as LevelAccumulator;
    level.members.add(edge.inviteeUserId);
    level.nft += (nftIntegral * ratio) / miningBpsDenominator;
    level.asset += (assetIntegral * ratio) / miningBpsDenominator;
    if (nftIntegral > 0n) {
      for (const piece of nftCounts.get(edge.inviteeUserId) ?? []) {
        const length = overlap(piece.from, piece.to, from, to);
        if (length === 0n || piece.count === 0n) continue;
        const add =
          (piece.count * miningFixedScale * length * ratio) /
          miningBpsDenominator;
        level.units.set(
          piece.community,
          (level.units.get(piece.community) ?? 0n) + add,
        );
      }
    }
  }

  const userIds = new Set<string>([
    ...nftSelf.keys(),
    ...assetSelf.keys(),
    ...referral.keys(),
    ...nftDetail.keys(),
    ...assetDetail.keys(),
  ]);

  interface Totals {
    nftSelf: bigint;
    assetSelf: bigint;
    nftReferral: bigint;
    assetReferral: bigint;
  }
  const totals = new Map<string, Totals>();
  for (const userId of userIds) {
    const levels = referral.get(userId);
    totals.set(userId, {
      nftSelf: integrate(nftSelf.get(userId), start, end),
      assetSelf: integrate(assetSelf.get(userId), start, end),
      nftReferral: levels?.reduce((sum, level) => sum + level.nft, 0n) ?? 0n,
      assetReferral:
        levels?.reduce((sum, level) => sum + level.asset, 0n) ?? 0n,
    });
  }

  const sorted = [...userIds].sort();
  const nftAllocation = allocatePoolBudget({
    budgetRaw: input.budgetNftRaw.toString(),
    weights: sorted.map((userId) => {
      const total = totals.get(userId) as Totals;
      return {
        walletId: userId,
        weightRaw: (total.nftSelf + total.nftReferral).toString(),
      };
    }),
  });
  const assetAllocation = allocatePoolBudget({
    budgetRaw: input.budgetAssetRaw.toString(),
    weights: sorted.map((userId) => {
      const total = totals.get(userId) as Totals;
      return {
        walletId: userId,
        weightRaw: (total.assetSelf + total.assetReferral).toString(),
      };
    }),
  });
  const nftRewards = new Map(
    nftAllocation.allocations.map((row) => [
      row.walletId,
      BigInt(row.amountRaw),
    ]),
  );
  const assetRewards = new Map(
    assetAllocation.allocations.map((row) => [
      row.walletId,
      BigInt(row.amountRaw),
    ]),
  );

  let nftDenominator = 0n;
  let assetDenominator = 0n;
  const users: MiningUserSettlement[] = sorted.map((userId) => {
    const total = totals.get(userId) as Totals;
    const nftSelfPower = total.nftSelf / duration;
    const assetSelfPower = total.assetSelf / duration;
    const nftReferralPower = total.nftReferral / duration;
    const assetReferralPower = total.assetReferral / duration;
    nftDenominator += (total.nftSelf + total.nftReferral) / duration;
    assetDenominator += (total.assetSelf + total.assetReferral) / duration;
    const nftReward = nftRewards.get(userId) ?? 0n;
    const assetReward = assetRewards.get(userId) ?? 0n;
    const levels = referral.get(userId);
    return Object.freeze({
      userId,
      nftSelfPower,
      assetSelfPower,
      nftReferralPower,
      assetReferralPower,
      nftTotalPower: (total.nftSelf + total.nftReferral) / duration,
      assetTotalPower: (total.assetSelf + total.assetReferral) / duration,
      levels: Object.freeze(
        Array.from({ length: miningReferralLevels }, (_unused, index) => {
          const level = levels?.[index];
          return Object.freeze({
            level: index + 1,
            ratioBps: input.referralRatiosBps[index] as number,
            effectiveMembers: level?.members.size ?? 0,
            nftPower: (level?.nft ?? 0n) / duration,
            assetPower: (level?.asset ?? 0n) / duration,
            nftUnitsByCommunity: new Map(
              [...(level?.units ?? new Map<string, bigint>()).entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([community, units]) => [community, units / duration]),
            ),
          });
        }),
      ),
      nftHoldings: Object.freeze(
        [...(nftDetail.get(userId)?.entries() ?? [])]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([instanceId, row]) =>
            Object.freeze({
              instanceId,
              communityId: row.communityId,
              countAtEnd: row.countAtEnd,
              power: row.integral / duration,
            }),
          ),
      ),
      assetHoldings: Object.freeze(
        [...(assetDetail.get(userId)?.entries() ?? [])]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([assetId, row]) =>
            Object.freeze({
              assetId,
              balanceAtEndRaw: row.balanceAtEnd,
              power: row.integral / duration,
            }),
          ),
      ),
      nftRewardRaw: nftReward,
      assetRewardRaw: assetReward,
      totalRewardRaw: nftReward + assetReward,
    });
  });

  return Object.freeze({
    users: Object.freeze(users),
    nft: Object.freeze({
      budgetRaw: input.budgetNftRaw,
      denominatorPower: nftDenominator,
      allocatedRaw: BigInt(nftAllocation.committedRaw),
      unallocatedRaw: BigInt(nftAllocation.unallocatedRaw),
    }),
    asset: Object.freeze({
      budgetRaw: input.budgetAssetRaw,
      denominatorPower: assetDenominator,
      allocatedRaw: BigInt(assetAllocation.committedRaw),
      unallocatedRaw: BigInt(assetAllocation.unallocatedRaw),
    }),
  });
}
