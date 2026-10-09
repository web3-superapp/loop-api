import type { InternalUser } from "../identity/internal-user-repository.js";

export type DeviceSessionClientPlatform = "android" | "ios";
export type DeviceSessionStatus = "active" | "revoked";

export interface DeviceSession {
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly deviceId: string;
  readonly clientPlatform: DeviceSessionClientPlatform;
  readonly clientVersion: string;
  readonly authStrength: "providerAuthenticated";
  readonly policyVersion: "sessionPolicyV1";
  readonly status: DeviceSessionStatus;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface CreatedDeviceSession extends Omit<
  DeviceSession,
  "status" | "revokedAt"
> {
  readonly status: "active";
  readonly revokedAt: null;
}

export interface CreateDeviceSessionInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly deviceId: string;
  readonly clientPlatform: DeviceSessionClientPlatform;
  readonly clientVersion: string;
}

export interface BootstrapVerifiedPrivyUserInput extends Omit<
  CreateDeviceSessionInput,
  "ownerUserId"
> {
  readonly privyUserId: string;
}

export interface BootstrapVerifiedPrivyUserResult {
  readonly account: InternalUser;
  readonly session: CreatedDeviceSession;
}

export type DeviceSessionCommandKind = "logout" | "revoke";

export interface RevokeDeviceSessionInput {
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  /**
   * `logout` (the caller's own session, Decision 0027) or `revoke` (another
   * session of the same owner, Decision 0037). Both write the same
   * `session_revoked` event; the command kind and digest version keep their
   * idempotency domains apart. Defaults to `logout`.
   */
  readonly commandKind?: DeviceSessionCommandKind;
  /**
   * For `revoke`: the caller's own session, verified inside the transaction
   * to be an active session of the same owner (Decision 0037 review).
   */
  readonly callerSessionId?: string;
}

export interface DeviceSessionRepository {
  bootstrapVerifiedPrivyUser(
    input: BootstrapVerifiedPrivyUserInput,
  ): Promise<BootstrapVerifiedPrivyUserResult>;
  create(input: CreateDeviceSessionInput): Promise<CreatedDeviceSession>;
  findById(
    ownerUserId: string,
    sessionId: string,
  ): Promise<DeviceSession | null>;
  /**
   * Newest-first sessions of one owner, active rows before revoked rows,
   * bounded by `limit`. The projection is owner-scoped audit data only.
   */
  listByOwner(
    ownerUserId: string,
    limit: number,
  ): Promise<readonly DeviceSession[]>;
  revoke(input: RevokeDeviceSessionInput): Promise<DeviceSession | null>;
}

export class DeviceSessionIdempotencyConflictError extends Error {
  constructor() {
    super("The session idempotency key conflicts with another request");
    this.name = "DeviceSessionIdempotencyConflictError";
  }
}

export class DeviceSessionRepositoryUnavailableError extends Error {
  constructor() {
    super("The device-session repository is unavailable");
    this.name = "DeviceSessionRepositoryUnavailableError";
  }
}

export class DeviceSessionCallerInvalidError extends Error {
  constructor() {
    super("The calling device session is not an active session of the owner");
    this.name = "DeviceSessionCallerInvalidError";
  }
}

export class DeviceSessionRateLimitedError extends Error {
  constructor() {
    super("The device-session creation quota is exhausted");
    this.name = "DeviceSessionRateLimitedError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new DeviceSessionRepositoryUnavailableError());
}

export function createUnavailableDeviceSessionRepository(): DeviceSessionRepository {
  return {
    bootstrapVerifiedPrivyUser: unavailable,
    create: unavailable,
    findById: unavailable,
    listByOwner: unavailable,
    revoke: unavailable,
  };
}
