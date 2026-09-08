import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  assertNoBody,
  assertNoBodyOrQuery,
  assetIdParamsSchema,
  v2CommonHeadersSchema,
  validateChainHeaders,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  candlesQuerySchema,
  marketAssetResourceSchema,
  marketCandlesResourceSchema,
  marketHoldersResourceSchema,
  marketNewPairsResourceSchema,
  marketOverviewResourceSchema,
  marketReadErrors,
  marketSmartMoneyResourceSchema,
  marketTradesResourceSchema,
  tradesQuerySchema,
} from "./market-schemas.js";

/**
 * V2 market module routes (D11, Decision 0034). Registered only when
 * `V2_MODULES_ENABLED` contains `market`. Every route is a read of Provider
 * or indexer facts; each response block fails closed on its own.
 */

interface AssetParams {
  readonly assetId: string;
}

function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => {
    controller.abort();
  });
  return controller.signal;
}

export function registerV2MarketRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, marketReadService } = dependencies;

  app.get(
    "/v2/market/overview",
    {
      schema: {
        operationId: "getV2MarketOverview",
        summary: "Get the market landing aggregate",
        description:
          "The caller's watchlist with price facts plus a trending list of registry assets ordered by DexScreener 24h volume (recommendationId + rule version). New pairs and smart money report their own availability.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketOverviewResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await marketReadService.getOverview({
        principal: requireAuthenticatedLoopPrincipal(request),
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/assets/:assetId",
    {
      schema: {
        operationId: "getV2MarketAsset",
        summary: "Get market, community, and security facts for one asset",
        description:
          "Registry identity and capability, DexScreener price/liquidity/volume facts from the deepest pair, the verified community bound to the asset, and GoPlus security facts as a labelled list. `swappable` stays false; no rating or verdict is derived.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketAssetResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AssetParams;
      const resource = await marketReadService.getAsset({
        assetId: params.assetId,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/assets/:assetId/candles",
    {
      schema: {
        operationId: "getV2MarketCandles",
        summary: "Get OHLCV candles for one asset",
        description:
          "GeckoTerminal OHLCV when that Provider is enabled; otherwise candles derived by LOOP from indexed PancakeSwap V3 Swap events of a registered pool (quality `derived`, labelled as an on-chain swap aggregate, priced in the pool's other token). Neither source is inferred from the other.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: candlesQuerySchema,
        response: { 200: marketCandlesResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AssetParams;
      const query = request.query as {
        readonly interval: unknown;
        readonly limit?: unknown;
      };
      const resource = await marketReadService.getCandles({
        assetId: params.assetId,
        interval: query.interval,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/assets/:assetId/trades",
    {
      schema: {
        operationId: "getV2MarketTrades",
        summary: "List indexed swaps for one asset",
        description:
          "Swap events of registered PancakeSwap V3 pools, newest first, each with transaction, log index, block, timestamp, confirmations, and direction relative to the asset. Unregistered pools and a lane that never ran are unavailable, never an empty success.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: tradesQuerySchema,
        response: { 200: marketTradesResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AssetParams;
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await marketReadService.getTrades({
        principal: requireAuthenticatedLoopPrincipal(request),
        assetId: params.assetId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/assets/:assetId/holders",
    {
      schema: {
        operationId: "getV2MarketHolders",
        summary: "Get holder facts for one asset",
        description:
          "GoPlus holder count with provenance. The top-holder distribution needs full transfer history and stays unavailable in this step.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketHoldersResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AssetParams;
      const resource = await marketReadService.getHolders({
        assetId: params.assetId,
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/new-pairs",
    {
      schema: {
        operationId: "getV2MarketNewPairs",
        summary: "List newly created pools",
        description:
          "GeckoTerminal new pools when that Provider is enabled (default off until its terms are verified); otherwise unavailable. Risk screening needs GoPlus per pool and stays unavailable in this step.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketNewPairsResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await marketReadService.getNewPairs({
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/market/smart-money",
    {
      schema: {
        operationId: "getV2MarketSmartMoney",
        summary: "Smart-money tracking (unavailable)",
        description:
          "Always unavailable in this step (D21). The route exists so the client can render the page state from a stable reason code instead of a fixture.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketSmartMoneyResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(marketReadService.getSmartMoney());
    },
  );
}
