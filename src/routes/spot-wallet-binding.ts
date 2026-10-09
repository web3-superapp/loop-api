import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import { emptyQueryStringSchema } from "../core/http/schemas.js";
import { parseSpotWalletBindingMutationRequest } from "../features/spot/spot-wallet-binding-contract.js";
import type { SpotWalletBindingService } from "../features/spot/spot-wallet-binding-service.js";
import {
  assertNoRawBody,
  hasRawHeader,
  mapCommonSpotError,
  noBodyOrClientIdempotencyGuard,
  rejectClientIdempotencyGuard,
  spotAuthenticationErrors,
  spotErrorResponseSchema,
} from "./spot-http.js";
import {
  spotWalletBindingMutationSchema,
  spotWalletBindingResourceSchema,
} from "./spot-route-schemas.js";

const deleteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_binding_version"],
  properties: spotWalletBindingMutationSchema.properties,
} as const;

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
    assertNoRawBody(request);
    if (hasRawHeader(request, "idempotency-key")) {
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
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseSpotWalletBindingMutationRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function assertDeleteInput(request: FastifyRequest): Promise<void> {
  try {
    const query = request.query as {
      readonly expected_binding_version?: unknown;
    };
    parseSpotWalletBindingMutationRequest({
      expected_binding_version: query.expected_binding_version,
    });
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

const mutationErrors = {
  ...spotAuthenticationErrors,
  409: spotErrorResponseSchema([
    "bootstrap_required",
    "version_conflict",
    "wallet_binding_required",
  ]),
} as const;

export function registerSpotWalletBindingRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SpotWalletBindingService,
): void {
  app.get(
    "/v1/spot/wallet-binding",
    {
      schema: {
        operationId: "getSpotWalletBinding",
        summary: "Get the shared Hyperliquid wallet-binding state",
        description:
          "Returns lifecycle state and its monotonic authority epoch without exposing an address or wallet identifier.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: spotWalletBindingResourceSchema,
          ...spotAuthenticationErrors,
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
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapCommonSpotError(error);
      }
    },
  );

  app.put(
    "/v1/spot/wallet-binding",
    {
      schema: {
        operationId: "putSpotWalletBinding",
        summary: "Bind, refresh, or rotate the shared Hyperliquid wallet",
        description:
          "Resolves the sole eligible Privy embedded EVM wallet server-side and never accepts client wallet authority.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: spotWalletBindingMutationSchema,
        response: { 200: spotWalletBindingResourceSchema, ...mutationErrors },
      },
      onRequest: rejectClientIdempotencyGuard,
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
        return mapCommonSpotError(error);
      }
    },
  );

  app.delete<{ Querystring: { readonly expected_binding_version: string } }>(
    "/v1/spot/wallet-binding",
    {
      schema: {
        operationId: "deleteSpotWalletBinding",
        summary: "Unbind the shared Hyperliquid wallet",
        description:
          "Clears current wallet authority through compare-and-swap while retaining the monotonic epoch.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: deleteQuerySchema,
        response: { 200: spotWalletBindingResourceSchema, ...mutationErrors },
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
        return mapCommonSpotError(error);
      }
    },
  );
}
