import { createHash } from "node:crypto";

import { canonicalJson } from "../../core/json/canonical-json.js";
import { isWithinMiningRelease, miningHourBudget } from "./hourly-budget.js";
import {
  MiningSettlementInputError,
  settleMiningHour,
  type MiningAssetHoldingSegment,
  type MiningHourlySettlementInput,
  type MiningHourlySettlementResult,
  type MiningNftHoldingSegment,
  type MiningParameterSlice,
  type MiningPriceSegment,
} from "./hourly-settlement-calculator.js";
import {
  formatMiningDecimal,
  miningHourSeconds,
  miningSettlementReasonCodes,
  parseMiningDecimal,
} from "./hourly-settlement-contract.js";
import type {
  CommitMiningEpochInput,
  MiningEpochRecord,
  MiningParameterVersionRecord,
  MiningSettlementFacts,
  MiningSettlementRepository,
} from "./hourly-settlement-ports.js";

/**
 * Decision 0116: turns the stored facts of one hour into the calculator's
 * input (time-sliced, attributed to users), computes, and commits the epoch
 * in one transaction. Re-running a settled hour is a no-op; a hour whose
 * inputs cannot be read completely is not settled (it waits or fails with
 * the reason) — nothing is estimated.
 */

export type MiningSettleOutcome =
  | { readonly kind: "settled"; readonly epoch: MiningEpochRecord }
  | { readonly kind: "already_settled"; readonly epoch: MiningEpochRecord }
  | { readonly kind: "skipped"; readonly reasonCode: string }
  | {
      readonly kind: "failed";
      readonly reasonCode: string;
      readonly epoch: MiningEpochRecord | null;
    };

export interface MiningReplayResult {
  readonly epochId: string;
  readonly storedDigest: string | null;
  readonly replayDigest: string | null;
  readonly digestMatches: boolean;
  readonly rewardsMatch: boolean;
  readonly mismatchedUserCount: number;
  readonly reasonCode: string | null;
}

export interface PreparedMiningHour {
  readonly input: MiningHourlySettlementInput;
  readonly digest: string;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly version: MiningParameterVersionRecord;
}

function seconds(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function iso(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

/** The approved version in force at `at` (greatest effectiveFrom ≤ at). */
export function miningVersionAt(
  versions: readonly MiningParameterVersionRecord[],
  at: bigint,
): MiningParameterVersionRecord | null {
  let found: MiningParameterVersionRecord | null = null;
  for (const version of versions) {
    if (version.status !== "approved") continue;
    const from = seconds(version.effectiveFrom);
    if (from <= at && (found === null || from >= seconds(found.effectiveFrom)))
      found = version;
  }
  return found;
}

function sliceOf(
  version: MiningParameterVersionRecord,
  from: bigint,
  to: bigint,
): MiningParameterSlice {
  return Object.freeze({
    from,
    to,
    versionId: version.versionId,
    coefficients: new Map(
      version.document.communityCoefficients.map((entry) => [
        entry.communityId,
        parseMiningDecimal(entry.coefficient) ?? 0n,
      ]),
    ),
    assetWeights: new Map(
      version.document.assetWeights.map((entry) => [
        entry.assetId,
        parseMiningDecimal(entry.weight) ?? 0n,
      ]),
    ),
  });
}

/** Version slices tiling [start, end). */
export function miningParameterSlices(
  versions: readonly MiningParameterVersionRecord[],
  start: bigint,
  end: bigint,
): readonly MiningParameterSlice[] {
  const first = miningVersionAt(versions, start);
  if (first === null) return [];
  const changes = versions
    .filter((version) => version.status === "approved")
    .map((version) => ({ version, at: seconds(version.effectiveFrom) }))
    .filter(({ at }) => at > start && at < end)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const slices: MiningParameterSlice[] = [];
  let current = first;
  let cursor = start;
  for (const change of changes) {
    if (change.at > cursor) {
      slices.push(sliceOf(current, cursor, change.at));
      cursor = change.at;
    }
    current = change.version;
  }
  slices.push(sliceOf(current, cursor, end));
  return slices;
}

interface Timeline<T> {
  readonly key: T;
  readonly opening: bigint;
  readonly moves: Array<{ at: bigint; delta: bigint }>;
}

/** Piecewise-constant segments of [start, cutoff) from an opening + deltas. */
function segmentsOf(
  opening: bigint,
  moves: readonly { at: bigint; delta: bigint }[],
  start: bigint,
  cutoff: bigint,
): Array<{ from: bigint; to: bigint; value: bigint }> {
  const out: Array<{ from: bigint; to: bigint; value: bigint }> = [];
  let value = opening;
  let cursor = start;
  for (const move of moves) {
    if (move.at >= cutoff) break;
    const at = move.at < start ? start : move.at;
    if (at > cursor) {
      out.push({ from: cursor, to: at, value });
      cursor = at;
    }
    value += move.delta;
    if (value < 0n) {
      throw new MiningSettlementInputError(
        miningSettlementReasonCodes.inputInvalid,
        "negative balance",
      );
    }
  }
  if (cutoff > cursor) out.push({ from: cursor, to: cutoff, value });
  return out.filter((segment) => segment.value > 0n);
}

function stringifyBigints(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), stringifyBigints(entry)])
      .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
  }
  if (Array.isArray(value)) return value.map(stringifyBigints);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        stringifyBigints(entry),
      ]),
    );
  }
  return value;
}

export function miningInputDigest(input: MiningHourlySettlementInput): string {
  return createHash("sha256")
    .update(canonicalJson(stringifyBigints(input)))
    .digest("hex");
}

/**
 * Pure: facts + versions → calculator input, digest, and summary. Throws
 * `MiningSettlementInputError` when a fact cannot be used.
 */
export function prepareMiningHour(input: {
  readonly hourStart: bigint;
  readonly versions: readonly MiningParameterVersionRecord[];
  readonly facts: MiningSettlementFacts;
}): PreparedMiningHour {
  const start = input.hourStart;
  const end = start + miningHourSeconds;
  const version = miningVersionAt(input.versions, start);
  if (version === null) {
    throw new MiningSettlementInputError(
      miningSettlementReasonCodes.parametersPending,
      "no version",
    );
  }
  if (input.facts.unknownAssetIds.length > 0) {
    throw new MiningSettlementInputError(
      miningSettlementReasonCodes.assetSourceUnknown,
      input.facts.unknownAssetIds.join(","),
    );
  }
  const slices = miningParameterSlices(input.versions, start, end);
  const releaseStart = seconds(version.document.releaseStartAt);

  // Attribution.
  const ownerOf = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const owner of input.facts.walletOwners) {
    if (owner.userIds.length === 1) {
      ownerOf.set(owner.address, owner.userIds[0] as string);
    } else if (owner.userIds.length > 1) {
      ambiguous.push(owner.address);
    }
  }
  let unattributed = 0;

  // NFT holdings.
  const communityOf = new Map<string, string | null>();
  const unboundInstances: string[] = [];
  for (const instance of input.facts.nftInstances) {
    const community =
      instance.communityIds.length === 1
        ? (instance.communityIds[0] as string)
        : null;
    if (community === null) unboundInstances.push(instance.instanceId);
    communityOf.set(instance.instanceId, community);
  }
  const nftTimelines = new Map<string, Timeline<[string, string]>>();
  const timeline = (instanceId: string, address: string) => {
    const key = `${instanceId}|${address}`;
    let row = nftTimelines.get(key);
    if (row === undefined) {
      row = { key: [instanceId, address], opening: 0n, moves: [] };
      nftTimelines.set(key, row);
    }
    return row;
  };
  for (const opening of input.facts.nftOpenings) {
    const row = timeline(opening.instanceId, opening.address);
    nftTimelines.set(`${opening.instanceId}|${opening.address}`, {
      ...row,
      opening: row.opening + opening.count,
    });
  }
  const moves = [...input.facts.nftMoves].sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber < b.blockNumber
        ? -1
        : 1
      : a.logIndex - b.logIndex,
  );
  for (const move of moves) {
    if (move.from !== null) {
      timeline(move.instanceId, move.from).moves.push({
        at: move.at,
        delta: -1n,
      });
    }
    if (move.to !== null) {
      timeline(move.instanceId, move.to).moves.push({
        at: move.at,
        delta: 1n,
      });
    }
  }
  const nftHoldings: MiningNftHoldingSegment[] = [];
  for (const row of [...nftTimelines.values()].sort((a, b) =>
    a.key.join("|") < b.key.join("|") ? -1 : 1,
  )) {
    const [instanceId, address] = row.key;
    const segments = segmentsOf(row.opening, row.moves, start, end);
    if (segments.length === 0) continue;
    const userId = ownerOf.get(address);
    if (userId === undefined) {
      unattributed += 1;
      continue;
    }
    for (const segment of segments) {
      nftHoldings.push({
        userId,
        instanceId,
        communityId: communityOf.get(instanceId) ?? null,
        from: segment.from,
        to: segment.to,
        count: segment.value,
      });
    }
  }

  // Asset holdings and prices (curve net / curve price, until graduation).
  const assetHoldings: MiningAssetHoldingSegment[] = [];
  const prices: MiningPriceSegment[] = [];
  const excludedAssets: Array<{
    assetId: string;
    reasonCode: string;
    from: string;
  }> = [];
  for (const asset of [...input.facts.assets].sort((a, b) =>
    a.assetId < b.assetId ? -1 : 1,
  )) {
    let cutoff = end;
    if (asset.graduatedAt !== null && asset.graduatedAt < end) {
      cutoff = asset.graduatedAt > start ? asset.graduatedAt : start;
      excludedAssets.push({
        assetId: asset.assetId,
        reasonCode: miningSettlementReasonCodes.assetGraduatedUnreadable,
        from: iso(cutoff),
      });
    }
    if (cutoff <= start) continue;
    let price = asset.openingPriceE18;
    let cursor = start;
    for (const move of asset.moves) {
      if (move.at >= cutoff) break;
      const at = move.at < start ? start : move.at;
      if (at > cursor) {
        prices.push({
          assetId: asset.assetId,
          from: cursor,
          to: at,
          priceE18: price,
        });
        cursor = at;
      }
      price = move.priceAfterE18;
    }
    prices.push({
      assetId: asset.assetId,
      from: cursor,
      to: cutoff,
      priceE18: price,
    });
    const byAddress = new Map<string, Timeline<string>>();
    for (const opening of asset.openingBalances) {
      byAddress.set(opening.address, {
        key: opening.address,
        opening: opening.balanceRaw,
        moves: [],
      });
    }
    for (const move of asset.moves) {
      const row = byAddress.get(move.address) ?? {
        key: move.address,
        opening: 0n,
        moves: [],
      };
      row.moves.push({ at: move.at, delta: move.deltaRaw });
      byAddress.set(move.address, row);
    }
    for (const row of [...byAddress.values()].sort((a, b) =>
      a.key < b.key ? -1 : 1,
    )) {
      const segments = segmentsOf(row.opening, row.moves, start, cutoff);
      if (segments.length === 0) continue;
      const userId = ownerOf.get(row.key);
      if (userId === undefined) {
        unattributed += 1;
        continue;
      }
      for (const segment of segments) {
        assetHoldings.push({
          userId,
          assetId: asset.assetId,
          from: segment.from,
          to: segment.to,
          balanceRaw: segment.value,
        });
      }
    }
  }

  const calculatorInput: MiningHourlySettlementInput = Object.freeze({
    hourStart: start,
    hourEnd: end,
    budgetNftRaw: miningHourBudget({
      hourStart: start,
      dailyBudgetRaw: BigInt(version.document.dailyBudgetNftRaw),
      releaseStart,
      releaseDays: version.document.releaseDays,
    }),
    budgetAssetRaw: miningHourBudget({
      hourStart: start,
      dailyBudgetRaw: BigInt(version.document.dailyBudgetAssetRaw),
      releaseStart,
      releaseDays: version.document.releaseDays,
    }),
    referralRatiosBps: version.document.referralRatiosBps,
    parameterSlices: slices,
    nftHoldings,
    assetHoldings,
    prices,
    referralEdges: input.facts.referralEdges
      .map((edge) => ({ ...edge }))
      .sort((a, b) =>
        `${a.inviterUserId}|${a.inviteeUserId}|${String(a.depth)}|${String(a.from)}` <
        `${b.inviterUserId}|${b.inviteeUserId}|${String(b.depth)}|${String(b.from)}`
          ? -1
          : 1,
      ),
  });
  const digest = miningInputDigest(calculatorInput);
  return Object.freeze({
    input: calculatorInput,
    digest,
    version,
    summary: Object.freeze({
      versionIds: [...new Set(slices.map((slice) => slice.versionId))],
      nftHoldingSegments: nftHoldings.length,
      assetHoldingSegments: assetHoldings.length,
      priceSegments: prices.length,
      referralEdges: calculatorInput.referralEdges.length,
      unboundInstances: unboundInstances.sort(),
      ambiguousAddressCount: ambiguous.length,
      unattributedHoldingCount: unattributed,
      excludedAssets,
    }),
  });
}

function rewardsOf(
  result: MiningHourlySettlementResult,
): CommitMiningEpochInput["rewards"] {
  return result.users.map((user) =>
    Object.freeze({
      userId: user.userId,
      nftSelfPower: formatMiningDecimal(user.nftSelfPower),
      assetSelfPower: formatMiningDecimal(user.assetSelfPower),
      nftReferralPower: formatMiningDecimal(user.nftReferralPower),
      assetReferralPower: formatMiningDecimal(user.assetReferralPower),
      nftTotalPower: formatMiningDecimal(user.nftTotalPower),
      assetTotalPower: formatMiningDecimal(user.assetTotalPower),
      levels: user.levels.map((level) => ({
        level: level.level,
        ratioBps: level.ratioBps,
        effectiveMembers: level.effectiveMembers,
        nftPower: formatMiningDecimal(level.nftPower),
        assetPower: formatMiningDecimal(level.assetPower),
        nftUnitsByCommunity: [...level.nftUnitsByCommunity.entries()].map(
          ([community, units]) => ({
            communityId: community === "unbound" ? null : community,
            units: formatMiningDecimal(units),
          }),
        ),
      })),
      nftHoldings: user.nftHoldings.map((holding) => ({
        instanceId: holding.instanceId,
        communityId: holding.communityId,
        countAtEnd: holding.countAtEnd.toString(),
        power: formatMiningDecimal(holding.power),
      })),
      assetHoldings: user.assetHoldings.map((holding) => ({
        assetId: holding.assetId,
        balanceAtEndRaw: holding.balanceAtEndRaw.toString(),
        power: formatMiningDecimal(holding.power),
      })),
      nftRewardRaw: user.nftRewardRaw.toString(),
      assetRewardRaw: user.assetRewardRaw.toString(),
      totalRewardRaw: user.totalRewardRaw.toString(),
    }),
  );
}

/** Asset ids with a positive weight anywhere in [start, end). */
export function admittedAssetIds(
  versions: readonly MiningParameterVersionRecord[],
  start: bigint,
  end: bigint,
): readonly string[] {
  const assetIds = new Set<string>();
  for (const slice of miningParameterSlices(versions, start, end)) {
    for (const [assetId, weight] of slice.assetWeights) {
      if (weight > 0n) assetIds.add(assetId);
    }
  }
  return [...assetIds].sort();
}

export interface MiningSettlementRunner {
  /** Whether the hour may be settled now (complete, sources fresh). */
  settleHour(input: {
    readonly hourStart: bigint;
    readonly trigger: "scheduled" | "test_trigger";
  }): Promise<MiningSettleOutcome>;
  replay(epochId: string): Promise<MiningReplayResult | null>;
  /** Unsettled hours in [now − catchupHours, now − 1h], oldest first. */
  candidateHours(catchupHours: number): Promise<readonly bigint[]>;
}

export function createMiningSettlementRunner(dependencies: {
  readonly repository: MiningSettlementRepository;
  readonly chainId: string;
  readonly indexerGraceSeconds: number;
  readonly now?: () => Date;
}): MiningSettlementRunner {
  const { repository } = dependencies;
  const now = dependencies.now ?? ((): Date => new Date());

  async function readFacts(
    hourStart: bigint,
    versions: readonly MiningParameterVersionRecord[],
  ): Promise<MiningSettlementFacts> {
    const end = hourStart + miningHourSeconds;
    return repository.readSettlementFacts({
      chainId: dependencies.chainId,
      hourStart,
      hourEnd: end,
      assetIds: admittedAssetIds(versions, hourStart, end),
    });
  }

  return Object.freeze<MiningSettlementRunner>({
    async settleHour({ hourStart, trigger }) {
      if (hourStart % miningHourSeconds !== 0n) {
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.inputInvalid,
        };
      }
      const hourEnd = hourStart + miningHourSeconds;
      const existing = await repository.getEpochByHour(iso(hourStart));
      if (existing?.status === "settled") {
        return { kind: "already_settled", epoch: existing };
      }
      const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
      const readyAt = hourEnd + BigInt(dependencies.indexerGraceSeconds);
      if (nowSeconds < readyAt) {
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.hourNotComplete,
        };
      }
      const versions = await repository.listApprovedParameterVersions();
      const version = miningVersionAt(versions, hourStart);
      if (version === null) {
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.parametersPending,
        };
      }
      if (
        !isWithinMiningRelease({
          hourStart,
          releaseStart: seconds(version.document.releaseStartAt),
          releaseDays: version.document.releaseDays,
        })
      ) {
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.outsideRelease,
        };
      }
      const freshness = await repository.readIndexerFreshness({
        chainId: dependencies.chainId,
        assetIds: admittedAssetIds(
          versions,
          hourStart,
          hourStart + miningHourSeconds,
        ),
      });
      for (const lane of freshness.lanes) {
        if (!lane.hasSources) continue;
        if (lane.updatedAt === null || seconds(lane.updatedAt) < readyAt) {
          return {
            kind: "skipped",
            reasonCode: miningSettlementReasonCodes.indexerBehind,
          };
        }
      }
      let prepared: PreparedMiningHour;
      let result: MiningHourlySettlementResult;
      try {
        const facts = await readFacts(hourStart, versions);
        prepared = prepareMiningHour({ hourStart, versions, facts });
        result = settleMiningHour(prepared.input);
      } catch (error) {
        if (!(error instanceof MiningSettlementInputError)) throw error;
        const epoch = await repository.recordEpochFailure({
          hourStart: iso(hourStart),
          hourEnd: iso(hourEnd),
          versionId: version.versionId,
          trigger,
          reasonCode: error.reasonCode,
          inputSummary: { detail: error.detail.slice(0, 500) },
        });
        return { kind: "failed", reasonCode: error.reasonCode, epoch };
      }
      const committed = await repository.commitEpoch({
        hourStart: iso(hourStart),
        hourEnd: iso(hourEnd),
        versionId: prepared.version.versionId,
        trigger,
        budgetNftRaw: result.nft.budgetRaw.toString(),
        budgetAssetRaw: result.asset.budgetRaw.toString(),
        denominatorNftPower: formatMiningDecimal(result.nft.denominatorPower),
        denominatorAssetPower: formatMiningDecimal(
          result.asset.denominatorPower,
        ),
        allocatedNftRaw: result.nft.allocatedRaw.toString(),
        allocatedAssetRaw: result.asset.allocatedRaw.toString(),
        unallocatedNftRaw: result.nft.unallocatedRaw.toString(),
        unallocatedAssetRaw: result.asset.unallocatedRaw.toString(),
        inputDigest: prepared.digest,
        inputSummary: prepared.summary,
        rewards: rewardsOf(result),
      });
      return committed.created
        ? { kind: "settled", epoch: committed.epoch }
        : { kind: "already_settled", epoch: committed.epoch };
    },

    async replay(epochId) {
      const epoch = await repository.getEpoch(epochId);
      if (epoch === null) return null;
      const hourStart = seconds(epoch.hourStart);
      const versions = await repository.listApprovedParameterVersions();
      try {
        const facts = await readFacts(hourStart, versions);
        const prepared = prepareMiningHour({ hourStart, versions, facts });
        const result = settleMiningHour(prepared.input);
        const stored = await repository.listEpochRewards({ epochId });
        const storedBy = new Map(stored.map((row) => [row.userId, row]));
        let mismatched = 0;
        const replayed = rewardsOf(result);
        for (const row of replayed) {
          const before = storedBy.get(row.userId);
          if (
            before === undefined ||
            before.nftRewardRaw !== row.nftRewardRaw ||
            before.assetRewardRaw !== row.assetRewardRaw
          ) {
            mismatched += 1;
          }
          storedBy.delete(row.userId);
        }
        mismatched += storedBy.size;
        return Object.freeze({
          epochId,
          storedDigest: epoch.inputDigest,
          replayDigest: prepared.digest,
          digestMatches: epoch.inputDigest === prepared.digest,
          rewardsMatch: mismatched === 0,
          mismatchedUserCount: mismatched,
          reasonCode: null,
        });
      } catch (error) {
        if (!(error instanceof MiningSettlementInputError)) throw error;
        return Object.freeze({
          epochId,
          storedDigest: epoch.inputDigest,
          replayDigest: null,
          digestMatches: false,
          rewardsMatch: false,
          mismatchedUserCount: 0,
          reasonCode: error.reasonCode,
        });
      }
    },

    async candidateHours(catchupHours) {
      const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
      const current = nowSeconds - (nowSeconds % miningHourSeconds);
      const out: bigint[] = [];
      for (let back = BigInt(catchupHours); back >= 1n; back -= 1n) {
        out.push(current - back * miningHourSeconds);
      }
      const settled = await Promise.all(
        out.map((hour) => repository.getEpochByHour(iso(hour))),
      );
      return out.filter((_hour, index) => settled[index]?.status !== "settled");
    },
  });
}
