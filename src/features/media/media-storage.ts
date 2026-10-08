import type { MediaKind } from "./media-contract.js";

/**
 * Storage port for uploaded media (Decision 0095). PostgreSQL implements it
 * today (`src/database/media-repository.ts`); an object store can replace
 * the implementation later without changing a route or a published ref.
 */

export interface MediaObjectMetadata {
  readonly mediaId: string;
  readonly ownerUserId: string;
  readonly kind: MediaKind;
  readonly contentType: "image/webp";
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface MediaObject extends MediaObjectMetadata {
  readonly bytes: Buffer;
}

export interface PutMediaObjectInput {
  readonly mediaId: string;
  readonly ownerUserId: string;
  readonly kind: MediaKind;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly idempotencyKey: string;
  /** SHA-256 of the uploaded input bytes, bound to the idempotency key. */
  readonly requestSha256: string;
}

export interface MediaStorage {
  /**
   * Stores a new object. When the owner already used `idempotencyKey`, the
   * stored object is returned if `kind` and `requestSha256` match, otherwise
   * `MediaIdempotencyConflictError` is raised; nothing is overwritten.
   */
  put(input: PutMediaObjectInput): Promise<MediaObjectMetadata>;
  /** The stored object of an earlier upload with this key, or null. */
  findByIdempotencyKey(input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
  }): Promise<
    (MediaObjectMetadata & { readonly requestSha256: string }) | null
  >;
  get(mediaId: string): Promise<MediaObject | null>;
  getMetadata(mediaId: string): Promise<MediaObjectMetadata | null>;
}

export class MediaStorageUnavailableError extends Error {
  readonly code = "media_storage_unavailable";

  constructor() {
    super("The media storage is unavailable");
    this.name = "MediaStorageUnavailableError";
  }
}

export class MediaIdempotencyConflictError extends Error {
  readonly code = "media_idempotency_conflict";

  constructor() {
    super("The media upload idempotency key was used for another upload");
    this.name = "MediaIdempotencyConflictError";
  }
}

export function createUnavailableMediaStorage(): MediaStorage {
  const unavailable = (): Promise<never> =>
    Promise.reject(new MediaStorageUnavailableError());
  return Object.freeze({
    put: unavailable,
    findByIdempotencyKey: unavailable,
    get: unavailable,
    getMetadata: unavailable,
  });
}
