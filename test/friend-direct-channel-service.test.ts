import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ChatOperationResource } from "../src/features/communication/chat-channel-contract.js";
import {
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  type ChatChannelService,
} from "../src/features/communication/chat-channel-service.js";
import {
  createFriendDirectChannelService,
  FRIEND_DIRECT_CHANNEL_BACKFILL_LIMIT,
  FRIEND_DIRECT_CHANNEL_MAX_ATTEMPTS,
  friendDirectChannelRetryDelaySeconds,
  type FriendDirectChannelJobRecord,
  type FriendDirectChannelJobRepository,
  type FriendDirectChannelParticipant,
} from "../src/features/communication/friend-direct-channel-service.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";

const low = "00000000-0000-4000-8000-000000000001";
const high = "00000000-0000-4000-8000-000000000002";
const lowProfile = "10000000-0000-4000-8000-000000000001";
const highProfile = "10000000-0000-4000-8000-000000000002";
const workerId = "20000000-0000-4000-8000-000000000001";

function job(
  overrides: Partial<FriendDirectChannelJobRecord> = {},
): FriendDirectChannelJobRecord {
  return {
    userIdLow: low,
    userIdHigh: high,
    ownerUserId: high,
    source: "accept",
    attempts: 1,
    operationId: null,
    operationOwnerUserId: null,
    ...overrides,
  };
}

function resource(
  status: ChatOperationResource["status"],
  error: string | null = null,
): ChatOperationResource {
  const terminal =
    status === "succeeded" ||
    status === "failed" ||
    status === "operator_required";
  return {
    operation_id: randomUUID(),
    kind: "direct_get_or_create",
    status,
    terminal,
    retry_after_ms: terminal ? null : 2000,
    result:
      status === "succeeded"
        ? {
            target_public_profile_id: lowProfile,
            stream_cid:
              "messaging:loop_direct_00000000000000000000000000000001",
          }
        : null,
    error: error === null ? null : { code: error },
    created_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:00.000Z",
  };
}

const participants: readonly FriendDirectChannelParticipant[] = [
  { userId: low, privyUserId: "did:privy:low", publicProfileId: lowProfile },
  { userId: high, privyUserId: "did:privy:high", publicProfileId: highProfile },
];

function harness(input: {
  readonly jobs: readonly FriendDirectChannelJobRecord[];
  readonly active?: boolean;
  readonly backfillEnabled?: boolean;
  readonly participants?: readonly FriendDirectChannelParticipant[];
}) {
  const repository = {
    enqueueBackfill: vi.fn(() => Promise.resolve(3)),
    claimDueJobs: vi.fn(() => Promise.resolve(input.jobs)),
    readParticipants: vi.fn(() =>
      Promise.resolve(input.participants ?? participants),
    ),
    hasActiveDirectChannel: vi.fn(() => Promise.resolve(input.active ?? false)),
    recordOperation: vi.fn(() => Promise.resolve(undefined)),
    completeJob: vi.fn(() => Promise.resolve(undefined)),
    retryJob: vi.fn(() => Promise.resolve(undefined)),
  } satisfies FriendDirectChannelJobRepository;
  const chat = {
    getOrCreateDirect: vi.fn<ChatChannelService["getOrCreateDirect"]>(),
    getOperation: vi.fn<ChatChannelService["getOperation"]>(),
  };
  const events: unknown[] = [];
  const service = createFriendDirectChannelService({
    repository,
    chat,
    backfillEnabled: input.backfillEnabled ?? false,
    workerId,
    onEvent: (event) => events.push(event),
  });
  return { repository, chat, service, events };
}

const signal = new AbortController().signal;

describe("friend_direct_channel lane (Decision 0172)", () => {
  it("runs the route's get-or-create for the accepter and settles succeeded", async () => {
    const h = harness({ jobs: [job()] });
    h.chat.getOrCreateDirect.mockResolvedValue(resource("succeeded"));

    const result = await h.service.runOnce(signal);

    expect(result).toEqual({
      kind: "completed",
      backfillEnqueued: null,
      claimed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
      retried: 0,
    });
    expect(h.repository.enqueueBackfill).not.toHaveBeenCalled();
    const call = h.chat.getOrCreateDirect.mock.calls[0]?.[0];
    if (call === undefined) {
      throw new Error("expected a get-or-create call");
    }
    expect(call.principal).toEqual({
      userId: high,
      privyUserId: "did:privy:high",
      streamUserId: deriveStreamUserId(high),
    });
    expect(call.body).toEqual({ target_public_profile_id: lowProfile });
    expect(h.repository.recordOperation).toHaveBeenCalledWith({
      userIdLow: low,
      userIdHigh: high,
      workerId,
      operationId: call.operationId,
      operationOwnerUserId: high,
    });
    expect(h.repository.completeJob).toHaveBeenCalledWith({
      userIdLow: low,
      userIdHigh: high,
      workerId,
      state: "succeeded",
      errorCode: null,
    });
  });

  it("does not call Stream when the pair already has an active channel (the app won)", async () => {
    const h = harness({ jobs: [job()], active: true });

    await h.service.runOnce(signal);

    expect(h.chat.getOrCreateDirect).not.toHaveBeenCalled();
    expect(h.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ state: "succeeded" }),
    );
  });

  it("falls back to the other direction on a refusal, then skips when both refuse", async () => {
    const h = harness({ jobs: [job()] });
    h.chat.getOrCreateDirect
      .mockRejectedValueOnce(new ChatChannelTargetUnavailableError())
      .mockResolvedValueOnce(resource("succeeded"));

    await h.service.runOnce(signal);

    expect(h.chat.getOrCreateDirect).toHaveBeenCalledTimes(2);
    expect(h.chat.getOrCreateDirect.mock.calls[1]?.[0].principal.userId).toBe(
      low,
    );
    expect(h.chat.getOrCreateDirect.mock.calls[1]?.[0].body).toEqual({
      target_public_profile_id: highProfile,
    });
    expect(h.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ state: "succeeded" }),
    );

    const refused = harness({ jobs: [job()] });
    refused.chat.getOrCreateDirect.mockRejectedValue(
      new ChatChannelTargetUnavailableError(),
    );
    const result = await refused.service.runOnce(signal);
    expect(result).toMatchObject({ skipped: 1, failed: 0 });
    expect(refused.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "skipped",
        errorCode: "direct_target_unavailable",
      }),
    );
  });

  it("skips without calling Stream when neither account has a public profile target", async () => {
    const h = harness({
      jobs: [job()],
      participants: [
        { userId: low, privyUserId: "did:privy:low", publicProfileId: null },
        { userId: high, privyUserId: "did:privy:high", publicProfileId: null },
      ],
    });
    await h.service.runOnce(signal);
    expect(h.chat.getOrCreateDirect).not.toHaveBeenCalled();
    expect(h.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ state: "skipped" }),
    );
  });

  it("keeps a non-terminal operation and polls it next time instead of creating another", async () => {
    const pending = harness({ jobs: [job()] });
    pending.chat.getOrCreateDirect.mockResolvedValue(resource("reconciling"));
    const first = await pending.service.runOnce(signal);
    expect(first).toMatchObject({ retried: 1 });
    expect(pending.repository.retryJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: null, retryDelaySeconds: 15 }),
    );

    const operationId = randomUUID();
    const poll = harness({
      jobs: [job({ attempts: 2, operationId, operationOwnerUserId: high })],
    });
    poll.chat.getOperation.mockResolvedValue(resource("succeeded"));
    await poll.service.runOnce(signal);
    expect(poll.chat.getOrCreateDirect).not.toHaveBeenCalled();
    expect(poll.chat.getOperation.mock.calls[0]?.[0]).toMatchObject({
      operationId,
      principal: { userId: high },
    });
    expect(poll.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ state: "succeeded" }),
    );
  });

  it("starts over when the recorded operation never committed", async () => {
    const h = harness({
      jobs: [
        job({
          attempts: 2,
          operationId: randomUUID(),
          operationOwnerUserId: high,
        }),
      ],
    });
    h.chat.getOperation.mockRejectedValue(new ChatOperationNotFoundError());
    h.chat.getOrCreateDirect.mockResolvedValue(resource("succeeded"));
    await h.service.runOnce(signal);
    expect(h.repository.recordOperation).toHaveBeenNthCalledWith(1, {
      userIdLow: low,
      userIdHigh: high,
      workerId,
      operationId: null,
      operationOwnerUserId: null,
    });
    expect(h.chat.getOrCreateDirect).toHaveBeenCalledTimes(1);
  });

  it("records a terminal chat failure as failed and never retries it", async () => {
    const h = harness({ jobs: [job()] });
    h.chat.getOrCreateDirect.mockResolvedValue(
      resource("operator_required", "stream_channel_projection_mismatch"),
    );
    const result = await h.service.runOnce(signal);
    expect(result).toMatchObject({ failed: 1 });
    expect(h.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        errorCode: "stream_channel_projection_mismatch",
      }),
    );
    expect(h.events).toEqual([
      {
        kind: "job_failed",
        errorCode: "stream_channel_projection_mismatch",
        attempts: 1,
      },
    ]);
  });

  it("backs off on an unavailable dependency and fails after the attempt cap", async () => {
    const h = harness({ jobs: [job({ attempts: 3 })] });
    h.chat.getOrCreateDirect.mockRejectedValue(
      new ChatChannelUnavailableError(),
    );
    const result = await h.service.runOnce(signal);
    expect(result).toMatchObject({ retried: 1 });
    expect(h.repository.retryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "direct_channel_unavailable",
        retryDelaySeconds: friendDirectChannelRetryDelaySeconds(3),
      }),
    );

    const capped = harness({
      jobs: [job({ attempts: FRIEND_DIRECT_CHANNEL_MAX_ATTEMPTS })],
    });
    capped.chat.getOrCreateDirect.mockRejectedValue(
      new ChatChannelUnavailableError(),
    );
    expect(await capped.service.runOnce(signal)).toMatchObject({ failed: 1 });
    expect(capped.repository.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        errorCode: "direct_channel_unavailable",
      }),
    );
  });

  it("enqueues a bounded backfill batch only when the flag is on", async () => {
    const h = harness({ jobs: [], backfillEnabled: true });
    const result = await h.service.runOnce(signal);
    expect(h.repository.enqueueBackfill).toHaveBeenCalledWith({
      limit: FRIEND_DIRECT_CHANNEL_BACKFILL_LIMIT,
    });
    expect(FRIEND_DIRECT_CHANNEL_BACKFILL_LIMIT).toBe(200);
    expect(result).toMatchObject({ backfillEnqueued: 3, claimed: 0 });
  });

  it("does nothing once aborted", async () => {
    const h = harness({ jobs: [job()] });
    const controller = new AbortController();
    controller.abort();
    expect(await h.service.runOnce(controller.signal)).toEqual({
      kind: "aborted",
    });
    expect(h.repository.claimDueJobs).not.toHaveBeenCalled();
  });

  it("caps the retry delay", () => {
    expect(friendDirectChannelRetryDelaySeconds(1)).toBe(5);
    expect(friendDirectChannelRetryDelaySeconds(2)).toBe(10);
    expect(friendDirectChannelRetryDelaySeconds(50)).toBe(600);
  });
});
