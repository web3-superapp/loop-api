import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  referralRulesConfigVersion,
  referralRulesEffectiveAt,
  referralRulesV1,
  type ReferralRulesProjection,
} from "../community/referral-rules.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  miningRankAnonymousMemberKey,
  miningRankScopes,
  miningReasonCodes,
  unavailable,
  type MiningFormulaStatus,
  type MiningPriceGuardRule,
  type MiningRankScope,
  type MiningWeightRangeDocument,
  type UnavailableProjection,
} from "./mining-contract.js";
import {
  MiningRepositoryUnavailableError,
  type MiningFormulaRecord,
  type MiningRepository,
  type MiningSnapshotRecord,
} from "./mining-repository.js";

/**
 * Mining read service (Decision 0036). With no approved formula every power,
 * reward, and rank is `unavailable`; the rules page shows the pending
 * version and marks it as such. The referral rules snapshot moves here from
 * the community module (path preserved).
 */

export interface MiningFormulaProjection {
  readonly configVersion: string;
  readonly status: MiningFormulaStatus;
  readonly effectiveAt: string | null;
  readonly approvedAt: string | null;
  readonly expressionKey: string;
  readonly dailyOutputKey: string;
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

export interface MiningSummaryResource {
  readonly power: UnavailableProjection;
  readonly networkPower: UnavailableProjection;
  readonly estimatedToday: UnavailableProjection;
  readonly accumulated: UnavailableProjection;
  readonly claimable: UnavailableProjection;
  readonly referralBoost: UnavailableProjection;
  readonly formula: {
    readonly status: "unavailable";
    readonly reasonCode: string;
    readonly pendingVersion: string | null;
  };
  readonly snapshot: MiningSnapshotProjection | UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningAssetsResource {
  readonly totalPower: UnavailableProjection;
  readonly included: readonly never[];
  readonly excluded: readonly never[];
  readonly source: UnavailableProjection;
  readonly referencePrice: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningRewardsResource {
  readonly claimable: UnavailableProjection;
  readonly claimExecutable: false;
  readonly estimatedToday: UnavailableProjection;
  readonly accumulated: UnavailableProjection;
  readonly ledger: readonly never[];
  readonly source: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningRankResource {
  readonly scope: MiningRankScope;
  readonly ranking: UnavailableProjection;
  readonly myPosition: UnavailableProjection;
  readonly snapshot: MiningSnapshotProjection | UnavailableProjection;
  readonly display: {
    readonly anonymousMemberKey: typeof miningRankAnonymousMemberKey;
    readonly ruleKey: "mining.rank.display.aliasOrAnonymous";
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningCommunityResource {
  readonly community: {
    readonly communityId: string;
    readonly name: string;
    readonly boundAssetId: string | null;
  };
  readonly weight:
    | {
        readonly status: "approved";
        readonly value: string;
        readonly configVersion: string;
        readonly reviewedAt: string;
      }
    | {
        readonly status: "unavailable";
        readonly reasonCode: string;
        readonly reviewStatus: "pending_review";
      };
  readonly communityPower: UnavailableProjection;
  readonly myContribution: UnavailableProjection;
  readonly rank: UnavailableProjection;
  readonly participants: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MiningRulesResource {
  readonly approved: MiningFormulaProjection | null;
  readonly pendingApproval: readonly MiningFormulaProjection[];
  readonly baseline: UnavailableProjection;
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
  getRank(input: { readonly scope?: unknown }): Promise<MiningRankResource>;
  getCommunity(input: {
    readonly communityId: string;
  }): Promise<MiningCommunityResource>;
  getRules(): Promise<MiningRulesResource>;
  referralRules(): ReferralRulesProjection;
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof MiningRepositoryUnavailableError) {
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
    effectiveAt: record.effectiveAt,
    approvedAt: record.approvedAt,
    expressionKey: record.formula.expressionKey,
    dailyOutputKey: record.formula.dailyOutputKey,
    weightRange: record.weightRange,
    priceGuardRules: record.priceGuardRules,
    referralBoost: record.formula.referralBoost,
  });
}

function snapshotProjection(
  record: MiningSnapshotRecord | null,
): MiningSnapshotProjection | UnavailableProjection {
  if (record === null) {
    return unavailable(miningReasonCodes.snapshotNotAvailable);
  }
  return Object.freeze({
    snapshotId: record.snapshotId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash,
    formulaVersion: record.formulaVersion,
    priceVersion: record.priceVersion,
    computedAt: record.computedAt,
  });
}

const baseline = unavailable(miningReasonCodes.formulaBaselinePending);

export function createMiningService(dependencies: {
  readonly repository: MiningRepository;
}): MiningService {
  const { repository } = dependencies;

  async function pendingVersion(): Promise<string | null> {
    const versions = await repository.listFormulaVersions();
    return (
      versions.find((v) => v.status === "pending_approval")?.configVersion ??
      null
    );
  }

  return Object.freeze({
    async getSummary() {
      try {
        // An approved formula never exists in this step (only the operator
        // script outside production can create one); even then no reward
        // authority exists, so every number stays unavailable until the D19
        // settlement contract is delivered on top of the snapshot lane.
        const [pending, snapshot] = await Promise.all([
          pendingVersion(),
          repository.getLatestSnapshot(),
        ]);
        return Object.freeze({
          power: baseline,
          networkPower: baseline,
          estimatedToday: baseline,
          accumulated: baseline,
          claimable: unavailable(miningReasonCodes.rewardAuthorityPending),
          referralBoost: unavailable(miningReasonCodes.referralBoostPending),
          formula: Object.freeze({
            status: "unavailable" as const,
            reasonCode: miningReasonCodes.formulaBaselinePending,
            pendingVersion: pending,
          }),
          snapshot: snapshotProjection(snapshot),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    getAssets() {
      return Promise.resolve(
        Object.freeze({
          totalPower: baseline,
          included: Object.freeze([]),
          excluded: Object.freeze([]),
          source: baseline,
          referencePrice: baseline,
          contractVersion: v2ContractVersion,
        }),
      );
    },

    getRewards() {
      return Promise.resolve(
        Object.freeze({
          claimable: unavailable(miningReasonCodes.rewardAuthorityPending),
          claimExecutable: false as const,
          estimatedToday: baseline,
          accumulated: baseline,
          ledger: Object.freeze([]),
          source: unavailable(miningReasonCodes.rewardAuthorityPending),
          contractVersion: v2ContractVersion,
        }),
      );
    },

    async getRank(input: Parameters<MiningService["getRank"]>[0]) {
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
        const snapshot = await repository.getLatestSnapshot();
        return Object.freeze({
          scope,
          ranking: baseline,
          myPosition: baseline,
          snapshot: snapshotProjection(snapshot),
          display: Object.freeze({
            anonymousMemberKey: miningRankAnonymousMemberKey,
            ruleKey: "mining.rank.display.aliasOrAnonymous" as const,
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunity(input: Parameters<MiningService["getCommunity"]>[0]) {
      try {
        const record = await repository.getCommunityWeight(input.communityId);
        if (record === null) {
          throw V2ApiError.notFound();
        }
        const weight =
          record.status === "approved" &&
          record.weight !== null &&
          record.configVersion !== null &&
          record.reviewedAt !== null
            ? Object.freeze({
                status: "approved" as const,
                value: record.weight,
                configVersion: record.configVersion,
                reviewedAt: record.reviewedAt,
              })
            : Object.freeze({
                status: "unavailable" as const,
                reasonCode: miningReasonCodes.communityWeightPendingReview,
                reviewStatus: "pending_review" as const,
              });
        return Object.freeze({
          community: Object.freeze({
            communityId: record.communityId,
            name: record.communityName,
            boundAssetId: record.boundAssetId,
          }),
          weight,
          communityPower: baseline,
          myContribution: baseline,
          rank: baseline,
          participants: baseline,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getRules() {
      try {
        const versions = await repository.listFormulaVersions();
        const approved = versions.find((v) => v.status === "approved") ?? null;
        return Object.freeze({
          approved: approved === null ? null : formulaProjection(approved),
          pendingApproval: Object.freeze(
            versions
              .filter((v) => v.status === "pending_approval")
              .map(formulaProjection),
          ),
          baseline,
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
  });
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
