import { z } from "zod";

import { parseSpotContract } from "./spot-contract-support.js";
import {
  compareExactUnsignedDecimalProduct,
  compareExactUnsignedDecimals,
  exactUnsignedDecimalsEqual,
} from "./spot-exact-decimal.js";
import {
  spotNotFilledReconciliationReasonCodes,
  spotRejectedReconciliationReasonCodes,
  type SpotIntentReconciliationSubject,
  type SpotIntentTerminalResolution,
} from "./spot-reconciliation-contract.js";

const maximumPostgresInteger = 2_147_483_647;
const canonicalPositiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const canonicalNonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const safeAssetIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;

const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalPositiveDecimalPattern);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalNonnegativeDecimalPattern);
const nonnegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(maximumPostgresInteger);
const tokenIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const clientOrderIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const providerOrderIdSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const feeSchema = z
  .object({
    amount: nonnegativeDecimalSchema,
    tokenIndex: nonnegativeIntegerSchema,
    tokenId: tokenIdSchema,
    assetDisplayIdentity: z.string().regex(safeAssetIdentityPattern),
  })
  .strict();
const terminalResolutionSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("filled"),
      providerOrderId: providerOrderIdSchema,
      clientOrderId: clientOrderIdSchema,
      filledBaseSize: positiveDecimalSchema,
      quoteAmount: positiveDecimalSchema,
      averageFillPrice: positiveDecimalSchema,
      fee: feeSchema,
      observedAt: rfc3339Schema,
      reasonCode: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("not_filled"),
      providerOrderId: providerOrderIdSchema,
      clientOrderId: clientOrderIdSchema,
      filledBaseSize: z.null(),
      quoteAmount: z.null(),
      averageFillPrice: z.null(),
      fee: z.null(),
      observedAt: rfc3339Schema,
      reasonCode: z.enum(spotNotFilledReconciliationReasonCodes),
    })
    .strict(),
  z
    .object({
      state: z.literal("rejected"),
      providerOrderId: providerOrderIdSchema,
      clientOrderId: clientOrderIdSchema,
      filledBaseSize: z.null(),
      quoteAmount: z.null(),
      averageFillPrice: z.null(),
      fee: z.null(),
      observedAt: rfc3339Schema,
      reasonCode: z.enum(spotRejectedReconciliationReasonCodes),
    })
    .strict(),
]);

export type SpotIntentTerminalAuthority = Pick<
  SpotIntentReconciliationSubject,
  | "clientOrderId"
  | "side"
  | "computedBaseSize"
  | "worstIocLimitPrice"
  | "baseTokenIndex"
  | "baseTokenId"
  | "baseDisplayIdentity"
  | "quoteTokenIndex"
  | "quoteTokenId"
  | "quoteDisplayIdentity"
>;

export function parseSpotIntentTerminalResolution(
  value: unknown,
): SpotIntentTerminalResolution {
  const resolution = parseSpotContract(terminalResolutionSchema, value);
  const observedAt = new Date(resolution.observedAt).toISOString();
  if (resolution.state === "filled") {
    return Object.freeze({
      ...resolution,
      observedAt,
      fee: Object.freeze({ ...resolution.fee }),
    });
  }
  return Object.freeze({ ...resolution, observedAt });
}

export function spotIntentTerminalResolutionMatchesAuthority(
  authority: SpotIntentTerminalAuthority,
  resolution: SpotIntentTerminalResolution,
): boolean {
  if (resolution.clientOrderId !== authority.clientOrderId) {
    return false;
  }
  if (resolution.state !== "filled") {
    return true;
  }
  if (
    !exactUnsignedDecimalsEqual(
      resolution.filledBaseSize,
      authority.computedBaseSize,
    ) ||
    compareExactUnsignedDecimalProduct(
      resolution.filledBaseSize,
      resolution.averageFillPrice,
      resolution.quoteAmount,
    ) !== 0
  ) {
    return false;
  }

  const priceToLimit = compareExactUnsignedDecimals(
    resolution.averageFillPrice,
    authority.worstIocLimitPrice,
  );
  if (
    (authority.side === "buy" && priceToLimit > 0) ||
    (authority.side === "sell" && priceToLimit < 0)
  ) {
    return false;
  }
  const worstNotionalToQuote = compareExactUnsignedDecimalProduct(
    resolution.filledBaseSize,
    authority.worstIocLimitPrice,
    resolution.quoteAmount,
  );
  if (
    (authority.side === "buy" && worstNotionalToQuote < 0) ||
    (authority.side === "sell" && worstNotionalToQuote > 0)
  ) {
    return false;
  }

  const fee = resolution.fee;
  const feeMatchesBase =
    fee.tokenIndex === authority.baseTokenIndex &&
    fee.tokenId === authority.baseTokenId;
  const feeMatchesQuote =
    fee.tokenIndex === authority.quoteTokenIndex &&
    fee.tokenId === authority.quoteTokenId;
  if (!feeMatchesBase && !feeMatchesQuote) {
    return false;
  }
  const feeEconomicMaximum = feeMatchesBase
    ? resolution.filledBaseSize
    : resolution.quoteAmount;
  if (compareExactUnsignedDecimals(fee.amount, feeEconomicMaximum) > 0) {
    return false;
  }
  return (
    fee.assetDisplayIdentity ===
    (feeMatchesBase
      ? authority.baseDisplayIdentity
      : authority.quoteDisplayIdentity)
  );
}
