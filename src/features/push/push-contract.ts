import type {
  NotificationCategory,
  OptionalNotificationCategory,
} from "../alerts/notification-contract.js";

/**
 * Push channel contract (Decision 0067).
 *
 * One delivery channel exists: FCM HTTP v1. Android receives FCM directly and
 * iOS receives it through the APNs key uploaded to the same Firebase project,
 * so the backend has exactly one Provider, one credential and one send path.
 *
 * A push is a pointer, never a fact. The data payload carries only
 * `type`, `entityRef` and `contextRoute`; the client re-authenticates and
 * re-reads state from `/v2/notifications/feed` before showing anything. The
 * in-app feed stays the authoritative record: a suppressed, rate-limited or
 * failed push never removes the feed row.
 */

export const pushProviderId = "fcm" as const;
export const pushPayloadVersion = "1" as const;

export const pushPlatforms = Object.freeze(["android", "ios"] as const);
export type PushPlatform = (typeof pushPlatforms)[number];

/**
 * First event batch. `security_event` is mandatory (03 §15.1: security
 * notifications may be forced on); the other two are gated by the owner's
 * `notification_preferences_v2` category and can be switched off.
 */
export const pushEventTypes = Object.freeze([
  "price_alert_triggered",
  "security_event",
  "community_voice_room_started",
] as const);
export type PushEventType = (typeof pushEventTypes)[number];

export interface PushEventDefinition {
  readonly eventType: PushEventType;
  /** The notification category whose preference gates the send. */
  readonly category: NotificationCategory;
  /** Mandatory events ignore the preference and use their own hourly budget. */
  readonly mandatory: boolean;
  /** Localization keys the device renders; no server text is ever sent. */
  readonly titleLocKey: string;
  readonly bodyLocKey: string;
}

export const pushEventDictionary = Object.freeze({
  price_alert_triggered: Object.freeze({
    eventType: "price_alert_triggered",
    category: "trade.priceAlert",
    mandatory: false,
    titleLocKey: "push.priceAlertTriggered.title",
    bodyLocKey: "push.priceAlertTriggered.body",
  }),
  security_event: Object.freeze({
    eventType: "security_event",
    category: "security.event",
    mandatory: true,
    titleLocKey: "push.securityEvent.title",
    bodyLocKey: "push.securityEvent.body",
  }),
  community_voice_room_started: Object.freeze({
    eventType: "community_voice_room_started",
    category: "community.announcement",
    mandatory: false,
    titleLocKey: "push.communityVoiceRoomStarted.title",
    bodyLocKey: "push.communityVoiceRoomStarted.body",
  }),
} as const satisfies Readonly<Record<PushEventType, PushEventDefinition>>);

/**
 * The preference category of an optional event, or `null` for a mandatory
 * one. `security.event` has no preference row by construction (Decision
 * 0034), which is why the mandatory branch never reads preferences.
 */
export function pushPreferenceCategory(
  eventType: PushEventType,
): OptionalNotificationCategory | null {
  const definition = pushEventDictionary[eventType];
  return definition.mandatory ? null : definition.category;
}

/**
 * Per-device hourly budgets. Optional and mandatory events are counted
 * separately so a flood of community or alert pushes can never crowd out a
 * security event, and neither budget can be spent by the other.
 */
export const pushRateLimits = Object.freeze({
  windowSeconds: 3_600,
  optionalPerDevicePerHour: 20,
  mandatoryPerDevicePerHour: 10,
} as const);

/** Upper bound on the audience of one community fan-out. */
export const pushCommunityAudienceLimit = 200;
/** Upper bound on the devices of one owner reached by a single event. */
export const pushOwnerAudienceLimit = 10;

export const pushReasonCodes = Object.freeze({
  /** No `FIREBASE_SERVICE_ACCOUNT_JSON_PATH`, or the file is unusable. */
  runtimeDeferred: "PUSH_RUNTIME_DEFERRED",
  /** Credentials exist but the repository or the sender is not composed. */
  runtimeUnavailable: "PUSH_RUNTIME_UNAVAILABLE",
  categoryDisabled: "PUSH_CATEGORY_DISABLED",
  noRegisteredDevice: "PUSH_NO_REGISTERED_DEVICE",
  duplicateEvent: "PUSH_DUPLICATE_EVENT",
  rateLimited: "PUSH_RATE_LIMITED",
  tokenUnregistered: "PUSH_TOKEN_UNREGISTERED",
  providerRejected: "PUSH_PROVIDER_REJECTED",
  providerUnreachable: "PUSH_PROVIDER_UNREACHABLE",
  providerUnauthorized: "PUSH_PROVIDER_UNAUTHORIZED",
  audienceTruncated: "PUSH_AUDIENCE_TRUNCATED",
  /** No physical device has acknowledged a LOOP push yet. */
  deviceEvidencePending: "PUSH_DEVICE_DELIVERY_EVIDENCE_PENDING",
} as const);

/** Why an active token row was retired. */
export const pushTokenRevokeReasons = Object.freeze([
  "client_unregister",
  "session_revoked",
  "provider_unregistered",
  "replaced_by_session",
] as const);
export type PushTokenRevokeReason = (typeof pushTokenRevokeReasons)[number];

export const pushTokenMinimumLength = 32;
export const pushTokenMaximumLength = 4_096;
/**
 * FCM registration tokens are URL-safe base64-ish strings with `:` and `_`
 * separators. The pattern exists to refuse anything that is not a token
 * before it is stored, not to prove that a token is live.
 */
export const pushTokenPatternSource = "^[A-Za-z0-9_:.~%-]{32,4096}$";

/**
 * Payload keys allowed on the wire. Anything else — amounts, addresses,
 * balances, codes, message text — is a contract violation, so the payload is
 * built from a closed set rather than filtered afterwards.
 */
export const pushPayloadKeys = Object.freeze([
  "type",
  "entityRef",
  "contextRoute",
  "eventVersion",
] as const);

/**
 * `entityRef` is `<opaqueType>:<uuid>`. The shape structurally excludes a
 * wallet address, a ticker and a decimal amount: the client resolves the
 * pointer by re-reading the feed.
 */
export const pushEntityRefPatternSource =
  "^[a-zA-Z][a-zA-Z0-9]{0,31}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const pushContextRoutePatternSource = "^[a-z][a-z0-9-]{0,63}$";

const entityRefPattern = new RegExp(pushEntityRefPatternSource);
const contextRoutePattern = new RegExp(pushContextRoutePatternSource);

export class InvalidPushPayloadError extends Error {
  constructor(readonly field: "entityRef" | "contextRoute") {
    super(`Invalid push payload field: ${field}`);
    this.name = "InvalidPushPayloadError";
  }
}

export interface PushPayload {
  readonly type: PushEventType;
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly eventVersion: typeof pushPayloadVersion;
}

/**
 * Producer-side guard. A payload that would leak anything beyond the pointer
 * throws here, before a Provider call and before a delivery row exists: a
 * producer bug must not become a push.
 */
export function createPushPayload(input: {
  readonly eventType: PushEventType;
  readonly entityRef: string;
  readonly contextRoute: string;
}): PushPayload {
  if (!entityRefPattern.test(input.entityRef)) {
    throw new InvalidPushPayloadError("entityRef");
  }
  if (!contextRoutePattern.test(input.contextRoute)) {
    throw new InvalidPushPayloadError("contextRoute");
  }
  return Object.freeze({
    type: input.eventType,
    entityRef: input.entityRef,
    contextRoute: input.contextRoute,
    eventVersion: pushPayloadVersion,
  });
}

/** SHA-256 hex of a registration token: the only form safe to log. */
export const pushTokenDigestPatternSource = "^[0-9a-f]{64}$";
