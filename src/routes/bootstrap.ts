import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { requireAuthenticatedPrivyPrincipal } from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
  streamUserIdPattern,
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import type { BootstrapService } from "../features/identity/bootstrap-service.js";

export function registerBootstrapRoute(
  app: FastifyInstance,
  authenticatePrivyBearer: preHandlerAsyncHookHandler,
  bootstrapService: BootstrapService,
): void {
  app.post(
    "/v1/bootstrap",
    {
      schema: {
        operationId: "bootstrapCurrentUser",
        summary: "Bootstrap the authenticated LOOP user",
        description:
          "Verifies a current Privy access token and returns the server-derived LOOP and Stream user IDs.",
        tags: ["identity"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            type: "object",
            headers: noStoreResponseHeaders(),
            additionalProperties: false,
            required: ["user", "stream_user_id"],
            properties: {
              user: {
                type: "object",
                additionalProperties: false,
                required: ["id"],
                properties: {
                  id: { type: "string", format: "uuid" },
                },
              },
              stream_user_id: {
                type: "string",
                pattern: streamUserIdPattern,
              },
            },
          },
          400: errorResponseSchema(["invalid_request"]),
          401: errorResponseSchema(
            ["authentication_required", "invalid_access_token"],
            { includeBearerChallenge: true },
          ),
          503: errorResponseSchema([
            "authentication_unavailable",
            "request_timeout",
          ]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticatePrivyBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedPrivyPrincipal(request);
      const result = await bootstrapService.bootstrap(principal);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(result);
    },
  );
}
