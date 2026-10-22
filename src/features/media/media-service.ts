import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  avatarRefMediaId,
  ipfsGatewayUrl,
  isMediaId,
  mediaAbsoluteUrl,
  mediaEtag,
  mediaPath,
  mediaReasonCodes,
  mediaRef,
  parseProjectNftImageReference,
  type MediaKind,
} from "./media-contract.js";
import { IpfsPinUnavailableError, type IpfsPinner } from "./ipfs-pinner.js";
import {
  MediaRejectedError,
  processMediaUpload,
  sha256Hex,
} from "./media-processor.js";
import {
  MediaIdempotencyConflictError,
  MediaStorageUnavailableError,
  type MediaObjectMetadata,
  type MediaStorage,
} from "./media-storage.js";
import {
  MediaUploadQuotaUnavailableError,
  MediaUploadRateLimitedError,
  type MediaUploadQuota,
} from "./media-upload-quota.js";

/**
 * Media upload and read (Decision 0095). Uploads are owner-bound and
 * idempotent per `Idempotency-Key`; reads are public by `mediaId`.
 */

export interface MediaUploadResource {
  readonly mediaId: string;
  readonly ref: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /**
   * Decision 0173, `project_nft_image` only: `url` is the IPFS gateway URL
   * when pinned (else the API-relative media path, like the other kinds),
   * `mediaUrl` the API-relative local copy, `cid` / `ipfsUri` the pin
   * (null when stored locally only).
   */
  readonly mediaUrl?: string;
  readonly cid?: string | null;
  readonly ipfsUri?: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

/** Decision 0173: a draft's resolved project NFT picture. */
export interface ResolvedProjectNftImage {
  /** Canonical: the gateway URL when pinned, else the absolute media URL. */
  readonly url: string;
  readonly cid: string | null;
}

export interface MediaReadResult {
  readonly bytes: Buffer;
  readonly contentType: "image/webp";
  readonly etag: string;
}

export interface MediaService {
  upload(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly kind: MediaKind;
    readonly idempotencyKey: string;
    readonly bytes: Buffer;
  }): Promise<MediaUploadResource>;
  /** Null when no such object exists. */
  read(mediaId: string): Promise<MediaReadResult | null>;
  /**
   * Refuses an `avatar:media/{id}` ref that is not an avatar the owner
   * uploaded (422 `MEDIA_NOT_OWNED`). Preset refs and null pass unchecked.
   */
  assertAvatarRefOwned(input: {
    readonly ownerUserId: string;
    readonly avatarRef: string | null;
  }): Promise<void>;
  /**
   * Decision 0173: resolves a draft's `nftImageAssetUrl` — the `url` an
   * upload to `POST /v2/media/project-nft-images` returned (gateway URL), or
   * the absolute `<PUBLIC_BASE_URL>/v2/media/<id>.webp` — to the owner's
   * `project_nft_image`. Anything else, another user's object or another
   * kind is 422 `MEDIA_NOT_OWNED`.
   */
  resolveProjectNftImage(input: {
    readonly ownerUserId: string;
    readonly url: unknown;
  }): Promise<ResolvedProjectNftImage>;
}

/** Decision 0173: 503 detailsSafe.reasonCode while the IPFS pin fails. */
export const mediaIpfsUnavailableReason = "MEDIA_IPFS_UNAVAILABLE";

export function mediaRejected(
  reasonCode: (typeof mediaReasonCodes)[keyof typeof mediaReasonCodes],
): V2ApiError {
  return V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode });
}

function project(
  metadata: MediaObjectMetadata,
  kind: MediaKind,
  ipfsGatewayBaseUrl: string | null,
): MediaUploadResource {
  if (kind === "project_nft_image") {
    const cid = metadata.ipfsCid ?? null;
    return Object.freeze({
      mediaId: metadata.mediaId,
      ref: mediaRef(kind, metadata.mediaId),
      url:
        cid !== null && ipfsGatewayBaseUrl !== null
          ? ipfsGatewayUrl(ipfsGatewayBaseUrl, cid)
          : mediaPath(metadata.mediaId),
      mediaUrl: mediaPath(metadata.mediaId),
      cid,
      ipfsUri: cid === null ? null : `ipfs://${cid}`,
      width: metadata.width,
      height: metadata.height,
      contractVersion: v2ContractVersion,
    });
  }
  return Object.freeze({
    mediaId: metadata.mediaId,
    ref: mediaRef(kind, metadata.mediaId),
    url: mediaPath(metadata.mediaId),
    width: metadata.width,
    height: metadata.height,
    contractVersion: v2ContractVersion,
  });
}

function mapFailure(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof MediaRejectedError) {
    throw mediaRejected(error.reasonCode);
  }
  if (error instanceof MediaIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof IpfsPinUnavailableError) {
    throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: mediaIpfsUnavailableReason,
    });
  }
  if (error instanceof MediaUploadRateLimitedError) {
    throw V2ApiError.rateLimited();
  }
  if (
    error instanceof MediaStorageUnavailableError ||
    error instanceof MediaUploadQuotaUnavailableError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function createMediaService(options: {
  readonly storage: MediaStorage;
  readonly quota: MediaUploadQuota;
  readonly generateMediaId?: () => string;
  /**
   * Decision 0173: NFT_IMAGE_STORAGE=filebase pins every
   * `project_nft_image` here before it is stored; null / absent (local)
   * stores it like the other kinds, without a CID.
   */
  readonly ipfsPinner?: IpfsPinner | null;
  /** IPFS_GATEWAY_BASE_URL; null = gateway URLs are not recognised. */
  readonly ipfsGatewayBaseUrl?: string | null;
  /** PUBLIC_BASE_URL, for absolute media URLs; absent = cannot resolve. */
  readonly publicBaseUrl?: string | null;
}): MediaService {
  const generateMediaId = options.generateMediaId ?? randomUUID;
  const ipfsPinner = options.ipfsPinner ?? null;
  const ipfsGatewayBaseUrl =
    ipfsPinner?.gatewayBaseUrl ?? options.ipfsGatewayBaseUrl ?? null;

  return Object.freeze({
    async upload(input: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly kind: MediaKind;
      readonly idempotencyKey: string;
      readonly bytes: Buffer;
    }): Promise<MediaUploadResource> {
      try {
        const ownerUserId = input.principal.userId;
        const requestSha256 = sha256Hex(input.bytes);
        const earlier = await options.storage.findByIdempotencyKey({
          ownerUserId,
          idempotencyKey: input.idempotencyKey,
        });
        if (earlier !== null) {
          if (
            earlier.kind !== input.kind ||
            earlier.requestSha256 !== requestSha256
          ) {
            throw new MediaIdempotencyConflictError();
          }
          return project(earlier, input.kind, ipfsGatewayBaseUrl);
        }
        await options.quota.consume(ownerUserId);
        const processed = await processMediaUpload(input.bytes);
        const mediaId = generateMediaId();
        // Decision 0173: pin the stored (re-encoded, metadata-stripped)
        // bytes, so the CID names exactly what /v2/media serves.
        const ipfsCid =
          input.kind === "project_nft_image" && ipfsPinner !== null
            ? await ipfsPinner.pin({
                bytes: processed.bytes,
                fileName: `${mediaId}.webp`,
              })
            : null;
        const stored = await options.storage.put({
          mediaId,
          ownerUserId,
          kind: input.kind,
          bytes: processed.bytes,
          width: processed.width,
          height: processed.height,
          sha256: processed.sha256,
          idempotencyKey: input.idempotencyKey,
          requestSha256,
          ...(ipfsCid === null ? {} : { ipfsCid }),
        });
        return project(stored, input.kind, ipfsGatewayBaseUrl);
      } catch (error) {
        return mapFailure(error);
      }
    },

    async read(mediaId: string): Promise<MediaReadResult | null> {
      if (!isMediaId(mediaId)) {
        throw V2ApiError.invalidRequest();
      }
      try {
        const stored = await options.storage.get(mediaId);
        return stored === null
          ? null
          : Object.freeze({
              bytes: stored.bytes,
              contentType: stored.contentType,
              etag: mediaEtag(stored.sha256),
            });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async assertAvatarRefOwned(input: {
      readonly ownerUserId: string;
      readonly avatarRef: string | null;
    }): Promise<void> {
      const mediaId = avatarRefMediaId(input.avatarRef);
      if (mediaId === null) {
        return;
      }
      let metadata: MediaObjectMetadata | null;
      try {
        metadata = await options.storage.getMetadata(mediaId);
      } catch (error) {
        return mapFailure(error);
      }
      if (
        metadata === null ||
        metadata.kind !== "avatar" ||
        metadata.ownerUserId !== input.ownerUserId
      ) {
        throw mediaRejected(mediaReasonCodes.notOwned);
      }
    },

    async resolveProjectNftImage(input: {
      readonly ownerUserId: string;
      readonly url: unknown;
    }): Promise<ResolvedProjectNftImage> {
      const publicBaseUrl = options.publicBaseUrl ?? null;
      if (publicBaseUrl === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      const reference = parseProjectNftImageReference(input.url, {
        publicBaseUrl,
        ipfsGatewayBaseUrl,
      });
      if (reference === null) {
        throw mediaRejected(mediaReasonCodes.notOwned);
      }
      let metadata: MediaObjectMetadata | null;
      try {
        metadata =
          reference.kind === "cid"
            ? await options.storage.findProjectNftImageByCid({
                ownerUserId: input.ownerUserId,
                cid: reference.cid,
              })
            : await options.storage.getMetadata(reference.mediaId);
      } catch (error) {
        return mapFailure(error);
      }
      if (
        metadata === null ||
        metadata.kind !== "project_nft_image" ||
        metadata.ownerUserId !== input.ownerUserId
      ) {
        throw mediaRejected(mediaReasonCodes.notOwned);
      }
      const cid = metadata.ipfsCid ?? null;
      return Object.freeze(
        cid !== null && ipfsGatewayBaseUrl !== null
          ? { url: ipfsGatewayUrl(ipfsGatewayBaseUrl, cid), cid }
          : {
              url: mediaAbsoluteUrl(publicBaseUrl, metadata.mediaId),
              cid: null,
            },
      );
    },
  });
}
