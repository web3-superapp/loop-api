/**
 * Uploaded media contract (Decision 0095). A media object is an immutable
 * 512 x 512 WebP picture addressed by an opaque `mediaId` (UUIDv4). Profiles
 * and communities reference it through an opaque ref string; the public URL
 * is a path under this API, never a storage location.
 */

export const mediaKinds = Object.freeze(["avatar", "community_logo"] as const);
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
