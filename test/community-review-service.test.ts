import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { NotificationRepository } from "../src/database/notification-repository.js";
import {
  createUnavailableCommunityRepository,
  type CommunityRecord,
  type CommunityRepository,
  type CommunityReviewRecord,
} from "../src/features/community/community-repository.js";
import {
  communityApplicationNotification,
  createCommunityReviewService,
} from "../src/features/community/community-review-service.js";
import {
  createPushPayload,
  pushEventDictionary,
} from "../src/features/push/push-contract.js";
import type {
  OwnerPushDispatchInput,
  PushDispatchService,
} from "../src/features/push/push-dispatch-service.js";
import { androidLocKey } from "../src/integrations/fcm/fcm-sender.js";

/**
 * The two review producers (Decision 0073) follow the Decision 0067 order:
 * the durable review first, then the feed row, then a push that points at
 * it. Nothing about the feed or the push can change what the review did.
 */

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const eventId = "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const reviewedAt = "2026-09-23T08:00:00.000Z";
const reason = "Name collides with a listed token; pick another";

function community(
  status: CommunityRecord["verificationStatus"],
  rejectedReason: string | null,
): CommunityRecord {
  return Object.freeze({
    communityId,
    name: "Frog Holders",
    slug: "frog-holders",
    description: null,
    logoRef: null,
    verificationStatus: status,
    boundAssetKey: null,
    memberCount: 1,
    createdAt: "2026-09-22T01:00:00.000Z",
    configVersion: "communityV1",
    application: Object.freeze({
      submittedAt: "2026-09-22T01:00:00.000Z",
      reviewedAt,
      rejectedReason,
    }),
  });
}

function reviewRecord(
  overrides: Partial<CommunityReviewRecord> = {},
): CommunityReviewRecord {
  return Object.freeze({
    community: community("verified", null),
    ownerUserId,
    eventId,
    changed: true,
    ...overrides,
  });
}

function notificationsFake(
  record: NotificationRepository["record"] = (input) =>
    Promise.resolve({
      ...input,
      notificationId: randomUUID(),
      readAt: null,
      createdAt: reviewedAt,
      createdAtCursor: reviewedAt.replace("Z", "000Z"),
    }),
) {
  const recordMock = vi.fn<NotificationRepository["record"]>(record);
  const repository: NotificationRepository = {
    listFeed: () => Promise.reject(new Error("not used")),
    record: recordMock,
    listRecentByType: () => Promise.resolve([]),
    markRead: () => Promise.reject(new Error("not used")),
    getPreferences: () => Promise.reject(new Error("not used")),
    replacePreferences: () => Promise.reject(new Error("not used")),
    isCategoryEnabled: () => Promise.resolve(true),
  };
  return { repository, record: recordMock };
}

function pushFake(status: "delivered" | "suppressed" = "delivered") {
  const owner: OwnerPushDispatchInput[] = [];
  const dispatchToOwner = vi.fn<PushDispatchService["dispatchToOwner"]>(
    (input) => {
      owner.push(input);
      return Promise.resolve({
        status,
        reasonCode: status === "delivered" ? null : "PUSH_CATEGORY_DISABLED",
        attemptedCount: 1,
        sentCount: status === "delivered" ? 1 : 0,
        duplicateCount: 0,
        rateLimitedCount: 0,
        failedCount: 0,
        invalidTokenCount: 0,
        audienceTruncated: false,
      });
    },
  );
  const service: PushDispatchService = {
    available: true,
    dispatchToOwner,
    dispatchToCommunity: () => Promise.reject(new Error("not used")),
  };
  return { service, owner, dispatchToOwner };
}

function repositoryFake(input: {
  readonly verify?: CommunityReviewRecord | Error;
  readonly reject?: CommunityReviewRecord | Error;
}): CommunityRepository {
  const settle = (value: CommunityReviewRecord | Error | undefined) =>
    value === undefined
      ? Promise.reject(new Error("not used"))
      : value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve(value);
  return {
    ...createUnavailableCommunityRepository(),
    verifyCommunity: () => settle(input.verify),
    rejectCommunity: () => settle(input.reject),
  };
}

const silentLogger = { warn: vi.fn() };

describe("community application feed row (Decision 0073)", () => {
  it("names the community, the outcome, the review time and the reason, keyed by the audit event", () => {
    const row = communityApplicationNotification({
      ownerUserId,
      community: community("rejected", reason),
      outcome: "rejected",
      eventId,
    });
    expect(row).toEqual({
      ownerUserId,
      type: "community.announcement",
      entityRef: `community:${communityId}`,
      contextRoute: "community-profile",
      contextParams: { communityId },
      payload: {
        event: "community.application.rejected",
        communityId,
        communityName: "Frog Holders",
        reviewedAt,
        reason,
      },
      dedupeKey: `community.application:${communityId}:rejected:${eventId}`,
      source: "loop_operator_review",
      observedAt: reviewedAt,
    });
    expect(row.dedupeKey).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
    expect(row.entityRef).toMatch(
      /^[a-z][A-Za-z0-9]{0,31}:[A-Za-z0-9._:-]{1,160}$/,
    );
  });

  it("carries a null reason for a verification", () => {
    const row = communityApplicationNotification({
      ownerUserId,
      community: community("verified", null),
      outcome: "verified",
      eventId,
    });
    expect(row.payload).toMatchObject({
      event: "community.application.verified",
      reason: null,
    });
    expect(row.dedupeKey).toBe(
      `community.application:${communityId}:verified:${eventId}`,
    );
  });
});

describe("community review service (Decision 0073)", () => {
  it("verifies, writes the feed row, then pushes a pointer to the owner", async () => {
    const notifications = notificationsFake();
    const push = pushFake();
    const service = createCommunityReviewService({
      repository: repositoryFake({ verify: reviewRecord() }),
      notifications: notifications.repository,
      push: push.service,
      logger: silentLogger,
    });

    const result = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });

    expect(result).toMatchObject({
      changed: true,
      notification: "recorded",
      push: { status: "delivered", reasonCode: null },
    });
    expect(result.community.verificationStatus).toBe("verified");
    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId,
      type: "community.announcement",
      payload: { event: "community.application.verified" },
    });
    expect(push.owner).toEqual([
      {
        ownerUserId,
        eventType: "community_application_verified",
        entityRef: `community:${communityId}`,
        contextRoute: "community-profile",
        eventKey: `community_application_verified:community:${communityId}:${eventId}`,
      },
    ]);
    // The feed row is written before the push is dispatched.
    const feedOrder = notifications.record.mock.invocationCallOrder[0] ?? 0;
    const pushOrder = push.dispatchToOwner.mock.invocationCallOrder[0] ?? 0;
    expect(feedOrder).toBeGreaterThan(0);
    expect(feedOrder).toBeLessThan(pushOrder);
  });

  it("rejects with the reason in the feed row and a reason-free push payload", async () => {
    const notifications = notificationsFake();
    const push = pushFake("suppressed");
    const service = createCommunityReviewService({
      repository: repositoryFake({
        reject: reviewRecord({ community: community("rejected", reason) }),
      }),
      notifications: notifications.repository,
      push: push.service,
      logger: silentLogger,
    });

    const result = await service.reject({
      communityId,
      requestId: randomUUID(),
      reasonCode: "policy_name_clash",
      reason,
    });

    expect(result).toMatchObject({
      changed: true,
      notification: "recorded",
      push: { status: "suppressed", reasonCode: "PUSH_CATEGORY_DISABLED" },
    });
    expect(notifications.record.mock.calls[0]?.[0]).toMatchObject({
      payload: { event: "community.application.rejected", reason },
    });
    const dispatched = push.owner[0];
    expect(dispatched?.eventType).toBe("community_application_rejected");
    const payload = createPushPayload({
      eventType: dispatched?.eventType ?? "community_application_rejected",
      entityRef: dispatched?.entityRef ?? "",
      contextRoute: dispatched?.contextRoute ?? "",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "contextRoute",
      "entityRef",
      "eventVersion",
      "type",
    ]);
    expect(JSON.stringify(payload)).not.toContain(reason);
    expect(JSON.stringify(payload)).not.toContain("Frog Holders");
    // Loc keys exist for both platforms; Android swaps dots for underscores.
    const definition = pushEventDictionary.community_application_rejected;
    expect(definition.titleLocKey).toBe(
      "push.communityApplicationRejected.title",
    );
    expect(androidLocKey(definition.bodyLocKey)).toBe(
      "push_communityApplicationRejected_body",
    );
  });

  it("raises nothing for an unchanged review (repair or repeated rejection)", async () => {
    const notifications = notificationsFake();
    const push = pushFake();
    const service = createCommunityReviewService({
      repository: repositoryFake({
        verify: reviewRecord({ changed: false, eventId: null }),
        reject: reviewRecord({
          community: community("rejected", reason),
          changed: false,
          eventId: null,
        }),
      }),
      notifications: notifications.repository,
      push: push.service,
      logger: silentLogger,
    });

    const verified = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    const rejected = await service.reject({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
      reason,
    });
    for (const result of [verified, rejected]) {
      expect(result).toMatchObject({
        changed: false,
        notification: "skipped",
        push: { status: "skipped", reasonCode: null },
      });
    }
    expect(notifications.record).not.toHaveBeenCalled();
    expect(push.owner).toEqual([]);
  });

  it("keeps the review when the feed write fails and still pushes the pointer", async () => {
    const logger = { warn: vi.fn() };
    const notifications = notificationsFake(() =>
      Promise.reject(new Error("feed down")),
    );
    const push = pushFake();
    const service = createCommunityReviewService({
      repository: repositoryFake({ verify: reviewRecord() }),
      notifications: notifications.repository,
      push: push.service,
      logger,
    });

    const result = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    expect(result).toMatchObject({ changed: true, notification: "failed" });
    expect(result.push.status).toBe("delivered");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ communityId, errorName: "Error" }),
      "Community review notification was not recorded",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("feed down");
  });

  it("reports duplicate when the dedupe key already exists", async () => {
    const notifications = notificationsFake(() => Promise.resolve(null));
    const service = createCommunityReviewService({
      repository: repositoryFake({ verify: reviewRecord() }),
      notifications: notifications.repository,
      push: null,
      logger: silentLogger,
    });
    const result = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    expect(result.notification).toBe("duplicate");
    expect(result.push).toEqual({ status: "skipped", reasonCode: null });
  });

  it("skips the feed and the push when neither runtime is composed, without faking either", async () => {
    const service = createCommunityReviewService({
      repository: repositoryFake({ verify: reviewRecord() }),
      notifications: null,
      push: null,
      logger: silentLogger,
    });
    const result = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    expect(result).toMatchObject({
      changed: true,
      notification: "skipped",
      push: { status: "skipped", reasonCode: null },
    });
  });

  it("warns and announces nothing when the community has no owner", async () => {
    const logger = { warn: vi.fn() };
    const notifications = notificationsFake();
    const push = pushFake();
    const service = createCommunityReviewService({
      repository: repositoryFake({
        verify: reviewRecord({ ownerUserId: null }),
      }),
      notifications: notifications.repository,
      push: push.service,
      logger,
    });
    const result = await service.verify({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    expect(result).toMatchObject({ changed: true, notification: "skipped" });
    expect(notifications.record).not.toHaveBeenCalled();
    expect(push.owner).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ communityId }),
      "Community review has no owner to notify",
    );
  });

  it("propagates a repository refusal untouched", async () => {
    const service = createCommunityReviewService({
      repository: repositoryFake({ reject: new Error("stale") }),
      notifications: null,
      push: null,
      logger: silentLogger,
    });
    await expect(
      service.reject({
        communityId,
        requestId: randomUUID(),
        reasonCode: "operator_manual_review",
        reason,
      }),
    ).rejects.toThrow("stale");
  });
});
