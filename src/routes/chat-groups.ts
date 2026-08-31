import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { canonicalizeClientIp } from "../core/http/client-ip.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import { assertNoBody } from "../core/http/request-input.js";
import {
  ChatGroupAliasUnavailableError,
  ChatGroupNotFoundError,
  CurrentGroupAliasNotFoundError,
  GroupAliasImmutableError,
  GroupAliasUnavailableError,
  InvalidChatGroupAliasRequestError,
  type ChatGroupAliasService,
} from "../features/communication/chat-group-alias-service.js";
import { aliasSearchLimits } from "../features/identity/alias-contract.js";
import { AliasSearchRateLimitedError } from "../features/identity/alias-search-quota.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const aliasInputPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const groupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group_id"],
  properties: { group_id: { type: "string", pattern: uuidPattern } },
} as const;

const resolveBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["stream_channel_id"],
  properties: {
    stream_channel_id: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      description:
        "Untrusted locator for an existing messaging channel; the backend verifies current membership and never creates or joins the channel.",
    },
  },
} as const;

const aliasBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias"],
  properties: {
    alias: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: aliasInputPattern,
      description:
        "First successful value becomes permanently immutable in this group; normalized aliases are unique within the group.",
    },
  },
} as const;

const aliasSearchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias_prefix"],
  properties: {
    alias_prefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: aliasInputPattern,
      description:
        "Literal group-alias prefix. After trimming, NFKC normalization, and ASCII-space folding it must contain 2-40 Unicode code points.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: aliasSearchLimits.maximum,
      default: aliasSearchLimits.default,
    },
  },
} as const;

const groupResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group_id"],
  properties: { group_id: { type: "string", format: "uuid" } },
  headers: noStoreResponseHeaders(),
} as const;

const aliasResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group_alias_id", "alias", "projection_state"],
  properties: {
    group_alias_id: { type: "string", format: "uuid" },
    alias: { type: "string", minLength: 1, maxLength: 40 },
    projection_state: { type: "string", enum: ["pending", "confirmed"] },
  },
  headers: noStoreResponseHeaders(),
} as const;

const aliasSearchResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "truncated"],
  properties: {
    items: {
      type: "array",
      maxItems: aliasSearchLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["group_alias_id", "alias"],
        properties: {
          group_alias_id: { type: "string", format: "uuid" },
          alias: { type: "string", minLength: 1, maxLength: 40 },
        },
      },
    },
    truncated: { type: "boolean" },
  },
  headers: noStoreResponseHeaders(),
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

function rawGuard(allowedQueryKeys: ReadonlySet<string>): onRequestHookHandler {
  return (request, _reply, done): void => {
    try {
      if (request.headers["idempotency-key"] !== undefined) {
        throw ApiError.invalidRequest();
      }
      const rawUrl = request.raw.url;
      if (rawUrl === undefined) {
        throw ApiError.invalidRequest();
      }
      const seen = new Set<string>();
      for (const [key] of new URL(
        rawUrl,
        "http://loop.invalid",
      ).searchParams.entries()) {
        if (!allowedQueryKeys.has(key) || seen.has(key)) {
          throw ApiError.invalidRequest();
        }
        seen.add(key);
      }
      if (request.method === "GET") {
        const contentLength = request.headers["content-length"];
        if (
          (contentLength !== undefined && contentLength !== "0") ||
          request.headers["transfer-encoding"] !== undefined
        ) {
          throw ApiError.invalidRequest();
        }
      }
    } catch (error) {
      done(error instanceof Error ? error : ApiError.invalidRequest());
      return;
    }
    done();
  };
}

const noQueryGuard = rawGuard(new Set());
const aliasSearchGuard = rawGuard(new Set(["alias_prefix", "limit"]));

function sendLocalError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 404 | 409 | 429 | 503,
  code:
    | "not_found"
    | "group_alias_immutable"
    | "group_alias_unavailable"
    | "search_rate_limited"
    | "chat_group_unavailable",
  message: string,
) {
  reply.header("cache-control", "no-store");
  return reply.code(statusCode).send({
    code,
    message,
    request_id: request.id,
  });
}

function mapChatGroupError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof InvalidChatGroupAliasRequestError) {
    throw ApiError.invalidRequest();
  }
  if (
    error instanceof ChatGroupNotFoundError ||
    error instanceof CurrentGroupAliasNotFoundError
  ) {
    return sendLocalError(
      request,
      reply,
      404,
      "not_found",
      "The requested resource does not exist.",
    );
  }
  if (error instanceof GroupAliasImmutableError) {
    return sendLocalError(
      request,
      reply,
      409,
      "group_alias_immutable",
      "The group alias cannot be changed.",
    );
  }
  if (error instanceof GroupAliasUnavailableError) {
    return sendLocalError(
      request,
      reply,
      409,
      "group_alias_unavailable",
      "The group alias is unavailable.",
    );
  }
  if (error instanceof AliasSearchRateLimitedError) {
    return sendLocalError(
      request,
      reply,
      429,
      "search_rate_limited",
      "Alias search is temporarily rate limited.",
    );
  }
  if (error instanceof ChatGroupAliasUnavailableError) {
    return sendLocalError(
      request,
      reply,
      503,
      "chat_group_unavailable",
      "Chat group aliases are unavailable.",
    );
  }
  throw error;
}

export function registerChatGroupRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: ChatGroupAliasService,
): void {
  app.post(
    "/v1/chat/groups/resolve",
    {
      schema: {
        operationId: "resolveExistingStreamGroup",
        summary: "Resolve an existing Stream messaging channel to a LOOP group",
        description:
          "Verifies that the authenticated Stream identity is already a channel member. It never creates a channel, joins a user, adds a member, or grants a role.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: resolveBodySchema,
        response: {
          200: groupResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["not_found"]),
          409: errorResponseSchema(["bootstrap_required"]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_group_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: noQueryGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const body = request.body as { readonly stream_channel_id?: unknown };
      try {
        const resource = await service.resolveGroup({
          principal: requireAuthenticatedLoopPrincipal(request),
          streamChannelId: body.stream_channel_id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapChatGroupError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/chat/groups/:group_id/me/alias",
    {
      schema: {
        operationId: "getCurrentGroupAlias",
        summary: "Get the authenticated member's immutable group alias",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        params: groupParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: aliasResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["not_found"]),
          409: errorResponseSchema(["bootstrap_required"]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_group_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: noQueryGuard,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly group_id?: unknown };
      try {
        const resource = await service.getCurrentAlias({
          principal: requireAuthenticatedLoopPrincipal(request),
          groupId: params.group_id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapChatGroupError(error, request, reply);
      }
    },
  );

  app.put(
    "/v1/chat/groups/:group_id/me/alias",
    {
      schema: {
        operationId: "putCurrentGroupAlias",
        summary: "Reserve and project the authenticated member's group alias",
        description:
          "The first committed alias is permanent for this user and group. A byte-identical retry is safe; any different alias conflicts, including after leaving and rejoining.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        params: groupParamsSchema,
        querystring: emptyQueryStringSchema,
        body: aliasBodySchema,
        response: {
          200: aliasResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["not_found"]),
          409: localErrorSchema([
            "bootstrap_required",
            "group_alias_immutable",
            "group_alias_unavailable",
          ]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_group_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: noQueryGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly group_id?: unknown };
      const body = request.body as { readonly alias?: unknown };
      try {
        const resource = await service.putCurrentAlias({
          principal: requireAuthenticatedLoopPrincipal(request),
          groupId: params.group_id,
          alias: body.alias,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapChatGroupError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/chat/groups/:group_id/aliases",
    {
      schema: {
        operationId: "searchCurrentGroupAliases",
        summary: "Search current group members by immutable group alias prefix",
        description:
          "The requester and every returned candidate are revalidated against Stream membership. The requester and pending projections are omitted. Results expose no global profile, LOOP, Stream, wallet, or cross-group identity.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        params: groupParamsSchema,
        querystring: aliasSearchQuerySchema,
        response: {
          200: aliasSearchResourceSchema,
          ...authenticationResponses,
          404: localErrorSchema(["not_found"]),
          409: errorResponseSchema(["bootstrap_required"]),
          429: localErrorSchema(["search_rate_limited"]),
          503: localErrorSchema([
            "authentication_unavailable",
            "chat_group_unavailable",
            "request_timeout",
          ]),
        },
      },
      onRequest: aliasSearchGuard,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly group_id?: unknown };
      const query = request.query as {
        readonly alias_prefix?: unknown;
        readonly limit?: unknown;
      };
      try {
        const resource = await service.searchAliases({
          principal: requireAuthenticatedLoopPrincipal(request),
          groupId: params.group_id,
          aliasPrefix: query.alias_prefix,
          limit: query.limit,
          canonicalClientIp: canonicalizeClientIp(request.ip),
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapChatGroupError(error, request, reply);
      }
    },
  );
}
