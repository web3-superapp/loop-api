import type {
  NotificationInboxProduceResult,
  NotificationInboxRepository,
} from "../../database/notification-inbox-repository.js";
import type { PushDispatchService } from "../push/push-dispatch-service.js";
import { visibleNotificationInboxEventTypes } from "../alerts/notification-contract.js";
import {
  notificationInboxFactFreshnessSeconds,
  notificationInboxGraduationBatch,
  notificationInboxMintBatch,
  notificationInboxPushBatch,
  notificationInboxPushEventType,
  notificationInboxPushFreshnessSeconds,
} from "./notification-inbox-contract.js";

/**
 * Decision 0177: one pass of the `notification_inbox` lane.
 *
 * 1. Write the MEME v2 graduation / badge-minted rows (always: the rows
 *    are the record whether or not the emit switch is on).
 * 2. Settle fine-event rows that are too old to push.
 * 3. Only while `NOTIFICATION_INBOX_EMIT` (the Decision 0177 events) or
 *    `LAUNCH_REVIEW_INBOX_EMIT` (the Decision 0178 events) is on and the
 *    push channel is composed: push the fresh ones of the switched-on
 *    events, at most once each.
 */

export type NotificationInboxRunResult =
  | { readonly kind: "aborted" }
  | {
      readonly kind: "completed";
      readonly produced: NotificationInboxProduceResult;
      readonly staleSettled: number;
      /** Rows handed to the push dispatcher (null: push not attempted). */
      readonly pushClaimed: number | null;
      readonly pushSent: number;
      /** A batch was full: the lane runs again at once. */
      readonly saturated: boolean;
    };

export interface NotificationInboxService {
  runOnce(signal: AbortSignal): Promise<NotificationInboxRunResult>;
}

export interface NotificationInboxServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface CreateNotificationInboxServiceOptions {
  readonly repository: NotificationInboxRepository;
  readonly push: PushDispatchService | null;
  /** `NOTIFICATION_INBOX_EMIT === "on"`. */
  readonly emit: boolean;
  /**
   * Decision 0178: `LAUNCH_REVIEW_INBOX_EMIT === "on"` (absent = off); the
   * four launch progress events are pushed only while it is on.
   */
  readonly launchReviewEmit?: boolean;
  readonly logger: NotificationInboxServiceLogger;
  readonly now?: () => Date;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createNotificationInboxService(
  options: CreateNotificationInboxServiceOptions,
): NotificationInboxService {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<NotificationInboxRunResult> {
      if (isAborted(signal)) return { kind: "aborted" };
      const produced = await options.repository.produceLaunch2({
        now: now(),
        freshnessSeconds: notificationInboxFactFreshnessSeconds,
        graduationLimit: notificationInboxGraduationBatch,
        mintLimit: notificationInboxMintBatch,
      });
      if (isAborted(signal)) return { kind: "aborted" };
      const staleSettled = await options.repository.settleStalePushes({
        now: now(),
        freshnessSeconds: notificationInboxPushFreshnessSeconds,
      });
      const push = options.push;
      const pushableEventTypes = visibleNotificationInboxEventTypes({
        inboxEmit: options.emit,
        launchReviewEmit: options.launchReviewEmit === true,
      });
      if (pushableEventTypes.length === 0 || push === null || !push.available) {
        return Object.freeze({
          kind: "completed",
          produced,
          staleSettled,
          pushClaimed: null,
          pushSent: 0,
          saturated: produced.saturated,
        });
      }
      const claims = await options.repository.claimPushes({
        now: now(),
        freshnessSeconds: notificationInboxPushFreshnessSeconds,
        limit: notificationInboxPushBatch,
        eventTypes: pushableEventTypes,
      });
      let pushSent = 0;
      for (const claim of claims) {
        if (isAborted(signal)) break;
        const eventType = notificationInboxPushEventType(claim.eventType);
        try {
          const summary = await push.dispatchToOwner({
            ownerUserId: claim.ownerUserId,
            eventType,
            entityRef: claim.entityRef,
            contextRoute: claim.contextRoute,
            eventKey: `inbox:${claim.dedupeKey}`,
            signal,
          });
          pushSent += summary.sentCount;
        } catch (error) {
          // The feed row stands; this push is simply not sent.
          options.logger.warn(
            {
              lane: "notification_inbox",
              reasonCode: "NOTIFICATION_INBOX_PUSH_FAILED",
              eventType,
              errorName: error instanceof Error ? error.name : "unknown",
            },
            "LOOP notification inbox push was not dispatched",
          );
        }
      }
      return Object.freeze({
        kind: "completed",
        produced,
        staleSettled,
        pushClaimed: claims.length,
        pushSent,
        saturated:
          produced.saturated || claims.length >= notificationInboxPushBatch,
      });
    },
  });
}
