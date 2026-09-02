import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
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
    throw error;
  }
}

export function createV2SessionService(options: {
  readonly enabled: boolean;
  readonly sessions: DeviceSessionRepository;
}): V2SessionService {
  function assertEnabled(): void {
    if (!options.enabled) {
      throw V2ApiError.capabilityUnavailable();
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
