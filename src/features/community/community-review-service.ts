import type {
  NotificationRepository,
  RecordNotificationInput,
} from "../../database/notification-repository.js";
import type { PushDispatchService } from "../push/push-dispatch-service.js";
import type {
  CommunityRecord,
  CommunityRepository,
  CommunityReviewRecord,
} from "./community-repository.js";

/**
 * Operator review of a community application (Decision 0073).
 *
 * Both outcomes follow the same order as every other producer since
 * Decision 0067: the durable state change first (status, review columns,
 * audit row, in one repository transaction), then the in-app feed row, then
 * the push as a pointer to that row. The feed write is best-effort and the
 * push summary is informational: neither can undo a review that already
 * committed, and neither is faked when its runtime is missing.
 */

export const communityApplicationFeedEvents = Object.freeze({
  verified: "community.application.verified",
  rejected: "community.application.rejected",
} as const);

export const communityApplicationContextRoute = "community-profile" as const;
export const communityApplicationNotificationSource =
  "loop_operator_review" as const;

export type CommunityReviewOutcome = "verified" | "rejected";

export interface CommunityReviewLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface CommunityReviewServiceOptions {
  readonly repository: CommunityRepository;
  /** Null when no notification runtime is composed: the feed row is skipped. */
  readonly notifications: NotificationRepository | null;
  /** Null when no push runtime is composed: the push is reported unavailable. */
  readonly push: PushDispatchService | null;
  readonly logger: CommunityReviewLogger;
}

export interface CommunityReviewCommand {
  readonly communityId: string;
  readonly requestId: string;
  readonly reasonCode: string;
}

export interface CommunityRejectCommand extends CommunityReviewCommand {
  readonly reason: string;
}

export interface CommunityReviewResult {
  readonly community: CommunityRecord;
  readonly changed: boolean;
  /** `recorded`, `duplicate`, `skipped` (no runtime), or `failed`. */
  readonly notification: "recorded" | "duplicate" | "skipped" | "failed";
  readonly push: {
    readonly status: "delivered" | "suppressed" | "unavailable" | "skipped";
    readonly reasonCode: string | null;
  };
}

export interface CommunityReviewService {
  verify(command: CommunityReviewCommand): Promise<CommunityReviewResult>;
  reject(command: CommunityRejectCommand): Promise<CommunityReviewResult>;
}

/**
 * The feed row for one review outcome. It is the authoritative record the
 * push points at: the community, the outcome, when it was decided, and the
 * operator's reason (null for a verification). It is keyed by the audit
 * event so a second rejection after a resubmission is a second row.
 */
export function communityApplicationNotification(input: {
  readonly ownerUserId: string;
  readonly community: CommunityRecord;
  readonly outcome: CommunityReviewOutcome;
  readonly eventId: string;
}): RecordNotificationInput {
  const reviewedAt = input.community.application.reviewedAt;
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: "community.announcement",
    entityRef: `community:${input.community.communityId}`,
    contextRoute: communityApplicationContextRoute,
    contextParams: Object.freeze({ communityId: input.community.communityId }),
    payload: Object.freeze({
      event: communityApplicationFeedEvents[input.outcome],
      communityId: input.community.communityId,
      communityName: input.community.name,
      reviewedAt,
      reason:
        input.outcome === "rejected"
          ? input.community.application.rejectedReason
          : null,
    }),
    dedupeKey: `community.application:${input.community.communityId}:${input.outcome}:${input.eventId}`,
    source: communityApplicationNotificationSource,
    observedAt: reviewedAt,
  });
}

export function createCommunityReviewService(
  options: CommunityReviewServiceOptions,
): CommunityReviewService {
  async function announce(
    record: CommunityReviewRecord,
    outcome: CommunityReviewOutcome,
    requestId: string,
  ): Promise<CommunityReviewResult> {
    const unchanged: CommunityReviewResult = Object.freeze({
      community: record.community,
      changed: false,
      notification: "skipped",
      push: Object.freeze({ status: "skipped", reasonCode: null }),
    });
    if (!record.changed || record.eventId === null) {
      return unchanged;
    }
    if (record.ownerUserId === null) {
      options.logger.warn(
        { communityId: record.community.communityId, requestId },
        "Community review has no owner to notify",
      );
      return Object.freeze({ ...unchanged, changed: true });
    }
    let notification: CommunityReviewResult["notification"] = "skipped";
    if (options.notifications !== null) {
      try {
        const row = await options.notifications.record(
          communityApplicationNotification({
            ownerUserId: record.ownerUserId,
            community: record.community,
            outcome,
            eventId: record.eventId,
          }),
        );
        notification = row === null ? "duplicate" : "recorded";
      } catch (error) {
        // The review stands; the feed simply lacks this row.
        notification = "failed";
        options.logger.warn(
          {
            communityId: record.community.communityId,
            requestId,
            errorName: error instanceof Error ? error.name : "unknown",
          },
          "Community review notification was not recorded",
        );
      }
    }
    let push: CommunityReviewResult["push"] = Object.freeze({
      status: "skipped",
      reasonCode: null,
    });
    if (options.push !== null) {
      const summary = await options.push.dispatchToOwner({
        ownerUserId: record.ownerUserId,
        eventType:
          outcome === "verified"
            ? "community_application_verified"
            : "community_application_rejected",
        entityRef: `community:${record.community.communityId}`,
        contextRoute: communityApplicationContextRoute,
        eventKey: `community_application_${outcome}:community:${record.community.communityId}:${record.eventId}`,
      });
      push = Object.freeze({
        status: summary.status,
        reasonCode: summary.reasonCode,
      });
    }
    return Object.freeze({
      community: record.community,
      changed: true,
      notification,
      push,
    });
  }

  const service: CommunityReviewService = {
    async verify(command) {
      const record = await options.repository.verifyCommunity({
        communityId: command.communityId,
        requestId: command.requestId,
        reasonCode: command.reasonCode,
      });
      return announce(record, "verified", command.requestId);
    },
    async reject(command) {
      const record = await options.repository.rejectCommunity({
        communityId: command.communityId,
        requestId: command.requestId,
        reasonCode: command.reasonCode,
        reason: command.reason,
      });
      return announce(record, "rejected", command.requestId);
    },
  };
  return Object.freeze(service);
}
