import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BootstrapService } from "../features/identity/bootstrap-service.js";
import {
  AuthenticationUnavailableError,
  InvalidAccessTokenError,
} from "../integrations/privy/access-token-verifier.js";

const maximumAuthorizationHeaderLength = 8_192;
const bearerPattern =
  /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

type BootstrapErrorCode =
  | "invalid_request"
  | "authentication_required"
  | "invalid_access_token"
  | "authentication_unavailable";
type DocumentedErrorCode = BootstrapErrorCode | "internal_error";

function responseHeaders(includeBearerChallenge = false) {
  return {
    "cache-control": {
      type: "string",
      const: "no-store",
      description: "Always no-store for identity responses",
    },
    "x-request-id": {
      type: "string",
      format: "uuid",
      description: "Server-generated request correlation ID",
    },
    ...(includeBearerChallenge
      ? {
          "www-authenticate": {
            type: "string",
            const: 'Bearer realm="loop-api"',
            description: "Bearer authentication challenge",
          },
        }
      : {}),
  } as const;
}

function errorResponseSchema(codes: readonly DocumentedErrorCode[]) {
  return {
    type: "object",
    headers: responseHeaders(codes.includes("authentication_required")),
    additionalProperties: false,
    required: ["code", "message", "request_id"],
    properties: {
      code: { type: "string", enum: codes },
      message: { type: "string" },
      request_id: { type: "string", format: "uuid" },
    },
  } as const;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 400 | 401 | 503,
  code: BootstrapErrorCode,
  message: string,
) {
  reply.header("cache-control", "no-store");

  if (statusCode === 401) {
    reply.header("www-authenticate", 'Bearer realm="loop-api"');
  }

  return reply.code(statusCode).send({
    code,
    message,
    request_id: request.id,
  });
}

function parseBearerToken(
  request: FastifyRequest,
): { readonly token: string } | { readonly error: "missing" | "invalid" } {
  const authorizationValues: string[] = [];

  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index];

    if (name?.toLowerCase() === "authorization") {
      authorizationValues.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }

  if (authorizationValues.length === 0) {
    return { error: "missing" };
  }

  if (authorizationValues.length !== 1) {
    return { error: "invalid" };
  }

  const authorization = authorizationValues[0];

  if (
    authorization === undefined ||
    authorization.length > maximumAuthorizationHeaderLength
  ) {
    return { error: "invalid" };
  }

  const match = bearerPattern.exec(authorization);
  return match?.[1] === undefined ? { error: "invalid" } : { token: match[1] };
}

export function registerBootstrapRoute(
  app: FastifyInstance,
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
        response: {
          200: {
            type: "object",
            headers: responseHeaders(),
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
                pattern: "^loop_[a-z0-9_-]{8,58}$",
              },
            },
          },
          400: errorResponseSchema(["invalid_request"]),
          401: errorResponseSchema([
            "authentication_required",
            "invalid_access_token",
          ]),
          503: errorResponseSchema(["authentication_unavailable"]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;

      if (request.body !== undefined || Object.keys(query).length > 0) {
        return sendError(
          request,
          reply,
          400,
          "invalid_request",
          "The request is invalid.",
        );
      }

      const authorization = parseBearerToken(request);

      if ("error" in authorization) {
        return authorization.error === "missing"
          ? sendError(
              request,
              reply,
              401,
              "authentication_required",
              "Authentication is required.",
            )
          : sendError(
              request,
              reply,
              401,
              "invalid_access_token",
              "The access token is invalid.",
            );
      }

      try {
        const result = await bootstrapService.bootstrap(authorization.token);
        reply.header("cache-control", "no-store");
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof AuthenticationUnavailableError) {
          return sendError(
            request,
            reply,
            503,
            "authentication_unavailable",
            "Authentication is unavailable.",
          );
        }

        if (error instanceof InvalidAccessTokenError) {
          return sendError(
            request,
            reply,
            401,
            "invalid_access_token",
            "The access token is invalid.",
          );
        }

        throw error;
      }
    },
  );
}
