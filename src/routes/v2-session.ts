import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import {
  requireAuthenticatedLoopPrincipal,
  requireAuthenticatedPrivyPrincipal,
} from "../core/http/authentication.js";
import { v2ErrorResponseSchema } from "../core/http/v2-error.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
  streamUserIdPattern,
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import { v2ContractVersion } from "../features/meta/product-policy.js";
import {
  parseV2CommonRequestMetadata,
  parseV2SessionLogoutMetadata,
  parseV2SessionWriteMetadata,
  v2CommonHeadersSchema,
  v2SessionLogoutHeadersSchema,
  v2SessionWriteHeadersSchema,
} from "../features/session/session-contract.js";
import type { V2SessionService } from "../features/session/session-service.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const uuidV4Pattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const communicationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["streamUserId"],
  properties: {
    streamUserId: { type: "string", pattern: streamUserIdPattern },
  },
} as const;

const accountReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId"],
  properties: {
    accountId: { type: "string", pattern: uuidPattern },
  },
} as const;

const publicSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sessionId",
    "deviceId",
    "status",
    "authStrength",
    "policyVersion",
    "createdAt",
    "lastSeenAt",
    "revokedAt",
  ],
  properties: {
    sessionId: { type: "string", pattern: uuidPattern },
    deviceId: { type: "string", pattern: uuidV4Pattern },
    status: { type: "string", const: "active" },
    authStrength: { type: "string", const: "providerAuthenticated" },
    policyVersion: { type: "string", const: "sessionPolicyV1" },
    createdAt: { type: "string", format: "date-time" },
    lastSeenAt: { type: "string", format: "date-time" },
    revokedAt: { type: "null" },
  },
} as const;

const bootstrapResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["account", "session", "communication", "contractVersion"],
  properties: {
    account: accountReferenceSchema,
    session: publicSessionSchema,
    communication: communicationSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const accountResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "account",
    "authentication",
    "communication",
    "policyVersion",
    "contractVersion",
  ],
  properties: {
    account: accountReferenceSchema,
    authentication: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "authStrength"],
      properties: {
        provider: { type: "string", const: "privy" },
        authStrength: { type: "string", const: "providerAuthenticated" },
      },
    },
    communication: communicationSchema,
    policyVersion: { type: "string", const: "sessionPolicyV1" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const logoutResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["session", "providerLogoutRequired", "contractVersion"],
  properties: {
    session: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "status", "revokedAt"],
      properties: {
        sessionId: { type: "string", pattern: uuidPattern },
        status: { type: "string", const: "revoked" },
        revokedAt: { type: "string", format: "date-time" },
      },
    },
    providerLogoutRequired: { type: "boolean", const: true },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const commonErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema(["VERSION_CONFLICT"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

function validateCommonHeaders(request: FastifyRequest): Promise<void> {
  parseV2CommonRequestMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

function validateWriteHeaders(request: FastifyRequest): Promise<void> {
  parseV2SessionWriteMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

function validateLogoutHeaders(request: FastifyRequest): Promise<void> {
  parseV2SessionLogoutMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

export function registerV2SessionRoutes(
  app: FastifyInstance,
  authenticatePrivyBearer: preHandlerAsyncHookHandler,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  sessionService: V2SessionService,
): void {
  app.post(
    "/v2/session/bootstrap",
    {
      schema: {
        operationId: "bootstrapV2Session",
        summary:
          "Register or restore the current LOOP account and device session",
        description:
          "Verifies the current Privy access token. The first successful bootstrap creates the LOOP account; login methods and account linking remain Privy-owned.",
        tags: ["identity"],
        security: [{ privyBearer: [] }],
        headers: v2SessionWriteHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: bootstrapResponseSchema,
          ...commonErrors,
          409: v2ErrorResponseSchema([
            "IDEMPOTENCY_CONFLICT",
            "VERSION_CONFLICT",
          ]),
        },
      },
      onRequest: validateWriteHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticatePrivyBearer,
    },
    async (request, reply) => {
      const result = await sessionService.bootstrap({
        principal: requireAuthenticatedPrivyPrincipal(request),
        metadata: parseV2SessionWriteMetadata(request.raw.rawHeaders),
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/v2/account/me",
    {
      schema: {
        operationId: "getV2Account",
        summary: "Get the authenticated LOOP account projection",
        description:
          "Returns opaque LOOP and Stream identities derived server-side from a current Privy access token.",
        tags: ["identity"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: accountResponseSchema,
          ...commonErrors,
          409: v2ErrorResponseSchema([
            "ACCOUNT_BOOTSTRAP_REQUIRED",
            "VERSION_CONFLICT",
          ]),
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = sessionService.getAccount(
        requireAuthenticatedLoopPrincipal(request),
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/v2/session/logout",
    {
      schema: {
        operationId: "logoutV2Session",
        summary: "Revoke the current LOOP device-session projection",
        description:
          "Revokes the owner-bound LOOP device-session audit projection. The client must still call the Privy SDK logout operation.",
        tags: ["identity"],
        security: [{ privyBearer: [] }],
        headers: v2SessionLogoutHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: logoutResponseSchema,
          ...commonErrors,
          404: v2ErrorResponseSchema(["SESSION_NOT_FOUND"]),
          409: v2ErrorResponseSchema([
            "ACCOUNT_BOOTSTRAP_REQUIRED",
            "IDEMPOTENCY_CONFLICT",
            "VERSION_CONFLICT",
          ]),
        },
      },
      onRequest: validateLogoutHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await sessionService.logout({
        principal: requireAuthenticatedLoopPrincipal(request),
        metadata: parseV2SessionLogoutMetadata(request.raw.rawHeaders),
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(result);
    },
  );
}
