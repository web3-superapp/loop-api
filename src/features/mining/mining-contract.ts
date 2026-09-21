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
  /** The Provider fact is fresh but lists no pair in which the asset is the base token (Decision 0057). */
  pricePairNotFound: "MINING_PRICE_PAIR_NOT_FOUND",
  /** The Provider priced the asset through a proxy the version does not declare. */
  priceProxyNotDeclared: "MINING_PRICE_PROXY_NOT_DECLARED",
  noBalanceInputs: "MINING_NO_BALANCE_INPUTS",
  /**
   * The newest run under the version in force could not value at least one
   * positive weighted holding, so nothing was published from it
   * (Decision 0057). Emitted on every number only while no complete
   * snapshot exists under that version.
   */
  snapshotIncomplete: "MINING_SNAPSHOT_INCOMPLETE",
  /** Default `invalidation_reason` for a snapshot the old writer published while a holding was unread (Decision 0057). */
  snapshotPublishedIncomplete: "MINING_SNAPSHOT_PUBLISHED_INCOMPLETE",
  /** The account has no balance row in the snapshot and no active wallet. */
  accountNotInSnapshot: "MINING_ACCOUNT_NOT_IN_SNAPSHOT",
  /**
   * The account has an active wallet but no complete snapshot under the
   * version in force includes it yet (Decision 0057): the wallet was
   * observed after the snapshot, or its balances have not been observed at
   * all. Shown after the next complete snapshot that includes it.
   */
  snapshotPending: "MINING_SNAPSHOT_PENDING",
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

/**
 * What a `mining_snapshots` row is (Decision 0057). Only `complete` rows are
 * read as the latest snapshot; `incomplete` rows record which holdings could
 * not be valued and carry no numbers; `invalidated` rows were withdrawn by
 * an operator after the fact.
 */
export const miningSnapshotStatuses = [
  "complete",
  "incomplete",
  "invalidated",
] as const;
export type MiningSnapshotStatus = (typeof miningSnapshotStatuses)[number];

/**
 * Where the observed balances behind a number came from (Decision 0061).
 * `chain` is an RPC observation of a real address — the only kind a
 * production stack can ever produce. `mock_seed` is a Development holding
 * written by `ops/seed-mock.sh --holdings` so the formula can be checked
 * against holdings nobody has to buy; `mixed` is a snapshot that counted
 * both. It is published so a client can say a number includes
 * demonstration holdings instead of presenting it as an on-chain fact.
 */
export const miningHoldingsSources = ["chain", "mock_seed", "mixed"] as const;
export type MiningHoldingsSource = (typeof miningHoldingsSources)[number];

/** Where one observed balance row came from; `mixed` is a snapshot-level word. */
export const walletBalanceSources = ["chain", "mock_seed"] as const;
export type WalletBalanceSource = (typeof walletBalanceSources)[number];

/** One holding a run could not value: the asset and the price reason. */
export interface MiningUnreadInput {
  readonly assetId: string;
  readonly reasonCode: string;
}

export const miningUnreadInputSchema = z
  .object({
    assetId: z
      .string()
      .regex(/^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  })
  .strict();
export const miningUnreadInputsSchema = z.array(miningUnreadInputSchema);
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

/**
 * How a power row's reference price was observed (Decisions 0044 and 0059).
 *
 * - `fresh`    — the asset is the base token of the pair that was read.
 * - `proxied`  — the price of the proxy asset the version declares
 *                (native BNB via WBNB).
 * - `derived`  — the asset is the *quote* token of the pair that was read
 *                and the price is `priceUsd / priceNative` of that pair,
 *                accepted only under a reference pricing rule the version
 *                declares and only inside that rule's guard band.
 */
export const miningReferencePriceQualities = [
  "fresh",
  "proxied",
  "derived",
] as const;
export type MiningReferencePriceQuality =
  (typeof miningReferencePriceQualities)[number];

/**
 * Reference pricing rule (Decision 0059): what a formula version declares
 * about how one asset may be priced when the base-token rule of Decision
 * 0036 finds nothing.
 *
 * - `stable` — the asset is pegged; the price may be inverted out of a pair
 *   in which the asset is the quote token, and is accepted only when it
 *   lands within `guardBps` of `pegUsd`. The peg itself is never published
 *   as a price: outside the band the holding stays unread.
 * - `pair` — the price comes from one declared pair, read by its own
 *   address. The asset must be that pair's base or quote token; when it is
 *   the quote token the price is inverted and the rule must also declare
 *   `pegUsd` (an inversion with nothing to compare against cannot be
 *   guarded, and an unguarded derived price is refused).
 */
export type MiningReferencePricingRule =
  | {
      readonly kind: "stable";
      /** Positive decimal string the derived price must stay close to. */
      readonly pegUsd: string;
      /** Half-width of the accepted band, in basis points of `pegUsd`. */
      readonly guardBps: number;
    }
  | {
      readonly kind: "pair";
      /** Lowercase `0x` pair (pool) address on the asset's chain. */
      readonly pairAddress: string;
      readonly pegUsd?: string | undefined;
      readonly guardBps?: number | undefined;
    };

/**
 * Deviation band used when a rule declares a guard subject but no width.
 * `03-非合约产品方案` §19 leaves the Mining price guard to be frozen, so no
 * product threshold exists to inherit; 500 bps is the conservative default
 * this decision pins and it lives with the formula version.
 */
export const miningReferencePriceDefaultGuardBps = 500;

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
  /**
   * Per-asset reference pricing rules (Decision 0059). An asset without a
   * rule keeps the base-token-only rule of Decision 0036.
   */
  readonly referencePricing?:
    Readonly<Record<string, MiningReferencePricingRule>> | undefined;
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

const positiveDecimalSchema = decimalSchema.refine(
  (value) => value !== "0" && !/^0(\.0+)?$/.test(value),
  { message: "must be positive" },
);
const guardBpsSchema = z.number().int().min(1).max(10_000);
const pairAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

export const miningReferencePricingRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stable"),
      pegUsd: positiveDecimalSchema,
      guardBps: guardBpsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pair"),
      pairAddress: pairAddressSchema,
      pegUsd: positiveDecimalSchema.optional(),
      guardBps: guardBpsSchema.optional(),
    })
    .strict(),
]);

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
    referencePricing: z
      .record(assetIdSchema, miningReferencePricingRuleSchema)
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
