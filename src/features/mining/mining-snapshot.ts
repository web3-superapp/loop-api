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
} from "./mining-contract.js";

/**
 * Pure Mining Power snapshot computation (Decision 0036, 03 §7.1).
 *
 * `power(account, asset) = holding × referencePriceUsd × weight`, where
 * `holding` is the observed raw balance scaled by the asset's decimals, the
 * reference price is a *fresh* market fact, and the weight is either the
 * formula's asset weight or an approved community weight for the asset. An
 * asset without a weight or without a fresh price contributes nothing and is
 * reported as skipped; nothing is ever assumed, defaulted, or interpolated.
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
  readonly quality: "fresh" | "stale" | "proxied" | "derived" | "unavailable";
  readonly fetchedAt: string | null;
  readonly source: string;
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

function selectWeight(
  assetId: string,
  formula: MiningFormulaDocument,
  communityWeights: readonly MiningCommunityWeightInput[],
): string | null {
  const formulaWeight = formula.assetWeights[assetId];
  if (isUnsignedDecimalString(formulaWeight)) {
    return formulaWeight;
  }
  const approved = communityWeights.find(
    (weight) =>
      weight.assetId === assetId &&
      weight.status === "approved" &&
      isUnsignedDecimalString(weight.weight),
  );
  return approved?.weight ?? null;
}

function selectPrice(
  assetId: string,
  prices: readonly MiningPriceInput[],
): MiningPriceInput | null {
  const price = prices.find((candidate) => candidate.assetId === assetId);
  if (
    price === undefined ||
    price.quality !== "fresh" ||
    !isUnsignedDecimalString(price.priceUsd) ||
    price.fetchedAt === null
  ) {
    return null;
  }
  return price;
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
    const weight = selectWeight(
      balance.assetId,
      formula.document,
      inputs.communityWeights,
    );
    if (weight === null) {
      if (!skippedAssets.has(balance.assetId)) {
        skippedAssets.add(balance.assetId);
        skipped.push({
          assetId: balance.assetId,
          reasonCode: miningReasonCodes.communityWeightPendingReview,
        });
      }
      continue;
    }
    const price = selectPrice(balance.assetId, inputs.prices);
    if (price === null || price.priceUsd === null || price.fetchedAt === null) {
      if (!skippedAssets.has(balance.assetId)) {
        skippedAssets.add(balance.assetId);
        skipped.push({
          assetId: balance.assetId,
          reasonCode: miningReasonCodes.priceNotFresh,
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
    return Object.freeze({
      kind: "unavailable",
      reasonCode:
        skipped.every(
          (skip) => skip.reasonCode === miningReasonCodes.priceNotFresh,
        ) && skipped.length > 0
          ? miningReasonCodes.priceNotFresh
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
