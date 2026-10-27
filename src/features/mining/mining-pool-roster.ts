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
 * Decision 0188 (power list): every other asset a verified community binds
 * (an **external** token, e.g. a BSC mainnet asset or a MEME v1 token) is a
 * roster row too, but let in by hand: it participates only while its asset
 * is in `includedAssets` and neither it nor the community is excluded; its
 * weight is then the explicit entry, else 1; otherwise it weighs 0 even when
 * `assetWeights` lists it. The roster is the only rule for bound assets; the
 * `community_mining_weights` table is no longer read.
 *
 * The roster default (1) applies only to `quantity` documents; a Decision
 * 0116 `valuation` document (replay only) keeps its own table. An asset no
 * verified community binds (BTCB, USDT, an unbound or pending-community
 * MEME) keeps the pre-0187 rule: its explicit weight or nothing. Pure: no
 * clock, database, or network.
 */

export const miningPoolDefaultTokenWeight = "1" as const;

/**
 * Decision 0188: `platform` = the bound asset is a launch2 MEME (default in);
 * `external` = any other bound asset (default out, let in by hand).
 */
export type MiningPoolKind = "platform" | "external";

/** One verified community × the asset it binds. */
export interface MiningPoolCandidate {
  readonly communityId: string;
  readonly communityName: string;
  /** `eip155:{chain}:{address}` — the community's `bound_asset_key`. */
  readonly assetId: string;
  readonly chainId: string;
  /** The bound token's contract address (the MEME for a platform row). */
  readonly memeAddress: string;
  readonly kind: MiningPoolKind;
  /**
   * The launch2 instance ticker; for an external row the asset registry
   * symbol (null when the asset is not registered).
   */
  readonly symbol: string | null;
  /** Opaque launch2 instance id; null for an external row. */
  readonly instanceId: string | null;
  /** On-chain launch id (`0x` + 64 hex); null for an external row. */
  readonly launchId: string | null;
  /**
   * Decision 0188: where the hourly settlement reads the asset's holdings —
   * `launch2` (platform), `meme_v1` (an external MEME v1 token), or null
   * (no settlement source: the snapshot alone values it). Optional on older
   * fixtures (→ launch2 for platform, null for external).
   */
  readonly settlementSource?: "launch2" | "meme_v1" | null;
}

/** Decision 0188: the external rows of a candidate list, by asset id. */
export function miningPoolExternalAssetIds(
  candidates: readonly Pick<MiningPoolCandidate, "assetId" | "kind">[],
): readonly string[] {
  return [
    ...new Set(
      candidates
        .filter((row) => row.kind === "external")
        .map((row) => row.assetId),
    ),
  ].sort();
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

function includedAssetsOf(document: MiningParameterDocument): Set<string> {
  return new Set(document.includedAssets ?? []);
}

/** Whether the roster default applies to the document at all. */
export function miningPoolRosterApplies(
  document: MiningParameterDocument,
): boolean {
  return document.assetPowerBasis === "quantity";
}

/**
 * Decision 0188: the external roster rows a weight map is built with.
 * `assetIds` are the external assets (gated: out unless `includedAssets`
 * lists them); `readable`, when given, narrows the ones that may weigh at
 * all (the hourly settlement passes the assets it has a source for — an
 * external token without one is valued by the snapshot only).
 */
export interface MiningPoolExternalAssets {
  readonly assetIds: readonly string[];
  readonly readable?: ReadonlySet<string>;
}

/**
 * Decision 0188: the external roster a settlement (or the snapshot's pool
 * part) gates — every external candidate plus every asset some version lets
 * in (`includedAssets`) that is not a platform MEME, so an asset let in
 * whose community later left the roster still never reaches a reader that
 * has no source for it. `readable` = the external candidates on `chainId`
 * with a MEME v1 source (pass `chainId` null for none). Null when empty.
 */
export function miningPoolExternalFor(
  candidates: readonly Pick<
    MiningPoolCandidate,
    "assetId" | "kind" | "chainId" | "settlementSource"
  >[],
  versions: readonly { readonly document: MiningParameterDocument }[],
  chainId: string | null,
): MiningPoolExternalAssets | null {
  const platform = new Set(
    candidates
      .filter((row) => row.kind !== "external")
      .map((row) => row.assetId),
  );
  const assetIds = new Set(miningPoolExternalAssetIds(candidates));
  for (const version of versions) {
    for (const assetId of version.document.includedAssets ?? []) {
      if (!platform.has(assetId)) assetIds.add(assetId);
    }
  }
  if (assetIds.size === 0) return null;
  const readable = new Set(
    candidates
      .filter(
        (row) =>
          row.kind === "external" &&
          chainId !== null &&
          row.chainId === chainId &&
          row.settlementSource === "meme_v1",
      )
      .map((row) => row.assetId),
  );
  return Object.freeze({
    assetIds: Object.freeze([...assetIds].sort()),
    readable,
  });
}

/**
 * The effective asset weights (1e18) of a document: the explicit table,
 * every candidate asset it does not list at weight 1 (quantity documents
 * only), every excluded asset at 0. Decision 0188: an external roster asset
 * is in the map only while `includedAssets` lists it (explicit weight, else
 * 1) and, with `readable`, only when readable. An asset absent from the map
 * weighs 0.
 */
export function miningEffectiveAssetWeights(
  document: MiningParameterDocument,
  candidateAssetIds: readonly string[],
  external: MiningPoolExternalAssets | null = null,
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
    if (external !== null) {
      const included = includedAssetsOf(document);
      for (const assetId of [...external.assetIds].sort()) {
        const letIn =
          included.has(assetId) &&
          (external.readable === undefined || external.readable.has(assetId));
        if (!letIn) weights.delete(assetId);
        else if (!weights.has(assetId)) weights.set(assetId, miningFixedScale);
      }
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
 * version yet) shows the defaults: a platform row participating at 1 and 1,
 * an external row (Decision 0188) not participating. A row that does not
 * participate shows "0" for both values.
 */
export function resolveMiningPoolEntry(
  document: MiningParameterDocument | null,
  candidate: Pick<MiningPoolCandidate, "assetId" | "communityId"> & {
    readonly kind?: MiningPoolKind;
  },
): MiningPoolEntry {
  const external = candidate.kind === "external";
  if (document === null) {
    return Object.freeze(
      external
        ? {
            participate: false,
            tokenWeight: "0",
            nftCoefficient: "0",
            source: "default" as const,
          }
        : {
            participate: true,
            tokenWeight: miningPoolDefaultTokenWeight,
            nftCoefficient: "1",
            source: "default" as const,
          },
    );
  }
  const assetExcluded = excludedAssetsOf(document).has(candidate.assetId);
  const communityExcluded = excludedCommunitiesOf(document).has(
    candidate.communityId,
  );
  const included = includedAssetsOf(document).has(candidate.assetId);
  const explicitWeight = document.assetWeights.find(
    (entry) => entry.assetId === candidate.assetId,
  );
  const explicitCoefficient = document.communityCoefficients.find(
    (entry) => entry.communityId === candidate.communityId,
  );
  const source =
    assetExcluded ||
    communityExcluded ||
    (external && included) ||
    explicitWeight !== undefined ||
    explicitCoefficient !== undefined
      ? ("explicit" as const)
      : ("default" as const);
  if (external && (!included || !miningPoolRosterApplies(document))) {
    return Object.freeze({
      participate: false,
      tokenWeight: "0",
      nftCoefficient: "0",
      source,
    });
  }
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
    source,
  });
}
