import { describe, expect, it, vi } from "vitest";

import { createCommunityChannelSyncWorker } from "../src/community-channel-sync-worker.js";
import type {
  CommunityChannelSyncJobRecord,
  CommunityChannelSyncRepository,
} from "../src/features/communication/communication-repository.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  type StreamCommunityChannelGateway,
} from "../src/integrations/stream/channel-gateway.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamChannelId = `loop_community_${communityId.replaceAll("-", "")}`;
const creatorStreamUserId = `loop_${ownerUserId.replaceAll("-", "")}`;

function job(
  overrides: Partial<CommunityChannelSyncJobRecord> = {},
): CommunityChannelSyncJobRecord {
  return Object.freeze({
    communityId,
    ownerUserId,
    streamChannelId,
    channelCreatedByStreamUserId: creatorStreamUserId,
    memberStreamUserId: creatorStreamUserId,
    kind: "add" as const,
    attempts: 1,
    channelProvisioned: true,
    channelName: "Frog Holders",
    memberCap: 3_000,
    syncedMemberCount: 10,
    ...overrides,
  });
}

function repositoryFake(jobs: readonly CommunityChannelSyncJobRecord[]): {
  readonly repository: CommunityChannelSyncRepository;
  readonly claimDueJobs: ReturnType<typeof vi.fn>;
  readonly markChannelProvisioned: ReturnType<typeof vi.fn>;
  readonly completeJob: ReturnType<typeof vi.fn>;
  readonly retryJob: ReturnType<typeof vi.fn>;
  readonly failJob: ReturnType<typeof vi.fn>;
} {
  let served = false;
  const claimDueJobs = vi.fn(() => {
    if (served) {
      return Promise.resolve([]);
    }
    served = true;
    return Promise.resolve(jobs);
  });
  const markChannelProvisioned = vi.fn(() => Promise.resolve());
  const completeJob = vi.fn(() => Promise.resolve());
  const retryJob = vi.fn(() => Promise.resolve());
  const failJob = vi.fn(() => Promise.resolve());
  return {
    repository: {
      claimDueJobs,
      markChannelProvisioned,
      completeJob,
      retryJob,
      failJob,
    },
    claimDueJobs,
    markChannelProvisioned,
    completeJob,
    retryJob,
    failJob,
  };
}

type ChannelMock = ReturnType<typeof vi.fn>;

function projection() {
  return {
    channelId: streamChannelId,
    streamCid: `messaging:${streamChannelId}`,
    memberCount: 11,
  };
}

function gatewayMocks(
  overrides: {
    readonly upsertCommunityChannel?: ChannelMock;
    readonly addMembers?: ChannelMock;
    readonly removeMembers?: ChannelMock;
  } = {},
): {
  readonly gateway: StreamCommunityChannelGateway;
  readonly upsertCommunityChannel: ChannelMock;
  readonly addMembers: ChannelMock;
  readonly removeMembers: ChannelMock;
} {
  const upsertCommunityChannel =
    overrides.upsertCommunityChannel ??
    vi.fn(() => Promise.resolve(projection()));
  const addMembers =
    overrides.addMembers ?? vi.fn(() => Promise.resolve(projection()));
  const removeMembers =
    overrides.removeMembers ?? vi.fn(() => Promise.resolve(projection()));
  return {
    gateway: {
      upsertCommunityChannel,
      addMembers,
      removeMembers,
    } as unknown as StreamCommunityChannelGateway,
    upsertCommunityChannel,
    addMembers,
    removeMembers,
  };
}

describe("community channel sync worker lane", () => {
  it("adds one member with exactly one provider call", async () => {
    const { repository, completeJob, retryJob } = repositoryFake([job()]);
    const { gateway, addMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    const result = await worker.runOnce();

    expect(result).toMatchObject({
      kind: "completed",
      claimedCount: 1,
      succeededCount: 1,
      retriedCount: 0,
      failedCount: 0,
    });
    expect(addMembers).toHaveBeenCalledTimes(1);
    expect(addMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: streamChannelId,
        actingStreamUserId: creatorStreamUserId,
        memberStreamUserIds: [creatorStreamUserId],
      }),
    );
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        memberState: "synced",
        channelState: "created",
      }),
    );
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("provisions the channel before the first add and never twice", async () => {
    const { repository, markChannelProvisioned, completeJob } = repositoryFake([
      job({ channelProvisioned: false }),
    ]);
    const { gateway, upsertCommunityChannel, addMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(upsertCommunityChannel).toHaveBeenCalledTimes(1);
    expect(markChannelProvisioned).toHaveBeenCalledTimes(1);
    expect(addMembers).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ memberState: "synced" }),
    );
  });

  it("treats an already-present member as a completed add (idempotent)", async () => {
    const { repository, completeJob } = repositoryFake([job()]);
    // Stream returns success for a member that is already in the channel; the
    // gateway does not compare an exact member set for a community channel.
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.resolve({
          channelId: streamChannelId,
          streamCid: `messaging:${streamChannelId}`,
          memberCount: 10,
        }),
      ),
    });
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ memberState: "synced" }),
    );
  });

  it("treats a removal of a non-member as a completed remove", async () => {
    const { repository, completeJob } = repositoryFake([
      job({ kind: "remove" }),
    ]);
    const { gateway, removeMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(removeMembers).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        memberState: "removed",
        channelState: "created",
      }),
    );
  });

  it("skips the provider entirely when removing from an unprovisioned channel", async () => {
    const { repository, completeJob } = repositoryFake([
      job({ kind: "remove", channelProvisioned: false }),
    ]);
    const { gateway, upsertCommunityChannel, removeMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(removeMembers).not.toHaveBeenCalled();
    expect(upsertCommunityChannel).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ memberState: "removed" }),
    );
  });

  it("parks a member as capacityPending at the channel member cap", async () => {
    const { repository, completeJob } = repositoryFake([
      job({ memberCap: 10, syncedMemberCount: 10 }),
    ]);
    const { gateway, addMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(addMembers).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        memberState: "capacityPending",
        channelState: "capacityPending",
      }),
    );
  });

  it("moves an unknown provider result to reconciling with a bounded backoff", async () => {
    const { repository, retryJob, completeJob, failJob } = repositoryFake([
      job({ attempts: 3 }),
    ]);
    const { gateway, addMembers } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.reject(new StreamChannelGatewayUnavailableError()),
      ),
    });
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ retriedCount: 1, succeededCount: 0 });
    expect(addMembers).toHaveBeenCalledTimes(1);
    expect(retryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "stream_channel_sync_unavailable",
        retryDelaySeconds: 20,
      }),
    );
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });

  it("caps the retry backoff", async () => {
    const { repository, retryJob } = repositoryFake([job({ attempts: 9 })]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.reject(new StreamChannelGatewayUnavailableError()),
      ),
    });
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(retryJob).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelaySeconds: 300 }),
    );
  });

  it("fails the job terminally once the attempt budget is exhausted", async () => {
    const { repository, failJob, retryJob } = repositoryFake([
      job({ attempts: 10 }),
    ]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.reject(new StreamChannelGatewayUnavailableError()),
      ),
    });
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ failedCount: 1 });
    expect(failJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_channel_sync_exhausted" }),
    );
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("fails the job terminally on an authoritative projection mismatch", async () => {
    const { repository, failJob } = repositoryFake([job()]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.reject(new StreamChannelProjectionMismatchError()),
      ),
    });
    const worker = createCommunityChannelSyncWorker({ repository, gateway });

    await worker.runOnce();

    expect(failJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "stream_channel_projection_mismatch",
      }),
    );
  });

  it("performs no work and no provider call once aborted", async () => {
    const { repository, claimDueJobs } = repositoryFake([job()]);
    const { gateway, addMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({ repository, gateway });
    const controller = new AbortController();
    controller.abort();

    const result = await worker.runOnce(controller.signal);

    expect(result.kind).toBe("aborted");
    expect(claimDueJobs).not.toHaveBeenCalled();
    expect(addMembers).not.toHaveBeenCalled();
  });

  it("uses one stable worker identity for its leases", () => {
    const { repository } = repositoryFake([]);
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway: gatewayMocks().gateway,
    });
    expect(worker.workerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
