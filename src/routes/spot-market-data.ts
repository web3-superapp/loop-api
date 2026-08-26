import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import { emptyQueryStringSchema } from "../core/http/schemas.js";
import {
  SpotMarketNotFoundError,
  type SpotMarketService,
} from "../features/spot/spot-market-service.js";
import {
  mapCommonSpotError,
  noBodyOrClientIdempotencyGuard,
  spotApiError,
  spotAuthenticationErrors,
  spotErrorResponseSchema,
} from "./spot-http.js";
import {
  spotBalancesResourceSchema,
  spotConfigResourceSchema,
  spotMarketFactsResourceSchema,
  uuidSchema,
} from "./spot-route-schemas.js";

const marketParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["market_id"],
  properties: { market_id: uuidSchema },
} as const;

function mapMarketError(error: unknown): never {
  if (error instanceof SpotMarketNotFoundError) {
    throw spotApiError(
      404,
      "spot_market_not_found",
      "The Spot market does not exist.",
    );
  }
  return mapCommonSpotError(error);
}

export function registerSpotMarketDataRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SpotMarketService,
): void {
  app.get(
    "/v1/spot/config",
    {
      schema: {
        operationId: "getSpotConfig",
        summary: "Get the Testnet Spot product configuration",
        description:
          "Returns only server-owned Testnet policy, opaque allowlisted markets, and truthful capability state.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: spotConfigResourceSchema,
          ...spotAuthenticationErrors,
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getConfig({
          principal: requireAuthenticatedLoopPrincipal(request),
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapMarketError(error);
      }
    },
  );

  app.get<{ Params: { readonly market_id: string } }>(
    "/v1/spot/markets/:market_id/facts",
    {
      schema: {
        operationId: "getSpotMarketFacts",
        summary: "Get bounded executable Spot market facts",
        description:
          "Returns one allowlisted market's lossless Testnet metadata, top of book, limits, and source times without provider identifiers.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        params: marketParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: spotMarketFactsResourceSchema,
          ...spotAuthenticationErrors,
          404: spotErrorResponseSchema(["spot_market_not_found"]),
        },
      },
      onRequest: noBodyOrClientIdempotencyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      try {
        const resource = await service.getMarketFacts({
          principal: requireAuthenticatedLoopPrincipal(request),
          marketId: request.params.market_id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapMarketError(error);
      }
    },
  );

  app.get(
    "/v1/spot/balances",
    {
      schema: {
        operationId: "getSpotBalances",
        summary: "Get bound master-account Spot balances",
        description:
          "Returns current Testnet Spot balances for server-resolved wallet authority without exposing an address or wallet identifier.",
        tags: ["spot"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: {
          200: spotBalancesResourceSchema,
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
        const resource = await service.getBalances({
          principal: requireAuthenticatedLoopPrincipal(request),
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapMarketError(error);
      }
    },
  );
}
