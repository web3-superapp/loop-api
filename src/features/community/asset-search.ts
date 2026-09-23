import type { AssetRecord } from "../../database/chain-registry-repository.js";

/**
 * `GET /v2/search?domain=assets` (Decision 0071).
 *
 * The Asset Registry is the operator-curated list of BSC assets LOOP knows
 * (Decision 0033): a dozen rows, never an open token index. A registry search
 * is therefore an in-memory prefix match over the readable rows the registry
 * repository already serves to the wallet and market modules — no new query,
 * no Provider call, and no result that the registry cannot vouch for. A
 * `blocked` asset is never returned because the repository never lists it.
 *
 * The query is matched, in this order of preference, against the on-chain
 * `symbol`, the on-chain `name` (its start, then any later word), and the
 * contract address. Every comparison is a case-insensitive prefix comparison;
 * the address form additionally accepts the hex digits without their `0x`
 * prefix.
 */

export const assetSearchQueryLimits = Object.freeze({
  minimumCodePoints: 2,
  maximumCodePoints: 64,
} as const);

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const hexPrefixPattern = /^(0x)?[0-9a-f]+$/u;
/** Bare hex shorter than this is a symbol or a name, not an address. */
const minimumBareHexLength = 4;

export class InvalidAssetSearchQueryError extends Error {
  constructor() {
    super("The asset search query is not acceptable");
    this.name = "InvalidAssetSearchQueryError";
  }
}

/**
 * Normalizes the literal query the same way the alias prefix is normalized
 * (trim, NFKC, whitespace folded to one ASCII space), lower-cased for the
 * case-insensitive match. 2–64 code points: two so a single letter cannot
 * list the registry, sixty-four so a whole pasted address still fits.
 */
export function parseAssetSearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidAssetSearchQueryError();
  }
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (forbiddenTextCharacters.test(normalized)) {
    throw new InvalidAssetSearchQueryError();
  }
  const codePoints = Array.from(normalized).length;
  if (
    codePoints < assetSearchQueryLimits.minimumCodePoints ||
    codePoints > assetSearchQueryLimits.maximumCodePoints
  ) {
    throw new InvalidAssetSearchQueryError();
  }
  return normalized;
}

/** Which field the query matched; lower ranks sort first. */
export const assetSearchMatchKinds = Object.freeze({
  symbolExact: 0,
  symbolPrefix: 1,
  namePrefix: 2,
  /** A later word of the name starts with the query ("Wrapped BNB" for "bnb"). */
  nameWordPrefix: 3,
  addressPrefix: 4,
} as const);
export type AssetSearchMatchKind =
  (typeof assetSearchMatchKinds)[keyof typeof assetSearchMatchKinds];

export interface AssetSearchMatch {
  readonly asset: AssetRecord;
  readonly rank: AssetSearchMatchKind;
}

export function matchRegistryAsset(
  asset: AssetRecord,
  query: string,
): AssetSearchMatch | null {
  const symbol = asset.symbol.normalize("NFKC").toLowerCase();
  if (symbol === query) {
    return Object.freeze({ asset, rank: assetSearchMatchKinds.symbolExact });
  }
  if (symbol.startsWith(query)) {
    return Object.freeze({ asset, rank: assetSearchMatchKinds.symbolPrefix });
  }
  const name = asset.name.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
  if (name.startsWith(query)) {
    return Object.freeze({ asset, rank: assetSearchMatchKinds.namePrefix });
  }
  if (name.split(" ").some((word) => word.startsWith(query))) {
    return Object.freeze({
      asset,
      rank: assetSearchMatchKinds.nameWordPrefix,
    });
  }
  if (asset.address !== null && hexPrefixPattern.test(query)) {
    const address = asset.address.toLowerCase();
    const bare = query.startsWith("0x") ? query.slice(2) : query;
    const addressMatches = query.startsWith("0x")
      ? address.startsWith(query)
      : bare.length >= minimumBareHexLength &&
        address.slice(2).startsWith(bare);
    if (addressMatches) {
      return Object.freeze({
        asset,
        rank: assetSearchMatchKinds.addressPrefix,
      });
    }
  }
  return null;
}

/**
 * Total order for a result page: best match first, then symbol, then the
 * asset ID so two rows with the same symbol still order deterministically.
 * The page cursor continues after the last `assetId` under this same order.
 */
export function compareAssetSearchMatches(
  left: AssetSearchMatch,
  right: AssetSearchMatch,
): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  const leftSymbol = left.asset.symbol.toLowerCase();
  const rightSymbol = right.asset.symbol.toLowerCase();
  if (leftSymbol !== rightSymbol) {
    return leftSymbol < rightSymbol ? -1 : 1;
  }
  return left.asset.assetId < right.asset.assetId
    ? -1
    : left.asset.assetId > right.asset.assetId
      ? 1
      : 0;
}

export interface AssetSearchPage {
  readonly items: readonly AssetSearchMatch[];
  readonly hasMore: boolean;
}

/**
 * Filters, orders, and pages the readable registry rows. `afterAssetId` is
 * the last row of the previous page; a value that is no longer in the ordered
 * result (the registry changed between pages) simply starts from the top,
 * which is the honest answer for a list that no longer contains that row.
 */
export function searchRegistryAssets(
  assets: readonly AssetRecord[],
  query: string,
  page: { readonly limit: number; readonly afterAssetId: string | null },
): AssetSearchPage {
  const ordered = assets
    .map((asset) => matchRegistryAsset(asset, query))
    .filter((match): match is AssetSearchMatch => match !== null)
    .sort(compareAssetSearchMatches);
  const startIndex =
    page.afterAssetId === null
      ? 0
      : ordered.findIndex(
          (match) => match.asset.assetId === page.afterAssetId,
        ) + 1;
  const items = ordered.slice(startIndex, startIndex + page.limit);
  return Object.freeze({
    items: Object.freeze(items),
    hasMore: startIndex + page.limit < ordered.length,
  });
}
