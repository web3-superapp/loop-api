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
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import { assertNoBody } from "../core/http/request-input.js";
import { aliasSearchLimits } from "../features/identity/alias-contract.js";
import { AliasSearchRateLimitedError } from "../features/identity/alias-search-quota.js";
import {
  InvalidPublicAliasSearchRequestError,
  PublicAliasSearchUnavailableError,
  type PublicAliasSearchService,
} from "../features/identity/public-alias-search-service.js";

const aliasPrefixPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias_prefix"],
  properties: {
    alias_prefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: aliasPrefixPattern,
      description:
        "Literal alias prefix. After trimming, NFKC normalization, and ASCII-space folding it must contain 2-40 Unicode code points; wildcard and fuzzy matching are not supported.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: aliasSearchLimits.maximum,
      default: aliasSearchLimits.default,
    },
  },
} as const;

const successResponseSchema = {
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
        required: ["public_profile_id", "profile_code", "alias", "avatar_ref"],
        properties: {
          public_profile_id: { type: "string", format: "uuid" },
          profile_code: {
            type: "string",
            pattern: "^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$",
            description:
              "Immutable globally unique display discriminator. It is not accepted as an authorization or command target.",
          },
          alias: { type: "string", minLength: 1, maxLength: 40 },
          avatar_ref: {
            anyOf: [
              {
                type: "string",
                pattern: "^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$",
              },
              { type: "null" },
            ],
          },
        },
      },
    },
    truncated: {
      type: "boolean",
      description:
        "True when the caller should narrow the prefix; no total count or deep-pagination cursor is exposed.",
    },
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

const rawSearchGuard: onRequestHookHandler = (request, _reply, done): void => {
  try {
    const contentLength = request.headers["content-length"];
    if (
      (contentLength !== undefined && contentLength !== "0") ||
      request.headers["transfer-encoding"] !== undefined ||
      request.headers["idempotency-key"] !== undefined
    ) {
      throw ApiError.invalidRequest();
    }
    const seen = new Set<string>();
    for (const [key] of rawQueryEntries(request)) {
      if ((key !== "alias_prefix" && key !== "limit") || seen.has(key)) {
        throw ApiError.invalidRequest();
      }
      seen.add(key);
    }
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function sendLocalError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 429 | 503,
  code: "search_rate_limited" | "discovery_unavailable",
  message: string,
) {
  reply.header("cache-control", "no-store");
  return reply.code(statusCode).send({
    code,
    message,
    request_id: request.id,
  });
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PublicAliasSearchService,
): void {
  app.get(
    "/v1/discovery/users",
    {
      schema: {
        operationId: "searchDiscoverableUsersByAlias",
        summary: "Search discoverable LOOP users by public alias prefix",
        description:
          "Returns other users' opt-in public Profile presentation fields, including an immutable profile code for distinguishing duplicate aliases. The complete public_profile_id remains the only command target. Group aliases, LOOP IDs, Stream IDs, wallets, group memberships, total counts, and deep pagination are never exposed.",
        tags: ["discovery"],
        security: [{ privyBearer: [] }],
        querystring: searchQuerySchema,
        response: {
          200: successResponseSchema,
          400: errorResponseSchema(["invalid_request"]),
          401: errorResponseSchema(
            ["authentication_required", "invalid_access_token"],
            { includeBearerChallenge: true },
          ),
          409: errorResponseSchema(["bootstrap_required"]),
          429: localErrorSchema(["search_rate_limited"]),
          503: localErrorSchema([
            "authentication_unavailable",
            "discovery_unavailable",
            "request_timeout",
          ]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
      onRequest: rawSearchGuard,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly alias_prefix?: unknown;
        readonly limit?: unknown;
      };
      try {
        const resource = await service.search({
          principal: requireAuthenticatedLoopPrincipal(request),
          aliasPrefix: query.alias_prefix,
          limit: query.limit,
          canonicalClientIp: canonicalizeClientIp(request.ip),
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        if (error instanceof InvalidPublicAliasSearchRequestError) {
          throw ApiError.invalidRequest();
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
        if (error instanceof PublicAliasSearchUnavailableError) {
          return sendLocalError(
            request,
            reply,
            503,
            "discovery_unavailable",
            "Alias discovery is unavailable.",
          );
        }
        throw error;
      }
    },
  );
}
