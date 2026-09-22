import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { V2SessionLogoutMetadata } from "../session/session-contract.js";
import { isValidClientVersion } from "../session/client-version.js";
import {
  pushPlatforms,
  pushProviderId,
  pushReasonCodes,
  pushTokenMaximumLength,
  pushTokenMinimumLength,
  type PushPlatform,
} from "./push-contract.js";
import {
  PushIdempotencyConflictError,
  PushRepositoryUnavailableError,
  PushSessionInvalidError,
  type PushRepository,
} from "./push-repository.js";

/**
 * Device push-token lifecycle (Decision 0067).
 *
 * A token is an address for one device session, not an account credential:
 * it is accepted only for the caller's own active session, whose
 * `X-Loop-Session-ID`, `X-Loop-Device-ID` and `X-Loop-Platform` must agree
 * with the stored session row, and it dies with that session.
 *
 * Registration is admitted only while the push runtime exists. With no
 * Firebase credential the capability is `unavailable` and the write is
 * refused, so a client can never hold a token the backend would silently
 * never use. Unregistration stays open regardless: taking an address back is
 * always allowed.
 */

export const pushTokenRegisterDigestDomain =
  "loop:v2:push-token:register:v1" as const;
export const pushTokenUnregisterDigestDomain =
  "loop:v2:push-token:unregister:v1" as const;

export interface PushTokenRegistrationResource {
  readonly registered: true;
  readonly pushTokenId: string;
  readonly platform: PushPlatform;
  readonly provider: typeof pushProviderId;
  readonly appVersion: string;
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PushTokenRemovalResource {
  readonly registered: false;
  readonly revokedAt: string | null;
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PushTokenService {
  register(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly metadata: V2SessionLogoutMetadata;
    readonly body: unknown;
    readonly requestId: string;
  }): Promise<PushTokenRegistrationResource>;
  unregister(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly metadata: V2SessionLogoutMetadata;
    readonly requestId: string;
  }): Promise<PushTokenRemovalResource>;
}

export interface CreatePushTokenServiceInput {
  readonly repository: PushRepository;
  /**
   * Whether an FCM credential is composed. `false` refuses registration with
   * `CAPABILITY_UNAVAILABLE`; it never fakes a successful registration.
   */
  readonly deliveryRuntimeAvailable: boolean;
  readonly now?: () => Date;
}

const tokenPattern = /^[A-Za-z0-9_:.~%-]+$/;

interface PushTokenWriteRequest {
  readonly platform: PushPlatform;
  readonly token: string;
  readonly appVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePushTokenWrite(body: unknown): PushTokenWriteRequest {
  if (!isRecord(body)) {
    throw V2ApiError.invalidRequest();
  }
  const keys = Object.keys(body);
  if (
    keys.length !== 3 ||
    !keys.includes("platform") ||
    !keys.includes("token") ||
    !keys.includes("appVersion")
  ) {
    throw V2ApiError.invalidRequest();
  }
  const { platform, token, appVersion } = body;
  if (
    typeof platform !== "string" ||
    !(pushPlatforms as readonly string[]).includes(platform) ||
    typeof token !== "string" ||
    token.length < pushTokenMinimumLength ||
    token.length > pushTokenMaximumLength ||
    !tokenPattern.test(token) ||
    typeof appVersion !== "string" ||
    !isValidClientVersion(appVersion)
  ) {
    throw V2ApiError.invalidRequest();
  }
  return Object.freeze({
    platform: platform as PushPlatform,
    token,
    appVersion,
  });
}

function digest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

/**
 * The registration digest covers the token through its SHA-256 only: the
 * idempotency record must be able to detect a changed request without
 * storing the address it carried.
 */
export function pushTokenRegisterDigest(input: {
  readonly request: PushTokenWriteRequest;
  readonly metadata: V2SessionLogoutMetadata;
}): string {
  return digest(pushTokenRegisterDigestDomain, [
    "register",
    input.metadata.sessionId,
    input.metadata.deviceId,
    input.request.platform,
    input.request.appVersion,
    createHash("sha256").update(input.request.token, "utf8").digest("hex"),
    input.metadata.contractVersion,
  ]);
}

export function pushTokenUnregisterDigest(
  metadata: V2SessionLogoutMetadata,
): string {
  return digest(pushTokenUnregisterDigestDomain, [
    "unregister",
    metadata.sessionId,
    metadata.deviceId,
    metadata.platform,
    metadata.contractVersion,
  ]);
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PushIdempotencyConflictError) {
      throw V2ApiError.idempotencyConflict();
    }
    if (error instanceof PushSessionInvalidError) {
      throw V2ApiError.sessionNotFound();
    }
    if (error instanceof PushRepositoryUnavailableError) {
      throw V2ApiError.capabilityUnavailable();
    }
    throw error;
  }
}

export function createPushTokenService(
  input: CreatePushTokenServiceInput,
): PushTokenService {
  const now = input.now ?? ((): Date => new Date());
  const service: PushTokenService = {
    async register({ principal, metadata, body, requestId }) {
      if (!input.deliveryRuntimeAvailable) {
        // Fail closed: no credential, no address collection.
        throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
          reasonCode: pushReasonCodes.runtimeDeferred,
        });
      }
      const request = parsePushTokenWrite(body);
      // The header platform is what the session row was created with; a
      // body that disagrees is a client defect, not a platform change.
      if (request.platform !== metadata.platform) {
        throw V2ApiError.invalidRequest();
      }
      const result = await translate(() =>
        input.repository.registerToken({
          ownerUserId: principal.userId,
          sessionId: metadata.sessionId,
          deviceId: metadata.deviceId,
          platform: request.platform,
          token: request.token,
          appVersion: request.appVersion,
          idempotencyKey: metadata.idempotencyKey,
          requestSha256: pushTokenRegisterDigest({ request, metadata }),
          requestId,
        }),
      );
      return Object.freeze({
        registered: true as const,
        pushTokenId: result.token.pushTokenId,
        platform: result.token.platform,
        provider: pushProviderId,
        appVersion: result.token.appVersion,
        observedAt: result.token.lastObservedAt,
        contractVersion: v2ContractVersion,
      });
    },

    async unregister({ principal, metadata, requestId }) {
      const result = await translate(() =>
        input.repository.unregisterToken({
          ownerUserId: principal.userId,
          sessionId: metadata.sessionId,
          idempotencyKey: metadata.idempotencyKey,
          requestSha256: pushTokenUnregisterDigest(metadata),
          requestId,
        }),
      );
      return Object.freeze({
        registered: false as const,
        revokedAt: result.revokedAt,
        observedAt: now().toISOString(),
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}

/** Composed when no push repository exists; every call fails closed. */
export function createUnavailablePushTokenService(): PushTokenService {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: pushReasonCodes.runtimeDeferred,
      }),
    );
  return Object.freeze({
    register: unavailable,
    unregister: unavailable,
  });
}
