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
import {
  parseSpotIntentIdempotencyKey,
  parseSpotIntentRequest,
} from "../features/spot/spot-intent-contract.js";
import {
  SpotIntentClaimRateLimitedError,
  SpotIntentExpiredError,
  SpotIntentIdempotencyConflictError,
  SpotIntentNotFoundError,
  SpotIntentStaleError,
  type SpotIntentService,
} from "../features/spot/spot-intent-service.js";
import {
  assertNoRawBody,
  mapCommonSpotError,
  noBodyOrClientIdempotencyGuard,
  spotApiError,
  spotAuthenticationErrors,
  spotErrorResponseSchema,
  uuidPattern,
} from "./spot-http.js";
import {
  spotIntentRequestSchema,
  spotIntentResourceSchema,
  uuidSchema,
} from "./spot-route-schemas.js";

const intentParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent_id"],
  properties: { intent_id: uuidSchema },
} as const;

const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", pattern: uuidPattern },
  },
} as const;

const prepareIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseSpotIntentIdempotencyKey(request.raw.rawHeaders);
  } catch {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictPrepareInput(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
  try {
    parseSpotIntentRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapIntentError(error: unknown): never {
  if (error instanceof SpotIntentIdempotencyConflictError) {
    throw ApiError.idempotencyConflict();
  }
  if (error instanceof SpotIntentClaimRateLimitedError) {
    throw spotApiError(
      429,
      "spot_intent_claim_rate_limited",
      "Too many unfinished Spot intent preparations.",
    );
  }
  if (error instanceof SpotIntentNotFoundError) {
    throw spotApiError(
      404,
      "spot_intent_not_found",
      "The Spot intent does not exist.",
    );
  }
  if (error instanceof SpotIntentExpiredError) {
    throw spotApiError(
      409,
      "spot_intent_expired",
      "The Spot intent has expired.",
    );
  }
  if (error instanceof SpotIntentStaleError) {
    throw spotApiError(
      409,
      "spot_intent_stale",
      "The Spot intent must be reviewed again.",
    );
  }
  return mapCommonSpotError(error);
}

export function registerSpotIntentRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SpotIntentService,
): void {
  app.post(
    "/v1/spot/intents",
    {
      schema: {
        operationId: "prepareSpotIntent",
        summary: "Prepare a durable Spot IOC review",
        description:
          "Creates or exactly replays one owner-bound immutable Testnet Spot quote and F11 review. It never submits provider bytes.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        headers: idempotencyHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: spotIntentRequestSchema,
        response: {
          201: spotIntentResourceSchema,
          ...spotAuthenticationErrors,
          409: spotErrorResponseSchema([
            "bootstrap_required",
            "wallet_binding_required",
            "idempotency_conflict",
            "spot_intent_expired",
            "spot_intent_stale",
          ]),
          429: spotErrorResponseSchema(["spot_intent_claim_rate_limited"]),
        },
      },
      onRequest: prepareIdempotencyGuard,
      preValidation: assertStrictPrepareInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = parseSpotIntentIdempotencyKey(request.raw.rawHeaders);
      } catch {
        throw ApiError.invalidRequest();
      }
      try {
        const resource = await service.prepare({
          principal: requireAuthenticatedLoopPrincipal(request),
          idempotencyKey,
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(201).send(resource);
      } catch (error) {
        return mapIntentError(error);
      }
    },
  );

  app.get<{ Params: { readonly intent_id: string } }>(
    "/v1/spot/intents/:intent_id",
    {
      schema: {
        operationId: "getSpotIntent",
        summary: "Get a Spot intent",
        description:
          "Returns only the authenticated owner's persisted Spot review and authoritative execution projection.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        params: intentParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: spotIntentResourceSchema,
          ...spotAuthenticationErrors,
          404: spotErrorResponseSchema(["spot_intent_not_found"]),
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
          intentId: request.params.intent_id,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapIntentError(error);
      }
    },
  );

  app.post<{ Params: { readonly intent_id: string } }>(
    "/v1/spot/intents/:intent_id/submit",
    {
      schema: {
        operationId: "submitSpotIntent",
        summary: "Submit the exact reviewed Spot IOC",
        description:
          "Revalidates current authority and submits at most one provider write attempt using only the persisted reviewed size and worst price.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        params: intentParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: spotIntentResourceSchema,
          ...spotAuthenticationErrors,
          404: spotErrorResponseSchema(["spot_intent_not_found"]),
          409: spotErrorResponseSchema([
            "bootstrap_required",
            "wallet_binding_required",
            "spot_intent_expired",
            "spot_intent_stale",
          ]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        assertNoRawBody(request);
        const resource = await service.submit({
          principal: requireAuthenticatedLoopPrincipal(request),
          intentId: request.params.intent_id,
          requestId: request.id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapIntentError(error);
      }
    },
  );
}
