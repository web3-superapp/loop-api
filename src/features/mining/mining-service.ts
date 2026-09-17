import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
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
  hasNoMiningSnapshot,
  resolveMiningBaseline,
  type MiningBaselineResolution,
  type MiningBaselineWithoutSnapshot,
} from "./mining-baseline.js";
import {
  miningRankAnonymousMemberKey,
  miningRankDisplayRuleKey,
  miningRankPowerRuleKey,
  miningRankScopes,
  miningReasonCodes,
  unavailable,
  type MiningDailyOutputDocument,
  type MiningFormulaScope,
  type MiningFormulaStatus,
  type MiningPriceGuardRule,
  type MiningRankScope,
  type MiningReferencePriceQuality,
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
  type MiningRankedAccountRecord,
  type MiningRepository,
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

export const miningRankLimit = 100;

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

export interface MiningSnapshotProjection {
  readonly snapshotId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly formulaVersion: string;
  readonly priceVersion: string;
  readonly computedAt: string;
}

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
  readonly snapshot: MiningSnapshotProjection | UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningIncludedAssetProjection {
  readonly assetId: string;
  /** The registry's on-chain `symbol()`; null only without a registry row. */
  readonly symbol: string | null;
  readonly holding: string;
  readonly referencePriceUsd: string;
  /** `proxied` = the declared proxy asset's price (Decision 0044). */
  readonly referencePriceQuality: MiningReferencePriceQuality;
  readonly referencePriceProxyAssetId: string | null;
  readonly weight: string;
  readonly power: string;
  readonly blockNumber: string;
}

export interface MiningExcludedAssetProjection {
  readonly assetId: string;
  /** The registry's on-chain `symbol()`; null only without a registry row. */
  readonly symbol: string | null;
  readonly reasonCode: string;
}

export interface MiningAssetsResource {
  readonly totalPower: MiningDecimalOrUnavailable;
  readonly included: readonly MiningIncludedAssetProjection[];
  readonly excluded: readonly MiningExcludedAssetProjection[];
  readonly source: MiningSnapshotProjection | UnavailableProjection;
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

export type MiningRankingProjection =
  | {
      readonly status: "available";
      readonly scope: "users";
      readonly items: readonly MiningRankedUserProjection[];
      readonly participants: number;
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
  readonly snapshot: MiningSnapshotProjection | UnavailableProjection;
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
  readonly snapshot: MiningSnapshotProjection | UnavailableProjection;
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

function formulaProjection(
  record: MiningFormulaRecord,
): MiningFormulaProjection {
  return Object.freeze({
    configVersion: record.configVersion,
    status: record.status,
    scope: record.formula.scope ?? null,
    effectiveAt: record.effectiveAt,
    approvedAt: record.approvedAt,
    expressionKey: record.formula.expressionKey,
    dailyOutputKey: record.formula.dailyOutputKey,
    assetWeights: record.formula.assetWeights,
    dailyOutput: record.formula.dailyOutput ?? null,
    weightRange: record.weightRange,
    priceGuardRules: record.priceGuardRules,
    referralBoost: record.formula.referralBoost,
  });
}

function snapshotProjection(
  record: MiningSnapshotRecord,
): MiningSnapshotProjection {
  return Object.freeze({
    snapshotId: record.snapshotId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash,
    formulaVersion: record.formulaVersion,
    priceVersion: record.priceVersion,
    computedAt: record.computedAt,
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
): MiningEstimateOrUnavailable {
  if (accountPower === null) {
    return unavailable(miningReasonCodes.accountNotInSnapshot);
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
function projectRankedUser(
  row: MiningRankedAccountRecord,
  viewerUserId: string,
): MiningRankedUserProjection {
  const isSelf = row.ownerUserId === viewerUserId;
  const display: MiningRankDisplayProjection =
    row.alias !== null &&
    row.publicProfileId !== null &&
    (isSelf || !row.anonymousMode)
      ? Object.freeze({
          kind: "alias" as const,
          alias: row.alias,
          publicProfileId: row.publicProfileId,
          audience: row.anonymousMode
            ? ("self" as const)
            : ("everyone" as const),
        })
      : Object.freeze({
          kind: "anonymous" as const,
          labelKey: miningRankAnonymousMemberKey,
        });
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
            snapshot: reason,
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = resolution.snapshot;
        const standing = await repository.getAccountStanding({
          snapshotId: snapshot.snapshotId,
          ownerUserId: input.principal.userId,
        });
        return Object.freeze({
          power:
            standing === null
              ? unavailable(miningReasonCodes.accountNotInSnapshot)
              : decimal(standing.totalPower),
          networkPower: decimal(snapshot.totalPower),
          estimatedToday: estimateProjection(
            resolution.formula,
            snapshot,
            standing?.totalPower ?? null,
          ),
          accumulated: rewardAuthorityPending,
          claimable: rewardAuthorityPending,
          referralBoost: unavailable(miningReasonCodes.referralBoostPending),
          formula,
          snapshot: snapshotProjection(snapshot),
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
            source: reason,
            referencePrice: reason,
            formula,
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
        // inputs the lane used (weight first, then the price guard).
        const excluded = excludedIds.map((assetId) => {
          const selection = selectMiningWeight(
            assetId,
            resolution.formula.formula,
            communityWeights,
          );
          return Object.freeze({
            assetId,
            symbol: symbols.get(assetId) ?? null,
            reasonCode:
              selection.kind === "skip"
                ? selection.reasonCode
                : miningReasonCodes.priceNotFresh,
          });
        });
        return Object.freeze({
          totalPower:
            standing === null
              ? unavailable(miningReasonCodes.accountNotInSnapshot)
              : decimal(standing.totalPower),
          included: Object.freeze(
            powers.map((row) =>
              Object.freeze({
                assetId: row.assetId,
                symbol: symbols.get(row.assetId) ?? null,
                holding: row.holding,
                referencePriceUsd: row.referencePriceUsd,
                referencePriceQuality: row.referencePriceQuality,
                referencePriceProxyAssetId: row.referencePriceProxyAssetId,
                weight: row.weight,
                power: row.power,
                blockNumber: row.blockNumber,
              }),
            ),
          ),
          excluded: Object.freeze(excluded),
          source: snapshotProjection(snapshot),
          referencePrice: Object.freeze({
            status: "available" as const,
            priceVersion: snapshot.priceVersion,
          }),
          formula,
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
        const display = Object.freeze({
          anonymousMemberKey: miningRankAnonymousMemberKey,
          ruleKey: miningRankDisplayRuleKey,
          powerRuleKey: miningRankPowerRuleKey,
        });
        const resolution = await baseline();
        const formula = await formulaState(resolution);
        if (hasNoMiningSnapshot(resolution)) {
          const reason = missingReason(resolution);
          return Object.freeze({
            scope,
            ranking: reason,
            myPosition: reason,
            snapshot: reason,
            display,
            formula,
            contractVersion: v2ContractVersion,
          });
        }
        const snapshot = resolution.snapshot;
        if (scope === "communities") {
          const rows = await repository.listCommunityRanking({
            snapshotId: snapshot.snapshotId,
            configVersion: resolution.formula.configVersion,
            limit: miningRankLimit,
          });
          return Object.freeze({
            scope,
            ranking: Object.freeze({
              status: "available" as const,
              scope: "communities" as const,
              items: Object.freeze(
                rows.map((row) =>
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
                  }),
                ),
              ),
              participants: rows.filter((row) => row.position !== null).length,
            }),
            myPosition: unavailable(miningReasonCodes.rankNotApplicable),
            snapshot: snapshotProjection(snapshot),
            display,
            formula,
            contractVersion: v2ContractVersion,
          });
        }
        const [rows, standing] = await Promise.all([
          repository.listAccountRanking({
            snapshotId: snapshot.snapshotId,
            limit: miningRankLimit,
          }),
          repository.getAccountStanding({
            snapshotId: snapshot.snapshotId,
            ownerUserId: input.principal.userId,
          }),
        ]);
        return Object.freeze({
          scope,
          ranking: Object.freeze({
            status: "available" as const,
            scope: "users" as const,
            items: Object.freeze(
              rows.map((row) => projectRankedUser(row, input.principal.userId)),
            ),
            participants: standing?.participantCount ?? 0,
          }),
          myPosition:
            standing === null
              ? unavailable(miningReasonCodes.accountNotInSnapshot)
              : standing.position === null
                ? unavailable(miningReasonCodes.rankNotRanked)
                : Object.freeze({
                    status: "available" as const,
                    position: standing.position,
                    power: standing.totalPower,
                  }),
          snapshot: snapshotProjection(snapshot),
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
            snapshot: reason,
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
              : miningReasonCodes.communityWeightPendingReview,
          );
          return Object.freeze({
            community,
            weight,
            communityPower: reason,
            myContribution: reason,
            rank: reason,
            participants: reason,
            snapshot: snapshotProjection(snapshot),
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
            mine === undefined
              ? unavailable(miningReasonCodes.accountNotInSnapshot)
              : decimal(mine.power),
          rank:
            standing.position === null
              ? unavailable(miningReasonCodes.rankNotRanked)
              : Object.freeze({
                  status: "available" as const,
                  position: standing.position,
                  power: standing.power,
                }),
          participants: projectParticipants(standing),
          snapshot: snapshotProjection(snapshot),
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
