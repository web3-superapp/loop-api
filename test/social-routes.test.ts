import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type {
  FriendListResource,
  FriendRequestListResource,
  FriendSearchResource,
  SocialOperationResource,
  SocialPrivacyResource,
} from "../src/features/social/social-contract.js";
import {
  SocialDomainError,
  type SocialService,
} from "../src/features/social/social-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerSocialRoutes } from "../src/routes/social.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetPublicProfileId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const friendRequestId = "28f34597-8bbd-4835-bff7-f7db654333b5";
const operationId = "d85b1407-351d-4694-9392-03acc5870eb1";
const privyUserId = "did:privy:social-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const accessToken = "header.payload.signature";
const observedAt = "2026-08-31T08:00:00.000Z";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const privacyResource = Object.freeze({
  version: 0,
  social_privacy: Object.freeze({
    friend_requests: "disabled",
    group_invites: "disabled",
    direct_messages: "disabled",
  }),
  updated_at: null,
}) satisfies SocialPrivacyResource;
const friendList = Object.freeze({
  items: Object.freeze([
    Object.freeze({
      public_profile_id: targetPublicProfileId,
      profile_code: "7K3M8Q2N5P",
      alias: null,
      avatar_ref: null,
      accepted_at: observedAt,
    }),
  ]),
  next_cursor: null,
}) satisfies FriendListResource;
const searchResource = Object.freeze({
  items: Object.freeze([
    Object.freeze({
      public_profile_id: targetPublicProfileId,
      profile_code: "7K3M8Q2N5P",
      alias: "Alice",
      avatar_ref: null,
      relationship: "incoming_pending",
      friend_request_id: friendRequestId,
    }),
  ]),
  truncated: false,
}) satisfies FriendSearchResource;
const requestList = Object.freeze({
  items: Object.freeze([
    Object.freeze({
      friend_request_id: friendRequestId,
      counterparty: Object.freeze({
        public_profile_id: targetPublicProfileId,
        profile_code: "7K3M8Q2N5P",
        alias: "Alice",
        avatar_ref: null,
      }),
      direction: "incoming",
      status: "pending",
      created_at: observedAt,
      expires_at: "2026-09-07T08:00:00.000Z",
    }),
  ]),
  next_cursor: null,
}) satisfies FriendRequestListResource;
const operationResource = Object.freeze({
  operation_id: operationId,
  kind: "friend_request_send",
  status: "succeeded",
  terminal: true,
  retry_after_ms: null,
  result: Object.freeze({
    friend_request_id: friendRequestId,
    status: "pending",
  }),
  error: null,
  created_at: observedAt,
  updated_at: observedAt,
}) satisfies SocialOperationResource;

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;
  const getSocialPrivacy = vi.fn<SocialService["getSocialPrivacy"]>(() =>
    Promise.resolve(privacyResource),
  );
  const replaceSocialPrivacy = vi.fn<SocialService["replaceSocialPrivacy"]>(
    () =>
      Promise.resolve({
        ...privacyResource,
        version: 1,
        updated_at: observedAt,
      }),
  );
  const listFriends = vi.fn<SocialService["listFriends"]>(() =>
    Promise.resolve(friendList),
  );
  const searchFriends = vi.fn<SocialService["searchFriends"]>(() =>
    Promise.resolve(searchResource),
  );
  const sendFriendRequest = vi.fn<SocialService["sendFriendRequest"]>(() =>
    Promise.resolve(operationResource),
  );
  const listFriendRequests = vi.fn<SocialService["listFriendRequests"]>(() =>
    Promise.resolve(requestList),
  );
  const decideFriendRequest = vi.fn<SocialService["decideFriendRequest"]>(() =>
    Promise.resolve({
      ...operationResource,
      kind: "friend_request_decide",
      result: { friend_request_id: friendRequestId, status: "accepted" },
    }),
  );
  const getOperation = vi.fn<SocialService["getOperation"]>(() =>
    Promise.resolve(operationResource),
  );
  return {
    decideFriendRequest,
    findByPrivyUserId,
    getOperation,
    getSocialPrivacy,
    internalUsers,
    listFriendRequests,
    listFriends,
    replaceSocialPrivacy,
    searchFriends,
    sendFriendRequest,
    service: {
      getSocialPrivacy,
      replaceSocialPrivacy,
      listFriends,
      searchFriends,
      sendFriendRequest,
      listFriendRequests,
      decideFriendRequest,
      getOperation,
    } satisfies SocialService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

async function createApp(input = dependencies()) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    logger: false,
    requestIdHeader: false,
  });
  const authentication = registerAuthenticationHooks(
    app,
    createAuthenticationService(input.verifier, input.internalUsers),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (reply.statusCode >= 400) {
      reply.header("cache-control", "no-store");
    }
  });
  registerSocialRoutes(
    app,
    authentication.authenticateLoopBearer,
    input.service,
  );
  app.setErrorHandler(async (error, request, reply) => {
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const mapped = validation ? ApiError.invalidRequest() : error;
    if (mapped instanceof ApiError) {
      if (mapped.includeBearerChallenge) {
        reply.header("www-authenticate", 'Bearer realm="loop-api"');
      }
      return reply.code(mapped.statusCode).send({
        code: mapped.code,
        message: mapped.safeMessage,
        request_id: request.id,
      });
    }
    return reply.code(500).send({
      code: "internal_error",
      message: "The request failed.",
      request_id: request.id,
    });
  });
  await app.ready();
  return { app, ...input };
}

function authHeaders(extra: Record<string, string | string[]> = {}) {
  return { authorization: `Bearer ${accessToken}`, ...extra };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}) {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("social routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("exposes owner-bound social privacy and CAS replacement", async () => {
    const input = await harness();
    const read = await input.app.inject({
      method: "GET",
      url: "/v1/profile/social-privacy",
      headers: authHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(privacyResource);
    expectOperationalHeaders(read);
    expect(input.getSocialPrivacy).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
    });

    const body = {
      expected_version: 0,
      social_privacy: {
        friend_requests: "enabled",
        group_invites: "friends",
        direct_messages: "friends",
      },
    };
    const replaced = await input.app.inject({
      method: "PUT",
      url: "/v1/profile/social-privacy",
      headers: authHeaders(),
      payload: body,
    });
    expect(replaced.statusCode).toBe(200);
    expect(input.replaceSocialPrivacy).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      body,
    });
  });

  it("forwards list/search inputs without accepting client identity", async () => {
    const input = await harness();
    const friends = await input.app.inject({
      method: "GET",
      url: "/v1/friends?limit=7",
      headers: authHeaders(),
    });
    expect(friends.statusCode).toBe(200);
    expect(friends.json()).toEqual(friendList);
    expect(input.listFriends).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      cursor: undefined,
      limit: 7,
    });

    const search = await input.app.inject({
      method: "GET",
      url: "/v1/friends/search?alias_prefix=Ali&limit=5",
      headers: authHeaders(),
      remoteAddress: "198.51.100.24",
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual(searchResource);
    expect(input.searchFriends).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { userId: ownerUserId, privyUserId, streamUserId },
        aliasPrefix: "Ali",
        limit: 5,
        canonicalClientIp: "198.51.100.24",
      }),
    );
    expectOperationalHeaders(search);
  });

  it("sends, lists, decides, and recovers friend request operations", async () => {
    const input = await harness();
    const send = await input.app.inject({
      method: "POST",
      url: "/v1/friend-requests",
      headers: authHeaders({ "idempotency-key": operationId }),
      remoteAddress: "198.51.100.24",
      payload: { target_public_profile_id: targetPublicProfileId },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json()).toEqual(operationResource);
    const sentInput = input.sendFriendRequest.mock.calls[0]?.[0];
    expect(sentInput).toMatchObject({
      idempotencyKey: operationId,
      body: { target_public_profile_id: targetPublicProfileId },
      canonicalClientIp: "198.51.100.24",
    });
    expect(sentInput?.requestId).toMatch(requestIdPattern);

    const list = await input.app.inject({
      method: "GET",
      url: "/v1/friend-requests?direction=incoming&status=pending&limit=20",
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(requestList);

    const decide = await input.app.inject({
      method: "POST",
      url: `/v1/friend-requests/${friendRequestId}/decision`,
      headers: authHeaders({ "idempotency-key": operationId }),
      payload: { decision: "accept" },
    });
    expect(decide.statusCode).toBe(200);
    expect(input.decideFriendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        friendRequestId,
        idempotencyKey: operationId,
        body: { decision: "accept" },
      }),
    );

    const operation = await input.app.inject({
      method: "GET",
      url: `/v1/social/operations/${operationId}`,
      headers: authHeaders(),
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toEqual(operationResource);
    expect(input.getOperation).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      operationId,
    });
  });

  it("rejects every malformed or duplicate idempotency header before auth", async () => {
    const input = await harness();
    for (const headers of [
      {},
      { "idempotency-key": operationId.toUpperCase() },
      { "idempotency-key": ` ${operationId}` },
      { "idempotency-key": "d85b1407-351d-1694-9392-03acc5870eb1" },
      { "idempotency-key": [operationId, operationId] },
    ]) {
      const response = await input.app.inject({
        method: "POST",
        url: "/v1/friend-requests",
        headers,
        payload: { target_public_profile_id: targetPublicProfileId },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(input.sendFriendRequest).not.toHaveBeenCalled();
  });

  it("rejects identity/query/header expansion before auth", async () => {
    const input = await harness();
    const requests = [
      {
        method: "GET" as const,
        url: "/v1/friends?owner_user_id=hostile",
      },
      {
        method: "GET" as const,
        url: "/v1/friends?limit=20&limit=20",
      },
      {
        method: "GET" as const,
        url: "/v1/friends?cursor=abc&limit=20",
      },
      {
        method: "GET" as const,
        url: "/v1/friends/search?alias_prefix=Al",
        headers: { "idempotency-key": operationId },
      },
      {
        method: "PUT" as const,
        url: "/v1/profile/social-privacy",
        headers: { "idempotency-key": operationId },
        payload: {
          expected_version: 0,
          social_privacy: {
            friend_requests: "disabled",
            group_invites: "disabled",
            direct_messages: "disabled",
          },
        },
      },
      {
        method: "POST" as const,
        url: "/v1/friend-requests?owner=hostile",
        headers: { "idempotency-key": operationId },
        payload: { target_public_profile_id: targetPublicProfileId },
      },
    ];
    for (const request of requests) {
      const response = await input.app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(input.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("requires current Privy authentication and bootstrap", async () => {
    const input = await harness();
    const missing = await input.app.inject({
      method: "GET",
      url: "/v1/friends",
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe('Bearer realm="loop-api"');
    expect(input.listFriends).not.toHaveBeenCalled();

    const noBootstrap = await harness(dependencies(false));
    const response = await noBootstrap.app.inject({
      method: "GET",
      url: "/v1/friends",
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "bootstrap_required" });
    expect(noBootstrap.listFriends).not.toHaveBeenCalled();
  });

  it.each([
    ["target_unavailable", 404],
    ["social_operation_not_found", 404],
    ["incoming_request_pending", 409],
    ["friend_request_already_decided", 409],
    ["idempotency_conflict", 409],
    ["social_rate_limited", 429],
    ["social_unavailable", 503],
  ] as const)(
    "maps %s to a stable sanitized response",
    async (code, status) => {
      const dependenciesWithError = dependencies();
      dependenciesWithError.getOperation.mockRejectedValueOnce(
        new SocialDomainError(code),
      );
      const input = await harness(dependenciesWithError);
      const response = await input.app.inject({
        method: "GET",
        url: `/v1/social/operations/${operationId}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain("Social operation failed");
      expectOperationalHeaders(response);
    },
  );

  it("serializes only the public social projection", async () => {
    const expanded = dependencies();
    expanded.searchFriends.mockResolvedValueOnce({
      ...searchResource,
      internal_user_id: ownerUserId,
      stream_user_id: streamUserId,
      wallet_address: "0x1111111111111111111111111111111111111111",
      items: searchResource.items.map((item) => ({
        ...item,
        internal_user_id: ownerUserId,
      })),
    } as unknown as FriendSearchResource);
    const input = await harness(expanded);
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/friends/search?alias_prefix=Al",
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(searchResource);
    expect(response.body).not.toContain(ownerUserId);
    expect(response.body).not.toContain(streamUserId);
    expect(response.body).not.toContain("wallet");
  });
});
