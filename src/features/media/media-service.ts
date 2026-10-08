import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  avatarRefMediaId,
  isMediaId,
  mediaEtag,
  mediaPath,
  mediaReasonCodes,
  mediaRef,
  type MediaKind,
} from "./media-contract.js";
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
  readonly contractVersion: typeof v2ContractVersion;
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
}

export function mediaRejected(
  reasonCode: (typeof mediaReasonCodes)[keyof typeof mediaReasonCodes],
): V2ApiError {
  return V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode });
}

function project(metadata: MediaObjectMetadata): MediaUploadResource {
  return Object.freeze({
    mediaId: metadata.mediaId,
    ref: mediaRef(metadata.kind, metadata.mediaId),
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
}): MediaService {
  const generateMediaId = options.generateMediaId ?? randomUUID;

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
          return project(earlier);
        }
        await options.quota.consume(ownerUserId);
        const processed = await processMediaUpload(input.bytes);
        const stored = await options.storage.put({
          mediaId: generateMediaId(),
          ownerUserId,
          kind: input.kind,
          bytes: processed.bytes,
          width: processed.width,
          height: processed.height,
          sha256: processed.sha256,
          idempotencyKey: input.idempotencyKey,
          requestSha256,
        });
        return project(stored);
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
  });
}
