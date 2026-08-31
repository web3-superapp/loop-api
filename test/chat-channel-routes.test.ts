import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { ChatOperationResource } from "../src/features/communication/chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictError,
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  type ChatChannelService,
} from "../src/features/communication/chat-channel-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerChatChannelRoutes } from "../src/routes/chat-channels.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const firstProfileId = "22222222-2222-4222-8222-222222222222";
const secondProfileId = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const accessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const succeededGroup = Object.freeze({
  operation_id: operationId,
  kind: "group_create",
  status: "succeeded",
  terminal: true,
  retry_after_ms: null,
  result: Object.freeze({
    group_id: groupId,
    name: "Desk",
    friend_public_profile_ids: Object.freeze([firstProfileId, secondProfileId]),
    stream_cid: "messaging:loop_group_5555555555554555",
  }),
  error: null,
  created_at: "2026-08-31T02:00:00.000Z",
  updated_at: "2026-08-31T02:00:01.000Z",
}) satisfies ChatOperationResource;

const pendingDirect = Object.freeze({
  operation_id: operationId,
  kind: "direct_get_or_create",
  status: "reconciling",
  terminal: false,
  retry_after_ms: 2_000,
  result: null,
  error: null,
  created_at: "2026-08-31T02:00:00.000Z",
  updated_at: "2026-08-31T02:00:01.000Z",
}) satisfies ChatOperationResource;

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId: "did:privy:chat-route-owner" }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;
  const createGroup = vi.fn<ChatChannelService["createGroup"]>(() =>
    Promise.resolve(succeededGroup),
  );
  const getOrCreateDirect = vi.fn<ChatChannelService["getOrCreateDirect"]>(() =>
    Promise.resolve(pendingDirect),
  );
  const getOperation = vi.fn<ChatChannelService["getOperation"]>(() =>
    Promise.resolve(pendingDirect),
  );
  return {
    createGroup,
    findByPrivyUserId,
    getOperation,
    getOrCreateDirect,
    internalUsers,
    service: {
      createGroup,
      getOrCreateDirect,
      getOperation,
    } satisfies ChatChannelService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

async function createHarness(input = dependencies()) {
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
  });
  registerChatChannelRoutes(
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

function headers(extra: Record<string, string | string[]> = {}) {
  return {
    authorization: `Bearer ${accessToken}`,
    "idempotency-key": operationId,
    ...extra,
  };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("Chat channel routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createHarness(input);
    apps.push(created.app);
    return created;
  }

  it("passes only the authenticated principal, client operation ID, body, and signal", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "POST",
      url: "/v1/chat/groups",
      headers: headers(),
      payload: {
        name: "Desk",
        friend_public_profile_ids: [firstProfileId, secondProfileId],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(succeededGroup);
    expectOperationalHeaders(response);
    const call = input.createGroup.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      principal: {
        userId: ownerUserId,
        privyUserId: "did:privy:chat-route-owner",
        streamUserId: "loop_11111111111141118111111111111111",
      },
      operationId,
      body: {
        name: "Desk",
        friend_public_profile_ids: [firstProfileId, secondProfileId],
      },
    });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns 202 with a stable polling location for a nonterminal command and GET", async () => {
    const input = await harness();
    const direct = await input.app.inject({
      method: "POST",
      url: "/v1/chat/direct-channels",
      headers: headers(),
      payload: { target_public_profile_id: firstProfileId },
    });
    const read = await input.app.inject({
      method: "GET",
      url: `/v1/chat/operations/${operationId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    for (const response of [direct, read]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(pendingDirect);
      expect(response.headers["location"]).toBe(
        `/v1/chat/operations/${operationId}`,
      );
      expect(response.headers["retry-after"]).toBe("2");
      expectOperationalHeaders(response);
    }
    expect(input.getOrCreateDirect).toHaveBeenCalledOnce();
    expect(input.getOperation).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", {}],
    ["duplicate", { "idempotency-key": [operationId, operationId] }],
    [
      "uppercase",
      { "idempotency-key": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ],
    ["non-v4", { "idempotency-key": "55555555-5555-1555-8555-555555555555" }],
  ])(
    "rejects a %s command idempotency header before authentication",
    async (_name, idempotency) => {
      const input = await harness();
      const response = await input.app.inject({
        method: "POST",
        url: "/v1/chat/direct-channels",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...idempotency,
        },
        payload: { target_public_profile_id: firstProfileId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe("invalid_request");
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(input.getOrCreateDirect).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed bodies, unknown query keys, and GET command headers", async () => {
    const input = await harness();
    const malformed = await input.app.inject({
      method: "POST",
      url: "/v1/chat/groups",
      headers: headers(),
      payload: {
        name: "Desk",
        friend_public_profile_ids: [firstProfileId, firstProfileId],
      },
    });
    const query = await input.app.inject({
      method: "POST",
      url: "/v1/chat/direct-channels?unexpected=1",
      headers: headers(),
      payload: { target_public_profile_id: firstProfileId },
    });
    const getHeader = await input.app.inject({
      method: "GET",
      url: `/v1/chat/operations/${operationId}`,
      headers: headers(),
    });

    for (const response of [malformed, query, getHeader]) {
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe("invalid_request");
    }
    expect(input.createGroup).not.toHaveBeenCalled();
    expect(input.getOrCreateDirect).not.toHaveBeenCalled();
    expect(input.getOperation).not.toHaveBeenCalled();
  });

  it("requires bootstrap after validating the Privy Bearer", async () => {
    const input = await harness(dependencies(false));
    const response = await input.app.inject({
      method: "POST",
      url: "/v1/chat/direct-channels",
      headers: headers(),
      payload: { target_public_profile_id: firstProfileId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe("bootstrap_required");
    expect(input.verifyAccessToken).toHaveBeenCalledOnce();
    expect(input.getOrCreateDirect).not.toHaveBeenCalled();
  });

  it.each([
    [new ChatChannelTargetUnavailableError(), 404, "target_unavailable"],
    [new ChatOperationNotFoundError(), 404, "chat_operation_not_found"],
    [new ChatChannelIdempotencyConflictError(), 409, "idempotency_conflict"],
    [new ChatChannelUnavailableError(), 503, "chat_unavailable"],
  ])(
    "maps bounded service failures without leaking provider or identity data",
    async (error, status, code) => {
      const input = dependencies();
      input.getOperation.mockRejectedValueOnce(error);
      const app = await harness(input);
      const response = await app.app.inject({
        method: "GET",
        url: `/v1/chat/operations/${operationId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(JSON.stringify(response.json())).not.toContain(ownerUserId);
      expectOperationalHeaders(response);
    },
  );
});
