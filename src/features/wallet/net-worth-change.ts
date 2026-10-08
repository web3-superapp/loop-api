import {
  addDecimalStrings,
  compareDecimalStrings,
  divideDecimalStrings,
  isCanonicalDecimalString,
  multiplyDecimalStrings,
  subtractDecimalStrings,
} from "../market/market-contract.js";

/**
 * 24h change of a wallet's net worth (Decision 0100), derived from the same
 * price read that valued the rows: a row worth `v` now whose price moved
 * `p` percent over 24h was worth `v / (1 + p/100)`, so it changed by
 * `v · p / (100 + p)`. The total change is the sum over the valued rows and
 * the percentage is that sum over the summed earlier values.
 *
 * Only rows worth more than zero count: a zero-value row cannot move the
 * total. One counted row without a 24h number (or with a number at or below
 * -100 %, which has no earlier value) makes the whole change unknown:
 * a partial sum would state a move the wallet did not make.
 */

export const netWorthChangeReasonCodes = Object.freeze({
  partial: "PRICE_CHANGE_PARTIAL",
} as const);

/** Fraction digits of the published USD change and percentage. */
export const netWorthChangeUsdDigits = 6;
export const netWorthChangePctDigits = 4;
const intermediateDigits = 24;

export interface NetWorthChangeRow {
  readonly valueUsd: string;
  /** Percent points, as DexScreener reports `priceChange.h24`; null when not reported. */
  readonly change24hPct: string | null;
}

export type NetWorthChange24h =
  | {
      readonly status: "available";
      /** Signed USD change, rounded to 6 places. */
      readonly usd: string;
      /** Signed percent points, rounded to 4 places. */
      readonly pct: string;
    }
  | { readonly status: "unavailable"; readonly reasonCode: string };

export function computeNetWorthChange24h(
  rows: readonly NetWorthChangeRow[],
): NetWorthChange24h {
  let change = "0";
  let earlier = "0";
  for (const row of rows) {
    if (compareDecimalStrings(row.valueUsd, "0") <= 0) {
      continue;
    }
    const pct = row.change24hPct;
    if (pct === null || !isCanonicalDecimalString(pct)) {
      return partial();
    }
    const denominator = addDecimalStrings("100", pct);
    if (compareDecimalStrings(denominator, "0") <= 0) {
      return partial();
    }
    const rowChange = divideDecimalStrings(
      multiplyDecimalStrings(row.valueUsd, pct),
      denominator,
      intermediateDigits,
    );
    if (rowChange === null) {
      return partial();
    }
    change = addDecimalStrings(change, rowChange);
    earlier = addDecimalStrings(
      earlier,
      subtractDecimalStrings(row.valueUsd, rowChange),
    );
  }
  const usd = roundHalfAwayFromZero(change, netWorthChangeUsdDigits);
  const pct =
    compareDecimalStrings(earlier, "0") <= 0
      ? "0"
      : roundHalfAwayFromZero(
          divideDecimalStrings(
            multiplyDecimalStrings(change, "100"),
            earlier,
            intermediateDigits,
          ) ?? "0",
          netWorthChangePctDigits,
        );
  return Object.freeze({ status: "available" as const, usd, pct });
}

/** Rounds a canonical decimal string to `digits` places, half away from zero. */
function roundHalfAwayFromZero(value: string, digits: number): string {
  const half = `0.${"0".repeat(digits)}5`;
  const shifted = value.startsWith("-")
    ? subtractDecimalStrings(value, half)
    : addDecimalStrings(value, half);
  return divideDecimalStrings(shifted, "1", digits) ?? "0";
}

function partial(): NetWorthChange24h {
  return Object.freeze({
    status: "unavailable" as const,
    reasonCode: netWorthChangeReasonCodes.partial,
  });
}
