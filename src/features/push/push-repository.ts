import type { OptionalNotificationCategory } from "../alerts/notification-contract.js";
import type {
  PushEventType,
  PushPlatform,
  PushTokenRevokeReason,
} from "./push-contract.js";

/**
 * Persistence boundary of the push channel (Decision 0067).
 *
 * The registration token leaves this boundary only towards the FCM sender.
 * Every other consumer works with `pushTokenId` and `tokenSha256`.
 */

export interface PushTokenRecord {
  readonly pushTokenId: string;
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly platform: PushPlatform;
  readonly tokenSha256: string;
  readonly appVersion: string;
  readonly status: "active" | "revoked";
  readonly registeredAt: string;
  readonly lastObservedAt: string;
  readonly revokedAt: string | null;
}

export interface RegisterPushTokenInput {
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly platform: PushPlatform;
  readonly token: string;
  readonly appVersion: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface RegisterPushTokenResult {
  /** False when the call replayed an idempotency key or changed nothing. */
  readonly created: boolean;
  readonly token: PushTokenRecord;
}

export interface UnregisterPushTokenInput {
  readonly ownerUserId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface UnregisterPushTokenResult {
  /** True when an active row was retired by this call or its first replay. */
  readonly unregistered: boolean;
  readonly revokedAt: string | null;
}

/** What the sender needs, and nothing more. */
export interface PushDeliveryTarget {
  readonly pushTokenId: string;
  readonly ownerUserId: string;
  readonly platform: PushPlatform;
  readonly tokenSha256: string;
  /** The FCM registration token. Never log, project, or persist elsewhere. */
  readonly token: string;
}

/**
 * `null` means the event is mandatory and ignores preferences;
 * otherwise the owner's stored value decides, defaulting to `defaultEnabled`
 * when the owner never wrote preferences.
 */
export interface PushCategoryGate {
  readonly category: OptionalNotificationCategory;
  readonly defaultEnabled: boolean;
}

export interface ListOwnerTargetsInput {
  readonly ownerUserId: string;
  readonly categoryGate: PushCategoryGate | null;
  readonly limit: number;
}

export interface ListCommunityTargetsInput {
  readonly communityId: string;
  readonly excludeOwnerUserId: string | null;
  readonly categoryGate: PushCategoryGate | null;
  readonly limit: number;
}

export interface ReserveDeliveryInput {
  readonly ownerUserId: string;
  readonly pushTokenId: string;
  readonly eventType: PushEventType;
  readonly eventKey: string;
  readonly mandatory: boolean;
  readonly windowSeconds: number;
  readonly limit: number;
}

export type ReserveDeliveryResult =
  | { readonly outcome: "reserved"; readonly deliveryId: string }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "rateLimited" };

export interface CompleteDeliveryInput {
  readonly deliveryId: string;
  readonly status: "sent" | "invalid_token" | "failed";
  readonly reasonCode: string | null;
  readonly providerMessageRef: string | null;
}

export interface PushRepository {
  registerToken(
    input: RegisterPushTokenInput,
  ): Promise<RegisterPushTokenResult>;
  unregisterToken(
    input: UnregisterPushTokenInput,
  ): Promise<UnregisterPushTokenResult>;
  findActiveTokenBySession(input: {
    readonly ownerUserId: string;
    readonly sessionId: string;
  }): Promise<PushTokenRecord | null>;
  listOwnerTargets(
    input: ListOwnerTargetsInput,
  ): Promise<readonly PushDeliveryTarget[]>;
  listCommunityTargets(
    input: ListCommunityTargetsInput,
  ): Promise<readonly PushDeliveryTarget[]>;
  /**
   * Reserves the at-most-once slot and the hourly budget in one transaction.
   * `duplicate` means this event already reached this device; `rateLimited`
   * means the device's budget for this class of event is spent.
   */
  reserveDelivery(input: ReserveDeliveryInput): Promise<ReserveDeliveryResult>;
  completeDelivery(input: CompleteDeliveryInput): Promise<void>;
  /** Retires a token the Provider reported as no longer registered. */
  revokeToken(input: {
    readonly pushTokenId: string;
    readonly reason: PushTokenRevokeReason;
  }): Promise<void>;
}

export class PushRepositoryUnavailableError extends Error {
  constructor() {
    super("The push repository is unavailable");
    this.name = "PushRepositoryUnavailableError";
  }
}

export class PushSessionInvalidError extends Error {
  constructor() {
    super("The device session cannot carry a push token");
    this.name = "PushSessionInvalidError";
  }
}

export class PushIdempotencyConflictError extends Error {
  constructor() {
    super("The push token idempotency key was reused with another request");
    this.name = "PushIdempotencyConflictError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new PushRepositoryUnavailableError());
}

export function createUnavailablePushRepository(): PushRepository {
  return Object.freeze({
    registerToken: unavailable,
    unregisterToken: unavailable,
    findActiveTokenBySession: unavailable,
    listOwnerTargets: unavailable,
    listCommunityTargets: unavailable,
    reserveDelivery: unavailable,
    completeDelivery: unavailable,
    revokeToken: unavailable,
  });
}
