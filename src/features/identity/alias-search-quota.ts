import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";

const minimumSecretBytes = 32;
const quotaPolicyVersion = "alias_search_v1";
const hmacDomain = "loop.alias-search-quota\0v1";

export type AliasSearchScope = "public" | "group";

export type AliasSearchQuotaRepository = Pick<
  ControlPlaneRepository,
  "consumeIssuanceQuota"
>;

export interface AliasSearchQuotaInput {
  readonly scope: AliasSearchScope;
  readonly userId: string;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface AliasSearchQuota {
  consume(input: AliasSearchQuotaInput): Promise<void>;
}

export class AliasSearchRateLimitedError extends Error {
  constructor() {
    super("The alias search quota is exhausted");
    this.name = "AliasSearchRateLimitedError";
  }
}

export class AliasSearchQuotaUnavailableError extends Error {
  constructor() {
    super("The alias search quota is unavailable");
    this.name = "AliasSearchQuotaUnavailableError";
  }
}

export function createUnavailableAliasSearchQuota(): AliasSearchQuota {
  return Object.freeze({
    consume: (): Promise<never> =>
      Promise.reject(new AliasSearchQuotaUnavailableError()),
  });
}

function createHmacKey(secret: Uint8Array): KeyObject {
  if (secret.byteLength < minimumSecretBytes) {
    throw new TypeError("The alias search quota secret is invalid");
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
    .update("\0", "utf8")
    .update(quotaPolicyVersion, "utf8")
    .update("\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

export function createAliasSearchQuota(input: {
  readonly repository: AliasSearchQuotaRepository;
  readonly hmacSecret: Uint8Array;
}): AliasSearchQuota {
  const key = createHmacKey(input.hmacSecret);

  return Object.freeze({
    async consume(request: AliasSearchQuotaInput): Promise<void> {
      request.signal.throwIfAborted();
      if (
        !/^[0-9a-f-]{36}$/.test(request.userId) ||
        !isCanonicalIp(request.canonicalClientIp)
      ) {
        throw new AliasSearchQuotaUnavailableError();
      }

      const capability =
        request.scope === "public"
          ? "public_alias_search"
          : "group_alias_search";
      const minuteUserCapacity = request.scope === "public" ? 30 : 60;
      const minuteIpCapacity = request.scope === "public" ? 60 : 120;
      const dailyUserCapacity = request.scope === "public" ? 300 : 600;

      try {
        await input.repository.consumeIssuanceQuota({
          capability,
          policyVersion: quotaPolicyVersion,
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
              capacity: minuteUserCapacity,
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
              capacity: minuteIpCapacity,
            },
            {
              subjectKind: "user_day",
              subjectHmac: subjectHmac(
                key,
                capability,
                "user_day",
                request.userId,
              ),
              windowDurationSeconds: 86_400,
              capacity: dailyUserCapacity,
            },
          ],
        });
      } catch (error) {
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }
        if (error instanceof IssuanceQuotaExceededError) {
          throw new AliasSearchRateLimitedError();
        }
        if (error instanceof ControlPlaneUnavailableError) {
          throw new AliasSearchQuotaUnavailableError();
        }
        throw new AliasSearchQuotaUnavailableError();
      }
      request.signal.throwIfAborted();
    },
  });
}
