import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
  blockListQuerySchema,
  blockListResourceSchema,
  blockRequestSchema,
  blockResourceSchema,
  commandErrors,
  connectionListQuerySchema,
  connectionListResourceSchema,
  followResourceSchema,
  messageRequestDecisionRequestSchema,
  messageRequestDecisionResourceSchema,
  messageRequestListResourceSchema,
  pageQuerySchema,
  publicProfileIdParamsSchema,
  readErrors,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * V2 social-graph routes (Decision 0031): the directed follow graph, the
 * owner-scoped block list, and the V2 adapter over the frozen V1
 * `friend_requests` storage. The V1 social routes are untouched.
 */

interface PublicProfileParams {
  readonly publicProfileId: string;
}

interface MessageRequestParams {
  readonly messageRequestId: string;
}

const messageRequestParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messageRequestId"],
  properties: {
    messageRequestId: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
  },
} as const;

function commandContext(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

export function registerV2SocialRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, communityService: service } = dependencies;

  app.post(
    "/v2/connections/follow/:publicProfileId",
    {
      schema: {
        operationId: "followV2Connection",
        summary: "Follow another account",
        description:
          "The follow graph is directed and needs no consent. A nonexistent, unactivated, non-discoverable, self, or blocked target all return the same non-enumerating NOT_FOUND.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: followResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as PublicProfileParams;
      const resource = await service.follow({
        principal: requireAuthenticatedLoopPrincipal(request),
        targetPublicProfileId: params.publicProfileId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/connections/follow/:publicProfileId",
    {
      schema: {
        operationId: "unfollowV2Connection",
        summary: "Stop following another account",
        description:
          "Idempotent: removing an edge that does not exist still succeeds and writes one audit row.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: followResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as PublicProfileParams;
      const resource = await service.unfollow({
        principal: requireAuthenticatedLoopPrincipal(request),
        targetPublicProfileId: params.publicProfileId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/connections",
    {
      schema: {
        operationId: "listV2Connections",
        summary: "List following or followers",
        description:
          "Owner-bound directed connections with the viewer's own follow state. Accounts the viewer has blocked are omitted; wallet addresses are never projected.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: connectionListQuerySchema,
        response: { 200: connectionListResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly direction?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listConnections({
        principal: requireAuthenticatedLoopPrincipal(request),
        direction: query.direction,
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/blocks",
    {
      schema: {
        operationId: "listV2Blocks",
        summary: "List blocked entities",
        description:
          "Only `kind=user` has storage in this step; `contract` and `domain` return CAPABILITY_UNAVAILABLE so the client can explain the disabled segments instead of showing a fixture.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: blockListQuerySchema,
        response: { 200: blockListResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly kind?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listBlocks({
        principal: requireAuthenticatedLoopPrincipal(request),
        kind: query.kind,
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/blocks",
    {
      schema: {
        operationId: "createV2Block",
        summary: "Block a user",
        description:
          "Blocking takes precedence over following and direct messages: both follow edges are removed in the same transaction. `contract` and `domain` are CAPABILITY_UNAVAILABLE.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: blockRequestSchema,
        response: { 200: blockResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.block({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/blocks",
    {
      schema: {
        operationId: "deleteV2Block",
        summary: "Unblock a user",
        description:
          "Removing a block never restores a follow edge; the caller must follow again explicitly.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: blockRequestSchema,
        response: { 200: blockResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.unblock({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/message-requests",
    {
      schema: {
        operationId: "listV2MessageRequests",
        summary: "List pending stranger message requests",
        description:
          "V2 projection over the frozen V1 friend_requests storage. Requests from blocked senders are omitted. Message previews and AI moderation flags have no backend and stay unavailable.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: pageQuerySchema,
        response: { 200: messageRequestListResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listMessageRequests({
        principal: requireAuthenticatedLoopPrincipal(request),
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/message-requests/:messageRequestId/decision",
    {
      schema: {
        operationId: "decideV2MessageRequest",
        summary: "Accept, ignore, or report a message request",
        description:
          "`accept` accepts the underlying V1 friend request; `ignore` rejects it with the V1 cooldown; `report` rejects it, blocks the sender, drops both follow edges, and appends the audit row in one transaction. An already decided or expired request is DATA_STALE.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: messageRequestParamsSchema,
        querystring: emptyQueryStringSchema,
        body: messageRequestDecisionRequestSchema,
        response: {
          200: messageRequestDecisionResourceSchema,
          ...commandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as MessageRequestParams;
      const resource = await service.decideMessageRequest({
        principal: requireAuthenticatedLoopPrincipal(request),
        messageRequestId: params.messageRequestId,
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
