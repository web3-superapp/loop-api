import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { canonicalizeClientIp } from "../../core/http/client-ip.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import type {
  V2ChatOperationResource,
  V2ChatService,
} from "../../features/communication/v2-chat-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoQuery,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import {
  chatGroupMembershipResourceSchema,
  chatGroupParamsSchema,
  chatOperationParamsSchema,
  chatOperationResourceSchema,
  communicationCommandErrors,
  communicationReadErrors,
  communicationTokenErrors,
  createChatGroupRequestSchema,
  createDirectChannelRequestSchema,
  pendingChatOperationResourceSchema,
  streamTokenResourceSchema,
} from "./communication-schemas.js";

/**
 * V2 chat wrapper (Decision 0032). It re-projects the frozen V1 chat surface:
 * camelCase fields, the seven-field V2 error envelope, and a
 * `/v2/chat/operations/{operationId}` locator. The operation state machine and
 * its idempotency binding are unchanged, and `/v1` is not touched.
 */

function commandMetadata(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

function sendOperation(
  reply: FastifyReply,
  resource: V2ChatOperationResource,
): FastifyReply {
  reply.header("cache-control", "no-store");
  if (!resource.terminal) {
    reply.header("location", `/v2/chat/operations/${resource.operationId}`);
    reply.header(
      "retry-after",
      String(Math.ceil((resource.retryAfterMs ?? 1_000) / 1_000)),
    );
    return reply.code(202).send(resource);
  }
  return reply.code(200).send(resource);
}

export function registerV2ChatRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: V2ChatService,
): void {
  for (const product of ["chat", "video"] as const) {
    const label = product === "chat" ? "Chat" : "Video";
    app.post(
      `/v2/${product}/token`,
      {
        schema: {
          operationId: `issueV2Stream${label}Token`,
          summary: `Issue a short-lived Stream ${label} token`,
          description: `Verifies the current Privy identity and issues a one-hour Stream ${label} user token for the server-derived Stream user ID. The token is never cached, persisted, or logged.`,
          tags: ["communication"],
          security: [{ privyBearer: [] }],
          headers: v2CommandHeadersSchema,
          querystring: emptyQueryStringSchema,
          response: {
            200: streamTokenResourceSchema,
            ...communicationTokenErrors,
          },
        },
        onRequest: validateCommandHeaders,
        preValidation: assertNoBodyOrQueryV2,
        preHandler: authenticateLoopBearer,
      },
      async (request, reply) => {
        const resource = await service.issueToken({
          principal: requireAuthenticatedLoopPrincipal(request),
          product,
          canonicalClientIp: canonicalizeClientIp(request.ip),
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }

  app.post(
    "/v2/chat/groups",
    {
      schema: {
        operationId: "createV2ChatGroup",
        summary: "Create a durable Stream group from accepted friends",
        description:
          "Persists a fixed Stream channel ID before one channel-creation attempt, rechecks friendship and social privacy, and reconciles an ambiguous provider result by that same ID. Friendship remains the only admission rule.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createChatGroupRequestSchema,
        response: {
          200: chatOperationResourceSchema,
          202: pendingChatOperationResourceSchema,
          ...communicationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.createGroup({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        signal: request.signal,
        ...commandMetadata(request),
      });
      return sendOperation(reply, resource);
    },
  );

  app.post(
    "/v2/chat/direct-channels",
    {
      schema: {
        operationId: "getOrCreateV2DirectChatChannel",
        summary:
          "Get or create the fixed direct channel for an accepted friend",
        description:
          "An accepted friendship (including one produced by accepting a message request) is the only admission rule for a DM. The unordered pair converges on one explicit Stream messaging CID.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createDirectChannelRequestSchema,
        response: {
          200: chatOperationResourceSchema,
          202: pendingChatOperationResourceSchema,
          ...communicationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getOrCreateDirect({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        signal: request.signal,
        ...commandMetadata(request),
      });
      return sendOperation(reply, resource);
    },
  );

  app.get(
    "/v2/chat/operations/:operationId",
    {
      schema: {
        operationId: "getV2ChatOperation",
        summary: "Get or reconcile an owner-bound chat channel operation",
        description:
          "operatorRequired is a terminal unresolved result, not a disguised failure. An unknown operation and a wrong owner return the same NOT_FOUND.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: chatOperationParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: chatOperationResourceSchema,
          202: pendingChatOperationResourceSchema,
          ...communicationReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly operationId: string };
      const resource = await service.getOperation({
        principal: requireAuthenticatedLoopPrincipal(request),
        operationId: params.operationId,
        requestId: request.id,
        signal: request.signal,
      });
      return sendOperation(reply, resource);
    },
  );

  app.delete(
    "/v2/chat/groups/:groupId/membership",
    {
      schema: {
        operationId: "leaveV2ChatGroup",
        summary: "Leave a small group",
        description:
          "Removes the caller from the Stream channel first and commits the LOOP membership removal only afterwards. Stream treats removing a non-member as a success, so an unknown provider result is safely retryable and never reports a leave that did not happen. The group creator cannot leave, and group member management stays unavailable.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: chatGroupParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: chatGroupMembershipResourceSchema,
          ...communicationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly groupId: string };
      const resource = await service.leaveGroup({
        principal: requireAuthenticatedLoopPrincipal(request),
        groupId: params.groupId,
        signal: request.signal,
        ...commandMetadata(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
