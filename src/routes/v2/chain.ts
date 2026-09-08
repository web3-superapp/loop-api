import type { FastifyInstance } from "fastify";

import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  assertNoBodyOrQuery,
  assetIdParamsSchema,
  assetResourceSchema,
  chainReadErrors,
  chainStatusResourceSchema,
  v2CommonHeadersSchema,
  validateChainHeaders,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * V2 chain module routes (Decision 0033). Registered only when
 * `V2_MODULES_ENABLED` contains `chain`; otherwise every path returns the V2
 * NOT_FOUND envelope. Both routes are read-only projections of facts the
 * backend observed on chain or stored in the Asset Registry.
 */
export function registerV2ChainRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, chainStatusService, assetRegistryService } =
    dependencies;

  app.get(
    "/v2/chain/status",
    {
      schema: {
        operationId: "getV2ChainStatus",
        summary: "Get BSC RPC and indexer read freshness",
        description:
          "Per-endpoint health behind opaque references, the verified chain ID, the current head, and the indexer lane height and lag. Provider URLs are never published, and an unreachable endpoint or an indexer that never ran is reported as unavailable instead of as a healthy zero.",
        tags: ["chain"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: chainStatusResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      const resource = await chainStatusService.getStatus();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/assets/:assetId",
    {
      schema: {
        operationId: "getV2Asset",
        summary: "Get one Asset Registry record",
        description:
          "Identity facts read from the token's own symbol()/name()/decimals() calls, recorded with the observing block. It is never evidence of price, liquidity, or tradability: `swappable` stays false until the Swap module is delivered.",
        tags: ["chain"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: assetResourceSchema, ...chainReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly assetId: string };
      const resource = await assetRegistryService.getAsset(params.assetId);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
