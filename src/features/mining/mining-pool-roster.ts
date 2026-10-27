import {
  formatMiningDecimal,
  miningFixedScale,
  parseMiningDecimal,
  type MiningParameterDocument,
} from "./hourly-settlement-contract.js";

/**
 * Decision 0187 (requirer 2026-10-27, user ruling the same day): the mining
 * pool roster. Every platform MEME (a launch2 instance's MEME, any chain)
 * that a **verified** community binds (`communities.bound_asset_key`, one
 * token one community) takes part in the hourly settlement and in the
 * snapshot without any console registration:
 *
 * - token weight = the document's explicit `assetWeights` entry; unlisted →
 *   1; listed in `excludedAssets` → 0 (excluded wins over explicit);
 * - NFT coefficient = the explicit `communityCoefficients` entry; unlisted →
 *   `defaultCommunityCoefficient` (1 for every document since 0123); listed
 *   in `excludedCommunities` → 0;
 * - "participates" = neither the asset nor the community is excluded; the
 *   console unticks a row by adding both.
 *
 * The roster default (1) applies only to `quantity` documents; a Decision
 * 0116 `valuation` document (replay only) keeps its own table. An asset
 * outside the candidate set (BTCB, USDT, a MEME v1 token, an unbound or
 * pending-community launch2 MEME) keeps the pre-0187 rule: its explicit
 * weight or nothing. Pure: no clock, database, or network.
 */

export const miningPoolDefaultTokenWeight = "1" as const;

/** One verified community × the launch2 MEME it binds. */
export interface MiningPoolCandidate {
  readonly communityId: string;
  readonly communityName: string;
  /** `eip155:{chain}:{meme}` — the community's `bound_asset_key`. */
  readonly assetId: string;
  readonly chainId: string;
  readonly memeAddress: string;
  /** The launch2 instance ticker. */
  readonly symbol: string;
  /** Opaque launch2 instance id. */
  readonly instanceId: string;
  /** On-chain launch id (`0x` + 64 hex). */
  readonly launchId: string;
}

export type MiningPoolValueSource = "default" | "explicit";

export interface MiningPoolEntry {
  readonly participate: boolean;
  /** Decimal string; "0" when excluded. */
  readonly tokenWeight: string;
  readonly nftCoefficient: string;
  /**
   * `explicit` when the document names the asset or the community in any of
   * `assetWeights`, `communityCoefficients`, `excludedAssets`,
   * `excludedCommunities`; `default` otherwise.
   */
  readonly source: MiningPoolValueSource;
}

function excludedAssetsOf(document: MiningParameterDocument): Set<string> {
  return new Set(document.excludedAssets ?? []);
}

function excludedCommunitiesOf(document: MiningParameterDocument): Set<string> {
  return new Set(document.excludedCommunities ?? []);
}

/** Whether the roster default applies to the document at all. */
export function miningPoolRosterApplies(
  document: MiningParameterDocument,
): boolean {
  return document.assetPowerBasis === "quantity";
}

/**
 * The effective asset weights (1e18) of a document: the explicit table,
 * every candidate asset it does not list at weight 1 (quantity documents
 * only), every excluded asset at 0. An asset absent from the map weighs 0.
 */
export function miningEffectiveAssetWeights(
  document: MiningParameterDocument,
  candidateAssetIds: readonly string[],
): ReadonlyMap<string, bigint> {
  const weights = new Map<string, bigint>(
    document.assetWeights.map((entry) => [
      entry.assetId,
      parseMiningDecimal(entry.weight) ?? 0n,
    ]),
  );
  if (miningPoolRosterApplies(document)) {
    for (const assetId of [...candidateAssetIds].sort()) {
      if (!weights.has(assetId)) weights.set(assetId, miningFixedScale);
    }
  }
  for (const assetId of excludedAssetsOf(document)) {
    if (weights.has(assetId)) weights.set(assetId, 0n);
  }
  return new Map([...weights.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The explicit community coefficients (1e18) with every excluded community
 * at 0; an unlisted community reads `defaultCommunityCoefficient`.
 */
export function miningEffectiveCommunityCoefficients(
  document: MiningParameterDocument,
): ReadonlyMap<string, bigint> {
  const coefficients = new Map<string, bigint>(
    document.communityCoefficients.map((entry) => [
      entry.communityId,
      parseMiningDecimal(entry.coefficient) ?? 0n,
    ]),
  );
  for (const communityId of excludedCommunitiesOf(document)) {
    coefficients.set(communityId, 0n);
  }
  return new Map(
    [...coefficients.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * One roster row as the console shows it. `document` null (no approved
 * version yet) shows the defaults: participating, 1 and 1.
 */
export function resolveMiningPoolEntry(
  document: MiningParameterDocument | null,
  candidate: Pick<MiningPoolCandidate, "assetId" | "communityId">,
): MiningPoolEntry {
  if (document === null) {
    return Object.freeze({
      participate: true,
      tokenWeight: miningPoolDefaultTokenWeight,
      nftCoefficient: "1",
      source: "default" as const,
    });
  }
  const assetExcluded = excludedAssetsOf(document).has(candidate.assetId);
  const communityExcluded = excludedCommunitiesOf(document).has(
    candidate.communityId,
  );
  const explicitWeight = document.assetWeights.find(
    (entry) => entry.assetId === candidate.assetId,
  );
  const explicitCoefficient = document.communityCoefficients.find(
    (entry) => entry.communityId === candidate.communityId,
  );
  const tokenWeight = assetExcluded
    ? "0"
    : (explicitWeight?.weight ??
      (miningPoolRosterApplies(document) ? miningPoolDefaultTokenWeight : "0"));
  const nftCoefficient = communityExcluded
    ? "0"
    : (explicitCoefficient?.coefficient ??
      formatMiningDecimal(
        parseMiningDecimal(document.defaultCommunityCoefficient) ?? 0n,
      ));
  return Object.freeze({
    participate: !assetExcluded && !communityExcluded,
    tokenWeight,
    nftCoefficient,
    source:
      assetExcluded ||
      communityExcluded ||
      explicitWeight !== undefined ||
      explicitCoefficient !== undefined
        ? ("explicit" as const)
        : ("default" as const),
  });
}
