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
  WatchlistVersionConflictError,
  parseWatchlistReplaceRequest,
  WATCHLIST_MAX_GROUPS,
  WATCHLIST_MAX_ITEMS,
} from "../features/watchlist/watchlist-contract.js";
import {
  InvalidWatchlistRequestError,
  type WatchlistService,
} from "../features/watchlist/watchlist-service.js";

const groupKeyPattern = "^[a-z0-9][a-z0-9_-]{0,31}$";
const assetKeyPattern = "^[A-Z0-9][A-Z0-9:_-]{0,63}$";

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["asset_key"],
  properties: {
    asset_key: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: assetKeyPattern,
    },
  },
} as const;

const inputGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "name", "items"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      pattern: groupKeyPattern,
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Untrusted display text; the server trims it and permits at most 40 Unicode code points after trimming",
    },
    items: {
      type: "array",
      maxItems: WATCHLIST_MAX_ITEMS,
      items: itemSchema,
    },
  },
} as const;

const inputGroupsSchema = {
  type: "array",
  maxItems: WATCHLIST_MAX_GROUPS,
  description:
    "Complete snapshot with at most 20 groups and at most 100 items in aggregate across all groups.",
  items: inputGroupSchema,
} as const;

const responseGroupSchema = {
  ...inputGroupSchema,
  properties: {
    ...inputGroupSchema.properties,
    name: { type: "string", minLength: 1, maxLength: 40 },
  },
} as const;

const responseGroupsSchema = {
  type: "array",
  maxItems: WATCHLIST_MAX_GROUPS,
  description:
    "Committed snapshot with at most 20 groups and at most 100 items in aggregate across all groups.",
  items: responseGroupSchema,
} as const;

const replaceRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version", "groups"],
  properties: {
    expected_version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    groups: inputGroupsSchema,
  },
} as const;

const watchlistResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "groups", "updated_at"],
  properties: {
    version: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_647,
    },
    groups: responseGroupsSchema,
    updated_at: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
} as const;

const authenticationErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  503: errorResponseSchema(["authentication_unavailable", "request_timeout"]),
  500: errorResponseSchema(["internal_error"]),
} as const;

const readErrors = {
  ...authenticationErrors,
  409: errorResponseSchema(["bootstrap_required"]),
} as const;

const replaceErrors = {
  ...authenticationErrors,
  409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
} as const;

function hasRawHeader(
  rawHeaders: readonly string[],
  expectedName: string,
): boolean {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

const rejectPutIdempotencyKey: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  if (hasRawHeader(request.raw.rawHeaders, "idempotency-key")) {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

function assertNoRawRequestBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    transferEncoding !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
}

const noRawBodyGuard: onRequestHookHandler = (request, _reply, done): void => {
  try {
    assertNoRawRequestBody(request);
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictReplaceInput(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }

  try {
    parseWatchlistReplaceRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapWatchlistError(error: unknown): never {
  if (error instanceof InvalidWatchlistRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof WatchlistVersionConflictError) {
    throw ApiError.versionConflict();
  }
  throw error;
}

export function registerWatchlistRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: WatchlistService,
): void {
  app.get(
    "/v1/watchlist",
    {
      schema: {
        operationId: "getWatchlist",
        summary: "Get the current user's Watchlist",
        description:
          "Returns the authenticated owner's grouped and ordered asset references. Asset keys are preferences, not proof that a market exists or is tradable.",
        tags: ["watchlist"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: { 200: watchlistResponseSchema, ...readErrors },
      },
      onRequest: noRawBodyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const snapshot = await service.get({ principal });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(snapshot);
      } catch (error) {
        return mapWatchlistError(error);
      }
    },
  );

  app.put(
    "/v1/watchlist",
    {
      schema: {
        operationId: "replaceWatchlist",
        summary: "Replace the current user's Watchlist",
        description:
          "Atomically replaces the complete owner-bound grouped snapshot using optimistic version control. Idempotency-Key is prohibited; an identical already-applied snapshot is a deterministic retry.",
        tags: ["watchlist"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: replaceRequestSchema,
        response: { 200: watchlistResponseSchema, ...replaceErrors },
      },
      onRequest: rejectPutIdempotencyKey,
      preValidation: assertStrictReplaceInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const snapshot = await service.replace({
          principal,
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(snapshot);
      } catch (error) {
        return mapWatchlistError(error);
      }
    },
  );
}
