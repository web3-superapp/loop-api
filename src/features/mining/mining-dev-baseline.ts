import { bscWrappedNativeAssetId } from "../market/market-contract.js";
import {
  isUnsignedDecimalString,
  miningDailyOutputUnitKey,
  type MiningCommunityWeightRange,
  type MiningFormulaDocument,
  type MiningPriceGuardRule,
  type MiningReferencePricingRule,
  type MiningWeightRangeDocument,
} from "./mining-contract.js";

/**
 * The Development Mining baseline (Decision 0043).
 *
 * The product formula (`miningFormulaV1-draft`, Decision 0036) has the right
 * shape but no parameters, because `02-合约产品方案` has not been provided.
 * This module pins a *self-describing* placeholder version so the Development
 * stack can compute real numbers from real inputs without impersonating a
 * product decision:
 *
 * - The version name says what it is; it is shown to the user as the rule
 *   label (red line 5) and must never look like a release.
 * - Every registered asset weighs `1`, so power degenerates to the USD value
 *   of the holding — the only default that invents no economics.
 * - The community weight range is a documented symmetric interval; a weight
 *   is written only through the explicit operator path.
 * - The daily output budget is the single true economic parameter. It is an
 *   obvious placeholder, it lives inside this configVersion, and it retires
 *   with it.
 *
 * Nothing here is read by a production process: the operator scripts refuse
 * `NODE_ENV=production`, and the formula row carries `scope:
 * development_baseline` so a product path can refuse it by inspection.
 */

/**
 * r4 (Decision 0061): the registry gained the real BSC tokens the seeded
 * communities bind, and a version's `assetWeights` are fixed when it is
 * written — an asset registered after a version exists is not weighted by
 * it and every holding of it is a policy exclusion. The revision is
 * therefore not cosmetic: it is how the new assets enter the formula.
 * Community weights are recorded per version, so every community weight is
 * re-approved under r4 (`pnpm mining:community-weight … --confirm`).
 */
export const miningDevBaselineConfigVersion =
  "miningFormula-devBaseline-2026-09-21-r4" as const;

/** Every registered, non-blocked asset weighs exactly one. */
export const miningDevBaselineAssetWeight = "1" as const;

/** Inclusive community weight interval: half to double the asset weight. */
export const miningDevBaselineCommunityWeightRange: MiningCommunityWeightRange =
  Object.freeze({ min: "0.5", max: "2" });

/**
 * PLACEHOLDER. One million units of the pending LOOP reward token per day,
 * chosen only so a share of network power renders as a number. It is not a
 * budget, not a promise, and it is replaced by 02 together with the version.
 */
export const miningDevBaselineDailyOutputBudget = "1000000" as const;

export const miningDevBaselineExpressionKey =
  "mining.rules.formula.holdingTimesReferencePriceTimesWeight" as const;
export const miningDevBaselineDailyOutputKey =
  "mining.rules.dailyOutput.shareOfNetworkPower" as const;

const assetIdPattern = /^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/;
const bscNativeAssetId = "eip155:56:native";

/**
 * Decision 0044: native BNB has no token address a DEX Provider can price;
 * its reference price is WBNB's (a 1:1 wrapper on this chain), carried as
 * `quality: proxied` on every row that uses it. Declared only when both
 * assets are registered.
 */
export const miningDevBaselinePriceProxies: Readonly<Record<string, string>> =
  Object.freeze({ [bscNativeAssetId]: bscWrappedNativeAssetId });

/** BSC-USD (USDT) on BNB Smart Chain, the asset the stable rule declares. */
export const bscUsdtAssetId =
  "eip155:56:0x55d398326f99059ff775485246999027b3197955" as const;

/** The guard band of the baseline's stable rule: ±2 % of the peg. */
export const miningDevBaselineStableGuardBps = 200;

/**
 * Decision 0059: from 2026-09-18 DexScreener answers for BSC USDT with a
 * short list of pairs (`WBNB/USDT`, `USDT/USDC`) in which USDT is usually
 * only the quote token, so the base-token rule of Decision 0036 found no
 * price and every snapshot became incomplete (Decision 0057). USDT is a USD
 * stable, so this version declares it as such: the price may be inverted out
 * of the deepest pair in which it is the quote token and is accepted only
 * within ±2 % of `1`. Outside that band the holding stays unread — the peg
 * is a guard, never a published price. Declared only when the asset is
 * registered.
 */
export const miningDevBaselineReferencePricing: Readonly<
  Record<string, MiningReferencePricingRule>
> = Object.freeze({
  [bscUsdtAssetId]: Object.freeze({
    kind: "stable" as const,
    pegUsd: "1",
    guardBps: miningDevBaselineStableGuardBps,
  }),
});

export interface MiningDevBaselineDocuments {
  readonly configVersion: typeof miningDevBaselineConfigVersion;
  readonly formula: MiningFormulaDocument;
  readonly weightRange: MiningWeightRangeDocument;
  readonly priceGuardRules: readonly MiningPriceGuardRule[];
}

/**
 * Builds the baseline documents from the registry's asset IDs. The caller
 * supplies the registered assets; this never invents one, and an empty
 * registry yields an empty weight map (which computes nothing).
 */
export function buildMiningDevBaselineDocuments(
  assetIds: readonly string[],
): MiningDevBaselineDocuments {
  const assetWeights: Record<string, string> = {};
  for (const assetId of [...new Set(assetIds)].sort()) {
    if (!assetIdPattern.test(assetId)) {
      throw new Error("Invalid registry asset ID");
    }
    assetWeights[assetId] = miningDevBaselineAssetWeight;
  }
  const priceProxies: Record<string, string> = {};
  for (const [asset, proxy] of Object.entries(miningDevBaselinePriceProxies)) {
    if (asset in assetWeights && proxy in assetWeights) {
      priceProxies[asset] = proxy;
    }
  }
  const referencePricing: Record<string, MiningReferencePricingRule> = {};
  for (const [asset, rule] of Object.entries(
    miningDevBaselineReferencePricing,
  )) {
    if (asset in assetWeights) {
      referencePricing[asset] = rule;
    }
  }
  return Object.freeze({
    configVersion: miningDevBaselineConfigVersion,
    formula: Object.freeze({
      kind: "holding_times_reference_price_times_weight" as const,
      expressionKey: miningDevBaselineExpressionKey,
      dailyOutputKey: miningDevBaselineDailyOutputKey,
      assetWeights: Object.freeze(assetWeights),
      referralBoost: Object.freeze({ status: "pending_approval" as const }),
      scope: "development_baseline" as const,
      dailyOutput: Object.freeze({
        status: "development_placeholder" as const,
        budget: miningDevBaselineDailyOutputBudget,
        unitKey: miningDailyOutputUnitKey,
      }),
      priceProxies: Object.freeze(priceProxies),
      referencePricing: Object.freeze(referencePricing),
    }),
    weightRange: Object.freeze({
      // The LOOP token has no contract, so its fixed-maximum weight rule is
      // still pending; the community range is pinned for this version only.
      loop: Object.freeze({
        status: "pending_approval" as const,
        descriptionKey: "mining.rules.weight.loopFixedMaximum",
      }),
      community: Object.freeze({
        status: "approved" as const,
        descriptionKey: "mining.rules.weight.communityReviewed",
        range: miningDevBaselineCommunityWeightRange,
      }),
      reviewFactorKeys: Object.freeze([
        "mining.rules.reviewFactor.communityQuality",
        "mining.rules.reviewFactor.communitySize",
        "mining.rules.reviewFactor.tokenLiquidity",
        "mining.rules.reviewFactor.projectQuality",
        "mining.rules.reviewFactor.marketStability",
        "mining.rules.reviewFactor.userQuality",
        "mining.rules.reviewFactor.loopPartnership",
      ]),
    }),
    // No product price guard is approved: the lane still requires a fresh
    // Provider price (own, declared proxy, or a declared reference pricing
    // rule inside its band), which is the only guard in force.
    priceGuardRules: Object.freeze([
      Object.freeze({
        ruleKey: "mining.rules.priceGuard.twap",
        status: "pending_approval" as const,
      }),
      Object.freeze({
        ruleKey: "mining.rules.priceGuard.multiPeriodMultiSource",
        status: "pending_approval" as const,
      }),
      Object.freeze({
        ruleKey: "mining.rules.priceGuard.liquidityCap",
        status: "pending_approval" as const,
      }),
    ]),
  });
}

/** Sanity guard for the constants themselves (exercised by tests). */
export function assertMiningDevBaselineConstants(): void {
  if (
    !isUnsignedDecimalString(miningDevBaselineDailyOutputBudget) ||
    !isUnsignedDecimalString(miningDevBaselineAssetWeight) ||
    !isUnsignedDecimalString(miningDevBaselineCommunityWeightRange.min) ||
    !isUnsignedDecimalString(miningDevBaselineCommunityWeightRange.max)
  ) {
    throw new Error("Mining dev baseline constants are not decimal strings");
  }
  for (const rule of Object.values(miningDevBaselineReferencePricing)) {
    if (rule.kind !== "stable") {
      continue;
    }
    if (
      !isUnsignedDecimalString(rule.pegUsd) ||
      rule.pegUsd === "0" ||
      !Number.isInteger(rule.guardBps) ||
      rule.guardBps < 1 ||
      rule.guardBps > 10_000
    ) {
      throw new Error("Mining dev baseline reference pricing rule is invalid");
    }
  }
}
