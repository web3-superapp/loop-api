import { z } from "zod";

/**
 * V2 Mining wire contract (Decision 0036). No formula version is approved,
 * so every power, reward, and rank value is `unavailable` with
 * `MINING_FORMULA_BASELINE_PENDING`; `claimable` is `REWARD_AUTHORITY_PENDING`.
 * The draft formula carries rule text only (03 §19): no weight number, no
 * reward budget, no yield promise.
 */

export const miningDraftFormulaVersion = "miningFormulaV1-draft" as const;

export const miningReasonCodes = Object.freeze({
  formulaBaselinePending: "MINING_FORMULA_BASELINE_PENDING",
  rewardAuthorityPending: "REWARD_AUTHORITY_PENDING",
  snapshotNotAvailable: "MINING_SNAPSHOT_NOT_AVAILABLE",
  communityWeightPendingReview: "COMMUNITY_WEIGHT_PENDING_REVIEW",
  referralBoostPending: "MINING_FORMULA_BASELINE_PENDING",
  priceNotFresh: "MINING_PRICE_NOT_FRESH",
  noBalanceInputs: "MINING_NO_BALANCE_INPUTS",
} as const);

export const miningFormulaStatuses = [
  "pending_approval",
  "approved",
  "retired",
] as const;
export type MiningFormulaStatus = (typeof miningFormulaStatuses)[number];

export const communityWeightStatuses = ["pending_review", "approved"] as const;
export type CommunityWeightStatus = (typeof communityWeightStatuses)[number];

export const miningRankScopes = ["users", "communities"] as const;
export type MiningRankScope = (typeof miningRankScopes)[number];

/** Anonymous member display key used whenever the alias may not be shown. */
export const miningRankAnonymousMemberKey = "mining.rank.anonymousMember";

export const unsignedDecimalPatternSource =
  "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$";
export const configVersionPatternSource = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const priceVersionPatternSource = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$";

const unsignedDecimalPattern = new RegExp(unsignedDecimalPatternSource);
const configVersionPattern = new RegExp(configVersionPatternSource);

/**
 * Formula document. `assetWeights` maps canonical asset IDs to decimal
 * weight strings and is empty in the draft; the community weight table
 * supplies reviewed weights per bound asset at snapshot time.
 */
export interface MiningFormulaDocument {
  readonly kind: "holding_times_reference_price_times_weight";
  readonly expressionKey: string;
  readonly dailyOutputKey: string;
  readonly assetWeights: Readonly<Record<string, string>>;
  readonly referralBoost: { readonly status: "pending_approval" | "approved" };
}

export interface MiningWeightRangeDocument {
  readonly loop: {
    readonly status: "pending_approval" | "approved";
    readonly descriptionKey: string;
  };
  readonly community: {
    readonly status: "pending_approval" | "approved";
    readonly descriptionKey: string;
  };
  readonly reviewFactorKeys: readonly string[];
}

export interface MiningPriceGuardRule {
  readonly ruleKey: string;
  readonly status: "pending_approval" | "approved";
}

const statusSchema = z.enum(["pending_approval", "approved"]);

export const miningFormulaDocumentSchema = z
  .object({
    kind: z.literal("holding_times_reference_price_times_weight"),
    expressionKey: z.string().min(1).max(128),
    dailyOutputKey: z.string().min(1).max(128),
    assetWeights: z.record(
      z.string().regex(/^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/),
      z.string().regex(unsignedDecimalPattern),
    ),
    referralBoost: z.object({ status: statusSchema }).strict(),
  })
  .strict();

export const miningWeightRangeDocumentSchema = z
  .object({
    loop: z
      .object({ status: statusSchema, descriptionKey: z.string().min(1) })
      .strict(),
    community: z
      .object({ status: statusSchema, descriptionKey: z.string().min(1) })
      .strict(),
    reviewFactorKeys: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();

export const miningPriceGuardRulesSchema = z
  .array(
    z
      .object({ ruleKey: z.string().min(1).max(128), status: statusSchema })
      .strict(),
  )
  .max(16);

export function isUnsignedDecimalString(value: unknown): value is string {
  return typeof value === "string" && unsignedDecimalPattern.test(value);
}

export function isConfigVersion(value: unknown): value is string {
  return typeof value === "string" && configVersionPattern.test(value);
}

export interface UnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export function unavailable(reasonCode: string): UnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}
