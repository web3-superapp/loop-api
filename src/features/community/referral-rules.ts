import { v2ContractVersion } from "../meta/product-policy.js";
import {
  unavailable,
  type UnavailableProjection,
} from "./community-contract.js";

/**
 * Versioned static referral rule snapshot (03 §7.2, main-agent ruling
 * 2026-09-07). It is a read-only product constant published under the
 * community module: no `mining` module exists yet, no relationship data is
 * stored before D19, and the rule is a Mining Power boost, never revenue,
 * commission, or a rebate.
 *
 * Percentages are canonical decimal strings, never JavaScript numbers.
 */

export const referralRulesConfigVersion = "referralRulesV1" as const;
export const referralRulesEffectiveAt = "2026-09-01T00:00:00.000Z" as const;

export interface ReferralLevelRule {
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly boostPercent: string;
  readonly descriptionKey: string;
}

export interface ReferralRulesProjection {
  readonly configVersion: typeof referralRulesConfigVersion;
  readonly effectiveAt: typeof referralRulesEffectiveAt;
  readonly appliesTo: "miningPower";
  readonly levels: readonly ReferralLevelRule[];
  readonly edges: UnavailableProjection;
  readonly inviteCode: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

const levels: readonly ReferralLevelRule[] = Object.freeze([
  Object.freeze({
    level: 1,
    boostPercent: "10",
    descriptionKey: "mining.referral.level1",
  }),
  Object.freeze({
    level: 2,
    boostPercent: "5",
    descriptionKey: "mining.referral.level2",
  }),
  Object.freeze({
    level: 3,
    boostPercent: "3",
    descriptionKey: "mining.referral.level3",
  }),
  Object.freeze({
    level: 4,
    boostPercent: "2",
    descriptionKey: "mining.referral.level4",
  }),
  Object.freeze({
    level: 5,
    boostPercent: "1",
    descriptionKey: "mining.referral.level5",
  }),
] as const satisfies readonly ReferralLevelRule[]);

export const referralRulesV1: ReferralRulesProjection = Object.freeze({
  configVersion: referralRulesConfigVersion,
  effectiveAt: referralRulesEffectiveAt,
  appliesTo: "miningPower",
  levels,
  edges: unavailable("REFERRAL_GRAPH_DEFERRED"),
  inviteCode: unavailable("INVITE_CODE_DEFERRED"),
  contractVersion: v2ContractVersion,
});
