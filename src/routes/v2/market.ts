import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { canonicalizeClientIp } from "../../core/http/client-ip.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  assertNoBody,
  assertNoBodyOrQuery,
  assetIdParamsSchema,
  v2CommonHeadersSchema,
  validateChainHeaders,
} from "./chain-schemas.js";
import { resolveIntelPromotions } from "../../features/admin/admin-settings-reader.js";
import type { V2RouteDependencies } from "./index.js";
import { registerV2MarketLogoRoute } from "./market-logos.js";
import {
  candlesQuerySchema,
  intelPromotionsResourceSchema,
  marketAssetResourceSchema,
  marketCategoryAssetsQuerySchema,
  marketCategoryAssetsResourceSchema,
  marketCandlesResourceSchema,
  marketHoldersResourceSchema,
  marketNewPairsResourceSchema,
  marketOverviewResourceSchema,
  marketLookupReadErrors,
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

function lookupCaller(request: FastifyRequest) {
  return {
    principal: requireAuthenticatedLoopPrincipal(request),
    canonicalClientIp: canonicalizeClientIp(request.ip),
  };
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

  registerV2MarketLogoRoute(app, dependencies.tokenLogoProxyService);

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
    "/v2/market/assets",
    {
      schema: {
        operationId: "listV2MarketCategoryAssets",
        summary: "List one market category (major, meme, community)",
        description:
          "Decision 0100. `major` is the static allow-list `marketMajorAssetIds` (configVersion marketCategoriesV1) intersected with non-blocked registry rows; `meme` is the project token of every registered Launch sale (testnet included; such rows carry quote null with MARKET_CHAIN_NOT_PRICED); `community` is every asset a verified community is bound to, with that community. Every candidate (at most 100) is priced in one batched DexScreener read under the overview's 1200 ms deadline, ordered by the sort field descending (rows without that number last, assetId ascending as the tie-breaker), then paged. The cursor is bound to the caller, category and sort, and carries the last row's sort key: the next page is every row strictly after it on fresh prices. `meme`/`community` answer 503 CAPABILITY_UNAVAILABLE when their candidate source is not composed; a missing cursor secret is 503 for every category.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: marketCategoryAssetsQuerySchema,
        response: {
          200: marketCategoryAssetsResourceSchema,
          ...marketReadErrors,
        },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly category: unknown;
        readonly sort?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await marketReadService.listCategoryAssets({
        principal: requireAuthenticatedLoopPrincipal(request),
        category: query.category,
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        signal: requestSignal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/intel/promotions",
    {
      schema: {
        operationId: "listV2IntelPromotions",
        summary: "List the intel page promotion cards",
        description:
          "Decision 0100. A versioned list of the cards in force now, ordered by `order`. Decision 0102: when the operator console has saved a list it is in force (configVersion intelPromotionsV1+db.<epoch ms>, effectiveAt = its save time); otherwise the shipped list (configVersion intelPromotionsV1). `deeplink` is always an in-app route (/intel, /square, /meme, /community/profile?id=<communityId>); entries outside that allow-list are refused when the server starts or the console saves. An empty `items` means no card is running: hide the strip.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: intelPromotionsResourceSchema, ...marketReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply
        .code(200)
        .send(
          await resolveIntelPromotions(
            dependencies.adminSettings ?? null,
            new Date(),
          ),
        );
    },
  );

  app.get(
    "/v2/market/assets/:assetId",
    {
      schema: {
        operationId: "getV2MarketAsset",
        summary: "Get market, community, and security facts for one asset",
        description:
          'Registry identity and capability, DexScreener price/liquidity/volume facts from the deepest pair, the verified community bound to the asset, and GoPlus security facts as a labelled list. `swappable` stays false; no rating or verdict is derived. A BSC token address the registry does not know (for example one pasted into a community chat) is resolved through a Provider lookup (GeckoTerminal first, DexScreener fallback; Decision 0058): `asset.status` is `unregistered`, identity fields come from the Provider, and the lookup is quota-bound per user (429 `RATE_LIMITED`). A Provider that answers "no such token" is 404; a Provider that cannot be reached leaves the facts `unavailable` in a 200.',
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: marketAssetResourceSchema, ...marketLookupReadErrors },
      },
      onRequest: validateChainHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AssetParams;
      const resource = await marketReadService.getAsset({
        assetId: params.assetId,
        caller: lookupCaller(request),
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
          "GeckoTerminal OHLCV when that Provider is enabled; otherwise candles derived by LOOP from indexed PancakeSwap V3 Swap events of a registered pool (quality `derived`, labelled as an on-chain swap aggregate, priced in the pool's other token). Neither source is inferred from the other. An asset LOOP has no registered pool for — registered (Decision 0064) or not (Decision 0058) — is charted through GeckoTerminal OHLCV of the top pool the lookup reports, published as `pool.origin: provider` with the Provider's dex id as `pool.protocol`; only the unregistered address consumes the lookup quota. Without GeckoTerminal, or when the Provider knows no pool either, the block is `MARKET_POOL_NOT_REGISTERED`.",
        tags: ["market"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: assetIdParamsSchema,
        querystring: candlesQuerySchema,
        response: {
          200: marketCandlesResourceSchema,
          ...marketLookupReadErrors,
        },
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
        caller: lookupCaller(request),
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
