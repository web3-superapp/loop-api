import {
  addDecimalStrings,
  compareDecimalStrings,
  formatRational,
  multiplyDecimalStrings,
} from "../market/market-contract.js";
import {
  isUnsignedDecimalString,
  miningReasonCodes,
  type MiningFormulaDocument,
  type MiningReferencePriceQuality,
} from "./mining-contract.js";

/**
 * Pure Mining Power snapshot computation (Decisions 0036 and 0043, 03 §7.1).
 *
 * `power(account, asset) = holding × referencePriceUsd × weight`, where
 * `holding` is the observed raw balance scaled by the asset's decimals, the
 * reference price is a *fresh* market fact, and `weight` is the formula's
 * asset weight multiplied by the approved community weight when exactly one
 * community binds the asset. An asset the formula does not weight, an asset
 * bound to a community whose weight is still under review, an asset bound by
 * two communities with approved weights, and an asset without a fresh price
 * all contribute nothing and are reported as skipped; nothing is ever
 * assumed, defaulted, or interpolated.
 *
 * The function has no I/O: the lane gathers inputs, this computes, the
 * repository writes. Every number is a canonical decimal string.
 */

export const miningPowerFractionDigits = 18;

export interface MiningBalanceInput {
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly assetId: string;
  readonly decimals: number;
  /** Smallest-unit integer string as observed on chain. */
  readonly rawValue: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}

export interface MiningPriceInput {
  readonly assetId: string;
  readonly priceUsd: string | null;
  /** The Provider fact's own quality; freshness is judged on `fetchedAt`. */
  readonly quality: "fresh" | "stale" | "proxied" | "derived" | "unavailable";
  readonly fetchedAt: string | null;
  readonly source: string;
  /** The asset whose price was read in this asset's place, if any. */
  readonly proxyAssetId?: string | null | undefined;
}

export interface MiningCommunityWeightInput {
  readonly communityId: string;
  readonly assetId: string;
  readonly weight: string | null;
  readonly status: "pending_review" | "approved";
}

export interface MiningSnapshotInputs {
  readonly balances: readonly MiningBalanceInput[];
  readonly prices: readonly MiningPriceInput[];
  readonly communityWeights: readonly MiningCommunityWeightInput[];
}

export interface MiningSnapshotPower {
  readonly ownerUserId: string;
  readonly assetId: string;
  readonly holding: string;
  readonly referencePriceUsd: string;
  /** `proxied` when the price is a declared proxy asset's (Decision 0044). */
  readonly referencePriceQuality: MiningReferencePriceQuality;
  readonly referencePriceProxyAssetId: string | null;
  readonly weight: string;
  readonly power: string;
  readonly blockNumber: string;
}

export interface MiningSnapshotSkip {
  readonly assetId: string;
  readonly reasonCode: string;
}

export type MiningSnapshotComputation =
  | {
      readonly kind: "computed";
      readonly formulaVersion: string;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly priceVersion: string;
      readonly totalPower: string;
      readonly powers: readonly MiningSnapshotPower[];
      readonly skipped: readonly MiningSnapshotSkip[];
    }
  | {
      readonly kind: "unavailable";
      readonly reasonCode: string;
      readonly skipped: readonly MiningSnapshotSkip[];
    };

const rawIntegerPattern = /^(0|[1-9][0-9]{0,77})$/;

/** Scales a smallest-unit integer to a decimal string by `decimals`. */
export function scaleRawHolding(rawValue: string, decimals: number): string {
  if (
    !rawIntegerPattern.test(rawValue) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    throw new Error("Invalid raw holding");
  }
  return formatRational(BigInt(rawValue), 10n ** BigInt(decimals), decimals);
}

type WeightSelection =
  | { readonly kind: "weight"; readonly weight: string }
  | { readonly kind: "skip"; readonly reasonCode: string };

/**
 * The formula's asset weight is required; a community weight is a second
 * factor on the community's bound asset. A bound asset whose weight is not
 * approved under this version is excluded rather than weighted by the asset
 * weight alone, so a community binding never silently drops its factor.
 */
export function selectMiningWeight(
  assetId: string,
  formula: MiningFormulaDocument,
  communityWeights: readonly MiningCommunityWeightInput[],
): WeightSelection {
  const assetWeight = formula.assetWeights[assetId];
  if (!isUnsignedDecimalString(assetWeight)) {
    return {
      kind: "skip",
      reasonCode: miningReasonCodes.assetWeightNotConfigured,
    };
  }
  const bindings = communityWeights.filter(
    (weight) => weight.assetId === assetId,
  );
  if (bindings.length === 0) {
    return { kind: "weight", weight: assetWeight };
  }
  const approvedWeights = bindings.flatMap((weight) =>
    weight.status === "approved" && isUnsignedDecimalString(weight.weight)
      ? [weight.weight]
      : [],
  );
  const [communityWeight, ...others] = approvedWeights;
  if (communityWeight === undefined) {
    return {
      kind: "skip",
      reasonCode: miningReasonCodes.communityWeightPendingReview,
    };
  }
  if (others.length > 0) {
    return {
      kind: "skip",
      reasonCode: miningReasonCodes.communityWeightAmbiguous,
    };
  }
  return {
    kind: "weight",
    weight: multiplyDecimalStrings(assetWeight, communityWeight),
  };
}

type PriceSelection =
  | {
      readonly kind: "price";
      readonly priceUsd: string;
      readonly fetchedAt: string;
      readonly source: string;
      readonly quality: MiningReferencePriceQuality;
      readonly proxyAssetId: string | null;
    }
  | { readonly kind: "skip"; readonly reasonCode: string };

/**
 * A price is usable when the Provider fact is fresh on its own observation
 * time. A price read through a proxy asset is usable only when the version
 * declares exactly that proxy for the asset, and is then carried as
 * `proxied` (Decision 0044); an undeclared proxy is refused.
 */
export function selectMiningPrice(
  assetId: string,
  formula: MiningFormulaDocument,
  prices: readonly MiningPriceInput[],
): PriceSelection {
  const price = prices.find((candidate) => candidate.assetId === assetId);
  if (
    price === undefined ||
    (price.quality !== "fresh" && price.quality !== "proxied") ||
    !isUnsignedDecimalString(price.priceUsd) ||
    price.fetchedAt === null
  ) {
    return { kind: "skip", reasonCode: miningReasonCodes.priceNotFresh };
  }
  const proxyAssetId = price.proxyAssetId ?? null;
  if (proxyAssetId === null && price.quality === "proxied") {
    return {
      kind: "skip",
      reasonCode: miningReasonCodes.priceProxyNotDeclared,
    };
  }
  if (proxyAssetId !== null) {
    const declared = formula.priceProxies?.[assetId];
    if (declared === undefined || declared !== proxyAssetId) {
      return {
        kind: "skip",
        reasonCode: miningReasonCodes.priceProxyNotDeclared,
      };
    }
  }
  return {
    kind: "price",
    priceUsd: price.priceUsd,
    fetchedAt: price.fetchedAt,
    source: price.source,
    quality: proxyAssetId === null ? "fresh" : "proxied",
    proxyAssetId,
  };
}

function compareBlocks(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Computes one snapshot. The snapshot block is the highest observed balance
 * block (each power row keeps its own observed block); the price version is
 * `source:<latest fetchedAt>` over the fresh prices actually used.
 */
export function computeMiningSnapshot(
  inputs: MiningSnapshotInputs,
  formula: {
    readonly configVersion: string;
    readonly document: MiningFormulaDocument;
  },
): MiningSnapshotComputation {
  const skipped: MiningSnapshotSkip[] = [];
  if (inputs.balances.length === 0) {
    return Object.freeze({
      kind: "unavailable",
      reasonCode: miningReasonCodes.noBalanceInputs,
      skipped: Object.freeze(skipped),
    });
  }

  const skippedAssets = new Set<string>();
  const perAccountAsset = new Map<string, MiningSnapshotPower>();
  let snapshotBlock: { readonly number: string; readonly hash: string } | null =
    null;
  let latestPriceFetchedAt: string | null = null;
  let priceSource: string | null = null;

  for (const balance of inputs.balances) {
    if (
      snapshotBlock === null ||
      compareBlocks(balance.blockNumber, snapshotBlock.number) > 0
    ) {
      snapshotBlock = { number: balance.blockNumber, hash: balance.blockHash };
    }
    const selection = selectMiningWeight(
      balance.assetId,
      formula.document,
      inputs.communityWeights,
    );
    if (selection.kind === "skip") {
      if (!skippedAssets.has(balance.assetId)) {
        skippedAssets.add(balance.assetId);
        skipped.push({
          assetId: balance.assetId,
          reasonCode: selection.reasonCode,
        });
      }
      continue;
    }
    const weight = selection.weight;
    const price = selectMiningPrice(
      balance.assetId,
      formula.document,
      inputs.prices,
    );
    if (price.kind === "skip") {
      if (!skippedAssets.has(balance.assetId)) {
        skippedAssets.add(balance.assetId);
        skipped.push({
          assetId: balance.assetId,
          reasonCode: price.reasonCode,
        });
      }
      continue;
    }
    if (
      latestPriceFetchedAt === null ||
      Date.parse(price.fetchedAt) > Date.parse(latestPriceFetchedAt)
    ) {
      latestPriceFetchedAt = price.fetchedAt;
    }
    priceSource ??= price.source;
    const holding = scaleRawHolding(balance.rawValue, balance.decimals);
    const power = multiplyDecimalStrings(
      multiplyDecimalStrings(holding, price.priceUsd),
      weight,
    );
    const key = `${balance.ownerUserId}|${balance.assetId}`;
    const existing = perAccountAsset.get(key);
    perAccountAsset.set(
      key,
      Object.freeze({
        ownerUserId: balance.ownerUserId,
        assetId: balance.assetId,
        holding:
          existing === undefined
            ? holding
            : addDecimalStrings(existing.holding, holding),
        referencePriceUsd: price.priceUsd,
        referencePriceQuality: price.quality,
        referencePriceProxyAssetId: price.proxyAssetId,
        weight,
        power:
          existing === undefined
            ? power
            : addDecimalStrings(existing.power, power),
        blockNumber:
          existing === undefined ||
          compareBlocks(balance.blockNumber, existing.blockNumber) > 0
            ? balance.blockNumber
            : existing.blockNumber,
      }),
    );
  }

  if (
    perAccountAsset.size === 0 ||
    snapshotBlock === null ||
    latestPriceFetchedAt === null ||
    priceSource === null
  ) {
    // Every asset was skipped: report the first skip's reason when all skips
    // share it, otherwise the generic weight reason.
    const [firstSkip] = skipped;
    const uniform =
      firstSkip !== undefined &&
      skipped.every((skip) => skip.reasonCode === firstSkip.reasonCode);
    return Object.freeze({
      kind: "unavailable",
      reasonCode: uniform
        ? firstSkip.reasonCode
        : miningReasonCodes.communityWeightPendingReview,
      skipped: Object.freeze(skipped),
    });
  }

  const powers = [...perAccountAsset.values()].sort((left, right) =>
    left.ownerUserId === right.ownerUserId
      ? left.assetId.localeCompare(right.assetId)
      : left.ownerUserId.localeCompare(right.ownerUserId),
  );
  let totalPower = "0";
  for (const row of powers) {
    totalPower = addDecimalStrings(totalPower, row.power);
  }
  if (compareDecimalStrings(totalPower, "0") < 0) {
    throw new Error("Mining power cannot be negative");
  }
  return Object.freeze({
    kind: "computed",
    formulaVersion: formula.configVersion,
    blockNumber: snapshotBlock.number,
    blockHash: snapshotBlock.hash,
    priceVersion: `${priceSource}:${latestPriceFetchedAt}`,
    totalPower,
    powers: Object.freeze(powers),
    skipped: Object.freeze(skipped),
  });
}
