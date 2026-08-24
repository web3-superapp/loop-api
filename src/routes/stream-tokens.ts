import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { canonicalizeClientIp } from "../core/http/client-ip.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
  streamUserIdPattern,
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import {
  StreamTokenQuotaExceededError,
  StreamTokenUnavailableError,
  type StreamTokenService,
} from "../features/communication/stream-token-service.js";
import type { StreamTokenProduct } from "../integrations/stream/token-issuer.js";

const successResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["api_key", "token", "expires_at", "user"],
  properties: {
    api_key: { type: "string", minLength: 1, maxLength: 512 },
    token: { type: "string", minLength: 32, maxLength: 16_384 },
    expires_at: { type: "string", format: "date-time" },
    user: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: streamUserIdPattern },
      },
    },
  },
} as const;

function registerStreamTokenRoute(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: StreamTokenService,
  product: StreamTokenProduct,
): void {
  const label = product === "chat" ? "Chat" : "Video";

  app.post(
    `/v1/${product}/token`,
    {
      schema: {
        operationId: `issueStream${label}Token`,
        summary: `Issue a short-lived Stream ${label} token`,
        description: `Verifies the current Privy identity and issues a one-hour Stream ${label} user token for the server-derived Stream user ID.`,
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: successResponseSchema,
          400: errorResponseSchema(["invalid_request"]),
          401: errorResponseSchema(
            ["authentication_required", "invalid_access_token"],
            { includeBearerChallenge: true },
          ),
          409: errorResponseSchema(["bootstrap_required"]),
          429: errorResponseSchema(["rate_limit_exceeded"]),
          503: errorResponseSchema([
            "authentication_unavailable",
            "stream_unavailable",
            "request_timeout",
          ]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      const canonicalClientIp = canonicalizeClientIp(request.ip);

      try {
        const result = await service.issueToken({
          principal,
          product,
          canonicalClientIp,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof StreamTokenQuotaExceededError) {
          throw ApiError.rateLimitExceeded();
        }

        if (error instanceof StreamTokenUnavailableError) {
          throw ApiError.streamUnavailable();
        }

        throw error;
      }
    },
  );
}

export function registerStreamTokenRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: StreamTokenService,
): void {
  registerStreamTokenRoute(app, authenticateLoopBearer, service, "chat");
  registerStreamTokenRoute(app, authenticateLoopBearer, service, "video");
}
