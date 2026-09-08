import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  assertNoBodyOrQuery,
  assertNoQuery,
  chainReadErrors,
  chainWriteErrors,
  replaceWatchlistRequestSchema,
  v2CommonHeadersSchema,
  validateChainHeaders,
  watchlistResourceSchema,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * V2 Watchlist module routes (D13, Decision 0033).
 *
 * The resource is the same owner-bound grouped list the frozen V1 surface
 * exposes; only the asset identity changes to a canonical `assetId`. The
 * version is shared with V1, so a V1 write is visible to a V2
 * compare-and-swap and vice versa.
 */
export function registerV2WatchlistRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, watchlistV2Service } = dependencies;

  app.get(
    "/v2/watchlist",
    {
      schema: {
        operationId: "getV2Watchlist",
        summary: "Get the owner-bound grouped watchlist",
        description:
          "Ordered groups and assetIds with the registry identity of each asset. A watchlist entry is a user preference only: it is never evidence that a market, price, or trading path exists.",
        tags: ["watchlist"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: watchlistResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await watchlistV2Service.get({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/watchlist",
    {
      schema: {
        operationId: "replaceV2Watchlist",
        summary: "Replace the owner-bound grouped watchlist",
        description:
          "Compare-and-swap replacement keyed by expectedVersion; an identical retry returns the committed resource and a stale version is VERSION_CONFLICT. Idempotency-Key is rejected. Every assetId must already be a readable Asset Registry row, otherwise the write is VALIDATION_FAILED. The replacement owns the whole owner-level snapshot, including any legacy V1 rows.",
        tags: ["watchlist"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: replaceWatchlistRequestSchema,
        response: { 200: watchlistResourceSchema, ...chainWriteErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await watchlistV2Service.replace({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
