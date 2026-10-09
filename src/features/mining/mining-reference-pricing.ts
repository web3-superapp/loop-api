import {
  addDecimalStrings,
  compareDecimalStrings,
  divideDecimalStrings,
  formatRational,
  multiplyDecimalStrings,
} from "../market/market-contract.js";
import type { TokenPairSnapshot } from "../../integrations/market/market-data-provider.js";
import {
  isUnsignedDecimalString,
  miningReasonCodes,
  miningReferencePriceDefaultGuardBps,
  type MiningFormulaDocument,
  type MiningReferencePricingRule,
} from "./mining-contract.js";

/**
 * Reference pricing rules (Decision 0059), as pure functions.
 *
 * Decision 0036 prices an asset only from a pair in which it is the *base*
 * token, because a pair in which it is only the quote is a price of the
 * other token. That rule left BSC USDT unpriced from 2026-09-18: DexScreener
 * answers for USDT with pairs (`WBNB/USDT`, `USDT/USDC`) in which USDT is
 * usually only the quote, and Decision 0057 then — correctly — refused to
 * publish a snapshot that could not value a real holding.
 *
 * A formula version may now declare, per asset, how it may be priced when
 * the base rule finds nothing. The inverted price of a quote token is exact
 * (`priceUsd / priceNative` is the quote token's USD price implied by the
 * pair), but it is a *derived* fact, so it is accepted only inside a
 * declared guard band and it is carried as `quality: "derived"` everywhere.
 * When the derived price falls outside the band nothing is published: the
 * peg is a guard, never a substitute price (red line: no invented fact).
 */

/** Fraction digits kept when a quote price is inverted. */
export const miningDerivedPriceFractionDigits = 18;

export interface MiningDerivedReferencePrice {
  readonly priceUsd: string;
  /** The pair the price was read from. */
  readonly pairAddress: string;
  /** True when the asset is the pair's quote token and the price is inverted. */
  readonly inverted: boolean;
}

export type MiningReferencePriceDerivation =
  | { readonly kind: "price"; readonly price: MiningDerivedReferencePrice }
  | { readonly kind: "skip"; readonly reasonCode: string };

function skip(reasonCode: string): MiningReferencePriceDerivation {
  return Object.freeze({ kind: "skip" as const, reasonCode });
}

function isPositiveDecimal(value: string | null): value is string {
  return (
    value !== null &&
    isUnsignedDecimalString(value) &&
    !/^0(\.0+)?$/.test(value)
  );
}

/** Absolute difference of two canonical unsigned decimal strings. */
function absoluteDifference(left: string, right: string): string {
  return compareDecimalStrings(left, right) >= 0
    ? addDecimalStrings(left, `-${right}`)
    : addDecimalStrings(right, `-${left}`);
}

/** The guard half-width in decimal form: `pegUsd × guardBps / 10000`. */
export function referencePriceGuardBand(
  pegUsd: string,
  guardBps: number,
): string {
  return multiplyDecimalStrings(
    pegUsd,
    formatRational(BigInt(guardBps), 10_000n, 8),
  );
}

/**
 * Whether a derived price may be used: it must lie within `guardBps` of the
 * rule's peg. A rule that needs a guard but declares no peg fails closed.
 */
export function isWithinReferencePriceGuard(
  priceUsd: string,
  pegUsd: string,
  guardBps: number,
): boolean {
  if (!isPositiveDecimal(priceUsd) || !isPositiveDecimal(pegUsd)) {
    return false;
  }
  if (!Number.isInteger(guardBps) || guardBps < 1 || guardBps > 10_000) {
    return false;
  }
  return (
    compareDecimalStrings(
      absoluteDifference(priceUsd, pegUsd),
      referencePriceGuardBand(pegUsd, guardBps),
    ) <= 0
  );
}

/**
 * The USD price of a pair's quote token implied by the pair:
 * `priceUsd` is the base token in USD, `priceNative` is the base token in
 * quote units, so the quote token is `priceUsd / priceNative`. `null` when
 * either number is missing or not positive.
 */
export function invertQuoteTokenPrice(
  pair: Pick<TokenPairSnapshot, "priceUsd" | "priceNative">,
): string | null {
  if (
    !isPositiveDecimal(pair.priceUsd) ||
    !isPositiveDecimal(pair.priceNative)
  ) {
    return null;
  }
  const inverted = divideDecimalStrings(
    pair.priceUsd,
    pair.priceNative,
    miningDerivedPriceFractionDigits,
  );
  return inverted === null || inverted === "0" ? null : inverted;
}

/** The guard a rule applies to a derived (inverted) price, if it declares one. */
function guardOf(
  rule: MiningReferencePricingRule,
): { readonly pegUsd: string; readonly guardBps: number } | null {
  if (rule.kind === "stable") {
    return { pegUsd: rule.pegUsd, guardBps: rule.guardBps };
  }
  if (rule.pegUsd === undefined) {
    return null;
  }
  return {
    pegUsd: rule.pegUsd,
    guardBps: rule.guardBps ?? miningReferencePriceDefaultGuardBps,
  };
}

/**
 * Re-checks a price the lane says it derived against the version's rule.
 * The lane derives; this is the authority that decides whether a derived
 * price may enter a snapshot, so the same judgement is made in the pure
 * computation and can be tested without any I/O.
 */
export function isDerivedPriceAllowed(input: {
  readonly assetId: string;
  readonly formula: MiningFormulaDocument;
  readonly priceUsd: string;
  readonly pairAddress: string | null;
  readonly inverted: boolean;
}): boolean {
  const rule = input.formula.referencePricing?.[input.assetId];
  if (rule === undefined || input.pairAddress === null) {
    return false;
  }
  if (rule.kind === "pair" && rule.pairAddress !== input.pairAddress) {
    return false;
  }
  if (!input.inverted) {
    // Nothing was inverted, so nothing is derived.
    return false;
  }
  const guard = guardOf(rule);
  if (guard === null) {
    return false;
  }
  return isWithinReferencePriceGuard(
    input.priceUsd,
    guard.pegUsd,
    guard.guardBps,
  );
}

function deeperLiquidity(
  left: TokenPairSnapshot,
  right: TokenPairSnapshot,
): TokenPairSnapshot {
  const a = left.liquidityUsd ?? "0";
  const b = right.liquidityUsd ?? "0";
  if (compareDecimalStrings(a, b) > 0) {
    return left;
  }
  if (compareDecimalStrings(a, b) < 0) {
    return right;
  }
  // Deterministic tie-break so two runs over the same fact agree.
  return left.pairAddress <= right.pairAddress ? left : right;
}

/**
 * `kind: "stable"`: the deepest pair in which the asset is the quote token,
 * inverted and guarded against the peg. Pairs in which the asset is the base
 * token are not considered here — the caller has already tried the base rule
 * and it found nothing.
 */
export function deriveStableReferencePrice(input: {
  readonly rule: Extract<MiningReferencePricingRule, { kind: "stable" }>;
  readonly tokenAddress: string;
  readonly pairs: readonly TokenPairSnapshot[];
}): MiningReferencePriceDerivation {
  let best: TokenPairSnapshot | null = null;
  for (const pair of input.pairs) {
    if (pair.quoteTokenAddress !== input.tokenAddress) {
      continue;
    }
    if (invertQuoteTokenPrice(pair) === null) {
      continue;
    }
    best = best === null ? pair : deeperLiquidity(best, pair);
  }
  if (best === null) {
    return skip(miningReasonCodes.pricePairNotFound);
  }
  const priceUsd = invertQuoteTokenPrice(best);
  if (priceUsd === null) {
    return skip(miningReasonCodes.pricePairNotFound);
  }
  if (
    !isWithinReferencePriceGuard(
      priceUsd,
      input.rule.pegUsd,
      input.rule.guardBps,
    )
  ) {
    // Outside the band the holding stays unread (Decision 0057). The peg
    // itself is never published as a price.
    return skip(miningReasonCodes.pricePairNotFound);
  }
  return Object.freeze({
    kind: "price" as const,
    price: Object.freeze({
      priceUsd,
      pairAddress: best.pairAddress,
      inverted: true,
    }),
  });
}

/**
 * `kind: "pair"`: the declared pair, read by its own address. The asset must
 * be that pair's base token (the price is `priceUsd`, no inversion) or its
 * quote token (inverted, and then the rule must declare a peg to guard it).
 */
export function deriveDeclaredPairReferencePrice(input: {
  readonly rule: Extract<MiningReferencePricingRule, { kind: "pair" }>;
  readonly tokenAddress: string;
  readonly pair: TokenPairSnapshot | null;
}): MiningReferencePriceDerivation {
  const pair = input.pair;
  if (pair === null || pair.pairAddress !== input.rule.pairAddress) {
    return skip(miningReasonCodes.pricePairNotFound);
  }
  if (pair.baseTokenAddress === input.tokenAddress) {
    if (!isPositiveDecimal(pair.priceUsd)) {
      return skip(miningReasonCodes.pricePairNotFound);
    }
    return Object.freeze({
      kind: "price" as const,
      price: Object.freeze({
        priceUsd: pair.priceUsd,
        pairAddress: pair.pairAddress,
        inverted: false,
      }),
    });
  }
  if (pair.quoteTokenAddress !== input.tokenAddress) {
    // The declared pair does not contain the asset at all.
    return skip(miningReasonCodes.pricePairNotFound);
  }
  const guard = guardOf(input.rule);
  if (guard === null) {
    // An inversion with nothing to compare against cannot be guarded.
    return skip(miningReasonCodes.pricePairNotFound);
  }
  const priceUsd = invertQuoteTokenPrice(pair);
  if (
    priceUsd === null ||
    !isWithinReferencePriceGuard(priceUsd, guard.pegUsd, guard.guardBps)
  ) {
    return skip(miningReasonCodes.pricePairNotFound);
  }
  return Object.freeze({
    kind: "price" as const,
    price: Object.freeze({
      priceUsd,
      pairAddress: pair.pairAddress,
      inverted: true,
    }),
  });
}
