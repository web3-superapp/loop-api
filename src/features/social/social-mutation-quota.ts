import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";

const minimumSecretBytes = 32;
const policyVersion = "social_mutation_v1";
const hmacDomain = "loop.social-mutation-quota\0v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SocialMutationCapability =
  "friend_request_send" | "friend_request_decide";

export type SocialMutationQuotaRepository = Pick<
  ControlPlaneRepository,
  "consumeIssuanceQuota"
>;

export interface SocialMutationQuotaInput {
  readonly capability: SocialMutationCapability;
  readonly userId: string;
  readonly canonicalClientIp: string;
  readonly targetRef: string;
  readonly signal: AbortSignal;
}

export interface SocialMutationQuota {
  consume(input: SocialMutationQuotaInput): Promise<void>;
}

export class SocialMutationRateLimitedError extends Error {
  constructor() {
    super("The social mutation quota is exhausted");
    this.name = "SocialMutationRateLimitedError";
  }
}

export class SocialMutationQuotaUnavailableError extends Error {
  constructor() {
    super("The social mutation quota is unavailable");
    this.name = "SocialMutationQuotaUnavailableError";
  }
}

export function createUnavailableSocialMutationQuota(): SocialMutationQuota {
  return Object.freeze({
    consume: (): Promise<never> =>
      Promise.reject(new SocialMutationQuotaUnavailableError()),
  });
}

function createHmacKey(secret: Uint8Array): KeyObject {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("The social mutation quota secret is invalid");
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
  capability: string,
  subjectKind: string,
  subject: string,
): string {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update(`\0${policyVersion}\0`, "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

export function createSocialMutationQuota(input: {
  readonly repository: SocialMutationQuotaRepository;
  readonly hmacSecret: Uint8Array;
}): SocialMutationQuota {
  const key = createHmacKey(input.hmacSecret);

  return Object.freeze({
    async consume(request: SocialMutationQuotaInput): Promise<void> {
      request.signal.throwIfAborted();
      if (
        !uuidPattern.test(request.userId) ||
        !uuidPattern.test(request.targetRef) ||
        !isCanonicalIp(request.canonicalClientIp)
      ) {
        throw new SocialMutationQuotaUnavailableError();
      }

      const capability = `social_${request.capability}`;
      const decision = request.capability === "friend_request_decide";
      try {
        await input.repository.consumeIssuanceQuota({
          capability,
          policyVersion,
          buckets: [
            {
              subjectKind: "user_minute",
              subjectHmac: subjectHmac(
                key,
                capability,
                "user_minute",
                request.userId,
              ),
              windowDurationSeconds: 60,
              capacity: decision ? 30 : 10,
            },
            {
              subjectKind: "ip_minute",
              subjectHmac: subjectHmac(
                key,
                capability,
                "ip_minute",
                request.canonicalClientIp,
              ),
              windowDurationSeconds: 60,
              capacity: decision ? 60 : 30,
            },
            {
              subjectKind: decision ? "request_day" : "target_day",
              subjectHmac: subjectHmac(
                key,
                capability,
                decision ? "request_day" : "target_day",
                request.targetRef,
              ),
              windowDurationSeconds: 86_400,
              capacity: decision ? 40 : 20,
            },
          ],
        });
      } catch (error) {
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }
        if (error instanceof IssuanceQuotaExceededError) {
          throw new SocialMutationRateLimitedError();
        }
        if (error instanceof ControlPlaneUnavailableError) {
          throw new SocialMutationQuotaUnavailableError();
        }
        throw new SocialMutationQuotaUnavailableError();
      }
      request.signal.throwIfAborted();
    },
  });
}
