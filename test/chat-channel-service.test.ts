import { describe, expect, it, vi } from "vitest";

import { digestCreateChatGroupRequest } from "../src/features/communication/chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictRepositoryError,
  ChatChannelTargetUnavailableRepositoryError,
  type ChatChannelExpectation,
  type ChatChannelRepository,
  type ChatOperationRecord,
} from "../src/features/communication/chat-channel-repository.js";
import {
  ChatChannelIdempotencyConflictError,
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  InvalidChatChannelServiceRequestError,
  createChatChannelService,
  createUnavailableChatChannelService,
} from "../src/features/communication/chat-channel-service.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  type StreamChannelGateway,
} from "../src/integrations/stream/channel-gateway.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const friendUserId = "22222222-2222-4222-8222-222222222222";
const secondFriendUserId = "33333333-3333-4333-8333-333333333333";
const firstPublicProfileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondPublicProfileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const canonicalDirectOperationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const groupId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:chat-channel-owner",
  streamUserId: deriveStreamUserId(ownerUserId),
});
const createdAt = "2026-08-31T02:00:00.000Z";
const submittedAt = "2026-08-31T02:00:01.000Z";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function groupOperation(
  overrides: Partial<ChatOperationRecord> = {},
): ChatOperationRecord {
  return Object.freeze({
    operationId,
    ownerUserId,
    kind: "group_create",
    requestDigest: "1".repeat(64),
    status: "pending",
    channelId: "loop_group_cccccccccccc4ccc",
    groupId,
    groupName: "Desk",
    friendPublicProfileIds: Object.freeze([
      firstPublicProfileId,
      secondPublicProfileId,
    ]),
    targetPublicProfileId: null,
    errorCode: null,
    attemptStartedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

function directOperation(
  overrides: Partial<ChatOperationRecord> = {},
): ChatOperationRecord {
  return Object.freeze({
    operationId,
    ownerUserId,
    kind: "direct_get_or_create",
    requestDigest: "2".repeat(64),
    status: "pending",
    channelId: "loop_direct_cccccccccccc4ccc",
    groupId: null,
    groupName: null,
    friendPublicProfileIds: Object.freeze([]),
    targetPublicProfileId: firstPublicProfileId,
    errorCode: null,
    attemptStartedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

const groupExpectation = Object.freeze({
  operationId,
  kind: "group",
  channelId: "loop_group_cccccccccccc4ccc",
  createdByUserId: ownerUserId,
  memberUserIds: Object.freeze([ownerUserId, friendUserId, secondFriendUserId]),
  name: "Desk",
}) satisfies ChatChannelExpectation;

const directExpectation = Object.freeze({
  operationId,
  kind: "direct",
  channelId: "loop_direct_cccccccccccc4ccc",
  createdByUserId: ownerUserId,
  memberUserIds: Object.freeze([ownerUserId, friendUserId]),
  name: null,
}) satisfies ChatChannelExpectation;

const canonicalDirectExpectation = Object.freeze({
  ...directExpectation,
  operationId: canonicalDirectOperationId,
  createdByUserId: friendUserId,
}) satisfies ChatChannelExpectation;

function dependencies() {
  const preparedGroup = groupOperation();
  const preparedDirect = directOperation();
  const succeededGroup = groupOperation({
    status: "succeeded",
    attemptStartedAt: submittedAt,
    updatedAt: "2026-08-31T02:00:02.000Z",
  });
  const succeededDirect = directOperation({
    status: "succeeded",
    attemptStartedAt: submittedAt,
    updatedAt: "2026-08-31T02:00:02.000Z",
  });
  const reconcilingGroup = groupOperation({
    status: "reconciling",
    attemptStartedAt: submittedAt,
    updatedAt: submittedAt,
  });
  const failedGroup = groupOperation({
    status: "failed",
    attemptStartedAt: submittedAt,
    errorCode: "stream_channel_not_created",
    updatedAt: "2026-08-31T02:02:00.000Z",
  });
  const operatorGroup = groupOperation({
    status: "operator_required",
    attemptStartedAt: submittedAt,
    errorCode: "stream_channel_projection_mismatch",
    updatedAt: "2026-08-31T02:00:10.000Z",
  });

  const prepareGroupOperation = vi.fn<
    ChatChannelRepository["prepareGroupOperation"]
  >(() => Promise.resolve(preparedGroup));
  const prepareDirectOperation = vi.fn<
    ChatChannelRepository["prepareDirectOperation"]
  >(() => Promise.resolve(preparedDirect));
  const claimSubmission = vi.fn<ChatChannelRepository["claimSubmission"]>(() =>
    Promise.resolve(groupExpectation),
  );
  const refreshOperation = vi.fn<ChatChannelRepository["refreshOperation"]>(
    () => Promise.resolve(preparedGroup),
  );
  const claimReconciliation = vi.fn<
    ChatChannelRepository["claimReconciliation"]
  >(() => Promise.resolve(groupExpectation));
  const markReconciling = vi.fn<ChatChannelRepository["markReconciling"]>(() =>
    Promise.resolve(reconcilingGroup),
  );
  const markSucceeded = vi.fn<ChatChannelRepository["markSucceeded"]>(() =>
    Promise.resolve(succeededGroup),
  );
  const markFailed = vi.fn<ChatChannelRepository["markFailed"]>(() =>
    Promise.resolve(failedGroup),
  );
  const markOperatorRequired = vi.fn<
    ChatChannelRepository["markOperatorRequired"]
  >(() => Promise.resolve(operatorGroup));
  const findCanonicalDirectOperation = vi.fn<
    ChatChannelRepository["findCanonicalDirectOperation"]
  >(() => Promise.resolve(null));
  const findOperation = vi.fn<ChatChannelRepository["findOperation"]>(() =>
    Promise.resolve(reconcilingGroup),
  );
  const repository = {
    prepareGroupOperation,
    prepareDirectOperation,
    refreshOperation,
    claimSubmission,
    claimReconciliation,
    markReconciling,
    markSucceeded,
    markFailed,
    markOperatorRequired,
    findCanonicalDirectOperation,
    findOperation,
  } satisfies ChatChannelRepository;

  const upsertFixedMessagingChannel = vi.fn<
    StreamChannelGateway["upsertFixedMessagingChannel"]
  >(() =>
    Promise.resolve({
      channelId: groupExpectation.channelId,
      streamCid: `messaging:${groupExpectation.channelId}`,
      kind: "group",
      memberStreamUserIds: groupExpectation.memberUserIds
        .map(deriveStreamUserId)
        .sort(),
      name: "Desk",
    }),
  );
  const readFixedMessagingChannel = vi.fn<
    StreamChannelGateway["readFixedMessagingChannel"]
  >(() =>
    Promise.resolve({
      status: "found",
      channel: {
        channelId: groupExpectation.channelId,
        streamCid: `messaging:${groupExpectation.channelId}`,
        kind: "group",
        memberStreamUserIds: groupExpectation.memberUserIds
          .map(deriveStreamUserId)
          .sort(),
        name: "Desk",
      },
    }),
  );
  const gateway = {
    upsertFixedMessagingChannel,
    readFixedMessagingChannel,
  } satisfies StreamChannelGateway;
  const service = createChatChannelService({
    repository,
    gateway,
    now: () => new Date("2026-08-31T02:00:10.000Z"),
  });

  return {
    claimReconciliation,
    claimSubmission,
    failedGroup,
    findCanonicalDirectOperation,
    findOperation,
    gateway,
    markFailed,
    markOperatorRequired,
    markReconciling,
    markSucceeded,
    prepareDirectOperation,
    prepareGroupOperation,
    refreshOperation,
    readFixedMessagingChannel,
    reconcilingGroup,
    operatorGroup,
    repository,
    service,
    succeededDirect,
    succeededGroup,
    upsertFixedMessagingChannel,
  };
}

describe("Chat channel service", () => {
  it("fails closed when channel coordination is unavailable", async () => {
    const service = createUnavailableChatChannelService();
    await expect(
      service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "Desk",
          friend_public_profile_ids: [
            firstPublicProfileId,
            secondPublicProfileId,
          ],
        },
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatChannelUnavailableError);
  });

  it("persists, authorizes, creates, verifies, and completes a group in order", async () => {
    const input = dependencies();
    const requestSignal = signal();

    await expect(
      input.service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "  Desk  ",
          friend_public_profile_ids: [
            secondPublicProfileId,
            firstPublicProfileId,
          ],
        },
        signal: requestSignal,
      }),
    ).resolves.toEqual({
      operation_id: operationId,
      kind: "group_create",
      status: "succeeded",
      terminal: true,
      retry_after_ms: null,
      result: {
        group_id: groupId,
        name: "Desk",
        friend_public_profile_ids: [
          firstPublicProfileId,
          secondPublicProfileId,
        ],
        stream_cid: `messaging:${groupExpectation.channelId}`,
      },
      error: null,
      created_at: createdAt,
      updated_at: "2026-08-31T02:00:02.000Z",
    });

    expect(input.prepareGroupOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        ownerUserId,
        requestId,
        name: "Desk",
        friendPublicProfileIds: [secondPublicProfileId, firstPublicProfileId],
        requestDigest: digestCreateChatGroupRequest({
          name: "Desk",
          friend_public_profile_ids: [
            secondPublicProfileId,
            firstPublicProfileId,
          ],
        }),
      }),
    );
    expect(input.claimSubmission).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
    });
    expect(input.upsertFixedMessagingChannel).toHaveBeenCalledWith({
      channelId: groupExpectation.channelId,
      kind: "group",
      createdByStreamUserId: principal.streamUserId,
      memberStreamUserIds: groupExpectation.memberUserIds
        .map(deriveStreamUserId)
        .sort(),
      name: "Desk",
      signal: requestSignal,
    });
    expect(
      input.prepareGroupOperation.mock.invocationCallOrder[0],
    ).toBeLessThan(input.claimSubmission.mock.invocationCallOrder[0] ?? 0);
    expect(input.claimSubmission.mock.invocationCallOrder[0]).toBeLessThan(
      input.upsertFixedMessagingChannel.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      input.upsertFixedMessagingChannel.mock.invocationCallOrder[0],
    ).toBeLessThan(input.markSucceeded.mock.invocationCallOrder[0] ?? 0);
  });

  it("converges a direct command on the repository-provided fixed channel", async () => {
    const input = dependencies();
    input.claimSubmission.mockResolvedValueOnce(directExpectation);
    input.markSucceeded.mockResolvedValueOnce(input.succeededDirect);
    input.upsertFixedMessagingChannel.mockResolvedValueOnce({
      channelId: directExpectation.channelId,
      streamCid: `messaging:${directExpectation.channelId}`,
      kind: "direct",
      memberStreamUserIds: directExpectation.memberUserIds
        .map(deriveStreamUserId)
        .sort(),
    });

    const resource = await input.service.getOrCreateDirect({
      principal,
      operationId,
      requestId,
      body: { target_public_profile_id: firstPublicProfileId },
      signal: signal(),
    });

    expect(resource.result).toEqual({
      target_public_profile_id: firstPublicProfileId,
      stream_cid: `messaging:${directExpectation.channelId}`,
    });
    expect(input.upsertFixedMessagingChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: directExpectation.channelId,
        kind: "direct",
        createdByStreamUserId: principal.streamUserId,
        memberStreamUserIds: directExpectation.memberUserIds
          .map(deriveStreamUserId)
          .sort(),
      }),
    );
  });

  it("lets a direct waiter dispatch the canonical operation without a second provider write", async () => {
    const input = dependencies();
    const preparedWaiter = directOperation();
    const canonicalSucceeded = directOperation({
      operationId: canonicalDirectOperationId,
      ownerUserId: friendUserId,
      status: "succeeded",
      attemptStartedAt: submittedAt,
      updatedAt: "2026-08-31T02:00:02.000Z",
    });
    const waiterSucceeded = directOperation({
      status: "succeeded",
      updatedAt: "2026-08-31T02:00:02.000Z",
    });
    input.refreshOperation
      .mockResolvedValueOnce(preparedWaiter)
      .mockResolvedValueOnce(waiterSucceeded);
    input.claimSubmission.mockResolvedValueOnce(canonicalDirectExpectation);
    input.markSucceeded.mockResolvedValueOnce(canonicalSucceeded);
    input.upsertFixedMessagingChannel.mockResolvedValueOnce({
      channelId: canonicalDirectExpectation.channelId,
      streamCid: `messaging:${canonicalDirectExpectation.channelId}`,
      kind: "direct",
      memberStreamUserIds: canonicalDirectExpectation.memberUserIds
        .map(deriveStreamUserId)
        .sort(),
    });

    await expect(
      input.service.getOrCreateDirect({
        principal,
        operationId,
        requestId,
        body: { target_public_profile_id: firstPublicProfileId },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      status: "succeeded",
      result: { stream_cid: `messaging:${directExpectation.channelId}` },
    });
    expect(input.markSucceeded).toHaveBeenCalledWith({
      ownerUserId: friendUserId,
      operationId: canonicalDirectOperationId,
      requestId,
    });
    expect(input.upsertFixedMessagingChannel).toHaveBeenCalledOnce();
    expect(input.refreshOperation).toHaveBeenCalledTimes(2);
  });

  it("lets a direct waiter poll reconcile an in-flight canonical operation", async () => {
    const input = dependencies();
    const preparedWaiter = directOperation();
    const canonicalReconciling = directOperation({
      operationId: canonicalDirectOperationId,
      ownerUserId: friendUserId,
      status: "reconciling",
      attemptStartedAt: submittedAt,
      updatedAt: submittedAt,
    });
    const canonicalSucceeded = directOperation({
      operationId: canonicalDirectOperationId,
      ownerUserId: friendUserId,
      status: "succeeded",
      attemptStartedAt: submittedAt,
      updatedAt: "2026-08-31T02:00:02.000Z",
    });
    const waiterSucceeded = directOperation({
      status: "succeeded",
      updatedAt: "2026-08-31T02:00:02.000Z",
    });
    input.findOperation.mockResolvedValueOnce(preparedWaiter);
    input.refreshOperation
      .mockResolvedValueOnce(preparedWaiter)
      .mockResolvedValueOnce(waiterSucceeded);
    input.findCanonicalDirectOperation.mockResolvedValueOnce(
      canonicalReconciling,
    );
    input.claimReconciliation.mockResolvedValueOnce(canonicalDirectExpectation);
    input.markSucceeded.mockResolvedValueOnce(canonicalSucceeded);
    input.readFixedMessagingChannel.mockResolvedValueOnce({
      status: "found",
      channel: {
        channelId: canonicalDirectExpectation.channelId,
        streamCid: `messaging:${canonicalDirectExpectation.channelId}`,
        kind: "direct",
        memberStreamUserIds: canonicalDirectExpectation.memberUserIds
          .map(deriveStreamUserId)
          .sort(),
      },
    });

    await expect(
      input.service.getOperation({
        principal,
        operationId,
        requestId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      status: "succeeded",
      result: { stream_cid: `messaging:${directExpectation.channelId}` },
    });
    expect(input.markSucceeded).toHaveBeenCalledWith({
      ownerUserId: friendUserId,
      operationId: canonicalDirectOperationId,
      requestId,
    });
    expect(input.upsertFixedMessagingChannel).not.toHaveBeenCalled();
    expect(input.readFixedMessagingChannel).toHaveBeenCalledOnce();
  });

  it("returns a durable nonterminal operation when another request owns submission", async () => {
    const input = dependencies();
    input.claimSubmission.mockResolvedValueOnce(null);
    input.findOperation.mockResolvedValueOnce(groupOperation());

    await expect(
      input.service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "Desk",
          friend_public_profile_ids: [
            firstPublicProfileId,
            secondPublicProfileId,
          ],
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      status: "pending",
      terminal: false,
      retry_after_ms: 2_000,
      result: null,
      error: null,
    });
    expect(input.upsertFixedMessagingChannel).not.toHaveBeenCalled();
  });

  it("terminates a stale pending operation before claiming a provider write", async () => {
    const input = dependencies();
    input.refreshOperation.mockResolvedValueOnce(
      groupOperation({
        status: "failed",
        errorCode: "submission_not_started",
        updatedAt: "2026-08-31T02:00:10.000Z",
      }),
    );

    await expect(
      input.service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "Desk",
          friend_public_profile_ids: [
            firstPublicProfileId,
            secondPublicProfileId,
          ],
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      terminal: true,
      error: { code: "submission_not_started" },
    });
    expect(input.refreshOperation).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
      pendingBefore: "2026-08-31T01:59:50.000Z",
    });
    expect(input.claimSubmission).not.toHaveBeenCalled();
    expect(input.upsertFixedMessagingChannel).not.toHaveBeenCalled();
  });

  it("returns a terminal failed operation when the final eligibility recheck cancels before provider submission", async () => {
    const input = dependencies();
    input.claimSubmission.mockResolvedValueOnce(null);
    input.refreshOperation.mockResolvedValueOnce(
      directOperation({
        status: "failed",
        attemptStartedAt: null,
        errorCode: "target_unavailable",
        updatedAt: "2026-08-31T02:00:01.000Z",
      }),
    );

    await expect(
      input.service.getOrCreateDirect({
        principal,
        operationId,
        requestId,
        body: { target_public_profile_id: firstPublicProfileId },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      status: "failed",
      terminal: true,
      retry_after_ms: null,
      result: null,
      error: { code: "target_unavailable" },
    });
    expect(input.upsertFixedMessagingChannel).not.toHaveBeenCalled();
    expect(input.readFixedMessagingChannel).not.toHaveBeenCalled();
  });

  it("reconciles the same fixed ID after an ambiguous provider write", async () => {
    const input = dependencies();
    input.upsertFixedMessagingChannel.mockRejectedValueOnce(
      new StreamChannelGatewayUnavailableError(),
    );

    const resource = await input.service.createGroup({
      principal,
      operationId,
      requestId,
      body: {
        name: "Desk",
        friend_public_profile_ids: [
          firstPublicProfileId,
          secondPublicProfileId,
        ],
      },
      signal: signal(),
    });

    expect(input.markReconciling).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
    });
    expect(input.readFixedMessagingChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: groupExpectation.channelId }),
    );
    expect(input.upsertFixedMessagingChannel).toHaveBeenCalledOnce();
    expect(resource.status).toBe("succeeded");
  });

  it("holds an authoritative write-side projection mismatch for an operator", async () => {
    const input = dependencies();
    input.upsertFixedMessagingChannel.mockRejectedValueOnce(
      new StreamChannelProjectionMismatchError(),
    );

    await expect(
      input.service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "Desk",
          friend_public_profile_ids: [
            firstPublicProfileId,
            secondPublicProfileId,
          ],
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      status: "operator_required",
      terminal: true,
      error: { code: "stream_channel_projection_mismatch" },
    });
    expect(input.markOperatorRequired).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
      errorCode: "stream_channel_projection_mismatch",
    });
    expect(input.markReconciling).not.toHaveBeenCalled();
    expect(input.readFixedMessagingChannel).not.toHaveBeenCalled();
  });

  it("holds an authoritative reconciliation projection mismatch for an operator", async () => {
    const input = dependencies();
    input.findOperation.mockResolvedValue(input.reconcilingGroup);
    input.readFixedMessagingChannel.mockRejectedValueOnce(
      new StreamChannelProjectionMismatchError(),
    );

    await expect(
      input.service.getOperation({
        principal,
        operationId,
        requestId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      status: "operator_required",
      terminal: true,
      error: { code: "stream_channel_projection_mismatch" },
    });
    expect(input.markOperatorRequired).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
      errorCode: "stream_channel_projection_mismatch",
    });
  });

  it("bounds repeated reconciliation unavailability with an operator hold", async () => {
    const input = dependencies();
    const old = groupOperation({
      status: "reconciling",
      attemptStartedAt: "2026-08-31T01:55:00.000Z",
      updatedAt: "2026-08-31T01:55:00.000Z",
    });
    input.findOperation.mockResolvedValue(old);
    input.readFixedMessagingChannel.mockRejectedValueOnce(
      new StreamChannelGatewayUnavailableError(),
    );
    input.markOperatorRequired.mockResolvedValueOnce(
      groupOperation({
        status: "operator_required",
        attemptStartedAt: "2026-08-31T01:55:00.000Z",
        errorCode: "stream_reconciliation_unavailable",
        updatedAt: "2026-08-31T02:00:10.000Z",
      }),
    );

    await expect(
      input.service.getOperation({
        principal,
        operationId,
        requestId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      status: "operator_required",
      terminal: true,
      error: { code: "stream_reconciliation_unavailable" },
    });
    expect(input.markOperatorRequired).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
      errorCode: "stream_reconciliation_unavailable",
    });
  });

  it("keeps a fresh authoritative not-found result reconciling", async () => {
    const input = dependencies();
    input.findOperation.mockResolvedValue(input.reconcilingGroup);
    input.readFixedMessagingChannel.mockResolvedValueOnce({
      status: "not_found",
    });

    const resource = await input.service.getOperation({
      principal,
      operationId,
      requestId,
      signal: signal(),
    });

    expect(resource.status).toBe("reconciling");
    expect(resource.terminal).toBe(false);
    expect(input.markFailed).not.toHaveBeenCalled();
  });

  it("holds a persistently absent fixed channel for an operator after the grace window", async () => {
    const input = dependencies();
    const old = groupOperation({
      status: "reconciling",
      attemptStartedAt: "2026-08-31T01:58:00.000Z",
      updatedAt: "2026-08-31T01:58:00.000Z",
    });
    input.findOperation.mockResolvedValue(old);
    input.readFixedMessagingChannel.mockResolvedValueOnce({
      status: "not_found",
    });
    input.markOperatorRequired.mockResolvedValueOnce(
      groupOperation({
        status: "operator_required",
        attemptStartedAt: "2026-08-31T01:58:00.000Z",
        errorCode: "stream_channel_not_created",
        updatedAt: "2026-08-31T02:00:10.000Z",
      }),
    );

    await expect(
      input.service.getOperation({
        principal,
        operationId,
        requestId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({
      status: "operator_required",
      terminal: true,
      error: { code: "stream_channel_not_created" },
    });
    expect(input.markOperatorRequired).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      requestId,
      errorCode: "stream_channel_not_created",
    });
  });

  it("maps owner-bound repository conflicts and target failures", async () => {
    const conflict = dependencies();
    conflict.prepareGroupOperation.mockRejectedValueOnce(
      new ChatChannelIdempotencyConflictRepositoryError(),
    );
    await expect(
      conflict.service.createGroup({
        principal,
        operationId,
        requestId,
        body: {
          name: "Desk",
          friend_public_profile_ids: [
            firstPublicProfileId,
            secondPublicProfileId,
          ],
        },
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatChannelIdempotencyConflictError);

    const unavailable = dependencies();
    unavailable.prepareDirectOperation.mockRejectedValueOnce(
      new ChatChannelTargetUnavailableRepositoryError(),
    );
    await expect(
      unavailable.service.getOrCreateDirect({
        principal,
        operationId,
        requestId,
        body: { target_public_profile_id: firstPublicProfileId },
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatChannelTargetUnavailableError);
  });

  it("rejects invalid commands before persistence", async () => {
    const input = dependencies();
    await expect(
      input.service.createGroup({
        principal,
        operationId: operationId.toUpperCase(),
        requestId,
        body: { name: "Desk", friend_public_profile_ids: [] },
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(InvalidChatChannelServiceRequestError);
    expect(input.prepareGroupOperation).not.toHaveBeenCalled();
  });

  it("hides an operation owned by another user as not found", async () => {
    const input = dependencies();
    input.findOperation.mockResolvedValueOnce(null);
    await expect(
      input.service.getOperation({
        principal,
        operationId,
        requestId,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatOperationNotFoundError);
  });

  it("returns a terminal exact replay without another Stream write", async () => {
    const input = dependencies();
    input.prepareGroupOperation.mockResolvedValueOnce(input.succeededGroup);

    const resource = await input.service.createGroup({
      principal,
      operationId,
      requestId,
      body: {
        name: "Desk",
        friend_public_profile_ids: [
          firstPublicProfileId,
          secondPublicProfileId,
        ],
      },
      signal: signal(),
    });

    expect(resource.status).toBe("succeeded");
    expect(input.claimSubmission).not.toHaveBeenCalled();
    expect(input.upsertFixedMessagingChannel).not.toHaveBeenCalled();
  });
});
