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
  type MiningHoldingsSource,
  type MiningReferencePriceQuality,
  type WalletBalanceSource,
} from "./mining-contract.js";
import { isDerivedPriceAllowed } from "./mining-reference-pricing.js";

/**
 * Pure Mining Power snapshot computation (Decisions 0036 and 0043, 03 §7.1).
 *
 * `power(account, asset) = holding × referencePriceUsd × weight`, where
 * `holding` is the observed raw balance scaled by the asset's decimals, the
 * reference price is a *fresh* market fact, and `weight` is the formula's
 * asset weight multiplied by the approved community weight when exactly one
 * community binds the asset. An asset the formula does not weight, an asset
 * bound to a community whose weight is still under review, and an asset
 * bound by two communities with approved weights are policy exclusions: they
 * contribute nothing, are reported as skipped, and the snapshot is complete
 * without them. A weighted asset with a *positive* observed balance and no
 * usable price is an unread holding (Decision 0057): the computation is
 * `incomplete`, reports the holding, and yields no number at all — leaving
 * the asset out would publish the holding as zero. A zero balance without a
 * price is only skipped (0 × any price = 0). Nothing is ever assumed,
 * defaulted, or interpolated.
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
  /**
   * Where the balance was observed (Decision 0061). `mock_seed` rows reach
   * this function only when the lane was configured to include them; the
   * computation never decides that, it only reports what it counted.
   */
  readonly source: WalletBalanceSource;
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
  /** The pair the price was read from, when the lane selected one (Decision 0059). */
  readonly pairAddress?: string | null | undefined;
  /** True when the price is the inverted quote side of `pairAddress`. */
  readonly derivedInverted?: boolean | undefined;
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
  /** The pair the reference price was read from; required when `derived`. */
  readonly referencePricePairAddress: string | null;
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
      /** The kinds of observed balance the published numbers count. */
      readonly holdingsSource: MiningHoldingsSource;
      readonly skipped: readonly MiningSnapshotSkip[];
    }
  | {
      /**
       * At least one positive, weighted holding has no usable price
       * (Decision 0057). No number is produced; the lane records the
       * attempt and the read paths keep the last complete snapshot.
       */
      readonly kind: "incomplete";
      readonly formulaVersion: string;
      readonly blockNumber: string;
      readonly blockHash: string;
      /** Null when no price at all was usable in this run. */
      readonly priceVersion: string | null;
      readonly unread: readonly MiningSnapshotSkip[];
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
      readonly pairAddress: string | null;
    }
  | { readonly kind: "skip"; readonly reasonCode: string };

/**
 * A price is usable when the Provider fact is fresh on its own observation
 * time. A price read through a proxy asset is usable only when the version
 * declares exactly that proxy for the asset, and is then carried as
 * `proxied` (Decision 0044); an undeclared proxy is refused. A price the
 * lane inverted out of a pair's quote side is usable only when the version
 * declares a reference pricing rule that names the pair (or accepts the
 * asset as a pegged stable) and the price lands inside that rule's guard
 * band, and is then carried as `derived` (Decision 0059).
 */
export function selectMiningPrice(
  assetId: string,
  formula: MiningFormulaDocument,
  prices: readonly MiningPriceInput[],
): PriceSelection {
  const price = prices.find((candidate) => candidate.assetId === assetId);
  if (
    price === undefined ||
    (price.quality !== "fresh" &&
      price.quality !== "proxied" &&
      price.quality !== "derived") ||
    price.fetchedAt === null
  ) {
    return { kind: "skip", reasonCode: miningReasonCodes.priceNotFresh };
  }
  if (price.priceUsd === null) {
    // The Provider answered freshly but no pair has the asset as base
    // (Decision 0057): a distinct, stable reason so an operator sees the
    // difference between "stale" and "not priced at all".
    return { kind: "skip", reasonCode: miningReasonCodes.pricePairNotFound };
  }
  if (!isUnsignedDecimalString(price.priceUsd)) {
    return { kind: "skip", reasonCode: miningReasonCodes.priceNotFresh };
  }
  const pairAddress = price.pairAddress ?? null;
  if (price.quality === "derived") {
    // The rule, the pair, and the guard are re-checked here so the pure
    // computation — not the lane — decides what may enter a snapshot.
    if (
      !isDerivedPriceAllowed({
        assetId,
        formula,
        priceUsd: price.priceUsd,
        pairAddress,
        inverted: price.derivedInverted ?? false,
      })
    ) {
      return { kind: "skip", reasonCode: miningReasonCodes.pricePairNotFound };
    }
    return {
      kind: "price",
      priceUsd: price.priceUsd,
      fetchedAt: price.fetchedAt,
      source: price.source,
      quality: "derived",
      proxyAssetId: null,
      pairAddress,
    };
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
    pairAddress,
  };
}

/**
 * The snapshot-level word for the kinds of observed balance a set of rows
 * counted (Decision 0061). Two kinds together are `mixed`; a single kind
 * keeps its own name. Nothing is ever reported as `chain` because it is
 * the default — the value is derived from the rows that produced power.
 */
function mergeHoldingsSource(
  left: MiningHoldingsSource | null,
  right: WalletBalanceSource,
): MiningHoldingsSource {
  if (left === null) {
    return right;
  }
  return left === right ? left : "mixed";
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
  const unread: MiningSnapshotSkip[] = [];
  const unreadAssets = new Set<string>();
  const perAccountAsset = new Map<string, MiningSnapshotPower>();
  let snapshotBlock: { readonly number: string; readonly hash: string } | null =
    null;
  let latestPriceFetchedAt: string | null = null;
  let priceSource: string | null = null;
  let snapshotHoldingsSource: MiningHoldingsSource | null = null;

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
      // A positive holding without a price is an unread holding; a zero
      // balance without a price changes no number and is only skipped.
      if (BigInt(balance.rawValue) > 0n) {
        if (!unreadAssets.has(balance.assetId)) {
          unreadAssets.add(balance.assetId);
          unread.push({
            assetId: balance.assetId,
            reasonCode: price.reasonCode,
          });
        }
      } else if (!skippedAssets.has(balance.assetId)) {
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
    snapshotHoldingsSource = mergeHoldingsSource(
      snapshotHoldingsSource,
      balance.source,
    );
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
        referencePricePairAddress: price.pairAddress,
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

  if (unread.length > 0 && snapshotBlock !== null) {
    return Object.freeze({
      kind: "incomplete",
      formulaVersion: formula.configVersion,
      blockNumber: snapshotBlock.number,
      blockHash: snapshotBlock.hash,
      priceVersion:
        latestPriceFetchedAt === null || priceSource === null
          ? null
          : `${priceSource}:${latestPriceFetchedAt}`,
      unread: Object.freeze(unread),
      // An asset that is unread for one account is unread, full stop; a
      // zero balance of it elsewhere does not also make it a policy skip.
      skipped: Object.freeze(
        skipped.filter((skip) => !unreadAssets.has(skip.assetId)),
      ),
    });
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
    // Only the rows that produced power decide the word: a mock balance of
    // an asset the version does not weight changes no number and does not
    // make the snapshot a demonstration.
    holdingsSource: snapshotHoldingsSource ?? "chain",
    skipped: Object.freeze(skipped),
  });
}
