import { describe, expect, it, vi } from "vitest";

import {
  SocialIdempotencyConflictError as RepositoryIdempotencyConflictError,
  SocialRepositoryUnavailableError,
  SocialTargetUnavailableError as RepositoryTargetUnavailableError,
  type SocialRepository,
} from "../src/database/social-repository.js";
import type { AliasSearchQuota } from "../src/features/identity/alias-search-quota.js";
import { createSocialCursorCodec } from "../src/features/social/social-cursor.js";
import {
  SocialMutationRateLimitedError,
  type SocialMutationQuota,
} from "../src/features/social/social-mutation-quota.js";
import {
  createSocialService,
  SocialDomainError,
} from "../src/features/social/social-service.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetPublicProfileId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const friendRequestId = "28f34597-8bbd-4835-bff7-f7db654333b5";
const friendshipId = "10a420b6-5812-4574-a914-a126417d55af";
const operationId = "d85b1407-351d-4694-9392-03acc5870eb1";
const requestId = "f07e98d2-e6fb-4aa4-9db9-0c899184d312";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:social-service-user",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});
const createdAt = "2026-08-30T10:00:00.000Z";
const expiresAt = "2026-09-06T10:00:00.000Z";

function dependencies() {
  const getSocialPrivacy = vi.fn<SocialRepository["getSocialPrivacy"]>(() =>
    Promise.resolve(null),
  );
  const replaceSocialPrivacy = vi.fn<SocialRepository["replaceSocialPrivacy"]>(
    (input) =>
      Promise.resolve({
        ownerUserId: input.ownerUserId,
        version: input.expectedVersion + 1,
        friendRequests: input.privacy.friend_requests,
        groupInvites: input.privacy.group_invites,
        directMessages: input.privacy.direct_messages,
        updatedAt: createdAt,
      }),
  );
  const listFriends = vi.fn<SocialRepository["listFriends"]>(() =>
    Promise.resolve([]),
  );
  const searchFriends = vi.fn<SocialRepository["searchFriends"]>(() =>
    Promise.resolve([]),
  );
  const preflightSocialCommand = vi.fn<
    SocialRepository["preflightSocialCommand"]
  >(() => Promise.resolve({ status: "new" }));
  const sendFriendRequest = vi.fn<SocialRepository["sendFriendRequest"]>(() =>
    Promise.resolve({
      created: true,
      operation: {
        operationId,
        kind: "friend_request_send",
        status: "succeeded",
        result: { friendRequestId, status: "pending" },
        error: null,
        createdAt,
        updatedAt: createdAt,
      },
      request: {
        friendRequestId,
        counterpartyPublicProfileId: targetPublicProfileId,
        counterpartyProfileCode: "7K3M8Q2N5P",
        counterpartyAlias: "Alice",
        counterpartyAvatarRef: null,
        direction: "outgoing",
        status: "pending",
        createdAt,
        expiresAt,
      },
      friendship: null,
    }),
  );
  const listFriendRequests = vi.fn<SocialRepository["listFriendRequests"]>(() =>
    Promise.resolve([]),
  );
  const decideFriendRequest = vi.fn<SocialRepository["decideFriendRequest"]>(
    () =>
      Promise.resolve({
        created: true,
        operation: {
          operationId,
          kind: "friend_request_decide",
          status: "succeeded",
          result: { friendRequestId, status: "accepted" },
          error: null,
          createdAt,
          updatedAt: createdAt,
        },
        request: null,
        friendship: {
          friendshipId,
          publicProfileId: targetPublicProfileId,
          profileCode: "7K3M8Q2N5P",
          alias: "Alice",
          avatarRef: null,
          acceptedAt: createdAt,
        },
      }),
  );
  const getSocialOperation = vi.fn<SocialRepository["getSocialOperation"]>(() =>
    Promise.resolve(null),
  );
  const repository = {
    getSocialPrivacy,
    replaceSocialPrivacy,
    listFriends,
    searchFriends,
    preflightSocialCommand,
    sendFriendRequest,
    listFriendRequests,
    decideFriendRequest,
    getSocialOperation,
  };
  const searchConsume = vi.fn<AliasSearchQuota["consume"]>(() =>
    Promise.resolve(),
  );
  const mutationConsume = vi.fn<SocialMutationQuota["consume"]>(() =>
    Promise.resolve(),
  );
  const service = createSocialService({
    repository,
    searchQuota: { consume: searchConsume },
    mutationQuota: { consume: mutationConsume },
    cursorCodec: createSocialCursorCodec({
      secret: Buffer.alloc(32, 7),
      now: () => new Date("2026-08-31T08:00:00.000Z"),
    }),
  });
  return {
    decideFriendRequest,
    getSocialOperation,
    getSocialPrivacy,
    listFriendRequests,
    listFriends,
    mutationConsume,
    preflightSocialCommand,
    replaceSocialPrivacy,
    repository,
    searchConsume,
    searchFriends,
    sendFriendRequest,
    service,
  };
}

describe("social service", () => {
  it("returns a non-writing, fail-closed social privacy default", async () => {
    const input = dependencies();
    await expect(
      input.service.getSocialPrivacy({ principal }),
    ).resolves.toEqual({
      version: 0,
      social_privacy: {
        friend_requests: "disabled",
        group_invites: "disabled",
        direct_messages: "disabled",
      },
      updated_at: null,
    });
    expect(input.getSocialPrivacy).toHaveBeenCalledWith(ownerUserId);
    expect(input.replaceSocialPrivacy).not.toHaveBeenCalled();
  });

  it("replaces social privacy through repository CAS with no identity input", async () => {
    const input = dependencies();
    const body = {
      expected_version: 0,
      social_privacy: {
        friend_requests: "enabled",
        group_invites: "friends",
        direct_messages: "friends",
      },
    } as const;
    await expect(
      input.service.replaceSocialPrivacy({ principal, body }),
    ).resolves.toEqual({
      version: 1,
      social_privacy: body.social_privacy,
      updated_at: createdAt,
    });
    expect(input.replaceSocialPrivacy).toHaveBeenCalledWith({
      ownerUserId,
      expectedVersion: 0,
      privacy: body.social_privacy,
    });
  });

  it("paginates friends with an owner/route-bound encrypted keyset cursor", async () => {
    const input = dependencies();
    input.listFriends.mockResolvedValueOnce([
      {
        friendshipId,
        publicProfileId: targetPublicProfileId,
        profileCode: "7K3M8Q2N5P",
        alias: null,
        avatarRef: null,
        acceptedAt: createdAt,
      },
      {
        friendshipId: friendRequestId,
        publicProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        profileCode: "8K3M8Q2N5P",
        alias: "Bob",
        avatarRef: "avatar:bob/main",
        acceptedAt: "2026-08-29T10:00:00.000Z",
      },
    ]);
    const first = await input.service.listFriends({
      principal,
      cursor: undefined,
      limit: 1,
    });
    expect(first.items).toEqual([
      {
        public_profile_id: targetPublicProfileId,
        profile_code: "7K3M8Q2N5P",
        alias: null,
        avatar_ref: null,
        accepted_at: createdAt,
      },
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(input.listFriends).toHaveBeenCalledWith({
      ownerUserId,
      limit: 2,
    });

    input.listFriends.mockResolvedValueOnce([]);
    await input.service.listFriends({
      principal,
      cursor: first.next_cursor,
      limit: undefined,
    });
    expect(input.listFriends).toHaveBeenLastCalledWith({
      ownerUserId,
      limit: 2,
      beforeAcceptedAt: createdAt,
      beforeFriendshipId: friendshipId,
    });
  });

  it("shares the public alias enumeration quota and exposes only relationship projection", async () => {
    const input = dependencies();
    input.searchFriends.mockResolvedValueOnce([
      {
        publicProfileId: targetPublicProfileId,
        profileCode: "7K3M8Q2N5P",
        alias: "Alice",
        avatarRef: null,
        relationship: "incoming_pending",
        friendRequestId,
      },
    ]);
    await expect(
      input.service.searchFriends({
        principal,
        aliasPrefix: "Ali",
        limit: 20,
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      items: [
        {
          public_profile_id: targetPublicProfileId,
          profile_code: "7K3M8Q2N5P",
          alias: "Alice",
          avatar_ref: null,
          relationship: "incoming_pending",
          friend_request_id: friendRequestId,
        },
      ],
      truncated: false,
    });
    expect(input.searchConsume).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "public", userId: ownerUserId }),
    );
    expect(input.searchConsume.mock.invocationCallOrder[0]).toBeLessThan(
      input.searchFriends.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("preflights new send operations before quota and binds operation id to the key", async () => {
    const input = dependencies();
    await expect(
      input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      kind: "friend_request_send",
      status: "succeeded",
      terminal: true,
      retry_after_ms: null,
      result: { friend_request_id: friendRequestId, status: "pending" },
      error: null,
    });
    expect(input.mutationConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "friend_request_send",
        userId: ownerUserId,
        targetRef: targetPublicProfileId,
      }),
    );
    expect(input.preflightSocialCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId,
        idempotencyKey: operationId,
        kind: "friend_request_send",
      }),
    );
    expect(
      input.preflightSocialCommand.mock.invocationCallOrder[0],
    ).toBeLessThan(input.mutationConsume.mock.invocationCallOrder[0] ?? 0);
    const sent = input.sendFriendRequest.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      ownerUserId,
      requestId,
      idempotencyKey: operationId,
      targetPublicProfileId,
    });
    expect(sent?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not consume quota for an exact command replay", async () => {
    const input = dependencies();
    input.preflightSocialCommand.mockResolvedValueOnce({ status: "replay" });

    await expect(
      input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ operation_id: operationId });

    expect(input.mutationConsume).not.toHaveBeenCalled();
    expect(input.sendFriendRequest).toHaveBeenCalledOnce();
  });

  it("replays the same durable target error without consuming quota", async () => {
    const input = dependencies();
    input.preflightSocialCommand.mockResolvedValueOnce({ status: "replay" });
    input.sendFriendRequest.mockRejectedValueOnce(
      new RepositoryTargetUnavailableError(),
    );

    await expect(
      input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "target_unavailable" }));

    expect(input.mutationConsume).not.toHaveBeenCalled();
    expect(input.sendFriendRequest).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting key before consuming quota", async () => {
    const input = dependencies();
    input.preflightSocialCommand.mockRejectedValueOnce(
      new RepositoryIdempotencyConflictError(),
    );

    await expect(
      input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "idempotency_conflict" }),
    );

    expect(input.mutationConsume).not.toHaveBeenCalled();
    expect(input.sendFriendRequest).not.toHaveBeenCalled();
  });

  it("recovers a concurrent exact replay when quota rejects", async () => {
    const input = dependencies();
    input.preflightSocialCommand
      .mockResolvedValueOnce({ status: "new" })
      .mockResolvedValueOnce({ status: "replay" });
    input.mutationConsume.mockRejectedValueOnce(
      new SocialMutationRateLimitedError(),
    );

    await expect(
      input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ operation_id: operationId });

    expect(input.preflightSocialCommand).toHaveBeenCalledTimes(2);
    expect(input.sendFriendRequest).toHaveBeenCalledOnce();
  });

  it("lists incoming and outgoing pending requests with stable cursors", async () => {
    const input = dependencies();
    input.listFriendRequests.mockResolvedValueOnce([
      {
        friendRequestId,
        counterpartyPublicProfileId: targetPublicProfileId,
        counterpartyProfileCode: "7K3M8Q2N5P",
        counterpartyAlias: null,
        counterpartyAvatarRef: null,
        direction: "incoming",
        status: "pending",
        createdAt,
        expiresAt,
      },
    ]);
    await expect(
      input.service.listFriendRequests({
        principal,
        direction: "incoming",
        status: "pending",
        cursor: undefined,
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [
        {
          friend_request_id: friendRequestId,
          counterparty: {
            public_profile_id: targetPublicProfileId,
            profile_code: "7K3M8Q2N5P",
            alias: null,
            avatar_ref: null,
          },
          direction: "incoming",
          status: "pending",
          created_at: createdAt,
          expires_at: expiresAt,
        },
      ],
      next_cursor: null,
    });
  });

  it("decides requests and provides owner-bound operation recovery", async () => {
    const input = dependencies();
    await expect(
      input.service.decideFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        friendRequestId,
        body: { decision: "accept" },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      kind: "friend_request_decide",
      result: { friend_request_id: friendRequestId, status: "accepted" },
    });
    const decided = input.decideFriendRequest.mock.calls[0]?.[0];
    expect(decided).toMatchObject({
      ownerUserId,
      requestId,
      idempotencyKey: operationId,
      friendRequestId,
      decision: "accept",
    });
    expect(decided?.requestSha256).toMatch(/^[0-9a-f]{64}$/);

    input.getSocialOperation.mockResolvedValueOnce({
      operationId,
      kind: "friend_request_send",
      status: "failed",
      result: null,
      error: { code: "target_unavailable" },
      createdAt,
      updatedAt: createdAt,
    });
    await expect(
      input.service.getOperation({ principal, operationId }),
    ).resolves.toMatchObject({
      operation_id: operationId,
      status: "failed",
      terminal: true,
      result: null,
      error: { code: "target_unavailable" },
    });
    expect(input.getSocialOperation).toHaveBeenCalledWith(
      ownerUserId,
      operationId,
    );
  });

  it("maps repository failures to stable domain errors without leaking details", async () => {
    const input = dependencies();
    input.sendFriendRequest
      .mockRejectedValueOnce(new RepositoryTargetUnavailableError())
      .mockRejectedValueOnce(new RepositoryIdempotencyConflictError())
      .mockRejectedValueOnce(new SocialRepositoryUnavailableError());

    for (const expectedCode of [
      "target_unavailable",
      "idempotency_conflict",
      "social_unavailable",
    ] as const) {
      const result = input.service.sendFriendRequest({
        principal,
        requestId,
        idempotencyKey: operationId,
        body: { target_public_profile_id: targetPublicProfileId },
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      });
      await expect(result).rejects.toEqual(
        expect.objectContaining({
          name: "SocialDomainError",
          code: expectedCode,
        }),
      );
      await expect(result).rejects.toBeInstanceOf(SocialDomainError);
    }
  });

  it("rejects cursor+limit and malformed repository identity output fail closed", async () => {
    const input = dependencies();
    await expect(
      input.service.listFriends({ principal, cursor: "bad", limit: 20 }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_request" }));
    input.searchFriends.mockResolvedValueOnce([
      {
        publicProfileId: targetPublicProfileId,
        profileCode: "7K3M8Q2N5P",
        alias: "Alice",
        avatarRef: null,
        relationship: "none",
        friendRequestId,
      },
    ]);
    await expect(
      input.service.searchFriends({
        principal,
        aliasPrefix: "Al",
        limit: 20,
        canonicalClientIp: "198.51.100.24",
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "social_unavailable" }));
  });
});
