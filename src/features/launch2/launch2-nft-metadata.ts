import type { Launch2Stage } from "./launch2-contract.js";
import type { Launch2InstanceRecord } from "./launch2-ports.js";

/**
 * Decision 0173: the ERC-721 metadata JSON of one MEME v2 project NFT,
 * served at `GET /v2/launch2/nft/{launchId}/{tokenId}` — the stable target
 * of a future on-chain `_baseURI` (`<base>/v2/launch2/nft/<launchId>/`).
 *
 * Only public facts: the project name / ticker / description, the stage,
 * the token id, and the picture. `image` is `ipfs://<cid>` when the NFT
 * picture was pinned, else its https URL, else the logo, else null;
 * `image_gateway` is the https form of the same picture (the IPFS gateway
 * URL) for clients that do not resolve `ipfs://`. Never a wallet, holder,
 * owner or viewer field.
 */

/** Shown when the project saved no description. */
export const launch2NftFallbackDescription =
  "A project NFT of a MEME v2 launch on LOOP.";

/** `0x` + 64 hex (any case): the Factory's bytes32 launch id. */
export const launch2NftLaunchIdPatternSource = "^0x[0-9a-fA-F]{64}$";

/** A positive decimal token id without leading zeros (1..n). */
export const launch2NftTokenIdPatternSource = "^[1-9][0-9]{0,9}$";

export interface Launch2NftMetadata {
  readonly name: string;
  readonly description: string;
  readonly image: string | null;
  readonly image_gateway: string | null;
  readonly attributes: readonly [
    { readonly trait_type: "Project"; readonly value: string },
    { readonly trait_type: "Token ID"; readonly value: number },
    { readonly trait_type: "Stage"; readonly value: Launch2Stage },
  ];
}

export function launch2NftMetadataOf(
  record: Pick<
    Launch2InstanceRecord,
    | "name"
    | "ticker"
    | "logoUrl"
    | "nftImageUrl"
    | "nftImageCid"
    | "projectProfile"
  >,
  tokenId: number,
  stage: Launch2Stage,
): Launch2NftMetadata {
  const description = record.projectProfile?.description?.trim() ?? "";
  return Object.freeze({
    name: `${record.name} #${tokenId}`,
    description:
      description.length === 0 ? launch2NftFallbackDescription : description,
    image:
      record.nftImageCid === null
        ? (record.nftImageUrl ?? record.logoUrl ?? null)
        : `ipfs://${record.nftImageCid}`,
    image_gateway: record.nftImageUrl ?? record.logoUrl ?? null,
    attributes: Object.freeze([
      Object.freeze({ trait_type: "Project" as const, value: record.ticker }),
      Object.freeze({ trait_type: "Token ID" as const, value: tokenId }),
      Object.freeze({ trait_type: "Stage" as const, value: stage }),
    ] as const),
  });
}
