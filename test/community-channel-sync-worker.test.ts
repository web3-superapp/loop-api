import { describe, expect, it, vi } from "vitest";

import { createCommunityChannelSyncWorker } from "../src/community-channel-sync-worker.js";
import {
  CommunicationRepositoryUnavailableError,
  type CommunityChannelSyncJobRecord,
  type CommunityChannelSyncRepository,
} from "../src/features/communication/communication-repository.js";
import type {
  CommunityPersonaService,
  CommunityPersonaSyncResult,
} from "../src/features/communication/community-persona-service.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
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

const personaId = "b5d6f0c2-2d1e-4c3a-9f6b-7a8c9d0e1f2a";
const personaAlias = "Harbor-4821";
const leaseToken = "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

function personaRecord() {
  return Object.freeze({
    personaId,
    communityId,
    ownerUserId,
    alias: personaAlias,
    aliasVersion: 1 as const,
    projectionState: "pending" as const,
    projectionAttempts: 0,
  });
}

function personasFake(
  overrides: Partial<CommunityPersonaService> = {},
  syncResult: CommunityPersonaSyncResult = {
    claimedCount: 0,
    confirmedCount: 0,
    deferredCount: 0,
  },
) {
  const ensurePersona = vi.fn(() =>
    Promise.resolve({ persona: personaRecord(), leaseToken }),
  );
  const confirmProjection = vi.fn(() => Promise.resolve(true));
  const requestProjection = vi.fn(() => Promise.resolve(true));
  const resetProjectionForMember = vi.fn(() => Promise.resolve());
  const projectPersona = vi.fn(() => Promise.resolve("confirmed" as const));
  const syncPendingProjections = vi.fn(() => Promise.resolve(syncResult));
  const personas: CommunityPersonaService = {
    ensurePersona,
    confirmProjection,
    requestProjection,
    resetProjectionForMember,
    projectPersona,
    syncPendingProjections,
    ...overrides,
  };
  return {
    personas,
    ensurePersona,
    confirmProjection,
    requestProjection,
    resetProjectionForMember,
    syncPendingProjections,
  };
}

function projection(confirmedPersonaStreamUserIds: readonly string[] = []) {
  return {
    channelId: streamChannelId,
    streamCid: `messaging:${streamChannelId}`,
    memberCount: 11,
    confirmedPersonaStreamUserIds,
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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

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
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

    await worker.runOnce();

    expect(failJob).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "stream_channel_projection_mismatch",
      }),
    );
  });

  it("fails the job terminally on a deterministic provider rejection", async () => {
    const { repository, failJob, retryJob } = repositoryFake([
      job({ attempts: 0 }),
    ]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.reject(new StreamChannelRequestRejectedError()),
      ),
    });
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ failedCount: 1, retriedCount: 0 });
    expect(failJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_channel_request_rejected" }),
    );
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("performs no work and no provider call once aborted", async () => {
    const { repository, claimDueJobs } = repositoryFake([job()]);
    const { gateway, addMembers } = gatewayMocks();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personasFake().personas,
    });
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
      personas: personasFake().personas,
    });
    expect(worker.workerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates the persona before the add and attaches it as member custom", async () => {
    const { repository, completeJob } = repositoryFake([job()]);
    const { gateway, addMembers } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.resolve(projection([creatorStreamUserId])),
      ),
    });
    const personas = personasFake();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ succeededCount: 1 });
    expect(personas.ensurePersona).toHaveBeenCalledWith({
      communityId,
      ownerUserId,
    });
    expect(personas.ensurePersona.mock.invocationCallOrder[0]).toBeLessThan(
      addMembers.mock.invocationCallOrder[0] ?? 0,
    );
    expect(addMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        memberPersonas: [
          {
            streamUserId: creatorStreamUserId,
            personaId,
            alias: personaAlias,
          },
        ],
      }),
    );
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ memberState: "synced" }),
    );
    expect(personas.confirmProjection).toHaveBeenCalledWith({
      personaId,
      leaseToken,
    });
    expect(personas.requestProjection).not.toHaveBeenCalled();
  });

  it("leaves the persona pending when the add response did not echo it", async () => {
    const { repository, completeJob } = repositoryFake([job()]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() => Promise.resolve(projection([]))),
    });
    const personas = personasFake();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ succeededCount: 1 });
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ memberState: "synced" }),
    );
    expect(personas.confirmProjection).not.toHaveBeenCalled();
    expect(personas.requestProjection).toHaveBeenCalledWith({
      persona: personaRecord(),
      leaseToken,
    });
  });

  it("retries under community_persona_unavailable without touching Stream or the attempt budget when persona generation fails (M1)", async () => {
    for (const attempts of [1, 10, 11]) {
      const { repository, retryJob, completeJob, failJob } = repositoryFake([
        job({ attempts }),
      ]);
      const { gateway, addMembers } = gatewayMocks();
      const personas = personasFake({
        ensurePersona: vi.fn(() =>
          Promise.reject(new CommunicationRepositoryUnavailableError()),
        ),
      });
      const worker = createCommunityChannelSyncWorker({
        repository,
        gateway,
        personas: personas.personas,
      });

      const result = await worker.runOnce();

      expect(result).toMatchObject({
        retriedCount: 1,
        succeededCount: 0,
        failedCount: 0,
      });
      expect(addMembers).not.toHaveBeenCalled();
      expect(completeJob).not.toHaveBeenCalled();
      expect(failJob).not.toHaveBeenCalled();
      expect(retryJob).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "community_persona_unavailable" }),
      );
    }
  });

  it("still treats an unknown persona-generation failure as a Stream-lane retry", async () => {
    const { repository, retryJob } = repositoryFake([job()]);
    const { gateway } = gatewayMocks();
    const personas = personasFake({
      ensurePersona: vi.fn(() => Promise.reject(new Error("unexpected"))),
    });
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    await worker.runOnce();

    expect(retryJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_channel_sync_unavailable" }),
    );
  });

  it("keeps a completed add as succeeded and logs when persona bookkeeping fails", async () => {
    const { repository, completeJob, retryJob } = repositoryFake([job()]);
    const { gateway } = gatewayMocks({
      addMembers: vi.fn(() =>
        Promise.resolve(projection([creatorStreamUserId])),
      ),
    });
    const personas = personasFake({
      confirmProjection: vi.fn(() =>
        Promise.reject(new CommunicationRepositoryUnavailableError()),
      ),
    });
    const warn = vi.fn();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
      logger: { warn },
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ succeededCount: 1, retriedCount: 0 });
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(retryJob).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      {
        communityId,
        ownerUserId,
        write: "confirm",
        errorName: "CommunicationRepositoryUnavailableError",
      },
      "Community persona bookkeeping failed after a completed sync job",
    );
  });

  it("resets the member's persona projection after a remove", async () => {
    const { repository } = repositoryFake([job({ kind: "remove" })]);
    const { gateway } = gatewayMocks();
    const personas = personasFake();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    await worker.runOnce();

    expect(personas.ensurePersona).not.toHaveBeenCalled();
    expect(personas.resetProjectionForMember).toHaveBeenCalledWith({
      communityId,
      ownerUserId,
    });
  });

  it("does not generate a persona for a member parked at the cap", async () => {
    const { repository } = repositoryFake([
      job({ memberCap: 10, syncedMemberCount: 10 }),
    ]);
    const { gateway } = gatewayMocks();
    const personas = personasFake();
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    await worker.runOnce();

    expect(personas.ensurePersona).not.toHaveBeenCalled();
  });

  it("runs the persona lane after the jobs and reports its counts", async () => {
    const { repository } = repositoryFake([]);
    const { gateway } = gatewayMocks();
    const personas = personasFake(
      {},
      { claimedCount: 3, confirmedCount: 2, deferredCount: 1 },
    );
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({
      kind: "completed",
      claimedCount: 0,
      personaClaimedCount: 3,
      personaConfirmedCount: 2,
      personaDeferredCount: 1,
    });
    expect(personas.syncPendingProjections).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it("treats a persona lane claim failure as infrastructure backoff", async () => {
    const { repository } = repositoryFake([]);
    const { gateway } = gatewayMocks();
    const personas = personasFake({
      syncPendingProjections: vi.fn(() => Promise.reject(new Error("db down"))),
    });
    const worker = createCommunityChannelSyncWorker({
      repository,
      gateway,
      personas: personas.personas,
    });

    await expect(worker.runOnce()).rejects.toMatchObject({
      code: "community_channel_sync_unavailable",
    });
  });
});
