import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import { assertNoBody } from "../core/http/request-input.js";
import {
  parseChatIdempotencyKey,
  parseCreateChatGroupRequest,
  parseCreateDirectChannelRequest,
  type ChatOperationResource,
} from "../features/communication/chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictError,
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  InvalidChatChannelServiceRequestError,
  type ChatChannelService,
} from "../features/communication/chat-channel-service.js";

const canonicalUuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const canonicalUuidV4Pattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const groupNamePattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      pattern: canonicalUuidV4Pattern,
      description:
        "Canonical lowercase UUIDv4. This same value is the durable operation_id.",
    },
  },
} as const;

const groupBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "friend_public_profile_ids"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: groupNamePattern,
      description:
        "Trimmed server-side and limited to 1-60 Unicode code points.",
    },
    friend_public_profile_ids: {
      type: "array",
      minItems: 2,
      maxItems: 29,
      uniqueItems: true,
      items: { type: "string", pattern: canonicalUuidPattern },
      description:
        "Two through twenty-nine accepted friends; the backend adds the caller.",
    },
  },
} as const;

const directBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["target_public_profile_id"],
  properties: {
    target_public_profile_id: {
      type: "string",
      pattern: canonicalUuidPattern,
    },
  },
} as const;

const operationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { type: "string", pattern: canonicalUuidV4Pattern },
  },
} as const;

const groupResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group_id", "name", "friend_public_profile_ids", "stream_cid"],
  properties: {
    group_id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 512 },
    friend_public_profile_ids: {
      type: "array",
      minItems: 2,
      maxItems: 29,
      uniqueItems: true,
      items: { type: "string", format: "uuid" },
    },
    stream_cid: {
      type: "string",
      pattern: "^messaging:loop_group_[a-z0-9_-]{8,}$",
    },
  },
} as const;

const directResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target_public_profile_id", "stream_cid"],
  properties: {
    target_public_profile_id: { type: "string", format: "uuid" },
    stream_cid: {
      type: "string",
      pattern: "^messaging:loop_direct_[a-z0-9_-]{8,}$",
    },
  },
} as const;

const operationResponseHeaders = {
  ...noStoreResponseHeaders(),
  location: {
    type: "string",
    pattern: `^/v1/chat/operations/${canonicalUuidV4Pattern.slice(1, -1)}$`,
    description: "Owner-bound polling location for a nonterminal operation",
  },
  "retry-after": {
    type: "string",
    pattern: "^[1-9][0-9]*$",
    description: "Minimum polling delay in seconds",
  },
} as const;

const operationResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation_id",
    "kind",
    "status",
    "terminal",
    "retry_after_ms",
    "result",
    "error",
    "created_at",
    "updated_at",
  ],
  properties: {
    operation_id: { type: "string", format: "uuid" },
    kind: {
      type: "string",
      enum: ["group_create", "direct_get_or_create"],
    },
    status: {
      type: "string",
      enum: [
        "pending",
        "submitting",
        "reconciling",
        "succeeded",
        "failed",
        "operator_required",
      ],
    },
    terminal: { type: "boolean" },
    retry_after_ms: {
      anyOf: [
        { type: "integer", minimum: 1, maximum: 60_000 },
        { type: "null" },
      ],
    },
    result: {
      anyOf: [groupResultSchema, directResultSchema, { type: "null" }],
    },
    error: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: {
            code: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,63}$",
            },
          },
        },
        { type: "null" },
      ],
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  headers: noStoreResponseHeaders(),
} as const;

const pendingOperationResourceSchema = {
  ...operationResourceSchema,
  headers: operationResponseHeaders,
} as const;

function localErrorSchema(codes: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["code", "message", "request_id"],
    properties: {
      code: { type: "string", enum: codes },
      message: { type: "string", minLength: 1 },
      request_id: { type: "string", format: "uuid" },
    },
    headers: noStoreResponseHeaders(),
  } as const;
}

const authenticationResponses = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  500: errorResponseSchema(["internal_error"]),
} as const;

function noQuery(request: FastifyRequest): void {
  const rawUrl = request.raw.url;
  if (
    rawUrl === undefined ||
    new URL(rawUrl, "http://loop.invalid").search !== ""
  ) {
    throw ApiError.invalidRequest();
  }
}

const commandGuard: onRequestHookHandler = (request, _reply, done): void => {
  try {
    noQuery(request);
    parseChatIdempotencyKey(request.raw.rawHeaders);
  } catch {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

const operationReadGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    noQuery(request);
    if (request.headers["idempotency-key"] !== undefined) {
      throw ApiError.invalidRequest();
    }
    const contentLength = request.headers["content-length"];
    if (
      (contentLength !== undefined && contentLength !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      throw ApiError.invalidRequest();
    }
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictGroupBody(request: FastifyRequest): Promise<void> {
  try {
    parseCreateChatGroupRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function assertStrictDirectBody(request: FastifyRequest): Promise<void> {
  try {
    parseCreateDirectChannelRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function sendLocalError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 404 | 503,
  code: "target_unavailable" | "chat_operation_not_found" | "chat_unavailable",
  message: string,
) {
  reply.header("cache-control", "no-store");
  return reply.code(statusCode).send({ code, message, request_id: request.id });
}

function mapChatChannelError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof InvalidChatChannelServiceRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof ChatChannelIdempotencyConflictError) {
    throw ApiError.idempotencyConflict();
  }
  if (error instanceof ChatChannelTargetUnavailableError) {
    return sendLocalError(
      request,
      reply,
      404,
      "target_unavailable",
      "The requested target is unavailable.",
    );
  }
  if (error instanceof ChatOperationNotFoundError) {
    return sendLocalError(
      request,
      reply,
      404,
      "chat_operation_not_found",
      "The Chat operation does not exist.",
    );
  }
  if (error instanceof ChatChannelUnavailableError) {
    return sendLocalError(
      request,
      reply,
      503,
      "chat_unavailable",
      "Chat channel coordination is unavailable.",
    );
  }
  throw error;
}

function sendOperation(reply: FastifyReply, resource: ChatOperationResource) {
  reply.header("cache-control", "no-store");
  if (!resource.terminal) {
    reply.header("location", `/v1/chat/operations/${resource.operation_id}`);
    reply.header(
      "retry-after",
      String(Math.ceil((resource.retry_after_ms ?? 1_000) / 1_000)),
    );
    return reply.code(202).send(resource);
  }
  return reply.code(200).send(resource);
}

export function registerChatChannelRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: ChatChannelService,
): void {
  app.post(
    "/v1/chat/groups",
    {
      schema: {
        operationId: "createChatGroup",
        summary: "Create a durable Stream group from accepted friends",
        description:
          "Persists a fixed Stream channel ID before one channel-creation attempt, rechecks friendship and social privacy, and reconciles ambiguous provider results by that same ID.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: idempotencyHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: groupBodySchema,
        response: {
          200: operationResourceSchema,
          202: pendingOperationResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["target_unavailable"]),
          409: errorResponseSchema([
            "bootstrap_required",
            "idempotency_conflict",
          ]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: commandGuard,
      preValidation: assertStrictGroupBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.createGroup({
          principal: requireAuthenticatedLoopPrincipal(request),
          operationId: parseChatIdempotencyKey(request.raw.rawHeaders),
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        return sendOperation(reply, resource);
      } catch (error) {
        return mapChatChannelError(error, request, reply);
      }
    },
  );

  app.post(
    "/v1/chat/direct-channels",
    {
      schema: {
        operationId: "getOrCreateDirectChatChannel",
        summary:
          "Get or create the fixed direct channel for an accepted friend",
        description:
          "The unordered friend pair converges on one explicit Stream messaging CID. The provider write is backend-only and durably reconcilable.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: idempotencyHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: directBodySchema,
        response: {
          200: operationResourceSchema,
          202: pendingOperationResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["target_unavailable"]),
          409: errorResponseSchema([
            "bootstrap_required",
            "idempotency_conflict",
          ]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: commandGuard,
      preValidation: assertStrictDirectBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getOrCreateDirect({
          principal: requireAuthenticatedLoopPrincipal(request),
          operationId: parseChatIdempotencyKey(request.raw.rawHeaders),
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        return sendOperation(reply, resource);
      } catch (error) {
        return mapChatChannelError(error, request, reply);
      }
    },
  );

  app.get<{ Params: { readonly operation_id: string } }>(
    "/v1/chat/operations/:operation_id",
    {
      schema: {
        operationId: "getChatOperation",
        summary: "Get or reconcile an owner-bound Chat channel operation",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        params: operationParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: operationResourceSchema,
          202: pendingOperationResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["chat_operation_not_found"]),
          409: errorResponseSchema(["bootstrap_required"]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: operationReadGuard,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getOperation({
          principal: requireAuthenticatedLoopPrincipal(request),
          operationId: request.params.operation_id,
          requestId: request.id,
          signal: request.signal,
        });
        return sendOperation(reply, resource);
      } catch (error) {
        return mapChatChannelError(error, request, reply);
      }
    },
  );
}
