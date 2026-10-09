import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import {
  ChatGroupAliasUnavailableError,
  ChatGroupNotFoundError,
  CurrentGroupAliasNotFoundError,
  GroupAliasImmutableError,
  GroupAliasUnavailableError,
  InvalidChatGroupAliasRequestError,
  type ChatGroupAliasService,
} from "../src/features/communication/chat-group-alias-service.js";
import type {
  CommunicationGroupResource,
  GroupAliasResource,
  GroupAliasSearchResource,
} from "../src/features/identity/alias-contract.js";
import { AliasSearchRateLimitedError } from "../src/features/identity/alias-search-quota.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerChatGroupRoutes } from "../src/routes/chat-groups.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:group-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const groupAliasId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherAliasId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const channelId = "existing_group_2026";
const validAccessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const groupResource = Object.freeze({ group_id: groupId });
const aliasResource = Object.freeze({
  group_alias_id: groupAliasId,
  alias: "群内小鹿",
  projection_state: "confirmed" as const,
});
const searchResource = Object.freeze({
  items: Object.freeze([
    Object.freeze({ group_alias_id: otherAliasId, alias: "群内小雨" }),
  ]),
  truncated: false,
});

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
  const resolveGroup = vi.fn<ChatGroupAliasService["resolveGroup"]>(() =>
    Promise.resolve(groupResource),
  );
  const getCurrentAlias = vi.fn<ChatGroupAliasService["getCurrentAlias"]>(() =>
    Promise.resolve(aliasResource),
  );
  const putCurrentAlias = vi.fn<ChatGroupAliasService["putCurrentAlias"]>(() =>
    Promise.resolve(aliasResource),
  );
  const searchAliases = vi.fn<ChatGroupAliasService["searchAliases"]>(() =>
    Promise.resolve(searchResource),
  );

  return {
    findByPrivyUserId,
    getCurrentAlias,
    internalUsers,
    putCurrentAlias,
    resolveGroup,
    searchAliases,
    service: {
      resolveGroup,
      getCurrentAlias,
      putCurrentAlias,
      searchAliases,
    } satisfies ChatGroupAliasService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

type Dependencies = ReturnType<typeof dependencies>;

async function createGroupHarness(input = dependencies()) {
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
  registerChatGroupRoutes(
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
    reply.header("cache-control", "no-store");
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
  return { authorization: `Bearer ${validAccessToken}`, ...extra };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

function serviceCallCount(input: Dependencies): number {
  return (
    input.resolveGroup.mock.calls.length +
    input.getCurrentAlias.mock.calls.length +
    input.putCurrentAlias.mock.calls.length +
    input.searchAliases.mock.calls.length
  );
}

describe("Chat group alias routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createGroupHarness(input);
    apps.push(created.app);
    return created;
  }

  it("passes only the authenticated principal and bounded route values to all group operations", async () => {
    const input = await harness();
    const resolve = await input.app.inject({
      method: "POST",
      url: "/v1/chat/groups/resolve",
      headers: authHeaders(),
      payload: { stream_channel_id: channelId },
    });
    const get = await input.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/me/alias`,
      headers: authHeaders(),
    });
    const put = await input.app.inject({
      method: "PUT",
      url: `/v1/chat/groups/${groupId}/me/alias`,
      headers: authHeaders(),
      payload: { alias: "群内小鹿" },
    });
    const search = await input.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=${encodeURIComponent("群内")}&limit=7`,
      headers: authHeaders(),
      remoteAddress: "198.51.100.25",
    });

    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toEqual(groupResource);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(aliasResource);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(aliasResource);
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual(searchResource);
    for (const response of [resolve, get, put, search]) {
      expectOperationalHeaders(response);
    }

    const principal = { userId: ownerUserId, privyUserId, streamUserId };
    const resolveInput = input.resolveGroup.mock.calls[0]?.[0];
    const getInput = input.getCurrentAlias.mock.calls[0]?.[0];
    const putInput = input.putCurrentAlias.mock.calls[0]?.[0];
    const searchInput = input.searchAliases.mock.calls[0]?.[0];
    expect(resolveInput).toMatchObject({
      principal,
      streamChannelId: channelId,
    });
    expect(getInput).toMatchObject({
      principal,
      groupId,
    });
    expect(putInput).toMatchObject({
      principal,
      groupId,
      alias: "群内小鹿",
    });
    expect(searchInput).toMatchObject({
      principal,
      groupId,
      aliasPrefix: "群内",
      limit: 7,
      canonicalClientIp: "198.51.100.25",
    });
    expect(resolveInput?.signal).toBeInstanceOf(AbortSignal);
    expect(getInput?.signal).toBeInstanceOf(AbortSignal);
    expect(putInput?.signal).toBeInstanceOf(AbortSignal);
    expect(searchInput?.signal).toBeInstanceOf(AbortSignal);
  });

  it("allows a one-code-point raw group prefix when NFKC expands it to the required length", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=${encodeURIComponent("ﬀ")}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(input.searchAliases).toHaveBeenCalledWith(
      expect.objectContaining({ aliasPrefix: "ﬀ" }),
    );
  });

  it("serializes no Stream, LOOP, wallet, public-profile, or cross-group identity fields", async () => {
    const input = dependencies();
    input.resolveGroup.mockResolvedValueOnce({
      group_id: groupId,
      stream_channel_id: channelId,
      internal_user_id: ownerUserId,
    } as unknown as CommunicationGroupResource);
    input.getCurrentAlias.mockResolvedValueOnce({
      ...aliasResource,
      stream_user_id: streamUserId,
      public_profile_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    } as unknown as GroupAliasResource);
    input.searchAliases.mockResolvedValueOnce({
      items: [
        {
          group_alias_id: otherAliasId,
          alias: "群内小雨",
          stream_user_id: "loop_private_candidate",
          wallet_address: "0x1111111111111111111111111111111111111111",
          other_group_alias: "cross-group",
        },
      ],
      truncated: false,
      total: 1,
      next_cursor: "private-cursor",
    } as unknown as GroupAliasSearchResource);
    const created = await harness(input);

    const resolve = await created.app.inject({
      method: "POST",
      url: "/v1/chat/groups/resolve",
      headers: authHeaders(),
      payload: { stream_channel_id: channelId },
    });
    const get = await created.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/me/alias`,
      headers: authHeaders(),
    });
    const search = await created.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=${encodeURIComponent("群内")}`,
      headers: authHeaders(),
    });

    expect(resolve.json()).toEqual({ group_id: groupId });
    expect(get.json()).toEqual(aliasResource);
    expect(search.json()).toEqual(searchResource);
    const combined = `${resolve.body}${get.body}${search.body}`;
    expect(combined).not.toContain(channelId);
    expect(combined).not.toContain(ownerUserId);
    expect(combined).not.toContain(streamUserId);
    expect(combined).not.toContain("wallet_address");
    expect(combined).not.toContain("public_profile_id");
    expect(combined).not.toContain("other_group_alias");
    expect(combined).not.toContain("next_cursor");
  });

  it("rejects strict params, query, body, and header failures before authentication", async () => {
    const input = await harness();
    const requests = [
      {
        method: "POST" as const,
        url: "/v1/chat/groups/resolve?channel_type=private",
        payload: { stream_channel_id: channelId },
      },
      {
        method: "POST" as const,
        url: "/v1/chat/groups/resolve",
        payload: {
          stream_channel_id: channelId,
          internal_user_id: ownerUserId,
        },
      },
      {
        method: "POST" as const,
        url: "/v1/chat/groups/resolve",
        payload: { stream_channel_id: "messaging:forbidden-cid" },
      },
      {
        method: "POST" as const,
        url: "/v1/chat/groups/resolve",
        headers: { "idempotency-key": randomUUID() },
        payload: { stream_channel_id: channelId },
      },
      {
        method: "GET" as const,
        url: "/v1/chat/groups/not-a-uuid/me/alias",
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/me/alias?owner=hostile`,
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        headers: { "content-type": "application/json" },
        payload: {},
      },
      {
        method: "PUT" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        payload: { alias: "safe\u202eevil" },
      },
      {
        method: "PUT" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        payload: { alias: "safe\u206aevil" },
      },
      {
        method: "PUT" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        payload: { alias: "Alias", stream_user_id: streamUserId },
      },
      {
        method: "PUT" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        headers: { "idempotency-key": randomUUID() },
        payload: { alias: "Alias" },
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/aliases`,
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=ab&alias_prefix=cd`,
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=ab&limit=21`,
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=ab&public_profile_id=hostile`,
      },
    ];

    for (const request of requests) {
      const response = await input.app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
    }

    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(input.findByPrivyUserId).not.toHaveBeenCalled();
    expect(serviceCallCount(input)).toBe(0);
  });

  it("authenticates every operation and requires an existing bootstrap", async () => {
    const requests = [
      {
        method: "POST" as const,
        url: "/v1/chat/groups/resolve",
        payload: { stream_channel_id: channelId },
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
      },
      {
        method: "PUT" as const,
        url: `/v1/chat/groups/${groupId}/me/alias`,
        payload: { alias: "Alias" },
      },
      {
        method: "GET" as const,
        url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=Al`,
      },
    ];

    const missingAuth = await harness();
    for (const request of requests) {
      const response = await missingAuth.app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "authentication_required",
      });
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="loop-api"',
      );
      expectOperationalHeaders(response);
    }
    expect(serviceCallCount(missingAuth)).toBe(0);

    const noBootstrap = await harness(dependencies(false));
    for (const request of requests) {
      const response = await noBootstrap.app.inject({
        ...request,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "bootstrap_required" });
      expectOperationalHeaders(response);
    }
    expect(noBootstrap.verifyAccessToken).toHaveBeenCalledTimes(4);
    expect(serviceCallCount(noBootstrap)).toBe(0);
  });

  it("uses one generic not-found response for missing groups, aliases, and memberships", async () => {
    const missingGroup = dependencies();
    missingGroup.resolveGroup.mockRejectedValueOnce(
      new ChatGroupNotFoundError(),
    );
    const first = await harness(missingGroup);
    const groupResponse = await first.app.inject({
      method: "POST",
      url: "/v1/chat/groups/resolve",
      headers: authHeaders(),
      payload: { stream_channel_id: channelId },
    });

    const missingAlias = dependencies();
    missingAlias.getCurrentAlias.mockRejectedValueOnce(
      new CurrentGroupAliasNotFoundError(),
    );
    const second = await harness(missingAlias);
    const aliasResponse = await second.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/me/alias`,
      headers: authHeaders(),
    });

    for (const response of [groupResponse, aliasResponse]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "not_found",
        message: "The requested resource does not exist.",
      });
      expect(response.body).not.toContain("member");
      expect(response.body).not.toContain("alias does not exist");
      expectOperationalHeaders(response);
    }
  });

  it("maps immutable, unavailable-name, quota, and provider failures to stable codes", async () => {
    const cases = [
      {
        error: new GroupAliasImmutableError(),
        expected: [
          409,
          "group_alias_immutable",
          "The group alias cannot be changed.",
        ],
        method: "putCurrentAlias" as const,
        request: {
          method: "PUT" as const,
          url: `/v1/chat/groups/${groupId}/me/alias`,
          payload: { alias: "Different" },
        },
      },
      {
        error: new GroupAliasUnavailableError(),
        expected: [
          409,
          "group_alias_unavailable",
          "The group alias is unavailable.",
        ],
        method: "putCurrentAlias" as const,
        request: {
          method: "PUT" as const,
          url: `/v1/chat/groups/${groupId}/me/alias`,
          payload: { alias: "Taken" },
        },
      },
      {
        error: new AliasSearchRateLimitedError(),
        expected: [
          429,
          "search_rate_limited",
          "Alias search is temporarily rate limited.",
        ],
        method: "searchAliases" as const,
        request: {
          method: "GET" as const,
          url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=Al`,
        },
      },
      {
        error: new ChatGroupAliasUnavailableError(),
        expected: [
          503,
          "chat_group_unavailable",
          "Chat group aliases are unavailable.",
        ],
        method: "resolveGroup" as const,
        request: {
          method: "POST" as const,
          url: "/v1/chat/groups/resolve",
          payload: { stream_channel_id: channelId },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const failed = dependencies();
      if (testCase.method === "putCurrentAlias") {
        failed.putCurrentAlias.mockRejectedValueOnce(testCase.error);
      } else if (testCase.method === "searchAliases") {
        failed.searchAliases.mockRejectedValueOnce(testCase.error);
      } else {
        failed.resolveGroup.mockRejectedValueOnce(testCase.error);
      }
      const input = await harness(failed);
      const response = await input.app.inject({
        ...testCase.request,
        headers: authHeaders(),
      });
      const [statusCode, code, message] = testCase.expected;

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ code, message });
      expectOperationalHeaders(response);
    }
  });

  it("maps invalid service input and sanitizes unexpected failures", async () => {
    const invalid = dependencies();
    invalid.resolveGroup.mockRejectedValueOnce(
      new InvalidChatGroupAliasRequestError(),
    );
    const invalidInput = await harness(invalid);
    const invalidResponse = await invalidInput.app.inject({
      method: "POST",
      url: "/v1/chat/groups/resolve",
      headers: authHeaders(),
      payload: { stream_channel_id: channelId },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({ code: "invalid_request" });
    expectOperationalHeaders(invalidResponse);

    const unexpected = dependencies();
    unexpected.searchAliases.mockRejectedValueOnce(
      new Error("private Stream membership and wallet detail"),
    );
    const unexpectedInput = await harness(unexpected);
    const unexpectedResponse = await unexpectedInput.app.inject({
      method: "GET",
      url: `/v1/chat/groups/${groupId}/aliases?alias_prefix=Al`,
      headers: authHeaders(),
    });
    expect(unexpectedResponse.statusCode).toBe(500);
    expect(unexpectedResponse.json()).toMatchObject({
      code: "internal_error",
      message: "The request failed.",
    });
    expect(unexpectedResponse.body).not.toContain("Stream membership");
    expect(unexpectedResponse.body).not.toContain("wallet");
    expectOperationalHeaders(unexpectedResponse);
  });
});
