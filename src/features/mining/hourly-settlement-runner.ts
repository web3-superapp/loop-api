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
  miningSettlementNextAttemptAt,
  miningSettlementReasonCodes,
  parseMiningDecimal,
} from "./hourly-settlement-contract.js";
import {
  miningEffectiveAssetWeights,
  miningEffectiveCommunityCoefficients,
  miningIgnoredNonRosterAssetIds,
  miningPoolExternalFor,
  type MiningPoolExternalAssets,
  type MiningSettlementAssetRule,
} from "./mining-pool-roster.js";
import type {
  CommitMiningEpochInput,
  MiningEpochRecord,
  MiningErc20OpeningPin,
  MiningMembershipFact,
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

/**
 * Decision 0187: the slice carries the **effective** weights — the explicit
 * table, the pool roster's platform MEMEs at weight 1 unless listed, and the
 * excluded assets / communities at 0 (`mining-pool-roster.ts`). With no
 * roster asset and no exclusion the maps equal the pre-0187 ones, so those
 * hours digest as before. Decision 0191: under the `roster` rule an
 * explicit weight of a non-roster asset is dropped.
 */
function sliceOf(
  version: MiningParameterVersionRecord,
  from: bigint,
  to: bigint,
  poolAssetIds: readonly string[],
  external: MiningPoolExternalAssets | null,
  rule: MiningSettlementAssetRule,
): MiningParameterSlice {
  return Object.freeze({
    from,
    to,
    versionId: version.versionId,
    coefficients: miningEffectiveCommunityCoefficients(version.document),
    defaultCoefficient:
      parseMiningDecimal(version.document.defaultCommunityCoefficient) ?? 0n,
    assetWeights: miningEffectiveAssetWeights(
      version.document,
      poolAssetIds,
      external,
      rule,
    ),
    assetPowerBasis: version.document.assetPowerBasis,
  });
}

/**
 * Version slices tiling [start, end). `poolAssetIds` (Decision 0187) are the
 * roster's platform MEMEs on the settled chain; `external` (Decision 0189)
 * the external roster assets, out unless let in (and readable). `rule`
 * (Decision 0191): `roster` for every hour settled from 0191 on; `document`
 * replays an earlier hour.
 */
export function miningParameterSlices(
  versions: readonly MiningParameterVersionRecord[],
  start: bigint,
  end: bigint,
  poolAssetIds: readonly string[] = [],
  external: MiningPoolExternalAssets | null = null,
  rule: MiningSettlementAssetRule = "document",
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
      slices.push(
        sliceOf(current, cursor, change.at, poolAssetIds, external, rule),
      );
      cursor = change.at;
    }
    current = change.version;
  }
  slices.push(sliceOf(current, cursor, end, poolAssetIds, external, rule));
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

interface Interval {
  readonly from: bigint;
  readonly to: bigint;
}

/**
 * Decision 0183: merged membership intervals of every (user, community)
 * clipped to [start, end). Keyed `user|community`.
 */
function membershipIntervals(
  memberships: readonly MiningMembershipFact[],
  start: bigint,
  end: bigint,
): Map<string, Interval[]> {
  const raw = new Map<string, Interval[]>();
  for (const membership of memberships) {
    const from = membership.from > start ? membership.from : start;
    const to =
      membership.to === null || membership.to > end ? end : membership.to;
    if (to <= from) continue;
    const key = `${membership.userId}|${membership.communityId}`;
    const list = raw.get(key) ?? [];
    list.push({ from, to });
    raw.set(key, list);
  }
  for (const [key, list] of raw) raw.set(key, mergeIntervals(list));
  return raw;
}

function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.from <= last.to) {
      out[out.length - 1] = {
        from: last.from,
        to: interval.to > last.to ? interval.to : last.to,
      };
    } else {
      out.push(interval);
    }
  }
  return out;
}

/** The parts of [from, to) covered by the merged intervals. */
function intersectIntervals(
  from: bigint,
  to: bigint,
  intervals: readonly Interval[],
): Interval[] {
  const out: Interval[] = [];
  for (const interval of intervals) {
    const a = interval.from > from ? interval.from : from;
    const b = interval.to < to ? interval.to : to;
    if (b > a) out.push({ from: a, to: b });
  }
  return out;
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

/**
 * SHA-256 of the canonical calculator input. Decision 0123 added
 * `assetPowerBasis` and `defaultCoefficient` to the slices; a slice carrying
 * the Decision 0116 values (`valuation`, 0) is digested without them, so an
 * hour settled before 0123 replays to its stored digest.
 */
export function miningInputDigest(input: MiningHourlySettlementInput): string {
  const slices = input.parameterSlices.map((slice) => {
    const { assetPowerBasis, defaultCoefficient, ...rest } = slice;
    return {
      ...rest,
      ...(assetPowerBasis === "valuation" ? {} : { assetPowerBasis }),
      ...(defaultCoefficient === 0n ? {} : { defaultCoefficient }),
    };
  });
  return createHash("sha256")
    .update(
      canonicalJson(stringifyBigints({ ...input, parameterSlices: slices })),
    )
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
  /**
   * Decision 0187: the pool roster's asset ids on the settled chain. Absent
   * only when replaying an hour settled before 0187 (its summary has no
   * `poolRosterAssetIds`).
   */
  readonly poolAssetIds?: readonly string[];
  /**
   * Decision 0189: the external roster assets (gated by `includedAssets`)
   * and the ones the settlement can read. Absent when there are none, and
   * when replaying an hour settled before 0189 (its summary has no
   * `poolExternalAssetIds`).
   */
  readonly poolExternal?: MiningPoolExternalAssets;
  /**
   * Decision 0187: the snapshot lane prepares a 1-second window at "now"
   * through the same rules (no budget is computed for a window that is not
   * a whole UTC hour). Default: one hour.
   */
  readonly windowSeconds?: bigint;
  /**
   * Decision 0191: `roster` (every hour settled from 0191 on, and the
   * snapshot) admits roster assets only and records
   * `ignoredNonRosterAssetIds`; `document` (default: replay of an earlier
   * hour, whose summary has no such key) keeps every explicit weight.
   */
  readonly assetRule?: MiningSettlementAssetRule;
}): PreparedMiningHour {
  const start = input.hourStart;
  const windowSeconds = input.windowSeconds ?? miningHourSeconds;
  const end = start + windowSeconds;
  const wholeHour =
    windowSeconds === miningHourSeconds && start % miningHourSeconds === 0n;
  const poolAssetIds = [...new Set(input.poolAssetIds ?? [])].sort();
  const external = normalizedExternal(input.poolExternal);
  const assetRule = input.assetRule ?? "document";
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
  const slices = miningParameterSlices(
    input.versions,
    start,
    end,
    poolAssetIds,
    external,
    assetRule,
  );
  const releaseStart = seconds(version.document.releaseStartAt);
  // Decision 0191: the assetWeights ids of the hour's versions that are no
  // roster asset; under the roster rule their facts are never used, even
  // when a reader returns them.
  const ignoredNonRoster =
    assetRule === "roster"
      ? [
          ...new Set(
            input.versions
              .filter((candidate) =>
                slices.some((slice) => slice.versionId === candidate.versionId),
              )
              .flatMap((candidate) =>
                miningIgnoredNonRosterAssetIds(
                  candidate.document,
                  poolAssetIds,
                  external,
                ),
              ),
          ),
        ].sort()
      : [];
  const ignoredNonRosterSet = new Set(ignoredNonRoster);

  // Attribution.
  const ownerOf = new Map<string, string>();
  const ambiguous: string[] = [];
  const ownersOf = new Map<string, readonly string[]>(
    input.facts.walletOwners.map((owner) => [owner.address, owner.userIds]),
  );
  for (const owner of input.facts.walletOwners) {
    if (owner.userIds.length === 1) {
      ownerOf.set(owner.address, owner.userIds[0] as string);
    } else if (owner.userIds.length > 1) {
      ambiguous.push(owner.address);
    }
  }
  let unattributed = 0;

  // Decision 0183 membership gate (absent on pre-S300 fixtures: no gate).
  const gate = input.facts.membershipGate ?? null;
  const memberIntervals =
    gate === null
      ? new Map<string, Interval[]>()
      : membershipIntervals(gate.memberships, start, end);
  const assetCommunities = new Map<string, readonly string[]>(
    gate === null
      ? []
      : gate.assetCommunities.map((row) => [row.assetId, row.communityIds]),
  );
  let gatedSegments = 0;
  /** Membership intervals of `userId` in any of `communityIds`. */
  const memberOf = (
    userId: string,
    communityIds: readonly string[],
  ): Interval[] =>
    mergeIntervals(
      communityIds.flatMap(
        (communityId) => memberIntervals.get(`${userId}|${communityId}`) ?? [],
      ),
    );
  /**
   * The parts of a holding segment that count: all of it without a gate or
   * without a verified community; otherwise only while the holder is a
   * member of one of `communityIds`.
   */
  const gated = (
    userId: string,
    communityIds: readonly string[],
    segment: { from: bigint; to: bigint },
  ): Interval[] => {
    if (gate === null || communityIds.length === 0) {
      return [{ from: segment.from, to: segment.to }];
    }
    const parts = intersectIntervals(
      segment.from,
      segment.to,
      memberOf(userId, communityIds),
    );
    const covered = parts.reduce(
      (sum, part) => sum + (part.to - part.from),
      0n,
    );
    if (covered < segment.to - segment.from) gatedSegments += 1;
    return parts;
  };

  // NFT holdings.
  const communityOf = new Map<string, string | null>();
  const unboundInstances: string[] = [];
  for (const instance of input.facts.nftInstances) {
    // Decision 0182: one live community per token, so more than one id here
    // is defensive only (the instance then counts as unbound).
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
    const communityId = communityOf.get(instanceId) ?? null;
    for (const segment of segments) {
      // Decision 0183: an NFT of a verified community counts only while its
      // holder is a member of that community.
      for (const part of gated(
        userId,
        communityId === null ? [] : [communityId],
        segment,
      )) {
        nftHoldings.push({
          userId,
          instanceId,
          communityId,
          from: part.from,
          to: part.to,
          count: segment.value,
        });
      }
    }
  }

  // Asset holdings (curve net, until graduation). Prices only when a
  // Decision 0116 `valuation` slice is in force inside the hour (replay).
  const valued = slices.some((slice) => slice.assetPowerBasis === "valuation");
  const assetHoldings: MiningAssetHoldingSegment[] = [];
  const prices: MiningPriceSegment[] = [];
  const excludedAssets: Array<{
    assetId: string;
    reasonCode: string;
    from: string;
  }> = [];
  // Decision 0189: external assets left out of the hour (lane stale, no
  // holdings source) — recorded, never estimated.
  for (const excluded of input.facts.externalExcludedAssets ?? []) {
    excludedAssets.push({
      assetId: excluded.assetId,
      reasonCode: excluded.reasonCode,
      from: iso(start),
    });
  }
  const erc20Pins: Array<{
    assetId: string;
    walletId: string;
    blockNumber: string;
  }> = [];
  const erc20Unknown = new Map<string, Set<string>>();
  let erc20Read = false;
  for (const asset of [...input.facts.assets]
    .filter((row) => !ignoredNonRosterSet.has(row.assetId))
    .sort((a, b) => (a.assetId < b.assetId ? -1 : 1))) {
    let cutoff = end;
    // Decision 0125: after graduation a quantity hour reads the indexed
    // ERC-20 balances; a valuation hour (replay) still has no price there.
    const post =
      asset.graduatedAt !== null &&
      asset.graduatedAt < end &&
      !valued &&
      asset.postGraduation !== undefined &&
      asset.postGraduation !== null
        ? asset.postGraduation
        : null;
    if (asset.graduatedAt !== null && asset.graduatedAt < end) {
      cutoff = asset.graduatedAt > start ? asset.graduatedAt : start;
      if (post === null) {
        excludedAssets.push({
          assetId: asset.assetId,
          // Decision 0126: a quantity hour only lacks the balance coverage.
          reasonCode: valued
            ? miningSettlementReasonCodes.assetGraduatedUnreadable
            : miningSettlementReasonCodes.assetGraduatedBalancePending,
          from: iso(cutoff),
        });
      }
    }
    if (post !== null) {
      const from = post.from > start ? post.from : start;
      const balances = new Map<string, Timeline<string>>();
      for (const opening of post.openingBalances) {
        balances.set(opening.address, {
          key: opening.address,
          opening: opening.balanceRaw,
          moves: [],
        });
      }
      for (const move of post.moves) {
        const row = balances.get(move.address) ?? {
          key: move.address,
          opening: 0n,
          moves: [],
        };
        row.moves.push({ at: move.at, delta: move.deltaRaw });
        balances.set(move.address, row);
      }
      for (const row of [...balances.values()].sort((a, b) =>
        a.key < b.key ? -1 : 1,
      )) {
        const segments = segmentsOf(row.opening, row.moves, from, end);
        if (segments.length === 0) continue;
        const userId = ownerOf.get(row.key);
        if (userId === undefined) {
          unattributed += 1;
          continue;
        }
        for (const segment of segments) {
          for (const part of gated(
            userId,
            assetCommunities.get(asset.assetId) ?? [],
            segment,
          )) {
            assetHoldings.push({
              userId,
              assetId: asset.assetId,
              from: part.from,
              to: part.to,
              balanceRaw: segment.value,
            });
          }
        }
      }
    }
    if (cutoff <= start) continue;
    if (valued) {
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
    }
    // Decision 0189: a user owning an `erc20` holder address whose balance
    // is unknown counts 0 for this asset in the hour (all their wallets).
    const unknownUsers = new Set<string>();
    if (asset.source === "erc20") {
      erc20Read = true;
      for (const pin of asset.openingPins ?? []) erc20Pins.push({ ...pin });
      for (const holder of asset.unknownHolders ?? []) {
        for (const userId of ownersOf.get(holder.address) ?? []) {
          unknownUsers.add(userId);
          const key = `${asset.assetId}|${holder.reasonCode}`;
          const users = erc20Unknown.get(key) ?? new Set<string>();
          users.add(userId);
          erc20Unknown.set(key, users);
        }
      }
    }
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
      if (unknownUsers.has(userId)) continue;
      for (const segment of segments) {
        // Decision 0183: a MEME bound by a verified community counts only
        // while its holder is a member of it; an unbound MEME is not gated.
        for (const part of gated(
          userId,
          assetCommunities.get(asset.assetId) ?? [],
          segment,
        )) {
          assetHoldings.push({
            userId,
            assetId: asset.assetId,
            from: part.from,
            to: part.to,
            balanceRaw: segment.value,
          });
        }
      }
    }
  }

  const calculatorInput: MiningHourlySettlementInput = Object.freeze({
    hourStart: start,
    hourEnd: end,
    budgetNftRaw: wholeHour
      ? miningHourBudget({
          hourStart: start,
          dailyBudgetRaw: BigInt(version.document.dailyBudgetNftRaw),
          releaseStart,
          releaseDays: version.document.releaseDays,
        })
      : 0n,
    budgetAssetRaw: wholeHour
      ? miningHourBudget({
          hourStart: start,
          dailyBudgetRaw: BigInt(version.document.dailyBudgetAssetRaw),
          releaseStart,
          releaseDays: version.document.releaseDays,
        })
      : 0n,
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
      assetPowerBases: [
        ...new Set(slices.map((slice) => slice.assetPowerBasis)),
      ].sort(),
      nftHoldingSegments: nftHoldings.length,
      assetHoldingSegments: assetHoldings.length,
      priceSegments: prices.length,
      referralEdges: calculatorInput.referralEdges.length,
      unboundInstances: unboundInstances.sort(),
      ambiguousAddressCount: ambiguous.length,
      unattributedHoldingCount: unattributed,
      excludedAssets,
      // Decision 0183: only on hours prepared with the membership gate.
      ...(gate === null
        ? {}
        : {
            membershipGate: "verified_member",
            membershipGatedSegmentCount: gatedSegments,
          }),
      // Decision 0184: the wallet scope in effect for this hour.
      ...(input.facts.walletKinds === undefined
        ? {}
        : { walletKinds: input.facts.walletKinds }),
      // Decision 0187: the roster the hour was prepared with (replay reuses
      // it, so a later verification or binding change does not move it).
      ...(input.poolAssetIds === undefined
        ? {}
        : { poolRosterAssetIds: poolAssetIds }),
      // Decision 0189: the rank projection rule of this hour (participating
      // roster communities only); hours without it keep the 0187 rule.
      poolRosterRule: "participating",
      // Decision 0191: the assetWeights ids the roster rule ignored (the
      // key's presence marks the rule, so a replay applies it again).
      ...(assetRule === "roster"
        ? { ignoredNonRosterAssetIds: ignoredNonRoster }
        : {}),
      // Decision 0189: the readings the erc20 openings rest on (a replay
      // reads exactly these rows) and the users counted 0 per reason.
      ...(erc20Read
        ? {
            externalOpeningPins: erc20Pins.sort((a, b) =>
              `${a.assetId}|${a.walletId}|${a.blockNumber}` <
              `${b.assetId}|${b.walletId}|${b.blockNumber}`
                ? -1
                : 1,
            ),
            externalUnknownHolders: [...erc20Unknown.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, users]) => {
                const [assetId, reasonCode] = key.split("|");
                return { assetId, reasonCode, userCount: users.size };
              }),
          }
        : {}),
      ...((input.facts.externalExcludedAssets ?? []).some(
        (row) => row.reasonCode === miningSettlementReasonCodes.sourceStale,
      )
        ? {
            externalStaleAssetIds: (input.facts.externalExcludedAssets ?? [])
              .filter(
                (row) =>
                  row.reasonCode === miningSettlementReasonCodes.sourceStale,
              )
              .map((row) => row.assetId)
              .sort(),
          }
        : {}),
      // Decision 0189: the external roster (only when there is one), so a
      // replay gates the same assets.
      ...(external === null
        ? {}
        : {
            poolExternalAssetIds: external.assetIds,
            poolExternalReadableAssetIds: [...(external.readable ?? [])].sort(),
          }),
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

/** Asset ids with a positive (effective) weight anywhere in [start, end). */
/** Decision 0189: sorted, unique; null when there is no external asset. */
function normalizedExternal(
  external: MiningPoolExternalAssets | undefined,
): MiningPoolExternalAssets | null {
  if (external === undefined || external.assetIds.length === 0) return null;
  return Object.freeze({
    assetIds: Object.freeze([...new Set(external.assetIds)].sort()),
    readable: new Set(
      [...(external.readable ?? [])].filter((assetId) =>
        external.assetIds.includes(assetId),
      ),
    ),
  });
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : null;
}

/** Decision 0189: the external roster an epoch was settled with, if any. */
function storedExternal(
  summary: Readonly<Record<string, unknown>>,
): MiningPoolExternalAssets | null {
  const assetIds = stringList(summary["poolExternalAssetIds"]);
  if (assetIds === null) return null;
  return normalizedExternal({
    assetIds,
    readable: new Set(
      stringList(summary["poolExternalReadableAssetIds"]) ?? [],
    ),
  });
}

/**
 * Decision 0189: the erc20 inputs an epoch was settled with — the assets
 * left out as stale and the pinned opening readings (null before 0189: a
 * fresh selection, which reads nothing because no erc20 asset was admitted).
 */
function storedErc20(summary: Readonly<Record<string, unknown>>): {
  readonly staleAssetIds: readonly string[];
  readonly pins: readonly MiningErc20OpeningPin[] | null;
} {
  const rawPins = summary["externalOpeningPins"];
  const pins = Array.isArray(rawPins)
    ? rawPins.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        return typeof row["assetId"] === "string" &&
          typeof row["walletId"] === "string" &&
          typeof row["blockNumber"] === "string"
          ? [
              Object.freeze({
                assetId: row["assetId"],
                walletId: row["walletId"],
                blockNumber: row["blockNumber"],
              }),
            ]
          : [];
      })
    : null;
  return {
    staleAssetIds: stringList(summary["externalStaleAssetIds"]) ?? [],
    pins,
  };
}

export function admittedAssetIds(
  versions: readonly MiningParameterVersionRecord[],
  start: bigint,
  end: bigint,
  poolAssetIds: readonly string[] = [],
  external: MiningPoolExternalAssets | null = null,
  rule: MiningSettlementAssetRule = "document",
): readonly string[] {
  const assetIds = new Set<string>();
  for (const slice of miningParameterSlices(
    versions,
    start,
    end,
    poolAssetIds,
    normalizedExternal(external ?? undefined),
    rule,
  )) {
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
  /** Decision 0184 (`MINING_EMBEDDED_WALLET_ONLY`). */
  readonly embeddedWalletOnly: boolean;
  readonly now?: () => Date;
}): MiningSettlementRunner {
  const { repository } = dependencies;
  const now = dependencies.now ?? ((): Date => new Date());

  async function readFacts(
    hourStart: bigint,
    versions: readonly MiningParameterVersionRecord[],
    poolAssetIds: readonly string[],
    external: MiningPoolExternalAssets | null,
    erc20: {
      readonly staleAssetIds: readonly string[];
      readonly pins: readonly MiningErc20OpeningPin[] | null;
    },
    rule: MiningSettlementAssetRule,
  ): Promise<MiningSettlementFacts> {
    const end = hourStart + miningHourSeconds;
    const assetIds = admittedAssetIds(
      versions,
      hourStart,
      end,
      poolAssetIds,
      external,
      rule,
    );
    // Decision 0189: the admitted external assets are read leniently (a
    // stale lane or a missing source leaves the asset out of the hour).
    const externalIds =
      external === null
        ? []
        : assetIds.filter((assetId) => external.assetIds.includes(assetId));
    return repository.readSettlementFacts({
      chainId: dependencies.chainId,
      hourStart,
      hourEnd: end,
      assetIds,
      embeddedWalletOnly: dependencies.embeddedWalletOnly,
      ...(externalIds.length === 0
        ? {}
        : {
            external: {
              assetIds: externalIds,
              staleAssetIds: erc20.staleAssetIds.filter((assetId) =>
                externalIds.includes(assetId),
              ),
              pins: erc20.pins,
            },
          }),
    });
  }

  /**
   * Decision 0187: the roster's platform MEMEs on the settled chain.
   * Decision 0189: plus the external roster (every chain), gated by
   * `includedAssets`; only an external token the settlement has a source
   * for on the settled chain (a MEME v1 token) can weigh here.
   */
  async function readRoster(
    versions: readonly MiningParameterVersionRecord[],
  ): Promise<{
    readonly poolAssetIds: readonly string[];
    readonly external: MiningPoolExternalAssets | null;
  }> {
    const candidates = await repository.listMiningPoolCandidates({});
    const poolAssetIds = [
      ...new Set(
        candidates
          .filter(
            (row) =>
              row.kind !== "external" && row.chainId === dependencies.chainId,
          )
          .map((row) => row.assetId),
      ),
    ].sort();
    return {
      poolAssetIds,
      external: miningPoolExternalFor(
        candidates,
        versions,
        dependencies.chainId,
      ),
    };
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
      // Decision 0129 §3: the scheduled lane waits out a failed hour's
      // backoff; an operator test trigger is not held back.
      if (
        trigger === "scheduled" &&
        existing?.status === "failed" &&
        now().getTime() < miningSettlementNextAttemptAt(existing)
      ) {
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.retryBackoff,
        };
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
      const { poolAssetIds, external } = await readRoster(versions);
      const freshness = await repository.readIndexerFreshness({
        chainId: dependencies.chainId,
        assetIds: admittedAssetIds(
          versions,
          hourStart,
          hourStart + miningHourSeconds,
          poolAssetIds,
          external,
          "roster",
        ),
        ...(external === null ? {} : { externalAssetIds: external.assetIds }),
      });
      const staleAssetIds: string[] = [];
      for (const lane of freshness.lanes) {
        if (!lane.hasSources) continue;
        const stale =
          lane.updatedAt === null || seconds(lane.updatedAt) < readyAt;
        if (!stale) continue;
        if (lane.externalAssetIds !== undefined) {
          // Decision 0189: a stale erc20_transfer lane only takes its
          // external assets out of this hour; the platform MEMEs settle.
          staleAssetIds.push(...lane.externalAssetIds);
          continue;
        }
        return {
          kind: "skipped",
          reasonCode: miningSettlementReasonCodes.indexerBehind,
        };
      }
      let prepared: PreparedMiningHour;
      let result: MiningHourlySettlementResult;
      try {
        const facts = await readFacts(
          hourStart,
          versions,
          poolAssetIds,
          external,
          { staleAssetIds, pins: null },
          "roster",
        );
        prepared = prepareMiningHour({
          hourStart,
          versions,
          facts,
          poolAssetIds,
          ...(external === null ? {} : { poolExternal: external }),
          assetRule: "roster",
        });
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
      // Decision 0187: an hour settled with the roster replays with the
      // stored roster; an earlier hour replays without one.
      const storedRoster = epoch.inputSummary["poolRosterAssetIds"];
      const poolAssetIds = Array.isArray(storedRoster)
        ? storedRoster.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined;
      // Decision 0189: likewise the stored external roster.
      const external = storedExternal(epoch.inputSummary);
      // Decision 0191: an hour settled under the roster rule records the
      // ignored ids; an earlier hour replays under the document rule.
      const assetRule: MiningSettlementAssetRule = Array.isArray(
        epoch.inputSummary["ignoredNonRosterAssetIds"],
      )
        ? "roster"
        : "document";
      try {
        const facts = await readFacts(
          hourStart,
          versions,
          poolAssetIds ?? [],
          external,
          // Decision 0189: the same stale set and the pinned readings.
          storedErc20(epoch.inputSummary),
          assetRule,
        );
        const prepared = prepareMiningHour({
          hourStart,
          versions,
          facts,
          ...(poolAssetIds === undefined ? {} : { poolAssetIds }),
          ...(external === null ? {} : { poolExternal: external }),
          assetRule,
        });
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
