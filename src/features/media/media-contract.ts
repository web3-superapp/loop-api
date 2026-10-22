/**
 * Uploaded media contract (Decision 0095). A media object is an immutable
 * 512 x 512 WebP picture addressed by an opaque `mediaId` (UUIDv4). Profiles
 * and communities reference it through an opaque ref string; the public URL
 * is a path under this API, never a storage location.
 */

export const mediaKinds = Object.freeze([
  "avatar",
  "community_logo",
  // Decision 0173: the project NFT picture (pinned to IPFS when configured).
  "project_nft_image",
] as const);
export type MediaKind = (typeof mediaKinds)[number];
/**
 * Decision 0140: every kind a stored object can have. `campaign_cover` is
 * uploaded from the operator console (no LOOP user owner) and is never
 * referenced by a profile or community ref.
 */
export const storedMediaKinds = Object.freeze([
  ...mediaKinds,
  "campaign_cover",
] as const);
export type StoredMediaKind = (typeof storedMediaKinds)[number];

export const mediaContentType = "image/webp" as const;
export const mediaOutputSize = 512;
export const mediaOutputQuality = 82;
export const mediaMinimumInputSide = 64;
/** Multipart file part limit (5 MiB). */
export const mediaMaximumUploadBytes = 5 * 1024 * 1024;
/** Decoder guard against decompression bombs (50 megapixels). */
export const mediaMaximumInputPixels = 50_000_000;
/**
 * Decision 0140: console campaign covers. PNG / JPEG / WebP by content,
 * at most 2 MiB, at least 600 x 300, stored as a 1200 x 600 cover WebP
 * (2:1, centre crop).
 */
export const campaignCoverWidth = 1200;
export const campaignCoverHeight = 600;
export const campaignCoverMinimumWidth = 600;
export const campaignCoverMinimumHeight = 300;
export const campaignCoverMaximumUploadBytes = 2 * 1024 * 1024;
/** Shared by both upload routes, per user per minute. */
export const mediaUploadsPerMinute = 6;

export const mediaIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const mediaIdBody =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const avatarMediaRefPatternSource = `^avatar:media/${mediaIdBody}$`;
export const logoMediaRefPatternSource = `^logo:media/${mediaIdBody}$`;
/** Decision 0173: `nft:media/{mediaId}` (informational; drafts take the URL). */
export const nftMediaRefPatternSource = `^nft:media/${mediaIdBody}$`;

/**
 * Decision 0173: an IPFS CID as Filebase / Kubo `add` returns it — CIDv0
 * (`Qm` + 44 base58) or a base32 CIDv1 (`b…`).
 */
export const ipfsCidPatternSource =
  "^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$";
const ipfsCidPattern = new RegExp(ipfsCidPatternSource);

export function isIpfsCid(value: unknown): value is string {
  return typeof value === "string" && ipfsCidPattern.test(value);
}

/** `<gateway base>/<cid>` (base with or without trailing slash). */
export function ipfsGatewayUrl(gatewayBaseUrl: string, cid: string): string {
  return `${gatewayBaseUrl.replace(/\/+$/u, "")}/${cid}`;
}

/**
 * Decision 0173: which uploaded object a draft's `nftImageAssetUrl` names —
 * `<IPFS_GATEWAY_BASE_URL>/<cid>` or `<PUBLIC_BASE_URL>/v2/media/<id>.webp`
 * (exactly, no query or fragment). Null for any other URL.
 */
export type ProjectNftImageReference =
  | { readonly kind: "cid"; readonly cid: string }
  | { readonly kind: "media"; readonly mediaId: string };

export function parseProjectNftImageReference(
  value: unknown,
  bases: {
    readonly publicBaseUrl: string;
    readonly ipfsGatewayBaseUrl: string | null;
  },
): ProjectNftImageReference | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  if (bases.ipfsGatewayBaseUrl !== null) {
    const prefix = `${bases.ipfsGatewayBaseUrl.replace(/\/+$/u, "")}/`;
    if (value.startsWith(prefix)) {
      const cid = value.slice(prefix.length);
      return isIpfsCid(cid) ? { kind: "cid", cid } : null;
    }
  }
  const mediaPrefix = `${bases.publicBaseUrl.replace(/\/+$/u, "")}/v2/media/`;
  if (value.startsWith(mediaPrefix) && value.endsWith(".webp")) {
    const mediaId = value.slice(mediaPrefix.length, -".webp".length);
    return mediaIdPattern.test(mediaId) ? { kind: "media", mediaId } : null;
  }
  return null;
}

const mediaIdPattern = new RegExp(mediaIdPatternSource);
const avatarMediaRefPattern = new RegExp(`^avatar:media/(${mediaIdBody})$`);
const logoMediaRefPattern = new RegExp(`^logo:media/(${mediaIdBody})$`);

/** `detailsSafe.reasonCode` values of a `VALIDATION_FAILED` media failure. */
export const mediaReasonCodes = Object.freeze({
  typeUnsupported: "MEDIA_TYPE_UNSUPPORTED",
  tooLarge: "MEDIA_TOO_LARGE",
  dimensionsTooSmall: "MEDIA_DIMENSIONS_TOO_SMALL",
  decodeFailed: "MEDIA_DECODE_FAILED",
  notOwned: "MEDIA_NOT_OWNED",
  notAuthorized: "MEDIA_NOT_AUTHORIZED",
} as const);

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && mediaIdPattern.test(value);
}

/** The media ID inside `avatar:media/{id}`, or null for any other value. */
export function avatarRefMediaId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return avatarMediaRefPattern.exec(value)?.[1] ?? null;
}

/** The media ID inside `logo:media/{id}`, or null for any other value. */
export function logoRefMediaId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return logoMediaRefPattern.exec(value)?.[1] ?? null;
}

export function mediaRef(kind: MediaKind, mediaId: string): string {
  return kind === "avatar"
    ? `avatar:media/${mediaId}`
    : kind === "project_nft_image"
      ? `nft:media/${mediaId}`
      : `logo:media/${mediaId}`;
}

/** The API-relative path of a media object; clients prefix their base URL. */
export function mediaPath(mediaId: string): string {
  return `/v2/media/${mediaId}.webp`;
}

/** The absolute URL under `publicBaseUrl` (with or without trailing slash). */
export function mediaAbsoluteUrl(
  publicBaseUrl: string,
  mediaId: string,
): string {
  return `${publicBaseUrl.replace(/\/+$/u, "")}${mediaPath(mediaId)}`;
}

/** Strong ETag derived from the stored SHA-256 of the WebP bytes. */
export function mediaEtag(sha256Hex: string): string {
  return `"${Buffer.from(sha256Hex, "hex").toString("base64url")}"`;
}
