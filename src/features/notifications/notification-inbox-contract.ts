import {
  notificationInboxContextRoutes,
  notificationInboxEventCategory,
  type NotificationInboxEventType,
} from "../alerts/notification-contract.js";
import type { RecordNotificationInput } from "../../database/notification-repository.js";
import type { PushEventType } from "../push/push-contract.js";

/**
 * Decision 0177: the four notification inbox events — who receives them,
 * the dedupe key that makes each one exactly-once per account, the client
 * route it opens and the display text of the feed row.
 *
 * The text is written once, in Chinese, into the feed row's `payload`
 * (`title` / `body`) next to the facts it was built from; the push carries
 * only the four-key pointer and the device's own localization keys.
 */

/** Facts older than this when the lane first sees them get no row. */
export const notificationInboxFactFreshnessSeconds = 24 * 60 * 60;
/** Fine-event rows older than this are never pushed. */
export const notificationInboxPushFreshnessSeconds = 30 * 60;
export const notificationInboxGraduationBatch = 20;
export const notificationInboxMintBatch = 200;
export const notificationInboxPushBatch = 100;

export const notificationInboxSources = Object.freeze({
  launch2: "launch2_indexer",
  social: "social_friend_request",
} as const);

const pushEventTypes = Object.freeze({
  "launch.graduated": "launch_graduated",
  "launch.badge_minted": "launch_badge_minted",
  "social.friend_request": "social_friend_request",
  "social.friend_accepted": "social_friend_accepted",
} as const satisfies Record<NotificationInboxEventType, PushEventType>);

export function notificationInboxPushEventType(
  eventType: NotificationInboxEventType,
): PushEventType {
  return pushEventTypes[eventType];
}

/** UTC+8 wall clock, `YYYY-MM-DD HH:mm`, for the Chinese body text. */
export function formatBeijingMinute(iso: string): string {
  const shifted = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

function shortHex(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Bounded like every payload value (512 code points). */
function bounded(value: string): string {
  const points = Array.from(value);
  return points.length <= 512 ? value : points.slice(0, 512).join("");
}

export function launchGraduatedNotification(input: {
  readonly ownerUserId: string;
  readonly instanceId: string;
  readonly projectName: string;
  readonly graduatedAt: string;
  readonly officialPoolId: string | null;
}): RecordNotificationInput {
  const eventType = "launch.graduated" as const;
  const pool =
    input.officialPoolId === null
      ? "官方池"
      : `官方池 ${shortHex(input.officialPoolId)}`;
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: `launch2Instance:${input.instanceId}`,
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ instanceId: input.instanceId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 已毕业`),
      body: bounded(
        `${input.projectName} 已于 ${formatBeijingMinute(input.graduatedAt)}（北京时间）毕业，交易已迁入${pool}。`,
      ),
      instanceId: input.instanceId,
      projectName: input.projectName,
      graduatedAt: input.graduatedAt,
      officialPoolId: input.officialPoolId,
    }),
    dedupeKey: `launch.graduated:${input.instanceId}`,
    source: notificationInboxSources.launch2,
    observedAt: input.graduatedAt,
  });
}

export function launchBadgeMintedNotification(input: {
  readonly ownerUserId: string;
  readonly instanceId: string;
  readonly projectName: string;
  readonly tokenId: string;
  readonly mintedAt: string;
  readonly transactionHash: string;
}): RecordNotificationInput {
  const eventType = "launch.badge_minted" as const;
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: `launch2Instance:${input.instanceId}`,
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ instanceId: input.instanceId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 勋章 #${input.tokenId} 铸造完成`),
      body: bounded(
        `你的共识勋章 #${input.tokenId} 已于 ${formatBeijingMinute(input.mintedAt)}（北京时间）上链确认。`,
      ),
      instanceId: input.instanceId,
      projectName: input.projectName,
      tokenId: input.tokenId,
      mintedAt: input.mintedAt,
      transactionHash: input.transactionHash,
    }),
    dedupeKey: `launch.badge_minted:${input.instanceId}:${input.tokenId}`,
    source: notificationInboxSources.launch2,
    observedAt: input.mintedAt,
  });
}

export function socialFriendRequestNotification(input: {
  readonly ownerUserId: string;
  readonly friendRequestId: string;
  readonly requesterPublicProfileId: string;
  readonly requesterAlias: string | null;
  readonly requestedAt: string;
}): RecordNotificationInput {
  const eventType = "social.friend_request" as const;
  const who = input.requesterAlias ?? "有人";
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: `friendRequest:${input.friendRequestId}`,
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ friendRequestId: input.friendRequestId }),
    payload: Object.freeze({
      event: eventType,
      title: "新的好友申请",
      body: bounded(`${who} 请求添加你为好友`),
      friendRequestId: input.friendRequestId,
      publicProfileId: input.requesterPublicProfileId,
      alias: input.requesterAlias,
    }),
    dedupeKey: `social.friend_request:${input.friendRequestId}`,
    source: notificationInboxSources.social,
    observedAt: input.requestedAt,
  });
}

export function socialFriendAcceptedNotification(input: {
  readonly ownerUserId: string;
  readonly friendRequestId: string;
  readonly accepterPublicProfileId: string;
  readonly accepterAlias: string | null;
  readonly acceptedAt: string;
}): RecordNotificationInput {
  const eventType = "social.friend_accepted" as const;
  const who = input.accepterAlias ?? "对方";
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: `friendRequest:${input.friendRequestId}`,
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({
      publicProfileId: input.accepterPublicProfileId,
    }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${who} 已接受你的好友申请`),
      body: "你们已成为好友，现在可以开始私聊。",
      friendRequestId: input.friendRequestId,
      publicProfileId: input.accepterPublicProfileId,
      alias: input.accepterAlias,
    }),
    dedupeKey: `social.friend_accepted:${input.friendRequestId}`,
    source: notificationInboxSources.social,
    observedAt: input.acceptedAt,
  });
}
