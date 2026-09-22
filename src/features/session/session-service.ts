import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { LoopIdAllocationExhaustedError } from "../identity/loop-id.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import type { V2SessionWriteMetadata } from "./session-contract.js";
import {
  DeviceSessionIdempotencyConflictError,
  DeviceSessionRateLimitedError,
  DeviceSessionRepositoryUnavailableError,
  type DeviceSession,
  type DeviceSessionRepository,
} from "./device-session-repository.js";
import type { VerifiedPrivyPrincipal } from "../../integrations/privy/access-token-verifier.js";
import type { NotificationRepository } from "../../database/notification-repository.js";
import { mandatoryNotificationCategory } from "../alerts/notification-contract.js";
import type { PushDispatchService } from "../push/push-dispatch-service.js";
import { v2ContractVersion } from "../meta/product-policy.js";

export interface V2SessionBootstrapResult {
  readonly account: {
    readonly accountId: string;
  };
  readonly session: V2PublicDeviceSession;
  readonly communication: {
    readonly streamUserId: string;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2AccountResult {
  readonly account: {
    readonly accountId: string;
  };
  readonly authentication: {
    readonly provider: "privy";
    readonly authStrength: "providerAuthenticated";
  };
  readonly communication: {
    readonly streamUserId: string;
  };
  readonly policyVersion: "sessionPolicyV1";
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2SessionLogoutResult {
  readonly session: {
    readonly sessionId: string;
    readonly status: "revoked";
    readonly revokedAt: string;
  };
  readonly providerLogoutRequired: true;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2PublicDeviceSession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly status: "active" | "revoked";
  readonly authStrength: "providerAuthenticated";
  readonly policyVersion: "sessionPolicyV1";
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface V2SessionService {
  bootstrap(input: {
    readonly principal: VerifiedPrivyPrincipal;
    readonly metadata: V2SessionWriteMetadata;
    readonly requestId: string;
  }): Promise<V2SessionBootstrapResult>;
  getAccount(principal: AuthenticatedLoopPrincipal): V2AccountResult;
  logout(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly metadata: V2SessionWriteMetadata & { readonly sessionId: string };
    readonly requestId: string;
  }): Promise<V2SessionLogoutResult>;
}

function commandDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("loop:v2:device-session-command:v1", "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function bootstrapDigest(metadata: V2SessionWriteMetadata): string {
  return commandDigest([
    "bootstrap",
    metadata.deviceId,
    metadata.platform,
    metadata.clientVersion,
    metadata.contractVersion,
  ]);
}

function logoutDigest(
  metadata: V2SessionWriteMetadata & { readonly sessionId: string },
): string {
  return commandDigest([
    "logout",
    metadata.sessionId,
    metadata.deviceId,
    metadata.platform,
    metadata.clientVersion,
    metadata.contractVersion,
  ]);
}

function publicSession(session: DeviceSession): V2PublicDeviceSession {
  return Object.freeze({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    status: session.status,
    authStrength: session.authStrength,
    policyVersion: session.policyVersion,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    revokedAt: session.revokedAt,
  });
}

async function mapRepositoryFailure<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DeviceSessionIdempotencyConflictError) {
      throw V2ApiError.idempotencyConflict();
    }
    if (error instanceof DeviceSessionRepositoryUnavailableError) {
      throw V2ApiError.capabilityUnavailable();
    }
    if (error instanceof DeviceSessionRateLimitedError) {
      throw V2ApiError.rateLimited();
    }
    if (error instanceof LoopIdAllocationExhaustedError) {
      // Five random LOOP ID candidates collided: fail closed, never fall
      // back to a sequential or client-supplied identifier.
      throw V2ApiError.fromCode("INTERNAL_ERROR");
    }
    throw error;
  }
}

export interface V2SessionServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

/**
 * The `security.event` a first sign-in from a device raises (Decision 0067).
 * Keyed by session so it can be written at most once per session, ever: a
 * replayed bootstrap returns the same session and collapses onto the same
 * dedupe key.
 */
export function newDeviceSignInNotification(input: {
  readonly ownerUserId: string;
  readonly session: DeviceSession;
}) {
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: mandatoryNotificationCategory,
    entityRef: `deviceSession:${input.session.sessionId}`,
    contextRoute: "devices",
    contextParams: Object.freeze({ sessionId: input.session.sessionId }),
    payload: Object.freeze({
      event: "new_device_sign_in",
      sessionId: input.session.sessionId,
      deviceId: input.session.deviceId,
      platform: input.session.clientPlatform,
      createdAt: input.session.createdAt,
    }),
    dedupeKey: `security.event:deviceSession:${input.session.sessionId}:new_device`,
    source: "loop_session",
    observedAt: input.session.createdAt,
  });
}

export function createV2SessionService(options: {
  readonly enabled: boolean;
  readonly sessions: DeviceSessionRepository;
  /** `null` when the notification repository is not composed. */
  readonly notifications?: NotificationRepository | null;
  /** Decision 0067; omitted keeps a new device feed-only. */
  readonly push?: PushDispatchService;
  readonly logger?: V2SessionServiceLogger;
}): V2SessionService {
  function assertEnabled(): void {
    if (!options.enabled) {
      throw V2ApiError.capabilityUnavailable();
    }
  }

  /**
   * A device is new when the account already has another session and no
   * other session — active or revoked — was ever created on this device.
   * Both the feed row and the push are best effort: a failure here never
   * undoes a sign-in the caller has already been granted.
   */
  async function announceNewDevice(
    ownerUserId: string,
    session: DeviceSession,
  ): Promise<void> {
    const notifications = options.notifications ?? null;
    if (notifications === null) {
      return;
    }
    try {
      const sessions = await options.sessions.listByOwner(ownerUserId, 200);
      const sameDevice = sessions.filter(
        (candidate) =>
          candidate.deviceId === session.deviceId &&
          candidate.sessionId !== session.sessionId,
      );
      if (sessions.length < 2 || sameDevice.length > 0) {
        return;
      }
      const recorded = await notifications.record(
        newDeviceSignInNotification({ ownerUserId, session }),
      );
      if (recorded === null || options.push === undefined) {
        return;
      }
      await options.push.dispatchToOwner({
        ownerUserId,
        eventType: "security_event",
        entityRef: `deviceSession:${session.sessionId}`,
        contextRoute: "devices",
        eventKey: `security_event:deviceSession:${session.sessionId}:new_device`,
      });
    } catch (error) {
      options.logger?.warn(
        {
          ownerUserId,
          sessionId: session.sessionId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "New device security.event was not recorded",
      );
    }
  }

  const service: V2SessionService = {
    async bootstrap(input): Promise<V2SessionBootstrapResult> {
      assertEnabled();
      const { account, session } = await mapRepositoryFailure(() =>
        options.sessions.bootstrapVerifiedPrivyUser({
          privyUserId: input.principal.privyUserId,
          idempotencyKey: input.metadata.idempotencyKey,
          requestSha256: bootstrapDigest(input.metadata),
          requestId: input.requestId,
          deviceId: input.metadata.deviceId,
          clientPlatform: input.metadata.platform,
          clientVersion: input.metadata.clientVersion,
        }),
      );

      await announceNewDevice(account.id, session);

      return Object.freeze({
        account: Object.freeze({ accountId: account.id }),
        session: publicSession(session),
        communication: Object.freeze({
          streamUserId: deriveStreamUserId(account.id),
        }),
        contractVersion: v2ContractVersion,
      });
    },

    getAccount(principal): V2AccountResult {
      assertEnabled();
      return Object.freeze({
        account: Object.freeze({ accountId: principal.userId }),
        authentication: Object.freeze({
          provider: "privy",
          authStrength: "providerAuthenticated",
        }),
        communication: Object.freeze({
          streamUserId: principal.streamUserId,
        }),
        policyVersion: "sessionPolicyV1",
        contractVersion: v2ContractVersion,
      });
    },

    async logout(input): Promise<V2SessionLogoutResult> {
      assertEnabled();
      const session = await mapRepositoryFailure(() =>
        options.sessions.revoke({
          ownerUserId: input.principal.userId,
          sessionId: input.metadata.sessionId,
          idempotencyKey: input.metadata.idempotencyKey,
          requestSha256: logoutDigest(input.metadata),
          requestId: input.requestId,
        }),
      );
      if (session === null || session.revokedAt === null) {
        throw V2ApiError.sessionNotFound();
      }

      return Object.freeze({
        session: Object.freeze({
          sessionId: session.sessionId,
          status: "revoked",
          revokedAt: session.revokedAt,
        }),
        providerLogoutRequired: true,
        contractVersion: v2ContractVersion,
      });
    },
  };

  return Object.freeze(service);
}
