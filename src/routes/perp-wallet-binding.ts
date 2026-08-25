import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import { parsePerpWalletBindingMutationRequest } from "../features/perp/wallet-binding-contract.js";
import {
  InvalidPerpWalletBindingRequestError,
  PerpWalletBindingSelectionRequiredError,
  PerpWalletBindingUnavailableError,
  PerpWalletBindingVersionConflictError,
  type PerpWalletBindingService,
} from "../features/perp/wallet-binding-service.js";

const bindingVersionPattern = "^(0|[1-9][0-9]{0,18})$";

const walletBindingResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "binding_version", "account_kind", "last_verified_at"],
  properties: {
    state: { type: "string", enum: ["bound", "unbound"] },
    binding_version: {
      type: "string",
      pattern: bindingVersionPattern,
      maxLength: 19,
      description:
        "Monotonic signed-bigint authority epoch represented as a decimal string.",
    },
    account_kind: {
      anyOf: [{ type: "string", enum: ["master"] }, { type: "null" }],
    },
    last_verified_at: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
} as const;

const mutationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_binding_version"],
  properties: {
    expected_binding_version: {
      type: "string",
      pattern: bindingVersionPattern,
      maxLength: 19,
    },
  },
} as const;

const deleteQueryStringSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_binding_version"],
  properties: mutationRequestSchema.properties,
} as const;

const commonErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  503: errorResponseSchema([
    "authentication_unavailable",
    "perp_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

const readErrors = {
  ...commonErrors,
  409: errorResponseSchema(["bootstrap_required"]),
} as const;

const mutationErrors = {
  ...commonErrors,
  409: errorResponseSchema([
    "bootstrap_required",
    "version_conflict",
    "wallet_binding_required",
  ]),
} as const;

function hasRawHeader(request: FastifyRequest, expectedName: string): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

const rejectClientIdempotencyKey: onRequestHookHandler = (
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

const rejectRawGetBody: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
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

function rawQueryEntries(request: FastifyRequest): readonly [string, string][] {
  const rawUrl = request.raw.url;
  if (rawUrl === undefined) {
    throw ApiError.invalidRequest();
  }
  return [...new URL(rawUrl, "http://loop.invalid").searchParams.entries()];
}

const validateDeleteRawInput: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    if (hasRawHeader(request, "idempotency-key")) {
      throw ApiError.invalidRequest();
    }
    const contentLength = request.headers["content-length"];
    if (
      (contentLength !== undefined && contentLength !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      throw ApiError.invalidRequest();
    }
    const entries = rawQueryEntries(request);
    if (
      entries.length !== 1 ||
      entries[0]?.[0] !== "expected_binding_version"
    ) {
      throw ApiError.invalidRequest();
    }
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertMutationInput(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length !== 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parsePerpWalletBindingMutationRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function assertDeleteInput(request: FastifyRequest): Promise<void> {
  try {
    parsePerpWalletBindingMutationRequest(request.query);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapWalletBindingError(error: unknown): never {
  if (error instanceof InvalidPerpWalletBindingRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof PerpWalletBindingVersionConflictError) {
    throw ApiError.versionConflict();
  }
  if (error instanceof PerpWalletBindingSelectionRequiredError) {
    throw ApiError.walletBindingRequired();
  }
  if (error instanceof PerpWalletBindingUnavailableError) {
    throw ApiError.perpUnavailable();
  }
  throw error;
}

export function registerPerpWalletBindingRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PerpWalletBindingService,
): void {
  app.get(
    "/v1/perp/wallet-binding",
    {
      schema: {
        operationId: "getPerpWalletBinding",
        summary: "Get the current Perp wallet-binding state",
        description:
          "Returns only lifecycle state and its authority epoch. Wallet IDs and addresses are never exposed.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            ...walletBindingResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...readErrors,
        },
      },
      onRequest: rejectRawGetBody,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.get({
          principal: requireAuthenticatedLoopPrincipal(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapWalletBindingError(error);
      }
    },
  );

  app.put(
    "/v1/perp/wallet-binding",
    {
      schema: {
        operationId: "putPerpWalletBinding",
        summary: "Bind, refresh, or rotate the current Perp wallet",
        description:
          "Explicitly selects the only eligible current Privy embedded Ethereum wallet without accepting or returning wallet authority.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: mutationRequestSchema,
        response: {
          200: {
            ...walletBindingResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...mutationErrors,
        },
      },
      onRequest: rejectClientIdempotencyKey,
      preValidation: assertMutationInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.put({
          principal: requireAuthenticatedLoopPrincipal(request),
          body: request.body,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapWalletBindingError(error);
      }
    },
  );

  app.delete<{ Querystring: { readonly expected_binding_version: string } }>(
    "/v1/perp/wallet-binding",
    {
      schema: {
        operationId: "deletePerpWalletBinding",
        summary: "Unbind the current Perp wallet",
        description:
          "Explicitly clears wallet authority while retaining the monotonic binding epoch. Wallet authority is not accepted or returned.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: deleteQueryStringSchema,
        response: {
          200: {
            ...walletBindingResourceSchema,
            headers: noStoreResponseHeaders(),
          },
          ...mutationErrors,
        },
      },
      onRequest: validateDeleteRawInput,
      preValidation: assertDeleteInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.delete({
          principal: requireAuthenticatedLoopPrincipal(request),
          expectedBindingVersion: request.query.expected_binding_version,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapWalletBindingError(error);
      }
    },
  );
}
