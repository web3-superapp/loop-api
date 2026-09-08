import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type { NotificationRepository } from "../../database/notification-repository.js";
import { mandatoryNotificationCategory } from "../alerts/notification-contract.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  DeviceSessionCallerInvalidError,
  DeviceSessionIdempotencyConflictError,
  DeviceSessionRateLimitedError,
  DeviceSessionRepositoryUnavailableError,
  type DeviceSession,
  type DeviceSessionRepository,
} from "../session/device-session-repository.js";
import type {
  V2DeviceReadMetadata,
  V2SessionLogoutMetadata,
} from "../session/session-contract.js";
import {
  deviceListLimit,
  deviceRiskPolicy,
  deviceSessionRevokeDigestDomain,
  securityReasonCodes,
} from "./security-contract.js";

/**
 * Device list and remote revocation over the `device_sessions` audit
 * projection (Decision 0037). A session row is never authentication; the
 * list only tells the user which installations bootstrapped this account.
 */

export interface DeviceProjection {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly platform: "android" | "ios";
  readonly clientVersion: string;
  readonly status: "active" | "revoked";
  readonly authStrength: "providerAuthenticated";
  readonly isCurrent: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface DeviceListResource {
  readonly devices: readonly DeviceProjection[];
  readonly currentSessionId: string | null;
  readonly riskSignals: {
    readonly newSessions24h: number;
    readonly highRiskNewDevice: boolean;
    readonly policy: typeof deviceRiskPolicy;
  };
  readonly revokeAll: {
    readonly status: "unavailable";
    readonly reasonCode: typeof securityReasonCodes.revokeAllStepUp;
  };
  readonly truncated: boolean;
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface DeviceRevokeResource {
  readonly session: {
    readonly sessionId: string;
    readonly status: "revoked";
    readonly revokedAt: string;
  };
  /**
   * What a revoke actually does in this step: the LOOP audit projection is
   * revoked and a security event is recorded. The other device's Privy
   * access token is not terminated; Privy session revocation is a Go/No-Go
   * item. Requests that name the revoked session are refused LOOP-side.
   */
  readonly effect: "auditOnly";
  readonly providerAccessTerminated: false;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface DeviceServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface DeviceService {
  list(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly metadata: V2DeviceReadMetadata;
  }): Promise<DeviceListResource>;
  revoke(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly targetSessionId: string;
    readonly metadata: V2SessionLogoutMetadata;
    readonly requestId: string;
  }): Promise<DeviceRevokeResource>;
  /** Always `AUTH_STEP_UP_REQUIRED` until an MFA step exists; never writes. */
  revokeAll(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly metadata: V2SessionLogoutMetadata;
  }): Promise<never>;
}

export interface CreateDeviceServiceInput {
  readonly sessions: DeviceSessionRepository;
  /** `null` when the notification repository is not composed. */
  readonly notifications: NotificationRepository | null;
  readonly logger: DeviceServiceLogger;
  readonly now?: () => Date;
}

/**
 * Security-event notification for a remote revocation (main-agent ruling
 * 2026-09-09). Deduplicated per session and UTC day so a replayed command or
 * a second revoke of an already revoked session does not add a row.
 */
export function deviceRevokedNotification(input: {
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly platform: "android" | "ios";
  readonly revokedAt: string;
  readonly revokedFromSessionId: string;
}) {
  const day = input.revokedAt.slice(0, 10);
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: mandatoryNotificationCategory,
    entityRef: `deviceSession:${input.sessionId}`,
    contextRoute: "devices",
    contextParams: Object.freeze({ sessionId: input.sessionId }),
    payload: Object.freeze({
      event: "session_revoked",
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      platform: input.platform,
      revokedAt: input.revokedAt,
      revokedFromSessionId: input.revokedFromSessionId,
    }),
    dedupeKey: `security.event:deviceSession:${input.sessionId}:revoked:${day}`,
    source: "loop_session",
    observedAt: input.revokedAt,
  });
}

function revokeDigest(
  targetSessionId: string,
  metadata: V2SessionLogoutMetadata,
): string {
  const hash = createHash("sha256");
  hash.update(deviceSessionRevokeDigestDomain, "utf8");
  for (const part of [
    "revoke",
    targetSessionId,
    metadata.sessionId,
    metadata.deviceId,
    metadata.platform,
    metadata.clientVersion,
    metadata.contractVersion,
  ]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function project(
  session: DeviceSession,
  currentSessionId: string | null,
): DeviceProjection {
  return Object.freeze({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    platform: session.clientPlatform,
    clientVersion: session.clientVersion,
    status: session.status,
    authStrength: session.authStrength,
    isCurrent: session.sessionId === currentSessionId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    revokedAt: session.revokedAt,
  });
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
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
    if (error instanceof DeviceSessionCallerInvalidError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
}

export function createDeviceService(
  input: CreateDeviceServiceInput,
): DeviceService {
  const now = input.now ?? ((): Date => new Date());
  const service: DeviceService = {
    async list({ principal, metadata }) {
      const observedAt = now();
      const sessions = await translate(() =>
        input.sessions.listByOwner(principal.userId, deviceListLimit + 1),
      );
      const windowStart =
        observedAt.getTime() - deviceRiskPolicy.windowHours * 3_600_000;
      const visible = sessions.slice(0, deviceListLimit);
      // Active sessions only, so the signal falls back after a revoke.
      const newSessions24h = visible.filter(
        (session) =>
          session.status === "active" &&
          Date.parse(session.createdAt) >= windowStart,
      ).length;
      return Object.freeze({
        devices: Object.freeze(
          visible.map((session) => project(session, metadata.sessionId)),
        ),
        currentSessionId: metadata.sessionId,
        riskSignals: Object.freeze({
          newSessions24h,
          highRiskNewDevice:
            newSessions24h >= deviceRiskPolicy.newSessionThreshold,
          policy: deviceRiskPolicy,
        }),
        revokeAll: Object.freeze({
          status: "unavailable" as const,
          reasonCode: securityReasonCodes.revokeAllStepUp,
        }),
        truncated: sessions.length > deviceListLimit,
        observedAt: observedAt.toISOString(),
        contractVersion: v2ContractVersion,
      });
    },

    async revoke({ principal, targetSessionId, metadata, requestId }) {
      // Presentation-layer guard: revoking the caller's own session is a
      // step-up operation (03 §10.5) and no MFA step is connected, so it is
      // refused before any persistence. The repository separately verifies
      // inside the transaction that the caller session is an active session
      // of the same owner. Self-logout keeps using POST /v2/session/logout.
      if (targetSessionId === metadata.sessionId) {
        throw V2ApiError.fromCode("AUTH_STEP_UP_REQUIRED");
      }
      const session = await translate(() =>
        input.sessions.revoke({
          ownerUserId: principal.userId,
          sessionId: targetSessionId,
          idempotencyKey: metadata.idempotencyKey,
          requestSha256: revokeDigest(targetSessionId, metadata),
          requestId,
          commandKind: "revoke",
          callerSessionId: metadata.sessionId,
        }),
      );
      if (session === null || session.revokedAt === null) {
        throw V2ApiError.sessionNotFound();
      }
      if (input.notifications !== null) {
        // Best effort after the durable revocation: a notification write
        // failure never undoes or hides an already committed revoke, and
        // the dedupe key makes a retry harmless.
        try {
          await input.notifications.record(
            deviceRevokedNotification({
              ownerUserId: principal.userId,
              sessionId: session.sessionId,
              deviceId: session.deviceId,
              platform: session.clientPlatform,
              revokedAt: session.revokedAt,
              revokedFromSessionId: metadata.sessionId,
            }),
          );
        } catch (error) {
          // The feed simply lacks this row; the revoke result stands.
          input.logger.warn(
            {
              sessionId: session.sessionId,
              ownerUserId: principal.userId,
              requestId,
              errorName: error instanceof Error ? error.name : "unknown",
            },
            "Device revoke security.event notification was not recorded",
          );
        }
      }
      return Object.freeze({
        session: Object.freeze({
          sessionId: session.sessionId,
          status: "revoked" as const,
          revokedAt: session.revokedAt,
        }),
        effect: "auditOnly" as const,
        providerAccessTerminated: false as const,
        contractVersion: v2ContractVersion,
      });
    },

    revokeAll() {
      return Promise.reject(V2ApiError.fromCode("AUTH_STEP_UP_REQUIRED"));
    },
  };
  return Object.freeze(service);
}
