import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  NotificationInboxPushClaim,
  NotificationInboxRepository,
} from "../src/database/notification-inbox-repository.js";
import {
  formatBeijingMinute,
  launchBadgeMintedNotification,
  launchGraduatedNotification,
  notificationInboxPushBatch,
  notificationInboxPushEventType,
  socialFriendAcceptedNotification,
  socialFriendRequestNotification,
} from "../src/features/notifications/notification-inbox-contract.js";
import { createNotificationInboxService } from "../src/features/notifications/notification-inbox-service.js";
import {
  notificationCategories,
  notificationInboxEventCategory,
  notificationInboxEventTypes,
} from "../src/features/alerts/notification-contract.js";
import {
  pushEventDictionary,
  pushPayloadKeys,
} from "../src/features/push/push-contract.js";
import type {
  OwnerPushDispatchInput,
  PushDispatchService,
  PushDispatchSummary,
} from "../src/features/push/push-dispatch-service.js";
import { createNotificationInboxWorker } from "../src/notification-inbox-worker.js";

const produced = Object.freeze({
  graduations: 1,
  mints: 2,
  skipped: 0,
  notifications: 4,
  saturated: false,
});

function claim(
  overrides: Partial<NotificationInboxPushClaim> = {},
): NotificationInboxPushClaim {
  const friendRequestId = randomUUID();
  return {
    notificationId: randomUUID(),
    ownerUserId: randomUUID(),
    eventType: "social.friend_request",
    entityRef: `friendRequest:${friendRequestId}`,
    contextRoute: "dm-requests",
    dedupeKey: `social.friend_request:${friendRequestId}`,
    ...overrides,
  };
}

function repositoryFake(claims: readonly NotificationInboxPushClaim[] = []) {
  const produceLaunch2 = vi.fn(() => Promise.resolve(produced));
  const claimPushes = vi.fn(() => Promise.resolve(claims));
  const repository: NotificationInboxRepository = {
    produceLaunch2,
    claimPushes,
    settleStalePushes: vi.fn(() => Promise.resolve(3)),
  };
  return Object.assign(repository, { mocks: { produceLaunch2, claimPushes } });
}

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

function pushFake(available = true) {
  const owner: OwnerPushDispatchInput[] = [];
  const push: PushDispatchService = {
    available,
    dispatchToOwner: vi.fn((input: OwnerPushDispatchInput) => {
      if (input.entityRef === "broken") {
        return Promise.reject(new Error("producer bug"));
      }
      owner.push(input);
      return Promise.resolve(sent);
    }),
    dispatchToCommunity: vi.fn(() => Promise.reject(new Error("not used"))),
  };
  return { push, owner };
}

const logger = { warn: vi.fn() };

describe("Decision 0177 notification inbox contract", () => {
  it("keeps the ten categories and maps every fine event onto one of them", () => {
    expect(notificationCategories).toHaveLength(10);
    for (const eventType of notificationInboxEventTypes) {
      expect(notificationCategories).toContain(
        notificationInboxEventCategory[eventType],
      );
      const pushType = notificationInboxPushEventType(eventType);
      expect(pushEventDictionary[pushType]).toMatchObject({
        category: notificationInboxEventCategory[eventType],
        mandatory: false,
      });
    }
    expect(pushPayloadKeys).toEqual([
      "type",
      "entityRef",
      "contextRoute",
      "eventVersion",
    ]);
  });

  it("builds the four feed rows with their dedupe keys, routes and Chinese text", () => {
    const owner = randomUUID();
    const instanceId = randomUUID();
    const graduated = launchGraduatedNotification({
      ownerUserId: owner,
      instanceId,
      projectName: "Moon",
      graduatedAt: "2026-10-22T06:05:00.000Z",
      officialPoolId: `0x${"ab".repeat(32)}`,
    });
    expect(graduated).toMatchObject({
      type: "launch.graduation",
      eventType: "launch.graduated",
      entityRef: `launch2Instance:${instanceId}`,
      contextRoute: "launch2-instance",
      contextParams: { instanceId },
      dedupeKey: `launch.graduated:${instanceId}`,
      payload: {
        title: "Moon 已毕业",
        body: "Moon 已于 2026-10-22 14:05（北京时间）毕业，交易已迁入官方池 0xabab…abab。",
      },
    });
    expect(
      launchBadgeMintedNotification({
        ownerUserId: owner,
        instanceId,
        projectName: "Moon",
        tokenId: "12",
        mintedAt: "2026-10-22T16:30:00.000Z",
        transactionHash: `0x${"cd".repeat(32)}`,
      }),
    ).toMatchObject({
      type: "launch.round",
      eventType: "launch.badge_minted",
      dedupeKey: `launch.badge_minted:${instanceId}:12`,
      payload: {
        title: "Moon 勋章 #12 铸造完成",
        body: "你的共识勋章 #12 已于 2026-10-23 00:30（北京时间）上链确认。",
      },
    });
    const friendRequestId = randomUUID();
    const profileId = randomUUID();
    expect(
      socialFriendRequestNotification({
        ownerUserId: owner,
        friendRequestId,
        requesterPublicProfileId: profileId,
        requesterAlias: null,
        requestedAt: "2026-10-22T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "community.mention",
      eventType: "social.friend_request",
      contextRoute: "dm-requests",
      contextParams: { friendRequestId },
      dedupeKey: `social.friend_request:${friendRequestId}`,
      payload: { title: "新的好友申请", body: "有人 请求添加你为好友" },
    });
    expect(
      socialFriendAcceptedNotification({
        ownerUserId: owner,
        friendRequestId,
        accepterPublicProfileId: profileId,
        accepterAlias: "Bob",
        acceptedAt: "2026-10-22T00:00:00.000Z",
      }),
    ).toMatchObject({
      contextRoute: "user-profile",
      contextParams: { publicProfileId: profileId },
      dedupeKey: `social.friend_accepted:${friendRequestId}`,
      payload: { title: "Bob 已接受你的好友申请" },
    });
    expect(formatBeijingMinute("2026-12-31T16:00:00.000Z")).toBe(
      "2027-01-01 00:00",
    );
  });
});

describe("Decision 0177 notification inbox service", () => {
  it("writes rows but never claims or pushes while the emit switch is off", async () => {
    const repository = repositoryFake([claim()]);
    const { push, owner } = pushFake();
    const service = createNotificationInboxService({
      repository,
      push,
      emit: false,
      logger,
    });
    const result = await service.runOnce(new AbortController().signal);
    expect(result).toMatchObject({
      kind: "completed",
      produced,
      staleSettled: 3,
      pushClaimed: null,
      pushSent: 0,
      saturated: false,
    });
    expect(repository.mocks.produceLaunch2).toHaveBeenCalledOnce();
    expect(repository.mocks.claimPushes).not.toHaveBeenCalled();
    expect(owner).toEqual([]);
  });

  it("does not claim without a composed push channel", async () => {
    const repository = repositoryFake([claim()]);
    const service = createNotificationInboxService({
      repository,
      push: null,
      emit: true,
      logger,
    });
    await service.runOnce(new AbortController().signal);
    const unavailable = createNotificationInboxService({
      repository,
      push: pushFake(false).push,
      emit: true,
      logger,
    });
    await unavailable.runOnce(new AbortController().signal);
    expect(repository.mocks.claimPushes).not.toHaveBeenCalled();
  });

  it("pushes each claimed row once with the four-key pointer while emit is on", async () => {
    const instanceId = randomUUID();
    const graduation = claim({
      eventType: "launch.graduated",
      entityRef: `launch2Instance:${instanceId}`,
      contextRoute: "launch2-instance",
      dedupeKey: `launch.graduated:${instanceId}`,
    });
    const request = claim();
    const broken = claim({ entityRef: "broken" });
    const repository = repositoryFake([graduation, request, broken]);
    const { push, owner } = pushFake();
    const warn = vi.fn();
    const service = createNotificationInboxService({
      repository,
      push,
      emit: true,
      logger: { warn },
    });
    const result = await service.runOnce(new AbortController().signal);
    expect(result).toMatchObject({ pushClaimed: 3, pushSent: 2 });
    expect(owner).toEqual([
      expect.objectContaining({
        ownerUserId: graduation.ownerUserId,
        eventType: "launch_graduated",
        entityRef: `launch2Instance:${instanceId}`,
        contextRoute: "launch2-instance",
        eventKey: `inbox:launch.graduated:${instanceId}`,
      }),
      expect.objectContaining({
        eventType: "social_friend_request",
        contextRoute: "dm-requests",
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "NOTIFICATION_INBOX_PUSH_FAILED",
      }),
      "LOOP notification inbox push was not dispatched",
    );
  });

  it("reports a full push batch as saturated and stops on abort", async () => {
    const claims = Array.from({ length: notificationInboxPushBatch }, () =>
      claim(),
    );
    const service = createNotificationInboxService({
      repository: repositoryFake(claims),
      push: pushFake().push,
      emit: true,
      logger,
    });
    await expect(
      service.runOnce(new AbortController().signal),
    ).resolves.toMatchObject({ saturated: true });
    const controller = new AbortController();
    controller.abort();
    await expect(service.runOnce(controller.signal)).resolves.toEqual({
      kind: "aborted",
    });
  });
});

describe("Decision 0177 notification inbox worker loop", () => {
  it("backs off on a failed pass and keeps running", async () => {
    const controller = new AbortController();
    let calls = 0;
    const backoff = vi.fn();
    const worker = createNotificationInboxWorker({
      service: {
        runOnce: () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error("db down"));
          controller.abort();
          return Promise.resolve({ kind: "aborted" as const });
        },
      },
      intervalMs: 1_000,
      onInfrastructureBackoff: backoff,
    });
    await worker.run(controller.signal);
    expect(calls).toBe(2);
    expect(backoff).toHaveBeenCalledWith({
      reasonCode: "notification_inbox_unavailable",
      consecutiveFailureCount: 1,
      retryDelayMs: 1_000,
    });
  });
});
