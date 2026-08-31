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
import { aliasSearchLimits } from "../features/identity/alias-contract.js";
import {
  parseSocialIdempotencyKey,
  socialListLimits,
} from "../features/social/social-contract.js";
import {
  SocialDomainError,
  type SocialDomainErrorCode,
  type SocialService,
} from "../features/social/social-service.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const uuidV4Pattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const profileCodePattern = "^[0-9A-HJKMNP-TV-Z]{10}$";
const avatarReferencePattern = "^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$";
const aliasPrefixPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const nullableAliasSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 40 }, { type: "null" }],
} as const;
const nullableAvatarSchema = {
  anyOf: [
    { type: "string", pattern: avatarReferencePattern, maxLength: 134 },
    { type: "null" },
  ],
} as const;
const nullableCursorSchema = {
  anyOf: [{ type: "string", minLength: 3, maxLength: 1_024 }, { type: "null" }],
} as const;
const socialPrivacyValuesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["friend_requests", "group_invites", "direct_messages"],
  properties: {
    friend_requests: { type: "string", enum: ["enabled", "disabled"] },
    group_invites: { type: "string", enum: ["friends", "disabled"] },
    direct_messages: { type: "string", enum: ["friends", "disabled"] },
  },
} as const;
const socialPrivacyResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "social_privacy", "updated_at"],
  properties: {
    version: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    social_privacy: socialPrivacyValuesSchema,
    updated_at: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
  headers: noStoreResponseHeaders(),
} as const;
const socialPrivacyReplacementSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version", "social_privacy"],
  properties: {
    expected_version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    social_privacy: socialPrivacyValuesSchema,
  },
} as const;
const presentationProperties = {
  public_profile_id: { type: "string", pattern: uuidPattern },
  profile_code: { type: "string", pattern: profileCodePattern },
  alias: nullableAliasSchema,
  avatar_ref: nullableAvatarSchema,
} as const;
const friendSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "public_profile_id",
    "profile_code",
    "alias",
    "avatar_ref",
    "accepted_at",
  ],
  properties: {
    ...presentationProperties,
    accepted_at: { type: "string", format: "date-time" },
  },
} as const;
const friendListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: {
      type: "array",
      maxItems: socialListLimits.maximum,
      items: friendSchema,
    },
    next_cursor: nullableCursorSchema,
  },
  headers: noStoreResponseHeaders(),
} as const;
const friendSearchItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "public_profile_id",
    "profile_code",
    "alias",
    "avatar_ref",
    "relationship",
    "friend_request_id",
  ],
  properties: {
    ...presentationProperties,
    alias: { type: "string", minLength: 1, maxLength: 40 },
    relationship: {
      type: "string",
      enum: ["none", "outgoing_pending", "incoming_pending", "friend"],
    },
    friend_request_id: {
      anyOf: [{ type: "string", pattern: uuidPattern }, { type: "null" }],
    },
  },
} as const;
const friendSearchResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "truncated"],
  properties: {
    items: {
      type: "array",
      maxItems: aliasSearchLimits.maximum,
      items: friendSearchItemSchema,
    },
    truncated: { type: "boolean" },
  },
  headers: noStoreResponseHeaders(),
} as const;
const counterpartySchema = {
  type: "object",
  additionalProperties: false,
  required: ["public_profile_id", "profile_code", "alias", "avatar_ref"],
  properties: presentationProperties,
} as const;
const friendRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "friend_request_id",
    "counterparty",
    "direction",
    "status",
    "created_at",
    "expires_at",
  ],
  properties: {
    friend_request_id: { type: "string", pattern: uuidPattern },
    counterparty: counterpartySchema,
    direction: { type: "string", enum: ["incoming", "outgoing"] },
    status: { type: "string", const: "pending" },
    created_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
  },
} as const;
const friendRequestListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: {
      type: "array",
      maxItems: socialListLimits.maximum,
      items: friendRequestSchema,
    },
    next_cursor: nullableCursorSchema,
  },
  headers: noStoreResponseHeaders(),
} as const;
const socialOperationResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["friend_request_id", "status"],
  properties: {
    friend_request_id: { type: "string", pattern: uuidPattern },
    status: {
      type: "string",
      enum: ["pending", "accepted", "rejected", "expired"],
    },
  },
} as const;
const socialOperationErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: {
      type: "string",
      enum: [
        "target_unavailable",
        "profile_required",
        "incoming_request_pending",
        "outgoing_request_pending",
        "already_friends",
        "friend_request_cooldown",
        "friend_request_not_found",
        "friend_request_already_decided",
      ],
    },
  },
} as const;
const socialOperationResponseSchema = {
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
    operation_id: { type: "string", pattern: uuidV4Pattern },
    kind: {
      type: "string",
      enum: ["friend_request_send", "friend_request_decide"],
    },
    status: { type: "string", enum: ["succeeded", "failed"] },
    terminal: { type: "boolean", const: true },
    retry_after_ms: { type: "null" },
    result: { anyOf: [socialOperationResultSchema, { type: "null" }] },
    error: { anyOf: [socialOperationErrorSchema, { type: "null" }] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  headers: noStoreResponseHeaders(),
} as const;

const paginationQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 3, maxLength: 1_024 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: socialListLimits.maximum,
    },
  },
} as const;
const friendSearchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias_prefix"],
  properties: {
    alias_prefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: aliasPrefixPattern,
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: aliasSearchLimits.maximum,
    },
  },
} as const;
const friendRequestListQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["direction", "status"],
  properties: {
    direction: { type: "string", enum: ["incoming", "outgoing"] },
    status: { type: "string", const: "pending" },
    cursor: { type: "string", minLength: 3, maxLength: 1_024 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: socialListLimits.maximum,
    },
  },
} as const;
const friendRequestSendSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target_public_profile_id"],
  properties: {
    target_public_profile_id: { type: "string", pattern: uuidPattern },
  },
} as const;
const friendRequestDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: { decision: { type: "string", enum: ["accept", "reject"] } },
} as const;
const friendRequestParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["friend_request_id"],
  properties: { friend_request_id: { type: "string", pattern: uuidPattern } },
} as const;
const operationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: { operation_id: { type: "string", pattern: uuidV4Pattern } },
} as const;
const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", pattern: uuidV4Pattern },
  },
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

const commonErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: localErrorSchema([
    "bootstrap_required",
    "version_conflict",
    "idempotency_conflict",
    "profile_required",
    "incoming_request_pending",
    "outgoing_request_pending",
    "already_friends",
    "friend_request_cooldown",
    "friend_request_already_decided",
  ]),
  429: localErrorSchema(["search_rate_limited", "social_rate_limited"]),
  503: localErrorSchema([
    "authentication_unavailable",
    "social_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

function rawQueryEntries(request: FastifyRequest): readonly [string, string][] {
  const rawUrl = request.raw.url;
  if (rawUrl === undefined) {
    throw ApiError.invalidRequest();
  }
  try {
    return [...new URL(rawUrl, "http://loop.invalid").searchParams.entries()];
  } catch {
    throw ApiError.invalidRequest();
  }
}

function hasRawBody(request: FastifyRequest): boolean {
  const contentLength = request.headers["content-length"];
  return (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  );
}

function assertRawQuery(
  request: FastifyRequest,
  allowed: ReadonlySet<string>,
  options: { readonly cursorLimitExclusive?: boolean } = {},
): void {
  const seen = new Set<string>();
  for (const [key] of rawQueryEntries(request)) {
    if (!allowed.has(key) || seen.has(key)) {
      throw ApiError.invalidRequest();
    }
    seen.add(key);
  }
  if (
    options.cursorLimitExclusive === true &&
    seen.has("cursor") &&
    seen.has("limit")
  ) {
    throw ApiError.invalidRequest();
  }
}

function hasIdempotencyHeader(request: FastifyRequest): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      return true;
    }
  }
  return false;
}

function createReadGuard(
  allowedQuery: readonly string[],
  cursorLimitExclusive = false,
): onRequestHookHandler {
  const allowed = new Set(allowedQuery);
  return (request, _reply, done): void => {
    try {
      if (hasRawBody(request) || hasIdempotencyHeader(request)) {
        throw ApiError.invalidRequest();
      }
      assertRawQuery(request, allowed, { cursorLimitExclusive });
    } catch (error) {
      done(error instanceof Error ? error : ApiError.invalidRequest());
      return;
    }
    done();
  };
}

function createWriteGuard(requireIdempotency: boolean): onRequestHookHandler {
  return (request, _reply, done): void => {
    try {
      assertRawQuery(request, new Set());
      if (requireIdempotency) {
        parseSocialIdempotencyKey(request.raw.rawHeaders);
      } else if (hasIdempotencyHeader(request)) {
        throw ApiError.invalidRequest();
      }
    } catch {
      done(ApiError.invalidRequest());
      return;
    }
    done();
  };
}

const errorMessages: Readonly<Record<SocialDomainErrorCode, string>> =
  Object.freeze({
    invalid_request: "The request is invalid.",
    social_unavailable: "Social features are unavailable.",
    search_rate_limited: "Alias search is temporarily rate limited.",
    social_rate_limited: "Social changes are temporarily rate limited.",
    version_conflict: "The resource has changed. Refresh and try again.",
    idempotency_conflict: "The idempotency key conflicts with another request.",
    target_unavailable: "The target is unavailable.",
    profile_required: "A public LOOP profile is required.",
    incoming_request_pending: "An incoming friend request is already pending.",
    outgoing_request_pending: "An outgoing friend request is already pending.",
    already_friends: "The users are already friends.",
    friend_request_cooldown: "Friend requests are temporarily unavailable.",
    friend_request_not_found: "The friend request does not exist.",
    friend_request_already_decided: "The friend request was already decided.",
    social_operation_not_found: "The social operation does not exist.",
  });

function errorStatus(code: SocialDomainErrorCode): 400 | 404 | 409 | 429 | 503 {
  switch (code) {
    case "invalid_request":
      return 400;
    case "target_unavailable":
    case "friend_request_not_found":
    case "social_operation_not_found":
      return 404;
    case "version_conflict":
    case "idempotency_conflict":
    case "profile_required":
    case "incoming_request_pending":
    case "outgoing_request_pending":
    case "already_friends":
    case "friend_request_cooldown":
    case "friend_request_already_decided":
      return 409;
    case "search_rate_limited":
    case "social_rate_limited":
      return 429;
    case "social_unavailable":
      return 503;
  }
}

function mapSocialError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!(error instanceof SocialDomainError)) {
    throw error;
  }
  const status = errorStatus(error.code);
  reply.header("cache-control", "no-store");
  if (status === 429) {
    reply.header("retry-after", "60");
  }
  return reply.code(status).send({
    code: error.code,
    message: errorMessages[error.code],
    request_id: request.id,
  });
}

function success(reply: FastifyReply, resource: unknown) {
  reply.header("cache-control", "no-store");
  return reply.code(200).send(resource);
}

export function registerSocialRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SocialService,
): void {
  app.get(
    "/v1/profile/social-privacy",
    {
      schema: {
        operationId: "getCurrentSocialPrivacy",
        summary: "Get fail-closed social privacy preferences",
        tags: ["profile", "social"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: { 200: socialPrivacyResourceSchema, ...commonErrors },
      },
      onRequest: createReadGuard([]),
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        return success(
          reply,
          await service.getSocialPrivacy({
            principal: requireAuthenticatedLoopPrincipal(request),
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.put(
    "/v1/profile/social-privacy",
    {
      schema: {
        operationId: "replaceCurrentSocialPrivacy",
        summary: "Replace social privacy preferences using CAS",
        tags: ["profile", "social"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: socialPrivacyReplacementSchema,
        response: { 200: socialPrivacyResourceSchema, ...commonErrors },
      },
      onRequest: createWriteGuard(false),
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        return success(
          reply,
          await service.replaceSocialPrivacy({
            principal: requireAuthenticatedLoopPrincipal(request),
            body: request.body,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/friends",
    {
      schema: {
        operationId: "listFriends",
        summary: "List accepted friends with opaque keyset pagination",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        querystring: paginationQuerySchema,
        response: { 200: friendListResponseSchema, ...commonErrors },
      },
      onRequest: createReadGuard(["cursor", "limit"], true),
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      try {
        return success(
          reply,
          await service.listFriends({
            principal: requireAuthenticatedLoopPrincipal(request),
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/friends/search",
    {
      schema: {
        operationId: "searchFriendsByAlias",
        summary: "Search discoverable public aliases with relationship state",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        querystring: friendSearchQuerySchema,
        response: { 200: friendSearchResponseSchema, ...commonErrors },
      },
      onRequest: createReadGuard(["alias_prefix", "limit"]),
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly alias_prefix?: unknown;
        readonly limit?: unknown;
      };
      try {
        return success(
          reply,
          await service.searchFriends({
            principal: requireAuthenticatedLoopPrincipal(request),
            aliasPrefix: query.alias_prefix,
            limit: query.limit,
            canonicalClientIp: canonicalizeClientIp(request.ip),
            signal: request.signal,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.post(
    "/v1/friend-requests",
    {
      schema: {
        operationId: "sendFriendRequest",
        summary: "Send an idempotent friend request",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: idempotencyHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: friendRequestSendSchema,
        response: {
          200: socialOperationResponseSchema,
          404: localErrorSchema(["target_unavailable"]),
          ...commonErrors,
        },
      },
      onRequest: createWriteGuard(true),
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        return success(
          reply,
          await service.sendFriendRequest({
            principal: requireAuthenticatedLoopPrincipal(request),
            requestId: request.id,
            idempotencyKey: parseSocialIdempotencyKey(request.raw.rawHeaders),
            body: request.body,
            canonicalClientIp: canonicalizeClientIp(request.ip),
            signal: request.signal,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/friend-requests",
    {
      schema: {
        operationId: "listFriendRequests",
        summary: "List incoming or outgoing pending friend requests",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        querystring: friendRequestListQuerySchema,
        response: { 200: friendRequestListResponseSchema, ...commonErrors },
      },
      onRequest: createReadGuard(
        ["direction", "status", "cursor", "limit"],
        true,
      ),
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly direction?: unknown;
        readonly status?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      try {
        return success(
          reply,
          await service.listFriendRequests({
            principal: requireAuthenticatedLoopPrincipal(request),
            direction: query.direction,
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.post(
    "/v1/friend-requests/:friend_request_id/decision",
    {
      schema: {
        operationId: "decideFriendRequest",
        summary: "Accept or reject a pending friend request",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: idempotencyHeadersSchema,
        params: friendRequestParamsSchema,
        querystring: emptyQueryStringSchema,
        body: friendRequestDecisionSchema,
        response: {
          200: socialOperationResponseSchema,
          404: localErrorSchema(["friend_request_not_found"]),
          ...commonErrors,
        },
      },
      onRequest: createWriteGuard(true),
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly friend_request_id: string };
      try {
        return success(
          reply,
          await service.decideFriendRequest({
            principal: requireAuthenticatedLoopPrincipal(request),
            requestId: request.id,
            idempotencyKey: parseSocialIdempotencyKey(request.raw.rawHeaders),
            friendRequestId: params.friend_request_id,
            body: request.body,
            canonicalClientIp: canonicalizeClientIp(request.ip),
            signal: request.signal,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );

  app.get(
    "/v1/social/operations/:operation_id",
    {
      schema: {
        operationId: "getSocialOperation",
        summary: "Get an owner-bound social command result",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        params: operationParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: socialOperationResponseSchema,
          404: localErrorSchema(["social_operation_not_found"]),
          ...commonErrors,
        },
      },
      onRequest: createReadGuard([]),
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly operation_id: string };
      try {
        return success(
          reply,
          await service.getOperation({
            principal: requireAuthenticatedLoopPrincipal(request),
            operationId: params.operation_id,
          }),
        );
      } catch (error) {
        return mapSocialError(error, request, reply);
      }
    },
  );
}
