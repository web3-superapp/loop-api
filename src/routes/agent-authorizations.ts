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
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import { parseAgentAuthorizationSignatureRequest } from "../features/perp/agent-authorization-contract.js";
import {
  AgentAuthorizationExpiredError,
  AgentAuthorizationFailedError,
  AgentAuthorizationMutationDisabledError,
  AgentAuthorizationNotFoundError,
  AgentAuthorizationUnavailableError,
  InvalidAgentAuthorizationRequestError,
  type AgentAuthorizationService,
} from "../features/perp/agent-authorization-service.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const addressPattern = "^0x[0-9a-f]{40}$";
const signaturePattern = "^[\\x21-\\x7e]{1,1024}$";

const authorizationIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authorization_id"],
  properties: {
    authorization_id: { type: "string", pattern: uuidPattern },
  },
} as const;

const signatureRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["signature"],
  properties: {
    signature: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      pattern: signaturePattern,
    },
  },
} as const;

const addressSchema = {
  type: "string",
  pattern: addressPattern,
  not: { const: "0x0000000000000000000000000000000000000000" },
} as const;

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "provider",
    "network",
    "action",
    "account",
    "signer_wallet_address",
    "agent",
  ],
  properties: {
    version: {
      type: "string",
      const: "perp_agent_authorization_review_v1",
    },
    provider: { type: "string", const: "hyperliquid" },
    network: { type: "string", const: "testnet" },
    action: { type: "string", const: "approve_agent" },
    account: {
      type: "object",
      additionalProperties: false,
      required: ["address", "kind"],
      properties: {
        address: addressSchema,
        kind: { type: "string", enum: ["master", "subaccount"] },
      },
    },
    signer_wallet_address: addressSchema,
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["address", "name", "valid_until"],
      properties: {
        address: addressSchema,
        name: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$",
        },
        valid_until: { type: "string", format: "date-time" },
      },
    },
  },
} as const;

const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "observed_at", "reason_code"],
  properties: {
    state: {
      type: "string",
      enum: ["active", "rejected", "failed", "unknown"],
    },
    observed_at: { type: "string", format: "date-time" },
    reason_code: {
      anyOf: [
        { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
  },
} as const;

const authorizationResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authorization_id",
    "state",
    "review",
    "signature",
    "expires_at",
    "result",
    "created_at",
    "updated_at",
  ],
  properties: {
    authorization_id: { type: "string", pattern: uuidPattern },
    state: {
      type: "string",
      enum: [
        "prepared",
        "submitting",
        "accepted",
        "active",
        "rejected",
        "failed",
        "unknown",
        "reconciling",
        "expired",
      ],
    },
    review: reviewSchema,
    signature: {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: {
        state: {
          type: "string",
          enum: ["required", "consumed", "expired"],
        },
      },
    },
    expires_at: { type: "string", format: "date-time" },
    result: { anyOf: [resultSchema, { type: "null" }] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
} as const;

const authenticationErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: errorResponseSchema(["bootstrap_required"]),
  503: errorResponseSchema([
    "authentication_unavailable",
    "agent_authorization_unavailable",
    "request_timeout",
  ]),
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

function assertNoRawBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
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

const noBodyOrClientIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    assertNoRawBody(request);
    if (hasRawHeader(request, "idempotency-key")) {
      throw ApiError.invalidRequest();
    }
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictSignatureBody(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseAgentAuthorizationSignatureRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapAgentAuthorizationError(error: unknown): never {
  if (error instanceof InvalidAgentAuthorizationRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof AgentAuthorizationMutationDisabledError) {
    throw ApiError.perpMutationDisabled();
  }
  if (error instanceof AgentAuthorizationNotFoundError) {
    throw ApiError.agentAuthorizationNotFound();
  }
  if (error instanceof AgentAuthorizationExpiredError) {
    throw ApiError.agentAuthorizationExpired();
  }
  if (error instanceof AgentAuthorizationUnavailableError) {
    throw ApiError.agentAuthorizationUnavailable();
  }
  if (error instanceof AgentAuthorizationFailedError) {
    throw error;
  }
  throw error;
}

export function registerAgentAuthorizationRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: AgentAuthorizationService,
): void {
  app.post(
    "/v1/perp/agent-authorizations",
    {
      schema: {
        operationId: "issueAgentAuthorization",
        summary: "Request a Testnet Agent authorization handoff",
        description:
          "Checks the default-deny Testnet approveAgent gate. No successful signable payload is available until the official formatter, nonce continuation, recovery, and credentialed evidence gates close.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          ...authenticationErrors,
          403: errorResponseSchema(["perp_mutation_disabled"]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        await service.issue({
          principal,
          requestId: request.id,
          signal: request.signal,
        });
      } catch (error) {
        return mapAgentAuthorizationError(error);
      }
      throw ApiError.agentAuthorizationUnavailable();
    },
  );

  app.get<{ Params: { authorization_id: string } }>(
    "/v1/perp/agent-authorizations/:authorization_id",
    {
      schema: {
        operationId: "getAgentAuthorization",
        summary: "Get an Agent authorization",
        description:
          "Returns only the current authenticated owner's persisted sanitized Agent authorization projection.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        params: authorizationIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: authorizationResourceSchema,
          ...authenticationErrors,
          404: errorResponseSchema(["agent_authorization_not_found"]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const resource = await service.get({
          principal,
          authorizationId: request.params.authorization_id,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapAgentAuthorizationError(error);
      }
    },
  );

  app.post<{ Params: { authorization_id: string } }>(
    "/v1/perp/agent-authorizations/:authorization_id/signatures",
    {
      schema: {
        operationId: "submitAgentAuthorizationSignature",
        summary: "Submit an Agent authorization signature",
        description:
          "Accepts only the transient opaque Privy signing result for an existing owner-bound handoff. The current implementation stops locally after its mutation gate and never calls recovery or relay.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        params: authorizationIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: signatureRequestSchema,
        response: {
          200: authorizationResourceSchema,
          ...authenticationErrors,
          403: errorResponseSchema(["perp_mutation_disabled"]),
          404: errorResponseSchema(["agent_authorization_not_found"]),
          409: errorResponseSchema([
            "bootstrap_required",
            "agent_authorization_expired",
          ]),
        },
      },
      onRequest: forbidClientIdempotencyHeader,
      preValidation: assertStrictSignatureBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const resource = await service.submitSignature({
          principal,
          authorizationId: request.params.authorization_id,
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapAgentAuthorizationError(error);
      }
    },
  );
}
