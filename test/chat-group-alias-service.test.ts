import { describe, expect, it, vi } from "vitest";

import {
  AliasDirectoryRepositoryUnavailableError,
  GroupAliasImmutableRepositoryError,
  GroupAliasUnavailableRepositoryError,
  type AliasDirectoryRepository,
  type CommunicationGroupRecord,
  type GroupAliasRecord,
} from "../src/database/alias-directory-repository.js";
import {
  ChatGroupAliasUnavailableError,
  ChatGroupNotFoundError,
  CurrentGroupAliasNotFoundError,
  GroupAliasImmutableError,
  GroupAliasUnavailableError,
  InvalidChatGroupAliasRequestError,
  createChatGroupAliasService,
  createUnavailableChatGroupAliasService,
} from "../src/features/communication/chat-group-alias-service.js";
import type { AliasSearchQuota } from "../src/features/identity/alias-search-quota.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import {
  StreamGroupMemberGatewayUnavailableError,
  StreamGroupMemberNotFoundError,
  type StreamGroupMemberGateway,
} from "../src/integrations/stream/group-member-gateway.js";

const userId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const secondUserId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const formerMemberUserId = "ca6739f3-3428-45ef-967a-5de71908d094";
const pendingUserId = "00ee81a3-8b64-4218-99e5-9cac843d7ab5";
const groupId = "fe81560b-e9cf-48ce-9223-3e85b066d738";
const channelId = "loop_group_01";
const groupAliasId = "8f49d507-ae87-4f65-a0d4-6b59a4d81151";
const principal = Object.freeze({
  userId,
  privyUserId: "did:privy:group-alias-user",
  streamUserId: deriveStreamUserId(userId),
});
const group = Object.freeze({
  groupId,
  streamChannelId: channelId,
  createdAt: "2026-08-31T01:02:03.000Z",
}) satisfies CommunicationGroupRecord;
const pendingAlias = Object.freeze({
  groupAliasId,
  groupId,
  ownerUserId: userId,
  alias: "松林狐狸",
  projectionState: "pending",
  createdAt: "2026-08-31T01:03:00.000Z",
  confirmedAt: null,
}) satisfies GroupAliasRecord;
const confirmedAlias = Object.freeze({
  ...pendingAlias,
  projectionState: "confirmed",
  confirmedAt: "2026-08-31T01:03:01.000Z",
}) satisfies GroupAliasRecord;

function signal(): AbortSignal {
  return new AbortController().signal;
}

function aliasRecord(input: {
  readonly groupAliasId: string;
  readonly ownerUserId: string;
  readonly alias: string;
  readonly projectionState?: "pending" | "confirmed";
}): GroupAliasRecord {
  const projectionState = input.projectionState ?? "confirmed";
  return Object.freeze({
    groupAliasId: input.groupAliasId,
    groupId,
    ownerUserId: input.ownerUserId,
    alias: input.alias,
    projectionState,
    createdAt: "2026-08-31T01:04:00.000Z",
    confirmedAt:
      projectionState === "confirmed" ? "2026-08-31T01:04:01.000Z" : null,
  });
}

function dependencies() {
  const searchPublicAliases = vi.fn<
    AliasDirectoryRepository["searchPublicAliases"]
  >(() => Promise.resolve([]));
  const resolveCommunicationGroup = vi.fn<
    AliasDirectoryRepository["resolveCommunicationGroup"]
  >(() => Promise.resolve(group));
  const findCommunicationGroup = vi.fn<
    AliasDirectoryRepository["findCommunicationGroup"]
  >(() => Promise.resolve(group));
  const findGroupAlias = vi.fn<AliasDirectoryRepository["findGroupAlias"]>(() =>
    Promise.resolve(confirmedAlias),
  );
  const reserveGroupAlias = vi.fn<
    AliasDirectoryRepository["reserveGroupAlias"]
  >(() => Promise.resolve(pendingAlias));
  const confirmGroupAliasProjection = vi.fn<
    AliasDirectoryRepository["confirmGroupAliasProjection"]
  >(() => Promise.resolve(confirmedAlias));
  const searchGroupAliases = vi.fn<
    AliasDirectoryRepository["searchGroupAliases"]
  >(() => Promise.resolve([]));
  const repository = {
    searchPublicAliases,
    resolveCommunicationGroup,
    findCommunicationGroup,
    findGroupAlias,
    reserveGroupAlias,
    confirmGroupAliasProjection,
    searchGroupAliases,
  } satisfies AliasDirectoryRepository;

  const assertCurrentMember = vi.fn<
    StreamGroupMemberGateway["assertCurrentMember"]
  >(() => Promise.resolve());
  const filterCurrentMembers = vi.fn<
    StreamGroupMemberGateway["filterCurrentMembers"]
  >(() => Promise.resolve(new Set([principal.streamUserId])));
  const projectAlias = vi.fn<StreamGroupMemberGateway["projectAlias"]>(() =>
    Promise.resolve(),
  );
  const gateway = {
    assertCurrentMember,
    filterCurrentMembers,
    projectAlias,
  } satisfies StreamGroupMemberGateway;

  const consume = vi.fn<AliasSearchQuota["consume"]>(() => Promise.resolve());
  const service = createChatGroupAliasService({
    repository,
    gateway,
    quota: { consume },
  });

  return {
    assertCurrentMember,
    confirmGroupAliasProjection,
    consume,
    filterCurrentMembers,
    findCommunicationGroup,
    findGroupAlias,
    gateway,
    projectAlias,
    repository,
    reserveGroupAlias,
    resolveCommunicationGroup,
    searchGroupAliases,
    service,
  };
}

describe("chat group alias service", () => {
  it("keeps every operation fail-closed in the unavailable service", async () => {
    const service = createUnavailableChatGroupAliasService();

    await expect(
      service.resolveGroup({
        principal,
        streamChannelId: channelId,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);
    await expect(
      service.getCurrentAlias({ principal, groupId, signal: signal() }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);
    await expect(
      service.putCurrentAlias({
        principal,
        groupId,
        alias: pendingAlias.alias,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);
    await expect(
      service.searchAliases({
        principal,
        groupId,
        aliasPrefix: "松林",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);
  });

  it("resolves an opaque LOOP group only after Stream confirms current membership", async () => {
    const input = dependencies();
    const requestSignal = signal();

    await expect(
      input.service.resolveGroup({
        principal,
        streamChannelId: channelId,
        signal: requestSignal,
      }),
    ).resolves.toEqual({ group_id: groupId });

    expect(input.assertCurrentMember).toHaveBeenCalledWith({
      channelId,
      streamUserId: principal.streamUserId,
      signal: requestSignal,
    });
    expect(input.resolveCommunicationGroup).toHaveBeenCalledWith(channelId);
    expect(input.assertCurrentMember.mock.invocationCallOrder[0]).toBeLessThan(
      input.resolveCommunicationGroup.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not resolve or read a group alias for a non-member", async () => {
    const resolving = dependencies();
    resolving.assertCurrentMember.mockRejectedValueOnce(
      new StreamGroupMemberNotFoundError(),
    );
    await expect(
      resolving.service.resolveGroup({
        principal,
        streamChannelId: channelId,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupNotFoundError);
    expect(resolving.resolveCommunicationGroup).not.toHaveBeenCalled();

    const reading = dependencies();
    reading.assertCurrentMember.mockRejectedValueOnce(
      new StreamGroupMemberNotFoundError(),
    );
    await expect(
      reading.service.getCurrentAlias({ principal, groupId, signal: signal() }),
    ).rejects.toBeInstanceOf(ChatGroupNotFoundError);
    expect(reading.findGroupAlias).not.toHaveBeenCalled();
  });

  it("returns the immutable current alias only after checking current membership", async () => {
    const input = dependencies();

    await expect(
      input.service.getCurrentAlias({ principal, groupId, signal: signal() }),
    ).resolves.toEqual({
      group_alias_id: groupAliasId,
      alias: pendingAlias.alias,
      projection_state: "confirmed",
    });
    expect(input.findCommunicationGroup).toHaveBeenCalledWith(groupId);
    expect(input.assertCurrentMember).toHaveBeenCalledOnce();
    expect(input.findGroupAlias).toHaveBeenCalledWith(groupId, userId);
    expect(input.assertCurrentMember.mock.invocationCallOrder[0]).toBeLessThan(
      input.findGroupAlias.mock.invocationCallOrder[0] ?? 0,
    );

    input.findGroupAlias.mockResolvedValueOnce(null);
    await expect(
      input.service.getCurrentAlias({ principal, groupId, signal: signal() }),
    ).rejects.toBeInstanceOf(CurrentGroupAliasNotFoundError);
  });

  it("reserves, projects, and confirms a new alias in strict order", async () => {
    const input = dependencies();
    const requestSignal = signal();

    await expect(
      input.service.putCurrentAlias({
        principal,
        groupId,
        alias: `  ${pendingAlias.alias}  `,
        signal: requestSignal,
      }),
    ).resolves.toEqual({
      group_alias_id: groupAliasId,
      alias: pendingAlias.alias,
      projection_state: "confirmed",
    });
    expect(input.reserveGroupAlias).toHaveBeenCalledWith({
      groupId,
      ownerUserId: userId,
      alias: pendingAlias.alias,
    });
    expect(input.projectAlias).toHaveBeenCalledWith({
      channelId,
      streamUserId: principal.streamUserId,
      groupAliasId,
      alias: pendingAlias.alias,
      signal: requestSignal,
    });
    expect(input.confirmGroupAliasProjection).toHaveBeenCalledWith({
      groupAliasId,
      groupId,
      ownerUserId: userId,
    });
    expect(input.reserveGroupAlias.mock.invocationCallOrder[0]).toBeLessThan(
      input.projectAlias.mock.invocationCallOrder[0] ?? 0,
    );
    expect(input.projectAlias.mock.invocationCallOrder[0]).toBeLessThan(
      input.confirmGroupAliasProjection.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    [new GroupAliasImmutableRepositoryError(), GroupAliasImmutableError],
    [new GroupAliasUnavailableRepositoryError(), GroupAliasUnavailableError],
  ])(
    "maps an immutable or conflicting reservation without projecting it",
    async (failure, ExpectedError) => {
      const input = dependencies();
      input.reserveGroupAlias.mockRejectedValueOnce(failure);

      await expect(
        input.service.putCurrentAlias({
          principal,
          groupId,
          alias: pendingAlias.alias,
          signal: signal(),
        }),
      ).rejects.toBeInstanceOf(ExpectedError);
      expect(input.projectAlias).not.toHaveBeenCalled();
      expect(input.confirmGroupAliasProjection).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed projection pending and repairs it by retrying the same alias", async () => {
    const input = dependencies();
    input.projectAlias
      .mockRejectedValueOnce(new StreamGroupMemberGatewayUnavailableError())
      .mockResolvedValueOnce();

    const request = {
      principal,
      groupId,
      alias: pendingAlias.alias,
      signal: signal(),
    } as const;
    await expect(input.service.putCurrentAlias(request)).rejects.toBeInstanceOf(
      ChatGroupAliasUnavailableError,
    );
    expect(input.confirmGroupAliasProjection).not.toHaveBeenCalled();

    await expect(
      input.service.putCurrentAlias({ ...request, signal: signal() }),
    ).resolves.toEqual({
      group_alias_id: groupAliasId,
      alias: pendingAlias.alias,
      projection_state: "confirmed",
    });
    expect(input.reserveGroupAlias).toHaveBeenCalledTimes(2);
    expect(input.reserveGroupAlias).toHaveBeenNthCalledWith(1, {
      groupId,
      ownerUserId: userId,
      alias: pendingAlias.alias,
    });
    expect(input.reserveGroupAlias).toHaveBeenNthCalledWith(2, {
      groupId,
      ownerUserId: userId,
      alias: pendingAlias.alias,
    });
    expect(input.projectAlias).toHaveBeenCalledTimes(2);
    expect(input.confirmGroupAliasProjection).toHaveBeenCalledOnce();
  });

  it("searches only confirmed aliases and batch-filters former members through Stream", async () => {
    const input = dependencies();
    const requestSignal = signal();
    const current = aliasRecord({
      groupAliasId: "66e99ff3-02dc-4efc-a233-e3f3b96bb7ca",
      ownerUserId: secondUserId,
      alias: "松林里的猫",
    });
    const former = aliasRecord({
      groupAliasId: "56689780-fc5e-476b-8584-ab085c2b53b6",
      ownerUserId: formerMemberUserId,
      alias: "松林里的鹿",
    });
    const pending = aliasRecord({
      groupAliasId: "ed6072c8-a24f-435c-a140-317e33de9ed2",
      ownerUserId: pendingUserId,
      alias: "松林里的鸟",
      projectionState: "pending",
    });
    input.searchGroupAliases.mockResolvedValueOnce([current, former, pending]);
    input.filterCurrentMembers.mockResolvedValueOnce(
      new Set([
        principal.streamUserId,
        deriveStreamUserId(secondUserId),
        deriveStreamUserId(pendingUserId),
      ]),
    );

    await expect(
      input.service.searchAliases({
        principal,
        groupId,
        aliasPrefix: "松林",
        limit: 20,
        canonicalClientIp: "2001:db8::1",
        signal: requestSignal,
      }),
    ).resolves.toEqual({
      items: [
        {
          group_alias_id: current.groupAliasId,
          alias: current.alias,
        },
      ],
      truncated: false,
    });
    expect(input.consume).toHaveBeenCalledWith({
      scope: "group",
      userId,
      canonicalClientIp: "2001:db8::1",
      signal: requestSignal,
    });
    expect(input.searchGroupAliases).toHaveBeenCalledWith({
      groupId,
      requesterUserId: userId,
      aliasPrefix: "松林",
      limit: 99,
    });
    expect(input.filterCurrentMembers).toHaveBeenCalledWith({
      channelId,
      streamUserIds: [
        principal.streamUserId,
        deriveStreamUserId(secondUserId),
        deriveStreamUserId(formerMemberUserId),
        deriveStreamUserId(pendingUserId),
      ],
      signal: requestSignal,
    });
  });

  it("hides group search from a requester who is no longer a current member", async () => {
    const input = dependencies();
    input.searchGroupAliases.mockResolvedValueOnce([
      aliasRecord({
        groupAliasId: "66e99ff3-02dc-4efc-a233-e3f3b96bb7ca",
        ownerUserId: secondUserId,
        alias: "松林里的猫",
      }),
    ]);
    input.filterCurrentMembers.mockResolvedValueOnce(
      new Set([deriveStreamUserId(secondUserId)]),
    );

    await expect(
      input.service.searchAliases({
        principal,
        groupId,
        aliasPrefix: "松林",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupNotFoundError);
  });

  it("maps repository and Stream availability failures without leaking details", async () => {
    const repositoryFailure = dependencies();
    repositoryFailure.findCommunicationGroup.mockRejectedValueOnce(
      new AliasDirectoryRepositoryUnavailableError(),
    );
    await expect(
      repositoryFailure.service.getCurrentAlias({
        principal,
        groupId,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);

    const gatewayFailure = dependencies();
    gatewayFailure.filterCurrentMembers.mockRejectedValueOnce(
      new StreamGroupMemberGatewayUnavailableError(),
    );
    await expect(
      gatewayFailure.service.searchAliases({
        principal,
        groupId,
        aliasPrefix: "松林",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(ChatGroupAliasUnavailableError);
  });

  it("rejects malformed identifiers and short searches before dependencies", async () => {
    const input = dependencies();

    await expect(
      input.service.getCurrentAlias({
        principal,
        groupId: "not-a-group",
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(InvalidChatGroupAliasRequestError);
    await expect(
      input.service.searchAliases({
        principal,
        groupId,
        aliasPrefix: "松",
        limit: 20,
        canonicalClientIp: "127.0.0.1",
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(InvalidChatGroupAliasRequestError);
    expect(input.consume).not.toHaveBeenCalled();
    expect(input.findCommunicationGroup).not.toHaveBeenCalled();
    expect(input.assertCurrentMember).not.toHaveBeenCalled();
  });
});
