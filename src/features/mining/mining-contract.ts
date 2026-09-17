import { z } from "zod";

/**
 * V2 Mining wire contract (Decisions 0036, 0043, and 0046). Without an
 * approved and effective formula version every power, reward, and rank
 * value is `unavailable` with `MINING_FORMULA_BASELINE_PENDING`; that code
 * means exactly "no version in force" and is never emitted by any slot
 * while a version is in force (Decision 0046). `claimable` is always
 * `REWARD_AUTHORITY_PENDING`; the referral boost is
 * `MINING_REFERRAL_BOOST_PENDING` until a version approves it. The product
 * draft carries rule text only (03 §19); the development baseline
 * (Decision 0043) carries explicit placeholder parameters that name
 * themselves as such.
 */

export const miningDraftFormulaVersion = "miningFormulaV1-draft" as const;

export const miningReasonCodes = Object.freeze({
  formulaBaselinePending: "MINING_FORMULA_BASELINE_PENDING",
  rewardAuthorityPending: "REWARD_AUTHORITY_PENDING",
  snapshotNotAvailable: "MINING_SNAPSHOT_NOT_AVAILABLE",
  /** The latest snapshot was computed under a version that is no longer the approved one. */
  snapshotStale: "MINING_SNAPSHOT_STALE",
  communityWeightPendingReview: "COMMUNITY_WEIGHT_PENDING_REVIEW",
  /** Two communities bind the same asset with an approved weight. */
  communityWeightAmbiguous: "COMMUNITY_WEIGHT_AMBIGUOUS",
  communityAssetNotBound: "COMMUNITY_ASSET_NOT_BOUND",
  assetWeightNotConfigured: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
  /**
   * The referral boost itself is not approved by the version in force (or
   * there is none). Says nothing about the rest of the page (Decision 0046).
   */
  referralBoostPending: "MINING_REFERRAL_BOOST_PENDING",
  priceNotFresh: "MINING_PRICE_NOT_FRESH",
  /** The Provider priced the asset through a proxy the version does not declare. */
  priceProxyNotDeclared: "MINING_PRICE_PROXY_NOT_DECLARED",
  noBalanceInputs: "MINING_NO_BALANCE_INPUTS",
  /** The account has no balance row in the snapshot (no active wallet). */
  accountNotInSnapshot: "MINING_ACCOUNT_NOT_IN_SNAPSHOT",
  /** Share of network power is undefined while the network total is zero. */
  networkPowerZero: "MINING_NETWORK_POWER_ZERO",
  /** The account has no positive power in the snapshot, so it holds no position. */
  rankNotRanked: "MINING_RANK_NOT_RANKED",
  /** `myPosition` has no meaning for the community scope. */
  rankNotApplicable: "MINING_RANK_NOT_APPLICABLE",
  /** The subject keeps `miningPowerVisibility: self`. */
  powerPrivate: "MINING_POWER_PRIVATE",
  /** The daily output budget of the approved version is not configured. */
  dailyOutputNotConfigured: "MINING_DAILY_OUTPUT_NOT_CONFIGURED",
  runtimeUnavailable: "MINING_RUNTIME_UNAVAILABLE",
} as const);

/**
 * The scope a formula version declares about itself. `development_baseline`
 * is the Decision 0043 placeholder: it lets the Development stack compute,
 * and it is refused as a product fact by every production path.
 */
export const miningFormulaScopes = ["development_baseline"] as const;
export type MiningFormulaScope = (typeof miningFormulaScopes)[number];

export const miningDailyOutputUnitKey =
  "mining.rules.dailyOutput.unit.loopTokenPending" as const;

export const miningFormulaStatuses = [
  "pending_approval",
  "approved",
  "retired",
] as const;
export type MiningFormulaStatus = (typeof miningFormulaStatuses)[number];

export const communityWeightStatuses = ["pending_review", "approved"] as const;
export type CommunityWeightStatus = (typeof communityWeightStatuses)[number];

/**
 * What an `unavailable` community weight says about its review: a bound
 * community is `pending_review`; a community without a bound asset has
 * nothing to review, so it is `not_applicable` (Decision 0046).
 */
export const communityWeightReviewStatuses = [
  "pending_review",
  "not_applicable",
] as const;
export type CommunityWeightReviewStatus =
  (typeof communityWeightReviewStatuses)[number];

export const miningRankScopes = ["users", "communities"] as const;
export type MiningRankScope = (typeof miningRankScopes)[number];

/** Anonymous member display key used whenever the alias may not be shown. */
export const miningRankAnonymousMemberKey = "mining.rank.anonymousMember";
/**
 * Rank display rule (Decision 0049): anonymous mode alone decides whether
 * others see the alias; the viewer always sees their own alias.
 */
export const miningRankDisplayRuleKey = "mining.rank.display.anonymousModeOnly";
/**
 * Rank power rule (Decision 0049): `mining_power_visibility` alone decides
 * whether others see the number; the position is always public.
 */
export const miningRankPowerRuleKey = "mining.rank.power.ownerVisibility";

export const unsignedDecimalPatternSource =
  "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$";
export const configVersionPatternSource = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const priceVersionPatternSource = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$";

const unsignedDecimalPattern = new RegExp(unsignedDecimalPatternSource);
const configVersionPattern = new RegExp(configVersionPatternSource);

/**
 * The only economic parameter of a formula version: the network-wide daily
 * output the share-of-network-power rule distributes. The development
 * baseline carries it as an explicit placeholder; a product version will
 * replace the status once 02 freezes the budget.
 */
export interface MiningDailyOutputDocument {
  readonly status: "development_placeholder";
  /** Unsigned decimal string per day, in the unit named by `unitKey`. */
  readonly budget: string;
  readonly unitKey: typeof miningDailyOutputUnitKey;
}

/** How a power row's reference price was observed (Decision 0044). */
export const miningReferencePriceQualities = ["fresh", "proxied"] as const;
export type MiningReferencePriceQuality =
  (typeof miningReferencePriceQualities)[number];

/**
 * Formula document. `assetWeights` maps canonical asset IDs to decimal
 * weight strings and is empty in the product draft; the development
 * baseline lists every registered asset at weight 1. A community weight is
 * a second factor on the community's bound asset (Decision 0043), never a
 * replacement for the asset weight. `priceProxies` declares, per asset, the
 * one asset whose Provider price may stand in for it (Decision 0044: native
 * BNB ← WBNB); an undeclared proxy is refused.
 */
export interface MiningFormulaDocument {
  readonly kind: "holding_times_reference_price_times_weight";
  readonly expressionKey: string;
  readonly dailyOutputKey: string;
  readonly assetWeights: Readonly<Record<string, string>>;
  readonly referralBoost: { readonly status: "pending_approval" | "approved" };
  /** Absent on the product draft; present on the development baseline. */
  readonly scope?: MiningFormulaScope | undefined;
  readonly dailyOutput?: MiningDailyOutputDocument | undefined;
  readonly priceProxies?: Readonly<Record<string, string>> | undefined;
}

/** Inclusive decimal bounds a reviewed community weight must satisfy. */
export interface MiningCommunityWeightRange {
  readonly min: string;
  readonly max: string;
}

export interface MiningWeightRangeDocument {
  readonly loop: {
    readonly status: "pending_approval" | "approved";
    readonly descriptionKey: string;
  };
  readonly community: {
    readonly status: "pending_approval" | "approved";
    readonly descriptionKey: string;
    /** Present only once a version pins the community range. */
    readonly range?: MiningCommunityWeightRange | undefined;
  };
  readonly reviewFactorKeys: readonly string[];
}

export interface MiningPriceGuardRule {
  readonly ruleKey: string;
  readonly status: "pending_approval" | "approved";
}

const statusSchema = z.enum(["pending_approval", "approved"]);

const decimalSchema = z.string().regex(unsignedDecimalPattern);
const assetIdSchema = z
  .string()
  .regex(/^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/);

export const miningDailyOutputDocumentSchema = z
  .object({
    status: z.literal("development_placeholder"),
    budget: decimalSchema,
    unitKey: z.literal(miningDailyOutputUnitKey),
  })
  .strict();

export const miningFormulaDocumentSchema = z
  .object({
    kind: z.literal("holding_times_reference_price_times_weight"),
    expressionKey: z.string().min(1).max(128),
    dailyOutputKey: z.string().min(1).max(128),
    assetWeights: z.record(assetIdSchema, decimalSchema),
    referralBoost: z.object({ status: statusSchema }).strict(),
    scope: z.enum(miningFormulaScopes).optional(),
    dailyOutput: miningDailyOutputDocumentSchema.optional(),
    priceProxies: z
      .record(assetIdSchema, assetIdSchema)
      .refine(
        (proxies) =>
          Object.entries(proxies).every(([asset, proxy]) => asset !== proxy),
        { message: "an asset cannot proxy itself" },
      )
      .optional(),
  })
  .strict();

export const miningCommunityWeightRangeSchema = z
  .object({ min: decimalSchema, max: decimalSchema })
  .strict()
  .refine((range) => compareUnsignedDecimals(range.min, range.max) <= 0, {
    message: "min must not exceed max",
  });

export const miningWeightRangeDocumentSchema = z
  .object({
    loop: z
      .object({ status: statusSchema, descriptionKey: z.string().min(1) })
      .strict(),
    community: z
      .object({
        status: statusSchema,
        descriptionKey: z.string().min(1),
        range: miningCommunityWeightRangeSchema.optional(),
      })
      .strict(),
    reviewFactorKeys: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();

/**
 * Exact comparison of two unsigned decimal strings with scaled integers; no
 * floating point is ever produced.
 */
export function compareUnsignedDecimals(
  left: string,
  right: string,
): -1 | 0 | 1 {
  if (
    !unsignedDecimalPattern.test(left) ||
    !unsignedDecimalPattern.test(right)
  ) {
    throw new Error("Invalid unsigned decimal");
  }
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const b = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `weight` lies inside the inclusive `[min, max]` range. */
export function isCommunityWeightWithinRange(
  weight: string,
  range: MiningCommunityWeightRange,
): boolean {
  return (
    isUnsignedDecimalString(weight) &&
    compareUnsignedDecimals(weight, range.min) >= 0 &&
    compareUnsignedDecimals(weight, range.max) <= 0
  );
}

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
