import {
  compareDecimalStrings,
  type MarketAssetSort,
} from "./market-contract.js";

/**
 * Ordering and keyset of the categorised market list (Decision 0100).
 *
 * Rows are ordered by the sort field descending; rows without a value for
 * the field (no quote, or the Provider did not report that number) follow
 * every valued row; `assetId` ascending breaks every tie. A cursor carries
 * the last row's key, so the next page is "every row strictly after this
 * key" in the same order, recomputed on fresh prices.
 */

export interface MarketCategoryOrderKey {
  /** Canonical decimal string of the sort field, or null when not reported. */
  readonly value: string | null;
  readonly assetId: string;
}

export const marketCategoryOrdering: Readonly<Record<MarketAssetSort, string>> =
  Object.freeze({
    marketCap: "dexscreener_market_cap_desc",
    change24h: "dexscreener_price_change_h24_desc",
    volume24h: "dexscreener_volume_h24_desc",
  });

/** Negative when `left` comes first. */
export function compareMarketCategoryKeys(
  left: MarketCategoryOrderKey,
  right: MarketCategoryOrderKey,
): number {
  if (left.value !== null && right.value !== null) {
    const byValue = compareDecimalStrings(right.value, left.value);
    if (byValue !== 0) {
      return byValue;
    }
  } else if (left.value !== null) {
    return -1;
  } else if (right.value !== null) {
    return 1;
  }
  return left.assetId < right.assetId
    ? -1
    : left.assetId > right.assetId
      ? 1
      : 0;
}

/**
 * Orders the rows, drops every row at or before `after`, and cuts one page.
 * `hasMore` is true when a row exists past the page.
 */
export function pageMarketCategoryRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => MarketCategoryOrderKey,
  after: MarketCategoryOrderKey | null,
  pageSize: number,
): { readonly items: readonly T[]; readonly hasMore: boolean } {
  const ordered = [...rows].sort((left, right) =>
    compareMarketCategoryKeys(keyOf(left), keyOf(right)),
  );
  const remaining =
    after === null
      ? ordered
      : ordered.filter(
          (row) => compareMarketCategoryKeys(keyOf(row), after) > 0,
        );
  return Object.freeze({
    items: Object.freeze(remaining.slice(0, pageSize)),
    hasMore: remaining.length > pageSize,
  });
}
