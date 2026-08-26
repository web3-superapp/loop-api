import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import { emptyQueryStringSchema } from "../core/http/schemas.js";
import { parseSpotAgentAuthorizationSignatureRequest } from "../features/spot/spot-agent-authorization-contract.js";
import {
  SpotAgentAuthorizationExpiredError,
  SpotAgentAuthorizationNotFoundError,
  type SpotAgentAuthorizationService,
} from "../features/spot/spot-agent-authorization-service.js";
import {
  mapCommonSpotError,
  noBodyOrClientIdempotencyGuard,
  rejectClientIdempotencyGuard,
  spotApiError,
  spotAuthenticationErrors,
  spotErrorResponseSchema,
} from "./spot-http.js";
import {
  spotAgentAuthorizationCreationResourceSchema,
  spotAgentAuthorizationResourceSchema,
  spotAgentSignatureRequestSchema,
  uuidSchema,
} from "./spot-route-schemas.js";

const authorizationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authorization_id"],
  properties: { authorization_id: uuidSchema },
} as const;

function assertStrictSignatureInput(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseSpotAgentAuthorizationSignatureRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapAuthorizationError(error: unknown): never {
  if (error instanceof SpotAgentAuthorizationNotFoundError) {
    throw spotApiError(
      404,
      "spot_agent_authorization_not_found",
      "The Spot Agent authorization does not exist.",
    );
  }
  if (error instanceof SpotAgentAuthorizationExpiredError) {
    throw spotApiError(
      409,
      "spot_agent_authorization_expired",
      "The Spot Agent authorization has expired.",
    );
  }
  return mapCommonSpotError(error);
}

export function registerSpotAgentAuthorizationRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SpotAgentAuthorizationService,
): void {
  app.post(
    "/v1/spot/agent-authorizations",
    {
      schema: {
        operationId: "issueSpotAgentAuthorization",
        summary: "Create a one-time Testnet approveAgent handoff",
        description:
          "Returns one short-lived server-built public signing payload. The client cannot select or edit its Agent, nonce, domain, or action.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          201: spotAgentAuthorizationCreationResourceSchema,
          ...spotAuthenticationErrors,
          409: spotErrorResponseSchema([
            "bootstrap_required",
            "wallet_binding_required",
          ]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.issue({
          principal: requireAuthenticatedLoopPrincipal(request),
          requestId: request.id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(201).send(resource);
      } catch (error) {
        return mapAuthorizationError(error);
      }
    },
  );

  app.get<{ Params: { readonly authorization_id: string } }>(
    "/v1/spot/agent-authorizations/:authorization_id",
    {
      schema: {
        operationId: "getSpotAgentAuthorization",
        summary: "Get sanitized Spot Agent-authorization status",
        description:
          "Returns only owner-scoped durable status. The one-time payload, Agent address, nonce, signature, and typed data are never returned.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        params: authorizationParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: spotAgentAuthorizationResourceSchema,
          ...spotAuthenticationErrors,
          404: spotErrorResponseSchema(["spot_agent_authorization_not_found"]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.get({
          principal: requireAuthenticatedLoopPrincipal(request),
          authorizationId: request.params.authorization_id,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapAuthorizationError(error);
      }
    },
  );

  app.post<{ Params: { readonly authorization_id: string } }>(
    "/v1/spot/agent-authorizations/:authorization_id/signatures",
    {
      schema: {
        operationId: "submitSpotAgentAuthorizationSignature",
        summary: "Submit the expected owner signature",
        description:
          "Accepts only the transient opaque Privy result for the stored handoff and journals no more than one relay attempt.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        params: authorizationParamsSchema,
        querystring: emptyQueryStringSchema,
        body: spotAgentSignatureRequestSchema,
        response: {
          200: spotAgentAuthorizationResourceSchema,
          ...spotAuthenticationErrors,
          404: spotErrorResponseSchema(["spot_agent_authorization_not_found"]),
          409: spotErrorResponseSchema([
            "bootstrap_required",
            "wallet_binding_required",
            "spot_agent_authorization_expired",
          ]),
        },
      },
      onRequest: rejectClientIdempotencyGuard,
      preValidation: assertStrictSignatureInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.submitSignature({
          principal: requireAuthenticatedLoopPrincipal(request),
          authorizationId: request.params.authorization_id,
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapAuthorizationError(error);
      }
    },
  );
}
