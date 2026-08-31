import type {
  FastifyInstance,
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
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import {
  parseReplacePrivacyRequest,
  parseReplaceProfileRequest,
} from "../features/profile/profile-contract.js";
import {
  InvalidProfileRequestError,
  ProfileVersionConflictError,
  type ProfileService,
} from "../features/profile/profile-service.js";

const avatarReferencePattern = "^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$";
const aliasInputPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const nullableAliasSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: 40,
      description:
        "Trimmed untrusted display alias; 1-40 Unicode code points with control, bidirectional-control, and invisible formatting characters rejected.",
    },
    { type: "null" },
  ],
} as const;

const nullableAliasInputSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: aliasInputPattern,
      description:
        "Normalized by trimming, then limited to 1-40 Unicode code points; control, bidirectional-control, and invisible formatting characters are rejected.",
    },
    { type: "null" },
  ],
} as const;

const nullableAvatarReferenceSchema = {
  anyOf: [
    {
      type: "string",
      pattern: avatarReferencePattern,
      maxLength: 134,
      description:
        "Opaque LOOP avatar reference. Arbitrary URLs and signed URLs are not accepted.",
    },
    { type: "null" },
  ],
} as const;

const profileValuesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias", "avatar_ref"],
  properties: {
    alias: nullableAliasSchema,
    avatar_ref: nullableAvatarReferenceSchema,
  },
} as const;

const profileValuesInputSchema = {
  ...profileValuesSchema,
  properties: {
    alias: nullableAliasInputSchema,
    avatar_ref: nullableAvatarReferenceSchema,
  },
} as const;

const privacyValuesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["discoverable", "copy_trade_visibility"],
  properties: {
    discoverable: { type: "boolean" },
    copy_trade_visibility: {
      type: "string",
      enum: ["private", "followers", "public"],
      description:
        "Presentation preference only; it does not grant copy-trading authorization.",
    },
  },
} as const;

const profileResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "profile", "updated_at"],
  properties: {
    version: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    profile: profileValuesSchema,
    updated_at: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
} as const;

const privacyResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "privacy", "updated_at"],
  properties: {
    version: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    privacy: privacyValuesSchema,
    updated_at: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
} as const;

const replaceProfileRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version", "profile"],
  properties: {
    expected_version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    profile: profileValuesInputSchema,
  },
} as const;

const replacePrivacyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version", "privacy"],
  properties: {
    expected_version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    privacy: privacyValuesSchema,
  },
} as const;

const commonErrorResponses = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  503: errorResponseSchema(["authentication_unavailable", "request_timeout"]),
  500: errorResponseSchema(["internal_error"]),
} as const;

function hasRawHeader(request: FastifyRequest, expectedName: string): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

const forbidClientIdempotencyHeader: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  if (hasRawHeader(request, "idempotency-key")) {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

const forbidRawBody: onRequestHookHandler = (request, _reply, done): void => {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

function assertProfileBody(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseReplaceProfileRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function assertPrivacyBody(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseReplacePrivacyRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapProfileError(error: unknown): never {
  if (error instanceof InvalidProfileRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof ProfileVersionConflictError) {
    throw ApiError.versionConflict();
  }
  throw error;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: ProfileService,
): void {
  app.get(
    "/v1/profile",
    {
      schema: {
        operationId: "getCurrentProfile",
        summary: "Get the authenticated LOOP user's Profile",
        description:
          "Returns owner-bound presentation data. A missing row is represented as an explicit version-0 default without writing to PostgreSQL.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            ...profileResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...commonErrorResponses,
          409: errorResponseSchema(["bootstrap_required"]),
        },
      },
      onRequest: forbidRawBody,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getProfile({
          principal: requireAuthenticatedLoopPrincipal(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapProfileError(error);
      }
    },
  );

  app.put(
    "/v1/profile",
    {
      schema: {
        operationId: "replaceCurrentProfile",
        summary: "Replace the authenticated LOOP user's Profile",
        description:
          "Atomically replaces normalized presentation data using an expected version. Idempotency-Key is not accepted; an identical lost-response retry returns the committed resource.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: replaceProfileRequestSchema,
        response: {
          200: {
            ...profileResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...commonErrorResponses,
          409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
        },
      },
      onRequest: forbidClientIdempotencyHeader,
      preValidation: assertProfileBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.replaceProfile({
          principal: requireAuthenticatedLoopPrincipal(request),
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapProfileError(error);
      }
    },
  );

  app.get(
    "/v1/profile/privacy",
    {
      schema: {
        operationId: "getCurrentPrivacyPreferences",
        summary: "Get the authenticated LOOP user's privacy preferences",
        description:
          "Returns fail-closed owner-only defaults without creating a row. Copy-trade visibility is not authorization.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            ...privacyResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...commonErrorResponses,
          409: errorResponseSchema(["bootstrap_required"]),
        },
      },
      onRequest: forbidRawBody,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getPrivacy({
          principal: requireAuthenticatedLoopPrincipal(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapProfileError(error);
      }
    },
  );

  app.put(
    "/v1/profile/privacy",
    {
      schema: {
        operationId: "replaceCurrentPrivacyPreferences",
        summary: "Replace the authenticated LOOP user's privacy preferences",
        description:
          "Atomically replaces fail-closed presentation preferences using an expected version. This does not grant copy-trading rights or create a relationship graph.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: replacePrivacyRequestSchema,
        response: {
          200: {
            ...privacyResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...commonErrorResponses,
          409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
        },
      },
      onRequest: forbidClientIdempotencyHeader,
      preValidation: assertPrivacyBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.replacePrivacy({
          principal: requireAuthenticatedLoopPrincipal(request),
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapProfileError(error);
      }
    },
  );
}
