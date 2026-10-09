/**
 * V2 notification categories and preference policy (Decision 0034).
 *
 * The ten product categories mirror the `notif-settings` prototype. Nine are
 * owner preferences; `security.event` is mandatory: it is always enabled, is
 * never stored, and a write that tries to disable it is rejected as
 * `INVALID_REQUEST` (the request-schema `const: true`). The client must still
 * send it so that the full ten-key document is what the CAS version covers.
 */

export const notificationCategories = Object.freeze([
  "mining.settlement",
  "mining.weight",
  "launch.round",
  "launch.graduation",
  "trade.result",
  "trade.priceAlert",
  "community.mention",
  "community.announcement",
  "community.all",
  "security.event",
] as const);
export type NotificationCategory = (typeof notificationCategories)[number];

export const mandatoryNotificationCategory = "security.event" as const;

export const optionalNotificationCategories = Object.freeze(
  notificationCategories.filter(
    (category): category is Exclude<NotificationCategory, "security.event"> =>
      category !== mandatoryNotificationCategory,
  ),
);
export type OptionalNotificationCategory =
  (typeof optionalNotificationCategories)[number];

/**
 * Defaults for an owner who never wrote preferences (version 0): every
 * category on except `community.all`, matching the prototype's "全部消息
 * 大群建议关闭" default. Enabled is intent only; no push Provider exists.
 */
export const defaultNotificationPreferences: Readonly<
  Record<OptionalNotificationCategory, boolean>
> = Object.freeze({
  "mining.settlement": true,
  "mining.weight": true,
  "launch.round": true,
  "launch.graduation": true,
  "trade.result": true,
  "trade.priceAlert": true,
  "community.mention": true,
  "community.announcement": true,
  "community.all": false,
});

export const notificationReasonCodes = Object.freeze({
  pushDeferred: "PUSH_RUNTIME_DEFERRED",
  runtimeUnavailable: "NOTIFICATIONS_RUNTIME_UNAVAILABLE",
  alertsRuntimeUnavailable: "PRICE_ALERTS_RUNTIME_UNAVAILABLE",
  moduleDeferred: "V2_NOTIFICATIONS_RUNTIME_DEFERRED",
} as const);

export const notificationFeedLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);

export const priceAlertListLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);

/** Route the client opens for a price-alert notification. */
export const priceAlertContextRoute = "token" as const;

export function isNotificationCategory(
  value: unknown,
): value is NotificationCategory {
  return (
    typeof value === "string" &&
    (notificationCategories as readonly string[]).includes(value)
  );
}
