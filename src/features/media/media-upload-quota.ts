import { createHmac, createSecretKey, type KeyObject } from "node:crypto";

import {
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";
import { mediaUploadsPerMinute } from "./media-contract.js";

/**
 * Upload rate limit (Decision 0095): six uploads per user per minute across
 * both upload routes, recorded in `issuance_rate_records` under an
 * HMAC-keyed subject so the table never holds a raw user ID.
 */

const minimumSecretBytes = 32;
const capability = "media_upload";
const policyVersion = "media_upload_v1";
const hmacDomain = "loop.media-upload-quota\0v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MediaUploadQuota {
  consume(userId: string): Promise<void>;
}

export class MediaUploadRateLimitedError extends Error {
  constructor() {
    super("The media upload quota is exhausted");
    this.name = "MediaUploadRateLimitedError";
  }
}

export class MediaUploadQuotaUnavailableError extends Error {
  constructor() {
    super("The media upload quota is unavailable");
    this.name = "MediaUploadQuotaUnavailableError";
  }
}

export function createUnavailableMediaUploadQuota(): MediaUploadQuota {
  return Object.freeze({
    consume: (): Promise<never> =>
      Promise.reject(new MediaUploadQuotaUnavailableError()),
  });
}

function createHmacKey(secret: Uint8Array): KeyObject {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("The media upload quota secret is invalid");
  }
  const copy = Buffer.from(secret);
  try {
    return createSecretKey(copy);
  } finally {
    copy.fill(0);
  }
}

export function createMediaUploadQuota(input: {
  readonly repository: Pick<ControlPlaneRepository, "consumeIssuanceQuota">;
  readonly hmacSecret: Uint8Array;
}): MediaUploadQuota {
  const key = createHmacKey(input.hmacSecret);
  return Object.freeze({
    async consume(userId: string): Promise<void> {
      if (!uuidPattern.test(userId)) {
        throw new MediaUploadQuotaUnavailableError();
      }
      const subjectHmac = createHmac("sha256", key)
        .update(hmacDomain, "utf8")
        .update(`\0${capability}\0${policyVersion}\0user_minute\0`, "utf8")
        .update(userId, "utf8")
        .digest("hex");
      try {
        await input.repository.consumeIssuanceQuota({
          capability,
          policyVersion,
          buckets: [
            {
              subjectKind: "user_minute",
              subjectHmac,
              windowDurationSeconds: 60,
              capacity: mediaUploadsPerMinute,
            },
          ],
        });
      } catch (error) {
        if (error instanceof IssuanceQuotaExceededError) {
          throw new MediaUploadRateLimitedError();
        }
        throw new MediaUploadQuotaUnavailableError();
      }
    },
  });
}
