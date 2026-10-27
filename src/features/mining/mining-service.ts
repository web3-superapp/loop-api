import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
  type V2CursorContinuation,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  ChainRegistryUnavailableError,
  type ChainRegistryRepository,
} from "../../database/chain-registry-repository.js";
import {
  referralRulesConfigVersion,
  referralRulesEffectiveAt,
  referralRulesV1,
  type ReferralRulesProjection,
} from "../community/referral-rules.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  type TokenLogoProjection,
  type TokenLogoProjector,
} from "../market/token-logo.js";
import {
  hasNoMiningSnapshot,
  resolveMiningBaseline,
  type MiningBaselineResolution,
  type MiningBaselineWithoutSnapshot,
} from "./mining-baseline.js";
import {
  miningRankAnonymousMemberKey,
  miningRankDisplayRuleKey,
  miningRankPaging,
  miningRankPowerRuleKey,
  miningRankScopes,
  miningReferralRankRuleKey,
  miningReasonCodes,
  unavailable,
  type MiningDailyOutputDocument,
  type MiningFormulaScope,
  type MiningFormulaStatus,
  type MiningHoldingsSource,
  type MiningPriceGuardRule,
  type MiningRankScope,
  type MiningReferencePriceQuality,
  type MiningSnapshotStatus,
  type MiningUnreadInput,
  type MiningWeightRangeDocument,
  type UnavailableProjection,
} from "./mining-contract.js";
import {
  projectCommunityWeight,
  projectParticipants,
  type MiningCommunityWeightProjection,
  type MiningParticipantsProjection,
} from "./mining-community-projection.js";
import { estimateDailyOutputShare } from "./mining-daily-output.js";
import {
  MiningRepositoryUnavailableError,
  type MiningFormulaRecord,
  type MiningRankEpochRecord,
  type MiningRankedAccountRecord,
  type MiningReferralRankRecord,
  type MiningRepository,
  type MiningSnapshotAttemptRecord,
  type MiningSnapshotRecord,
} from "./mining-repository.js";
import { selectMiningWeight } from "./mining-snapshot.js";

/**
 * Mining read service (Decisions 0036, 0043, and 0046). Every number is
 * read from the latest snapshot computed under the formula version in
 * force; without one, every power, estimate, and rank is `unavailable` with
 * a reason code and the rules page shows the pending version marked as
 * such. Rewards stay `REWARD_AUTHORITY_PENDING`: no ledger row is ever
 * written here. Asset symbols on the composition page come from the Asset
 * Registry (the same rows the snapshot lane priced), never from a fixture.
 */

export interface MiningFormulaProjection {
  readonly configVersion: string;
  readonly status: MiningFormulaStatus;
  readonly scope: MiningFormulaScope | null;
  readonly effectiveAt: string | null;
  readonly approvedAt: string | null;
  readonly expressionKey: string;
  readonly dailyOutputKey: string;
  readonly assetWeights: Readonly<Record<string, string>>;
  readonly dailyOutput: MiningDailyOutputDocument | null;
  readonly weightRange: MiningWeightRangeDocument;
  readonly priceGuardRules: readonly MiningPriceGuardRule[];
  readonly referralBoost: { readonly status: "pending_approval" | "approved" };
}

/**
 * The newest run under the version in force (Decision 0057): the published
 * snapshot itself, an incomplete attempt naming the holdings it could not
 * value, or a snapshot an operator invalidated.
 */
export interface MiningSnapshotAttemptProjection {
  readonly snapshotId: string;
  readonly status: MiningSnapshotStatus;
  readonly computedAt: string;
  /** `MINING_SNAPSHOT_INCOMPLETE`, the invalidation reason, or null when complete. */
  readonly reasonCode: string | null;
  readonly unreadInputs: readonly MiningUnreadInput[];
}

export interface MiningSnapshotProjection {
  readonly snapshotId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly formulaVersion: string;
  readonly priceVersion: string;
  readonly computedAt: string;
  /**
   * A newer attempt under the same version did not complete: the numbers on
   * the page are this snapshot's and are older than `latestAttempt`.
   */
  readonly stale: boolean;
  readonly latestAttempt: MiningSnapshotAttemptProjection;
  /**
   * Which kinds of observed balance produced the numbers on this page
   * (Decision 0061). `chain` is the only value a production stack can
   * publish; `mock_seed` or `mixed` means the Development seed's holdings
   * were counted and the client says so on screen.
   */
  readonly holdingsSource: MiningHoldingsSource;
}

/** No complete snapshot; `latestAttempt` explains the newest run when there is one. */
export type MiningSnapshotUnavailableProjection = UnavailableProjection & {
  readonly latestAttempt?: MiningSnapshotAttemptProjection;
};

export type MiningSnapshotOrUnavailable =
  MiningSnapshotProjection | MiningSnapshotUnavailableProjection;

export interface MiningDecimalProjection {
  readonly status: "available";
  readonly value: string;
}

export type MiningDecimalOrUnavailable =
  MiningDecimalProjection | UnavailableProjection;

export interface MiningEstimateProjection {
  readonly status: "available";
  readonly value: string;
  readonly budget: string;
  readonly unitKey: string;
  readonly budgetStatus: MiningDailyOutputDocument["status"];
  /** The version the budget belongs to; its name is the on-screen label. */
  readonly formulaVersion: string;
  readonly scope: MiningFormulaScope | null;
}

export type MiningEstimateOrUnavailable =
  MiningEstimateProjection | UnavailableProjection;

export type MiningFormulaStateProjection =
  | {
      readonly status: "approved";
      readonly configVersion: string;
      readonly effectiveAt: string;
      readonly scope: MiningFormulaScope | null;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly pendingVersion: string | null;
    };

export interface MiningSummaryResource {
  readonly power: MiningDecimalOrUnavailable;
  readonly networkPower: MiningDecimalOrUnavailable;
  readonly estimatedToday: MiningEstimateOrUnavailable;
  readonly accumulated: UnavailableProjection;
  readonly claimable: UnavailableProjection;
  readonly referralBoost: UnavailableProjection;
  readonly formula: MiningFormulaStateProjection;
  readonly snapshot: MiningSnapshotOrUnavailable;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningIncludedAssetProjection {
  readonly assetId: string;
  /** The registry's on-chain `symbol()`; null only without a registry row. */
  readonly symbol: string | null;
  /** Display picture of the asset (Decision 0072); never an identifier. */
  readonly logo: TokenLogoProjection;
  readonly holding: string;
  /**
   * Null only with quality `unavailable` (Decision 0189, written only under
   * `MINING_SNAPSHOT_UNPRICED_POWER_EMIT`).
   */
  readonly referencePriceUsd: string | null;
  /** Decision 0189: present only on an `unavailable` row. */
  readonly referencePriceReasonCode?: string;
  /**
   * `proxied` = the declared proxy asset's price (Decision 0044);
   * `derived` = the inverted quote side of `referencePricePairAddress`,
   * inside the guard band the version declares (Decision 0059).
   */
  readonly referencePriceQuality: MiningReferencePriceQuality;
  readonly referencePriceProxyAssetId: string | null;
  /** The pair the price was read from; never null when `derived`. */
  readonly referencePricePairAddress: string | null;
  readonly weight: string;
  readonly power: string;
  readonly blockNumber: string;
}

export interface MiningExcludedAssetProjection {
  readonly assetId: string;
  /** The registry's on-chain `symbol()`; null only without a registry row. */
  readonly symbol: string | null;
  /** Display picture of the asset (Decision 0072); never an identifier. */
  readonly logo: TokenLogoProjection;
  readonly reasonCode: string;
}

export interface MiningAssetsResource {
  readonly totalPower: MiningDecimalOrUnavailable;
  readonly included: readonly MiningIncludedAssetProjection[];
  readonly excluded: readonly MiningExcludedAssetProjection[];
  readonly source: MiningSnapshotOrUnavailable;
  readonly referencePrice:
    | { readonly status: "available"; readonly priceVersion: string }
    | UnavailableProjection;
  /** The version in force, exactly as the summary publishes it (Decision 0046). */
  readonly formula: MiningFormulaStateProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningRewardsResource {
  readonly claimable: UnavailableProjection;
  readonly claimExecutable: false;
  readonly estimatedToday: MiningEstimateOrUnavailable;
  readonly accumulated: UnavailableProjection;
  readonly ledger: readonly never[];
  readonly source: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

/** The owner's `mining_power_visibility` setting, published verbatim. */
export type MiningRankPowerVisibility = "everyone" | "self";

export type MiningRankDisplayProjection =
  | {
      readonly kind: "alias";
      readonly alias: string;
      readonly publicProfileId: string;
      /**
       * `self` only on the viewer's own row while anonymous mode is on: the
       * owner still sees the alias, everyone else sees the anonymous label.
       */
      readonly audience: MiningRankPowerVisibility;
      /** Stored avatar ref of the profile (Decision 0100); null when none. */
      readonly avatarRef: string | null;
    }
  | {
      readonly kind: "anonymous";
      readonly labelKey: typeof miningRankAnonymousMemberKey;
    };

export interface MiningRankedUserProjection {
  /** Null while the power is zero: in the snapshot, not ranked. */
  readonly position: number | null;
  /**
   * Null only when the row is not the viewer's and its owner limits power
   * visibility to `self` (Decision 0049). The position stays public.
   */
  readonly power: string | null;
  readonly powerVisibility: MiningRankPowerVisibility;
  readonly display: MiningRankDisplayProjection;
  readonly isSelf: boolean;
}

export interface MiningRankedCommunityProjection {
  /** Null while the power is zero: weighted and bound, not ranked. */
  readonly position: number | null;
  readonly power: string;
  readonly community: {
    readonly communityId: string;
    readonly name: string;
    readonly boundAssetId: string;
  };
  readonly weight: string;
  readonly participants: number;
}

/** One inviter on the referral rank (Decision 0100). */
export interface MiningRankedReferrerProjection {
  readonly position: number;
  /** Direct invitees in force, every validation status. Always public. */
  readonly invitedCount: number;
  readonly display: MiningRankDisplayProjection;
  readonly isSelf: boolean;
}

/** The caller's own place on the requested rank (Decision 0100). */
export interface MiningRankMeProjection {
  readonly rank: number;
  /** Power (users, communities) or direct invitee count (referrals), as a decimal string. */
  readonly value: string;
  /** Only on `communities`: the caller's best-ranked community. */
  readonly communityId?: string;
}

export type MiningRankingProjection =
  | {
      readonly status: "available";
      readonly scope: "users";
      readonly items: readonly MiningRankedUserProjection[];
      readonly participants: number;
    }
  | {
      readonly status: "available";
      readonly scope: "referrals";
      readonly items: readonly MiningRankedReferrerProjection[];
      readonly participants: number;
      readonly ruleKey: typeof miningReferralRankRuleKey;
    }
  | {
      readonly status: "available";
      readonly scope: "communities";
      readonly items: readonly MiningRankedCommunityProjection[];
      readonly participants: number;
    }
  | UnavailableProjection;

export type MiningPositionProjection =
  | {
      readonly status: "available";
      readonly position: number;
      readonly power: string;
    }
  | UnavailableProjection;

export interface MiningRankResource {
  readonly scope: MiningRankScope;
  readonly ranking: MiningRankingProjection;
  readonly myPosition: MiningPositionProjection;
  /** Null when the caller holds no place on this rank (Decision 0100). */
  readonly me: MiningRankMeProjection | null;
  /** Next page of `ranking.items`; null on the last page (Decision 0100). */
  readonly nextCursor: string | null;
  readonly snapshot: MiningSnapshotOrUnavailable;
  readonly display: {
    readonly anonymousMemberKey: typeof miningRankAnonymousMemberKey;
    readonly ruleKey: typeof miningRankDisplayRuleKey;
    readonly powerRuleKey: typeof miningRankPowerRuleKey;
  };
  /** The version in force, exactly as the summary publishes it (Decision 0046). */
  readonly formula: MiningFormulaStateProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningCommunityResource {
  readonly community: {
    readonly communityId: string;
    readonly name: string;
    readonly boundAssetId: string | null;
  };
  /** Shared with the community-side `miningPower` (Decision 0045). */
  readonly weight: MiningCommunityWeightProjection;
  readonly communityPower: MiningDecimalOrUnavailable;
  readonly myContribution: MiningDecimalOrUnavailable;
  readonly rank: MiningPositionProjection;
  /** Shared with the community-side `miningPower` (Decision 0045). */
  readonly participants: MiningParticipantsProjection;
  readonly snapshot: MiningSnapshotOrUnavailable;
  readonly contractVersion: typeof v2ContractVersion;
}

export type MiningBaselineProjection =
  | {
      readonly status: "approved";
      readonly configVersion: string;
      readonly effectiveAt: string;
      readonly scope: MiningFormulaScope | null;
    }
  | UnavailableProjection;

export interface MiningRulesResource {
  readonly approved: MiningFormulaProjection | null;
  readonly pendingApproval: readonly MiningFormulaProjection[];
  readonly baseline: MiningBaselineProjection;
  readonly referral: {
    readonly configVersion: typeof referralRulesConfigVersion;
    readonly effectiveAt: typeof referralRulesEffectiveAt;
    readonly levels: ReferralRulesProjection["levels"];
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningService {
  getSummary(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<MiningSummaryResource>;
  getAssets(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<MiningAssetsResource>;
  getRewards(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<MiningRewardsResource>;
  getRank(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly scope?: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<MiningRankResource>;
  getCommunity(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly communityId: string;
  }): Promise<MiningCommunityResource>;
  getRules(): Promise<MiningRulesResource>;
  referralRules(): ReferralRulesProjection;
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (
    error instanceof MiningRepositoryUnavailableError ||
    error instanceof ChainRegistryUnavailableError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

/** Decision 0125: the asset power rule of `/v2/mining/*` snapshots. */
export const miningSnapshotAssetPowerBasis = "quantity" as const;
export const miningLegacyExpressionKey =
  "mining.rules.formula.holdingTimesReferencePriceTimesWeight";
export const miningQuantityExpressionKey =
  "mining.rules.formula.holdingTimesWeight";

function formulaProjection(
  record: MiningFormulaRecord,
): MiningFormulaProjection {
  return Object.freeze({
    configVersion: record.configVersion,
    status: record.status,
    scope: record.formula.scope ?? null,
    effectiveAt: record.effectiveAt,
    approvedAt: record.approvedAt,
    // Decision 0125: every snapshot is computed as holding × weight now,
    // whatever key the stored version carries.
    expressionKey:
      record.formula.expressionKey === miningLegacyExpressionKey
        ? miningQuantityExpressionKey
        : record.formula.expressionKey,
    dailyOutputKey: record.formula.dailyOutputKey,
    assetWeights: record.formula.assetWeights,
    dailyOutput: record.formula.dailyOutput ?? null,
    weightRange: record.weightRange,
    priceGuardRules: record.priceGuardRules,
    referralBoost: record.formula.referralBoost,
  });
}

function attemptProjection(
  attempt: MiningSnapshotAttemptRecord,
): MiningSnapshotAttemptProjection {
  return Object.freeze({
    snapshotId: attempt.snapshotId,
    status: attempt.status,
    computedAt: attempt.computedAt,
    reasonCode:
      attempt.status === "incomplete"
        ? miningReasonCodes.snapshotIncomplete
        : attempt.status === "invalidated"
          ? attempt.invalidationReason
          : null,
    unreadInputs: Object.freeze(
      attempt.unreadInputs.map((input) => Object.freeze({ ...input })),
    ),
  });
}

/** A resolution that carries a complete snapshot under the version in force. */
type MiningBaselineWithSnapshot = Extract<
  MiningBaselineResolution,
  { readonly snapshot: MiningSnapshotRecord }
>;

function snapshotProjection(
  resolution: MiningBaselineWithSnapshot,
): MiningSnapshotProjection {
  const record = resolution.snapshot;
  return Object.freeze({
    snapshotId: record.snapshotId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash,
    formulaVersion: record.formulaVersion,
    priceVersion: record.priceVersion,
    computedAt: record.computedAt,
    stale: resolution.stale,
    latestAttempt: attemptProjection(resolution.latestAttempt),
    holdingsSource: record.holdingsSource,
  });
}

/**
 * The `snapshot` slot of the users and communities ranks (Decision 0148):
 * the settled hour they rank, in the unchanged snapshot shape so clients
 * keep decoding it. `computedAt` is the hour's end (the power is the
 * average over `[hourStart, hourEnd)`; the same anchor the minute display
 * of `GET /v2/mining/rewards` uses). An hour has no single block:
 * `blockNumber` is "0" and `blockHash` carries the hour's input digest;
 * `formulaVersion` is the parameter version and `priceVersion` the epoch's
 * idempotency key. Settlement reads indexed chain facts only, so the
 * holdings are `chain`, and a settled hour is never stale.
 */
function rankEpochSnapshot(
  epoch: MiningRankEpochRecord,
): MiningSnapshotProjection {
  const latestAttempt: MiningSnapshotAttemptProjection = Object.freeze({
    snapshotId: epoch.epochId,
    status: "complete" as const,
    computedAt: epoch.hourEnd,
    reasonCode: null,
    unreadInputs: Object.freeze([]),
  });
  return Object.freeze({
    snapshotId: epoch.epochId,
    blockNumber: "0",
    blockHash: `0x${epoch.inputDigest}`,
    formulaVersion: epoch.configVersion,
    priceVersion: `mining_hourly:${epoch.hourStart}`,
    computedAt: epoch.hourEnd,
    stale: false,
    latestAttempt,
    holdingsSource: "chain" as const,
  });
}

/**
 * The `snapshot` slot without a complete snapshot: the same reason as every
 * number, plus the newest attempt under the version in force when there is
 * one, so the client can say *why* nothing is published (Decision 0057).
 */
function missingSnapshot(
  resolution: MiningBaselineWithoutSnapshot,
): MiningSnapshotUnavailableProjection {
  const reason = missingReason(resolution);
  if (resolution.status === "pending" || resolution.latestAttempt === null) {
    return reason;
  }
  return Object.freeze({
    ...reason,
    latestAttempt: attemptProjection(resolution.latestAttempt),
  });
}

function decimal(value: string): MiningDecimalProjection {
  return Object.freeze({ status: "available", value });
}

const baselinePending = unavailable(miningReasonCodes.formulaBaselinePending);
const rewardAuthorityPending = unavailable(
  miningReasonCodes.rewardAuthorityPending,
);

/** Why the resolution carries no snapshot: no baseline, none computed, or stale. */
function missingReason(
  resolution: MiningBaselineWithoutSnapshot,
): UnavailableProjection {
  if (resolution.status === "pending") {
    return baselinePending;
  }
  return unavailable(resolution.snapshotReasonCode);
}

/**
 * `estimatedToday` under the share-of-network-power rule. Requires the
 * version's daily output budget, a positive network total, and the
 * account's own power; each missing input has its own reason code.
 */
function estimateProjection(
  formula: MiningFormulaRecord,
  snapshot: MiningSnapshotRecord,
  accountPower: string | null,
  absentReason: UnavailableProjection,
): MiningEstimateOrUnavailable {
  if (accountPower === null) {
    return absentReason;
  }
  const dailyOutput = formula.formula.dailyOutput;
  if (dailyOutput === undefined) {
    return unavailable(miningReasonCodes.dailyOutputNotConfigured);
  }
  const value = estimateDailyOutputShare({
    budget: dailyOutput.budget,
    accountPower,
    networkPower: snapshot.totalPower,
  });
  if (value === null) {
    return unavailable(miningReasonCodes.networkPowerZero);
  }
  return Object.freeze({
    status: "available",
    value,
    budget: dailyOutput.budget,
    unitKey: dailyOutput.unitKey,
    budgetStatus: dailyOutput.status,
    formulaVersion: formula.configVersion,
    scope: formula.formula.scope ?? null,
  });
}

/**
 * One ranked row as the viewer sees it (Decision 0049). Anonymous mode alone
 * decides the name others see; `mining_power_visibility` alone decides
 * whether others see the number; `discoverable` decides nothing here. The
 * viewer always sees their own alias and power.
 */
const rankCursorRoute = "miningRank";

function rankCursorString(
  continuation: V2CursorContinuation,
  key: string,
): string {
  const value = continuation[key];
  if (typeof value !== "string" || value.length === 0) {
    throw V2ApiError.invalidRequest();
  }
  return value;
}

function rankCursorNumber(
  continuation: V2CursorContinuation,
  key: string,
): number {
  const value = continuation[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw V2ApiError.invalidRequest();
  }
  return value;
}

/** The Decision 0049 display rule, shared by every rank scope. */
function projectRankDisplay(
  row: Pick<
    MiningRankedAccountRecord,
    "alias" | "publicProfileId" | "anonymousMode" | "avatarRef"
  >,
  isSelf: boolean,
): MiningRankDisplayProjection {
  return row.alias !== null &&
    row.publicProfileId !== null &&
    (isSelf || !row.anonymousMode)
    ? Object.freeze({
        kind: "alias" as const,
        alias: row.alias,
        publicProfileId: row.publicProfileId,
        audience: row.anonymousMode ? ("self" as const) : ("everyone" as const),
        avatarRef: row.avatarRef,
      })
    : Object.freeze({
        kind: "anonymous" as const,
        labelKey: miningRankAnonymousMemberKey,
      });
}

function projectRankedReferrer(
  row: MiningReferralRankRecord,
  viewerUserId: string,
): MiningRankedReferrerProjection {
  const isSelf = row.ownerUserId === viewerUserId;
  return Object.freeze({
    position: row.position,
    invitedCount: row.invitedCount,
    display: projectRankDisplay(row, isSelf),
    isSelf,
  });
}

function projectRankedUser(
  row: MiningRankedAccountRecord,
  viewerUserId: string,
): MiningRankedUserProjection {
  const isSelf = row.ownerUserId === viewerUserId;
  const display = projectRankDisplay(row, isSelf);
  return Object.freeze({
    position: row.position,
    power: isSelf || row.powerVisibleToOthers ? row.totalPower : null,
    powerVisibility: row.powerVisibleToOthers
      ? ("everyone" as const)
      : ("self" as const),
    display,
    isSelf,
  });
}

export function createMiningService(dependencies: {
  readonly repository: MiningRepository;
  /** Asset Registry rows: the only source of a row's `symbol`. */
  readonly registry: Pick<ChainRegistryRepository, "listAssets">;
  /** Publishes every asset row's logo as this API's proxy URL (Decision 0089). */
  readonly tokenLogos: TokenLogoProjector;
  /**
   * Rank cursors (Decision 0100). Without it the first page is still served
   * and `nextCursor` is null; a cursor is then `CAPABILITY_UNAVAILABLE`.
   */
  readonly cursorCodec?: V2CursorCodec | null;
  readonly now?: () => Date;
}): MiningService {
  const { repository, registry } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  /** `assetId → symbol` for the given IDs; an ID without a row is absent. */
  async function symbolsFor(
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(assetIds)];
    const records =
      unique.length === 0 ? [] : await registry.listAssets(unique);
    return new Map(records.map((record) => [record.assetId, record.symbol]));
  }

  async function pendingVersion(): Promise<string | null> {
    const versions = await repository.listFormulaVersions();
    return (
      versions.find((v) => v.status === "pending_approval")?.configVersion ??
      null
    );
  }

  function baseline(): Promise<MiningBaselineResolution> {
    return resolveMiningBaseline(repository, now());
  }

  /**
   * One rank page request (Decision 0100): the page size, the keyset of the
   * previous page's last row, and how to mint the next cursor. The cursor is
   * bound to the caller and the scope; it carries its own page size and the
   * running row count so a chain stops at `maximumTotal`.
   */
  function readRankPage(
    ownerId: string,
    scope: MiningRankScope,
    query: { readonly cursor?: unknown; readonly limit?: unknown },
  ): {
    readonly pageSize: number;
    readonly fetchSize: number;
    readonly continuation: V2CursorContinuation | null;
    next(
      served: number,
      key: Readonly<Record<string, string | number>>,
    ): string | null;
  } {
    const codec = dependencies.cursorCodec ?? null;
    const filter = `scope=${scope}`;
    if (query.cursor !== undefined && query.limit !== undefined) {
      throw V2ApiError.invalidRequest();
    }
    let pageSize: number = miningRankPaging.defaultLimit;
    let servedBefore = 0;
    let continuation: V2CursorContinuation | null = null;
    if (query.cursor !== undefined) {
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (typeof query.cursor !== "string") {
        throw V2ApiError.invalidRequest();
      }
      try {
        continuation = codec.decode({
          ownerId,
          route: rankCursorRoute,
          filter,
          cursor: query.cursor,
        });
      } catch (error) {
        if (error instanceof InvalidV2CursorError) {
          throw V2ApiError.invalidRequest();
        }
        throw error;
      }
      const size = continuation["limit"];
      const served = continuation["served"];
      if (
        typeof size !== "number" ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > miningRankPaging.maximumLimit ||
        typeof served !== "number" ||
        !Number.isInteger(served) ||
        served < 1 ||
        served >= miningRankPaging.maximumTotal
      ) {
        throw V2ApiError.invalidRequest();
      }
      pageSize = size;
      servedBefore = served;
    } else if (query.limit !== undefined) {
      if (
        typeof query.limit !== "number" ||
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > miningRankPaging.maximumLimit
      ) {
        throw V2ApiError.invalidRequest();
      }
      pageSize = query.limit;
    }
    const remaining = miningRankPaging.maximumTotal - servedBefore;
    const effective = Math.min(pageSize, remaining);
    return {
      pageSize: effective,
      fetchSize: effective + 1,
      continuation,
      next(served, key) {
        const total = servedBefore + served;
        if (codec === null || total >= miningRankPaging.maximumTotal) {
          return null;
        }
        return codec.encode({
          ownerId,
          route: rankCursorRoute,
          filter,
          continuation: { ...key, limit: pageSize, served: total },
        });
      },
    };
  }

  /**
   * Why an account has no row in the snapshot (Decision 0057): with an
   * active wallet the snapshot simply predates it (or its balances were
   * never observed) — `MINING_SNAPSHOT_PENDING`, shown after the next
   * complete snapshot that includes it; without one there is nothing for
   * the lane to read — `MINING_ACCOUNT_NOT_IN_SNAPSHOT`. Never a zero.
   */
  async function absentReason(
    ownerUserId: string,
  ): Promise<UnavailableProjection> {
    return unavailable(
      (await repository.hasActiveWallet(ownerUserId))
        ? miningReasonCodes.snapshotPending
        : miningReasonCodes.accountNotInSnapshot,
    );
  }

  async function formulaState(
    resolution: MiningBaselineResolution,
  ): Promise<MiningFormulaStateProjection> {
    if (resolution.status === "approved") {
      return Object.freeze({
        status: "approved" as const,
        configVersion: resolution.formula.configVersion,
        effectiveAt: resolution.formula.effectiveAt ?? "",
        scope: resolution.formula.formula.scope ?? null,
      });
    }
    return Object.freeze({
      status: "unavailable" as const,
      reasonCode: miningReasonCodes.formulaBaselinePending,
      pendingVersion: await pendingVersion(),
    });
  }

  const service: MiningService = {
    async getSummary(input) {
      try {
        const resolution = await baseline();
        const formula = await formulaState(resolution);
        if (hasNoMiningSnapshot(resolution)) {
          const reason = missingReason(resolution);
          return Object.freeze({
            power: reason,
            networkPower: reason,
            estimatedToday: reason,
            accumulated: rewardAuthorityPending,
            claimable: rewardAuthorityPending,
            referralBoost: unavailable(miningReasonCodes.referralBoostPending),
            formula,
            snapshot: missingSnapshot(resolution),
            assetPowerBasis: miningSnapshotAssetPowerBasis,
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = resolution.snapshot;
        const standing = await repository.getAccountStanding({
          snapshotId: snapshot.snapshotId,
          ownerUserId: input.principal.userId,
        });
        const absent =
          standing === null ? await absentReason(input.principal.userId) : null;
        return Object.freeze({
          power: absent ?? decimal(standing?.totalPower ?? "0"),
          networkPower: decimal(snapshot.totalPower),
          estimatedToday: estimateProjection(
            resolution.formula,
            snapshot,
            standing?.totalPower ?? null,
            absent ?? unavailable(miningReasonCodes.accountNotInSnapshot),
          ),
          accumulated: rewardAuthorityPending,
          claimable: rewardAuthorityPending,
          referralBoost: unavailable(miningReasonCodes.referralBoostPending),
          formula,
          snapshot: snapshotProjection(resolution),
          assetPowerBasis: miningSnapshotAssetPowerBasis,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getAssets(input) {
      try {
        const resolution = await baseline();
        const formula = await formulaState(resolution);
        if (hasNoMiningSnapshot(resolution)) {
          const reason = missingReason(resolution);
          return Object.freeze({
            totalPower: reason,
            included: Object.freeze([]),
            excluded: Object.freeze([]),
            source: missingSnapshot(resolution),
            referencePrice: reason,
            formula,
            assetPowerBasis: miningSnapshotAssetPowerBasis,
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = resolution.snapshot;
        const [powers, standing, heldAssetIds, communityWeights] =
          await Promise.all([
            repository.listAccountPowers({
              snapshotId: snapshot.snapshotId,
              ownerUserId: input.principal.userId,
            }),
            repository.getAccountStanding({
              snapshotId: snapshot.snapshotId,
              ownerUserId: input.principal.userId,
            }),
            repository.listAccountBalanceAssetIds(input.principal.userId),
            repository.listCommunityWeightInputs(
              resolution.formula.configVersion,
            ),
          ]);
        const includedIds = new Set(powers.map((row) => row.assetId));
        const excludedIds = heldAssetIds.filter(
          (assetId) => !includedIds.has(assetId),
        );
        const symbols = await symbolsFor([...includedIds, ...excludedIds]);
        // An asset the account holds but the snapshot did not weight was
        // skipped by the lane; the reason is re-derived from the same
        // inputs the lane used (weight first, then the price guard). When
        // the newest attempt under the version recorded the asset as unread,
        // that recorded reason is the fact (Decision 0057).
        const unreadReasons = new Map(
          resolution.latestAttempt.unreadInputs.map((input) => [
            input.assetId,
            input.reasonCode,
          ]),
        );
        const excluded = excludedIds.map((assetId) => {
          const selection = selectMiningWeight(
            assetId,
            resolution.formula.formula,
            communityWeights,
          );
          return Object.freeze({
            assetId,
            symbol: symbols.get(assetId) ?? null,
            logo: dependencies.tokenLogos.projectForAssetId(assetId),
            reasonCode:
              selection.kind === "skip"
                ? selection.reasonCode
                : (unreadReasons.get(assetId) ??
                  miningReasonCodes.priceNotFresh),
          });
        });
        return Object.freeze({
          totalPower:
            standing === null
              ? await absentReason(input.principal.userId)
              : decimal(standing.totalPower),
          included: Object.freeze(
            powers.map((row) =>
              Object.freeze({
                assetId: row.assetId,
                symbol: symbols.get(row.assetId) ?? null,
                logo: dependencies.tokenLogos.projectForAssetId(row.assetId),
                holding: row.holding,
                referencePriceUsd: row.referencePriceUsd,
                referencePriceQuality: row.referencePriceQuality,
                referencePriceProxyAssetId: row.referencePriceProxyAssetId,
                referencePricePairAddress: row.referencePricePairAddress,
                // Decision 0189: only on an unpriced power-list row.
                ...(row.referencePriceReasonCode === undefined ||
                row.referencePriceReasonCode === null
                  ? {}
                  : { referencePriceReasonCode: row.referencePriceReasonCode }),
                weight: row.weight,
                power: row.power,
                blockNumber: row.blockNumber,
              }),
            ),
          ),
          excluded: Object.freeze(excluded),
          source: snapshotProjection(resolution),
          referencePrice: Object.freeze({
            status: "available" as const,
            priceVersion: snapshot.priceVersion,
          }),
          formula,
          assetPowerBasis: miningSnapshotAssetPowerBasis,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getRewards(input) {
      try {
        const resolution = await baseline();
        let estimatedToday: MiningEstimateOrUnavailable;
        if (hasNoMiningSnapshot(resolution)) {
          estimatedToday = missingReason(resolution);
        } else {
          const standing = await repository.getAccountStanding({
            snapshotId: resolution.snapshot.snapshotId,
            ownerUserId: input.principal.userId,
          });
          estimatedToday = estimateProjection(
            resolution.formula,
            resolution.snapshot,
            standing?.totalPower ?? null,
            standing === null
              ? await absentReason(input.principal.userId)
              : unavailable(miningReasonCodes.accountNotInSnapshot),
          );
        }
        return Object.freeze({
          claimable: rewardAuthorityPending,
          claimExecutable: false as const,
          estimatedToday,
          accumulated: rewardAuthorityPending,
          ledger: Object.freeze([]),
          source: rewardAuthorityPending,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getRank(input) {
      try {
        const scope =
          input.scope === undefined
            ? "users"
            : miningRankScopes.includes(input.scope as MiningRankScope)
              ? (input.scope as MiningRankScope)
              : null;
        if (scope === null) {
          throw V2ApiError.invalidRequest();
        }
        const page = readRankPage(input.principal.userId, scope, input);
        const display = Object.freeze({
          anonymousMemberKey: miningRankAnonymousMemberKey,
          ruleKey: miningRankDisplayRuleKey,
          powerRuleKey: miningRankPowerRuleKey,
        });
        const resolution = await baseline();
        const formula = await formulaState(resolution);
        const viewer = input.principal.userId;

        if (scope === "referrals") {
          // A live PostgreSQL fact: it does not wait for a Mining snapshot.
          const after = page.continuation;
          const [rows, standing] = await Promise.all([
            repository.listReferralRanking({
              limit: page.fetchSize,
              ...(after === null
                ? {}
                : {
                    after: {
                      invitedCount: rankCursorNumber(after, "count"),
                      ownerUserId: rankCursorString(after, "owner"),
                    },
                  }),
            }),
            repository.getReferralStanding({ ownerUserId: viewer }),
          ]);
          const items = rows.slice(0, page.pageSize);
          const last = items.at(-1);
          return Object.freeze({
            scope,
            ranking: Object.freeze({
              status: "available" as const,
              scope: "referrals" as const,
              items: Object.freeze(
                items.map((row) => projectRankedReferrer(row, viewer)),
              ),
              participants: standing.participantCount,
              ruleKey: miningReferralRankRuleKey,
            }),
            myPosition: unavailable(miningReasonCodes.rankNotApplicable),
            me:
              standing.position === null || standing.invitedCount === null
                ? null
                : Object.freeze({
                    rank: standing.position,
                    value: String(standing.invitedCount),
                  }),
            nextCursor:
              last === undefined || rows.length <= page.pageSize
                ? null
                : page.next(items.length, {
                    count: last.invitedCount,
                    owner: last.ownerUserId,
                  }),
            snapshot: hasNoMiningSnapshot(resolution)
              ? missingSnapshot(resolution)
              : snapshotProjection(resolution),
            display,
            formula,
            contractVersion: v2ContractVersion,
          });
        }

        // Decision 0148: the users and communities ranks read the newest
        // settled hour, not the snapshot lane; `formula` stays the snapshot
        // baseline state every mining page publishes.
        const epoch = await repository.getLatestRankEpoch();
        if (epoch === null) {
          const reason = unavailable(miningReasonCodes.snapshotNotAvailable);
          return Object.freeze({
            scope,
            ranking: reason,
            myPosition: reason,
            me: null,
            nextCursor: null,
            snapshot: reason,
            display,
            formula,
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = rankEpochSnapshot(epoch);
        if (scope === "communities") {
          const after = page.continuation;
          const [rows, mine] = await Promise.all([
            repository.listCommunityRanking({
              epochId: epoch.epochId,
              limit: page.fetchSize,
              ...(after === null
                ? {}
                : {
                    after: {
                      power: rankCursorString(after, "power"),
                      communityName: rankCursorString(after, "name"),
                      communityId: rankCursorString(after, "community"),
                    },
                  }),
            }),
            repository.getMemberBestCommunityStanding({
              epochId: epoch.epochId,
              ownerUserId: viewer,
            }),
          ]);
          const items = rows.slice(0, page.pageSize);
          const last = items.at(-1);
          return Object.freeze({
            scope,
            ranking: Object.freeze({
              status: "available" as const,
              scope: "communities" as const,
              items: Object.freeze(
                items.map((row) =>
                  Object.freeze({
                    position: row.position,
                    power: row.power,
                    community: Object.freeze({
                      communityId: row.communityId,
                      name: row.communityName,
                      boundAssetId: row.boundAssetId,
                    }),
                    weight: row.weight,
                    participants: row.participantCount,
                    // S316 (optional key, client first): the community logo.
                    avatarRef: row.avatarRef ?? null,
                  }),
                ),
              ),
              participants: items.filter((row) => row.position !== null).length,
            }),
            myPosition: unavailable(miningReasonCodes.rankNotApplicable),
            me:
              mine === null || mine.position === null
                ? null
                : Object.freeze({
                    rank: mine.position,
                    value: mine.power,
                    communityId: mine.communityId,
                  }),
            nextCursor:
              last === undefined || rows.length <= page.pageSize
                ? null
                : page.next(items.length, {
                    power: last.power,
                    name: last.communityName,
                    community: last.communityId,
                  }),
            snapshot,
            display,
            formula,
            contractVersion: v2ContractVersion,
          });
        }
        const after = page.continuation;
        const [rows, standing] = await Promise.all([
          repository.listAccountRanking({
            epochId: epoch.epochId,
            limit: page.fetchSize,
            ...(after === null
              ? {}
              : {
                  after: {
                    totalPower: rankCursorString(after, "power"),
                    ownerUserId: rankCursorString(after, "owner"),
                  },
                }),
          }),
          repository.getEpochAccountStanding({
            epochId: epoch.epochId,
            ownerUserId: viewer,
          }),
        ]);
        const items = rows.slice(0, page.pageSize);
        const last = items.at(-1);
        return Object.freeze({
          scope,
          ranking: Object.freeze({
            status: "available" as const,
            scope: "users" as const,
            items: Object.freeze(
              items.map((row) => projectRankedUser(row, viewer)),
            ),
            participants: standing.participantCount,
          }),
          // An account without a row in the settled hour had no power in it
          // (no holding, no powered invitee): not ranked, never "pending".
          myPosition:
            standing.totalPower === null || standing.position === null
              ? unavailable(miningReasonCodes.rankNotRanked)
              : Object.freeze({
                  status: "available" as const,
                  position: standing.position,
                  power: standing.totalPower,
                }),
          me:
            standing.totalPower === null || standing.position === null
              ? null
              : Object.freeze({
                  rank: standing.position,
                  value: standing.totalPower,
                }),
          nextCursor:
            last === undefined || rows.length <= page.pageSize
              ? null
              : page.next(items.length, {
                  power: last.totalPower,
                  owner: last.ownerUserId,
                }),
          snapshot,
          display,
          formula,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },
    async getCommunity(input) {
      try {
        const record = await repository.getCommunityWeight(input.communityId);
        if (record === null) {
          throw V2ApiError.notFound();
        }
        const weight = projectCommunityWeight(record);
        const community = Object.freeze({
          communityId: record.communityId,
          name: record.communityName,
          boundAssetId: record.boundAssetId,
        });
        const resolution = await baseline();
        if (hasNoMiningSnapshot(resolution)) {
          const reason = missingReason(resolution);
          return Object.freeze({
            community,
            weight,
            communityPower: reason,
            myContribution: reason,
            rank: reason,
            participants: reason,
            snapshot: missingSnapshot(resolution),
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = resolution.snapshot;
        const standing = await repository.getCommunityStanding({
          snapshotId: snapshot.snapshotId,
          configVersion: resolution.formula.configVersion,
          communityId: record.communityId,
        });
        if (standing === null) {
          // No bound asset, or no weight approved under the version in force.
          const reason = unavailable(
            record.boundAssetId === null
              ? miningReasonCodes.communityAssetNotBound
              : record.rosterExcluded === true
                ? miningReasonCodes.poolExcluded
                : miningReasonCodes.communityWeightPendingReview,
          );
          return Object.freeze({
            community,
            weight,
            communityPower: reason,
            myContribution: reason,
            rank: reason,
            participants: reason,
            snapshot: snapshotProjection(resolution),
            contractVersion: v2ContractVersion,
          });
        }
        const myPowers = await repository.listAccountPowers({
          snapshotId: snapshot.snapshotId,
          ownerUserId: input.principal.userId,
        });
        const mine = myPowers.find(
          (row) => row.assetId === standing.boundAssetId,
        );
        return Object.freeze({
          community,
          weight,
          communityPower: decimal(standing.power),
          myContribution:
            mine !== undefined
              ? decimal(mine.power)
              : myPowers.length === 0
                ? await absentReason(input.principal.userId)
                : unavailable(miningReasonCodes.accountNotInSnapshot),
          rank:
            standing.position === null
              ? unavailable(miningReasonCodes.rankNotRanked)
              : Object.freeze({
                  status: "available" as const,
                  position: standing.position,
                  power: standing.power,
                }),
          participants: projectParticipants(standing),
          snapshot: snapshotProjection(resolution),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getRules() {
      try {
        const [versions, resolution] = await Promise.all([
          repository.listFormulaVersions(),
          baseline(),
        ]);
        const approved = versions.find((v) => v.status === "approved") ?? null;
        return Object.freeze({
          approved: approved === null ? null : formulaProjection(approved),
          pendingApproval: Object.freeze(
            versions
              .filter((v) => v.status === "pending_approval")
              .map(formulaProjection),
          ),
          baseline:
            resolution.status === "approved"
              ? Object.freeze({
                  status: "approved" as const,
                  configVersion: resolution.formula.configVersion,
                  effectiveAt: resolution.formula.effectiveAt ?? "",
                  scope: resolution.formula.formula.scope ?? null,
                })
              : baselinePending,
          referral: Object.freeze({
            configVersion: referralRulesConfigVersion,
            effectiveAt: referralRulesEffectiveAt,
            levels: referralRulesV1.levels,
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    referralRules() {
      return referralRulesV1;
    },
  };
  return Object.freeze(service);
}

export function createUnavailableMiningService(): MiningService {
  const unavailableService = () =>
    Promise.reject(V2ApiError.capabilityUnavailable());
  return Object.freeze({
    getSummary: unavailableService,
    getAssets: unavailableService,
    getRewards: unavailableService,
    getRank: unavailableService,
    getCommunity: unavailableService,
    getRules: unavailableService,
    referralRules: () => referralRulesV1,
  });
}
