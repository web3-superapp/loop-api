import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";
import { unlistedTokenLookupPolicy } from "./market-contract.js";

/**
 * Enumeration guard for unregistered-address lookups (Decision 0058), built
 * on the Decision 0024 issuance-quota buckets: an authenticated user per
 * minute, the canonical client IP per minute, and the user per day. The
 * quota is consumed before any Provider request and regardless of cache
 * state, because a cache hit reveals Provider coverage just as a miss does.
 *
 * Subjects are HMAC-derived with the same server-only secret the alias
 * search uses; LOOP user IDs and IP addresses are never stored.
 */

const minimumSecretBytes = 32;
const hmacDomain = "loop.unlisted-token-lookup-quota\0v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type UnlistedTokenLookupQuotaRepository = Pick<
  ControlPlaneRepository,
  "consumeIssuanceQuota"
>;

export interface UnlistedTokenLookupQuotaInput {
  readonly userId: string;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface UnlistedTokenLookupQuota {
  consume(input: UnlistedTokenLookupQuotaInput): Promise<void>;
}

export class UnlistedTokenLookupRateLimitedError extends Error {
  constructor() {
    super("The unregistered token lookup quota is exhausted");
    this.name = "UnlistedTokenLookupRateLimitedError";
  }
}

export class UnlistedTokenLookupQuotaUnavailableError extends Error {
  constructor() {
    super("The unregistered token lookup quota is unavailable");
    this.name = "UnlistedTokenLookupQuotaUnavailableError";
  }
}

export function createUnavailableUnlistedTokenLookupQuota(): UnlistedTokenLookupQuota {
  return Object.freeze({
    consume: (): Promise<never> =>
      Promise.reject(new UnlistedTokenLookupQuotaUnavailableError()),
  });
}

function createHmacKey(secret: Uint8Array): KeyObject {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("The unlisted token lookup quota secret is invalid");
  }
  const copy = Buffer.from(secret);
  try {
    return createSecretKey(copy);
  } finally {
    copy.fill(0);
  }
}

function isCanonicalIp(value: string): boolean {
  const family = isIP(value);
  if (family === 0) {
    return false;
  }
  try {
    const url =
      family === 6
        ? new URL(`http://[${value}]/`)
        : new URL(`http://${value}/`);
    const canonical = family === 6 ? url.hostname.slice(1, -1) : url.hostname;
    return canonical === value;
  } catch {
    return false;
  }
}

function subjectHmac(
  key: KeyObject,
  subjectKind: string,
  subject: string,
): string {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0", "utf8")
    .update(unlistedTokenLookupPolicy.capability, "utf8")
    .update(`\0${unlistedTokenLookupPolicy.policyVersion}\0`, "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

export function createUnlistedTokenLookupQuota(input: {
  readonly repository: UnlistedTokenLookupQuotaRepository;
  readonly hmacSecret: Uint8Array;
}): UnlistedTokenLookupQuota {
  const key = createHmacKey(input.hmacSecret);

  return Object.freeze({
    async consume(request: UnlistedTokenLookupQuotaInput): Promise<void> {
      request.signal.throwIfAborted();
      if (
        !uuidPattern.test(request.userId) ||
        !isCanonicalIp(request.canonicalClientIp)
      ) {
        throw new UnlistedTokenLookupQuotaUnavailableError();
      }
      try {
        await input.repository.consumeIssuanceQuota({
          capability: unlistedTokenLookupPolicy.capability,
          policyVersion: unlistedTokenLookupPolicy.policyVersion,
          buckets: [
            {
              subjectKind: "user_minute",
              subjectHmac: subjectHmac(key, "user_minute", request.userId),
              windowDurationSeconds: 60,
              capacity: unlistedTokenLookupPolicy.userMinuteCapacity,
            },
            {
              subjectKind: "ip_minute",
              subjectHmac: subjectHmac(
                key,
                "ip_minute",
                request.canonicalClientIp,
              ),
              windowDurationSeconds: 60,
              capacity: unlistedTokenLookupPolicy.ipMinuteCapacity,
            },
            {
              subjectKind: "user_day",
              subjectHmac: subjectHmac(key, "user_day", request.userId),
              windowDurationSeconds: 86_400,
              capacity: unlistedTokenLookupPolicy.userDayCapacity,
            },
          ],
        });
      } catch (error) {
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }
        if (error instanceof IssuanceQuotaExceededError) {
          throw new UnlistedTokenLookupRateLimitedError();
        }
        if (error instanceof ControlPlaneUnavailableError) {
          throw new UnlistedTokenLookupQuotaUnavailableError();
        }
        throw new UnlistedTokenLookupQuotaUnavailableError();
      }
      request.signal.throwIfAborted();
    },
  });
}
