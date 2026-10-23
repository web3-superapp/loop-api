import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  NotificationInboxPushClaim,
  NotificationInboxRepository,
} from "../src/database/notification-inbox-repository.js";
import {
  launchReviewInboxEventTypes,
  notificationCategories,
  notificationInboxContextRoutes,
  notificationInboxCoreEventTypes,
  notificationInboxEventCategory,
  visibleNotificationInboxEventTypes,
} from "../src/features/alerts/notification-contract.js";
import {
  launchActivatedNotification,
  launchDeployFailedNotification,
  launchDeployFailureText,
  launchRejectionReasonText,
  launchReviewApprovedNotification,
  launchReviewRejectedNotification,
} from "../src/features/notifications/launch-review-inbox-contract.js";
import { notificationInboxPushEventType } from "../src/features/notifications/notification-inbox-contract.js";
import { createNotificationInboxService } from "../src/features/notifications/notification-inbox-service.js";
import {
  createPushPayload,
  pushEventDictionary,
} from "../src/features/push/push-contract.js";
import type {
  OwnerPushDispatchInput,
  PushDispatchService,
  PushDispatchSummary,
} from "../src/features/push/push-dispatch-service.js";

/**
 * Decision 0178 (S291): the project owner's launch review / deployment
 * progress events — category, routes, Chinese text, dedupe keys, the push
 * mapping, and the LAUNCH_REVIEW_INBOX_EMIT gate of the lane's push.
 */

const owner = "3f5493ce-6226-4ac0-b73e-102443a16a79";
const projectId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const jobId = "1c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const instanceId = "2c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";

const pushTypes = {
  "launch.review_approved": "launch_review_approved",
  "launch.review_rejected": "launch_review_rejected",
  "launch.activated": "launch_activated",
  "launch.deploy_failed": "launch_deploy_failed",
} as const;

describe("Decision 0178 launch review inbox contract", () => {
  it("files all four events under launch.round with their routes and push types", () => {
    expect(launchReviewInboxEventTypes).toEqual([
      "launch.review_approved",
      "launch.review_rejected",
      "launch.activated",
      "launch.deploy_failed",
    ]);
    expect(notificationCategories).toHaveLength(10);
    expect(notificationInboxContextRoutes).toMatchObject({
      "launch.review_approved": "launch2-project-sign",
      "launch.review_rejected": "launch2-projects-mine",
      "launch.activated": "launch2-instance",
      "launch.deploy_failed": "launch2-projects-mine",
    });
    for (const eventType of launchReviewInboxEventTypes) {
      expect(notificationInboxEventCategory[eventType]).toBe("launch.round");
      const pushType = notificationInboxPushEventType(eventType);
      expect(pushType).toBe(pushTypes[eventType]);
      expect(pushEventDictionary[pushType]).toMatchObject({
        eventType: pushType,
        category: "launch.round",
        mandatory: false,
      });
      // The device payload stays the Decision 0067 four-key pointer.
      expect(
        Object.keys(
          createPushPayload({
            eventType: pushType,
            entityRef: `launchProject:${projectId}`,
            contextRoute: notificationInboxContextRoutes[eventType],
          }),
        ),
      ).toEqual(["type", "entityRef", "contextRoute", "eventVersion"]);
    }
  });

  it("separates the two emit switches", () => {
    expect(
      visibleNotificationInboxEventTypes({
        inboxEmit: false,
        launchReviewEmit: false,
      }),
    ).toEqual([]);
    expect(
      visibleNotificationInboxEventTypes({
        inboxEmit: true,
        launchReviewEmit: false,
      }),
    ).toEqual([...notificationInboxCoreEventTypes]);
    expect(
      visibleNotificationInboxEventTypes({
        inboxEmit: false,
        launchReviewEmit: true,
      }),
    ).toEqual([...launchReviewInboxEventTypes]);
  });

  it("builds the approval row (sign page, once per config version)", () => {
    const row = launchReviewApprovedNotification({
      ownerUserId: owner,
      projectId,
      projectName: "Moon",
      symbol: "MOON",
      configVersion: 2,
      approvedAt: "2026-10-23T01:00:00.000Z",
    });
    expect(row).toEqual({
      ownerUserId: owner,
      type: "launch.round",
      eventType: "launch.review_approved",
      entityRef: `launchProject:${projectId}`,
      contextRoute: "launch2-project-sign",
      contextParams: { projectId },
      payload: {
        event: "launch.review_approved",
        title: "Moon 审核已通过",
        body: "请完成签名，发射才会部署",
        projectName: "Moon",
        symbol: "MOON",
        taskId: projectId,
        projectId,
        configVersion: "2",
      },
      dedupeKey: `launch.review_approved:${projectId}:v2`,
      source: "launch_review",
      observedAt: "2026-10-23T01:00:00.000Z",
    });
  });

  it("builds the rejection row with the reviewer's note or the reason text", () => {
    const material = launchReviewRejectedNotification({
      ownerUserId: owner,
      projectId,
      projectName: "Moon",
      symbol: null,
      decision: { kind: "material", rejectionId: jobId },
      reasonCode: "other",
      note: "  官网打不开  ",
      rejectedAt: "2026-10-23T01:00:00.000Z",
    });
    expect(material).toMatchObject({
      type: "launch.round",
      eventType: "launch.review_rejected",
      contextRoute: "launch2-projects-mine",
      contextParams: { projectId },
      payload: {
        title: "Moon 审核未通过",
        body: "官网打不开",
        reasonText: "官网打不开",
        reasonCode: "other",
        taskId: projectId,
      },
      dedupeKey: `launch.review_rejected:${projectId}:material:${jobId}`,
    });
    expect(material.payload).not.toHaveProperty("symbol");
    const config = launchReviewRejectedNotification({
      ownerUserId: owner,
      projectId,
      projectName: "Moon",
      symbol: "MOON",
      decision: { kind: "config", configVersion: 3 },
      reasonCode: "buyback_recipient_invalid",
      note: null,
      rejectedAt: "2026-10-23T01:00:00.000Z",
    });
    expect(config).toMatchObject({
      payload: {
        body: "回购收币地址不符合平台要求，修改后可以重新提交审核。",
        reasonText: "回购收币地址不符合平台要求，修改后可以重新提交审核。",
        configVersion: "3",
        symbol: "MOON",
      },
      dedupeKey: `launch.review_rejected:${projectId}:config:v3`,
    });
    expect(launchRejectionReasonText("unknown_code", null)).toBe(
      "审核未通过，按审核意见修改后可以重新提交。",
    );
  });

  it("builds the activation row: sale time ahead, or already on sale", () => {
    const ahead = launchActivatedNotification({
      ownerUserId: owner,
      projectId,
      jobId,
      instanceId,
      projectName: "Moon",
      symbol: "MOON",
      saleStartAt: "2026-10-24T12:00:00.000Z",
      activatedAt: "2026-10-23T01:00:00.000Z",
      now: new Date("2026-10-23T01:00:05.000Z"),
    });
    expect(ahead).toEqual({
      ownerUserId: owner,
      type: "launch.round",
      eventType: "launch.activated",
      entityRef: `launch2Instance:${instanceId}`,
      contextRoute: "launch2-instance",
      contextParams: { instanceId },
      payload: {
        event: "launch.activated",
        title: "Moon 已上链",
        body: "2026-10-24 20:00（北京时间）开售",
        projectName: "Moon",
        symbol: "MOON",
        taskId: projectId,
        projectId,
        jobId,
        instanceId,
        saleStartAt: "2026-10-24T12:00:00.000Z",
      },
      dedupeKey: `launch.activated:${instanceId}`,
      source: "launch2_indexer",
      observedAt: "2026-10-23T01:00:00.000Z",
    });
    const started = launchActivatedNotification({
      ownerUserId: owner,
      projectId,
      jobId,
      instanceId,
      projectName: "Moon",
      symbol: "MOON",
      saleStartAt: "2026-10-23T00:00:00.000Z",
      activatedAt: "2026-10-23T01:00:00.000Z",
      now: new Date("2026-10-23T01:00:05.000Z"),
    });
    expect(started.payload["body"]).toBe("已开售");
  });

  it("builds the final-failure row with a short reason (once per task)", () => {
    const row = launchDeployFailedNotification({
      ownerUserId: owner,
      projectId,
      jobId,
      projectName: "Moon",
      symbol: "MOON",
      failureCode: "HOOKS_SIGNATURE_EXPIRED",
      failedAt: "2026-10-23T01:00:00.000Z",
    });
    expect(row).toMatchObject({
      type: "launch.round",
      eventType: "launch.deploy_failed",
      entityRef: `launchProject:${projectId}`,
      contextRoute: "launch2-projects-mine",
      contextParams: { projectId },
      payload: {
        title: "Moon 部署失败",
        body: "签名已过期，请重新签名",
        taskId: projectId,
        jobId,
        failureCode: "HOOKS_SIGNATURE_EXPIRED",
      },
      dedupeKey: `launch.deploy_failed:${jobId}`,
      source: "hooks_launch_executor",
    });
    expect(launchDeployFailureText(null)).toBe("部署未完成，请联系平台");
    expect(launchDeployFailureText("SOMETHING_NEW")).toBe(
      "部署未完成，请联系平台",
    );
  });

  it("keeps every payload within the feed schema (≤ 16 string values)", () => {
    const rows = [
      launchReviewApprovedNotification({
        ownerUserId: owner,
        projectId,
        projectName: "Moon",
        symbol: "MOON",
        configVersion: 1,
        approvedAt: "2026-10-23T01:00:00.000Z",
      }),
      launchReviewRejectedNotification({
        ownerUserId: owner,
        projectId,
        projectName: "Moon",
        symbol: "MOON",
        decision: { kind: "config", configVersion: 1 },
        reasonCode: "other",
        note: "x".repeat(600),
        rejectedAt: "2026-10-23T01:00:00.000Z",
      }),
    ];
    for (const row of rows) {
      const values = Object.values(row.payload);
      expect(values.length).toBeLessThanOrEqual(16);
      for (const value of values) {
        expect(typeof value).toBe("string");
        expect(Array.from(value as string).length).toBeLessThanOrEqual(512);
      }
      expect(row.dedupeKey).toMatch(/^[A-Za-z0-9._:-]{1,200}$/u);
      expect(row.entityRef).toMatch(
        /^[a-z][A-Za-z0-9]{0,31}:[A-Za-z0-9._:-]{1,160}$/u,
      );
    }
  });
});

const sent: PushDispatchSummary = Object.freeze({
  status: "delivered",
  reasonCode: null,
  attemptedCount: 1,
  sentCount: 1,
  duplicateCount: 0,
  rateLimitedCount: 0,
  failedCount: 0,
  invalidTokenCount: 0,
  audienceTruncated: false,
});

function harness(claims: readonly NotificationInboxPushClaim[]) {
  const claimPushes = vi.fn<NotificationInboxRepository["claimPushes"]>(() =>
    Promise.resolve(claims),
  );
  const repository: NotificationInboxRepository = {
    produceLaunch2: vi.fn(() =>
      Promise.resolve({
        graduations: 0,
        mints: 0,
        activations: 1,
        skipped: 0,
        notifications: 1,
        saturated: false,
      }),
    ),
    claimPushes,
    settleStalePushes: vi.fn(() => Promise.resolve(0)),
  };
  const dispatched: OwnerPushDispatchInput[] = [];
  const push: PushDispatchService = {
    available: true,
    dispatchToOwner: vi.fn((input: OwnerPushDispatchInput) => {
      dispatched.push(input);
      return Promise.resolve(sent);
    }),
    dispatchToCommunity: vi.fn(() => Promise.reject(new Error("not used"))),
  };
  return { repository, claimPushes, push, dispatched };
}

const approvedClaim: NotificationInboxPushClaim = {
  notificationId: randomUUID(),
  ownerUserId: owner,
  eventType: "launch.review_approved",
  entityRef: `launchProject:${projectId}`,
  contextRoute: "launch2-project-sign",
  dedupeKey: `launch.review_approved:${projectId}:v1`,
};

describe("Decision 0178 push gate in the notification_inbox lane", () => {
  const logger = { warn: vi.fn() };

  it("claims nothing while both switches are off", async () => {
    const { repository, claimPushes, push } = harness([approvedClaim]);
    const service = createNotificationInboxService({
      repository,
      push,
      emit: false,
      launchReviewEmit: false,
      logger,
    });
    const result = await service.runOnce(new AbortController().signal);
    expect(result).toMatchObject({ kind: "completed", pushClaimed: null });
    expect(claimPushes).not.toHaveBeenCalled();
  });

  it("claims only the Decision 0177 events while only NOTIFICATION_INBOX_EMIT is on", async () => {
    const { repository, claimPushes, push } = harness([]);
    const service = createNotificationInboxService({
      repository,
      push,
      emit: true,
      logger,
    });
    await service.runOnce(new AbortController().signal);
    expect(claimPushes.mock.calls[0]?.[0].eventTypes).toEqual([
      ...notificationInboxCoreEventTypes,
    ]);
  });

  it("claims and pushes the launch progress events while LAUNCH_REVIEW_INBOX_EMIT is on", async () => {
    const { repository, claimPushes, push, dispatched } = harness([
      approvedClaim,
    ]);
    const service = createNotificationInboxService({
      repository,
      push,
      emit: false,
      launchReviewEmit: true,
      logger,
    });
    const result = await service.runOnce(new AbortController().signal);
    expect(claimPushes.mock.calls[0]?.[0].eventTypes).toEqual([
      ...launchReviewInboxEventTypes,
    ]);
    expect(result).toMatchObject({ pushClaimed: 1, pushSent: 1 });
    expect(dispatched).toEqual([
      expect.objectContaining({
        ownerUserId: owner,
        eventType: "launch_review_approved",
        entityRef: `launchProject:${projectId}`,
        contextRoute: "launch2-project-sign",
        eventKey: `inbox:launch.review_approved:${projectId}:v1`,
      }),
    ]);
  });
});
