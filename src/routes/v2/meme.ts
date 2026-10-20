import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import { assertDecimalStringFields } from "./chain-schemas.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  memeBestTradesQuerySchema,
  memeBestTradesResourceSchema,
  memeCandleQuerySchema,
  memeCandlesResourceSchema,
  memeCommandErrors,
  memeCreateCommandErrors,
  memeCreateRequestSchema,
  memeHoldersResourceSchema,
  memeIntentIdParamsSchema,
  memeIntentParamsSchema,
  memeIntentReportRequestSchema,
  memeIntentRequestSchema,
  memeIntentResourceSchema,
  memeListQuerySchema,
  memePageQuerySchema,
  memeQuoteQuerySchema,
  memeQuoteResourceSchema,
  memeReadErrors,
  memeTokenDetailResourceSchema,
  memeTokenIdParamsSchema,
  memeTokenListResourceSchema,
  memeTradesResourceSchema,
} from "./meme-schemas.js";

/**
 * V2 MEME curve launchpad routes (Decision 0101). Registered only when
 * `V2_MODULES_ENABLED` contains `meme`. Without the four `MEME_*` contract
 * keys and `LAUNCH_USD1_ADDRESS` every route answers 503
 * CAPABILITY_UNAVAILABLE with `detailsSafe.reasonCode`.
 */

const unavailableNote =
  "503 CAPABILITY_UNAVAILABLE with detailsSafe.reasonCode while the meme contract is not configured (MEME_CONTRACT_NOT_CONFIGURED / MEME_USD1_NOT_CONFIGURED) or the store is unreachable.";

function idempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

interface TokenParams {
  readonly memeTokenId: string;
}

export function registerV2MemeRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, memeService: service } = dependencies;

  app.get(
    "/v2/meme/tokens",
    {
      schema: {
        operationId: "listV2MemeTokens",
        summary: "List MEME launchpad tokens",
        description: `Tokens created through the App and seen on chain by the meme_event lane (Decision 0101). tab=new (default): chain creation time desc. hot: last-hour wallet-side USD1 volume desc (60-second ranking snapshot). graduating: trading with progress >= 50%, progress desc. graduated: graduation time desc. Prices come from the curve snapshot (priceSource loop_curve); a graduated row reads DexScreener and, when that has no price, carries priceUsd1 null with quoteUnavailable.reasonCode. Signed keyset cursor; limit (<= 50, default 30) and cursor are mutually exclusive. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: memeListQuerySchema,
        response: { 200: memeTokenListResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.listTokens({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query["tab"] === undefined ? {} : { tab: query["tab"] }),
        ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/meme/tokens",
    {
      schema: {
        operationId: "createV2MemeToken",
        summary: "Create a MEME token draft",
        description: `Creates a draft the caller then deploys with a create Intent (Decision 0101). name and symbol under the shared launch token text rule (Decisions 0164 / 0168: any script, NFC + trim, 1-20 UTF-16 units, at least one visible character), description <= 500, imageMediaId an upload of the caller (POST /v2/media/community-logos), links https only; otherwise 422 VALIDATION_FAILED / MEME_METADATA_INVALID (detailsSafe.field; detailsSafe.textReasonCode TEXT_NOT_VISIBLE | TAG_OUTSIDE_FLAG | LEADING_COMBINING_MARK when only the Decision 0168 visibility rule refused the name / symbol) or MEME_IMAGE_NOT_OWNED. A CREATE2 salt is reserved from the vanity pool (vanity true, the address ends in the configured suffix) or drawn at random (vanity false). The 201 is the token detail with metadataHash, salt, and predictedAddress. MEME_CREATE_DAILY_LIMIT drafts per account per rolling 24 hours: 429 RATE_LIMITED / MEME_CREATE_RATE_LIMITED (detailsSafe.dailyLimit). Idempotency-Key replays the same draft. Retired by Decision 0151: 410 MEME_CLASSIC_LAUNCH_RETIRED (nothing written) unless MEME_CLASSIC_CREATE_ENABLED is true; launches go through /v2/launch2. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: memeCreateRequestSchema,
        response: {
          201: memeTokenDetailResourceSchema,
          ...memeCreateCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.createToken({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/meme/tokens/:memeTokenId",
    {
      schema: {
        operationId: "getV2MemeToken",
        summary: "Get one MEME token",
        description: `The list row plus the curve snapshot, the contract, the viewer block (the caller's active wallet: token balance, USD1 balance, remaining wallet cap, USD1 and token allowances towards the curve, read on the launch slot with a 1.5-second cache; null with viewerUnavailable.reasonCode when unreadable), and graduation facts (pool, LP burn transaction, amounts, residual) once graduated. A draft or pending_chain token is visible to its creator only; anything else is 404 NOT_FOUND / MEME_TOKEN_NOT_FOUND. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: memeTokenIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: memeTokenDetailResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as TokenParams;
      const resource = await service.getToken({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/best-trades",
    {
      schema: {
        operationId: "listV2MemeBestTrades",
        summary: "List the week's best MEME trades",
        description: `Decision 0142: at most 10 (wallet, token) pairs ranked by realized USD1, highest first. realizedUsd1 = the wallet's curve sell proceeds of the token in the last 7 days − the tokens sold × the wallet's average curve buy price of that token (all its buys up to the computation time); only positive results. Curve (inner market) trades only: DEX swaps of graduated classic MEME tokens are not indexed. A pair without a curve buy has no cost basis and is left out. The wallet must belong to a LOOP account with an active public profile and a trade history visible to everyone; anonymous wallets never appear. Operator-hidden tokens are left out. The same for every caller; computed on read and cached for 5 minutes per API process (observedAt is the computation time). window accepts only 7d (default). ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: memeBestTradesQuerySchema,
        response: { 200: memeBestTradesResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.listBestTrades({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query["window"] === undefined ? {} : { window: query["window"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/tokens/:memeTokenId/trades",
    {
      schema: {
        operationId: "listV2MemeTokenTrades",
        summary: "List a MEME token's curve trades",
        description: `Trade logs indexed by the meme_event lane, newest first; account is the LOOP public profile behind the wallet when one exists. Signed cursor; limit <= 100 (default 50). ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: memeTokenIdParamsSchema,
        querystring: memePageQuerySchema,
        response: { 200: memeTradesResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as TokenParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listTrades({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
        ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/tokens/:memeTokenId/candles",
    {
      schema: {
        operationId: "listV2MemeTokenCandles",
        summary: "Get a MEME token's curve K-line",
        description: `OHLC of the post-trade curve price and wallet-side USD1 volume, aggregated from the indexed trades, oldest first; empty buckets are not filled. interval 1m|5m|15m|1h|4h|1d (default 15m), limit <= 300 (default 200) most recent buckets. After graduation the curve K-line is frozen at the graduation time (frozenAt); the client switches to the DEX chart. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: memeTokenIdParamsSchema,
        querystring: memeCandleQuerySchema,
        response: { 200: memeCandlesResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as TokenParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listCandles({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
        ...(query["interval"] === undefined
          ? {}
          : { interval: query["interval"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/tokens/:memeTokenId/holders",
    {
      schema: {
        operationId: "listV2MemeTokenHolders",
        summary: "List a MEME token's curve holders",
        description: `Net curve position per wallet (buys − sells), balance desc, with shareBps of the 1e9 supply, isCreator, isViewer, and the public profile when one exists. Wallet-to-wallet ERC-20 transfers are not tracked. After graduation the distribution is frozen (frozenAt). Signed cursor; limit <= 100 (default 50). ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: memeTokenIdParamsSchema,
        querystring: memePageQuerySchema,
        response: { 200: memeHoldersResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as TokenParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listHolders({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
        ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/quote",
    {
      schema: {
        operationId: "getV2MemeQuote",
        summary: "Quote a curve buy or sell",
        description: `docs/10 §2 recomputed with BigInt integer math (rounded down for the user) on the curve read from the launch slot (basis chain, 1.5-second cache) or, when the chain is unreadable, the indexed snapshot (basis loop_indexer). The chain's quoteBuy/quoteSell at the same block audits it; a drift above 0.1% is logged. walletCapHit compares the wallet's balance (walletId, read on chain) plus the output with the 40,000,000-token cap. 409 DATA_STALE / MEME_CURVE_FULL or MEME_CURVE_NOT_TRADING; 422 VALIDATION_FAILED / MEME_SELL_EXCEEDS_BALANCE when the sell exceeds the sold supply. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: memeQuoteQuerySchema,
        response: { 200: memeQuoteResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.quote({
        principal: requireAuthenticatedLoopPrincipal(request),
        tokenId: query["tokenId"],
        side: query["side"],
        amount: query["amount"],
        ...(query["walletId"] === undefined
          ? {}
          : { walletId: query["walletId"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/meme/tokens/:memeTokenId/intents",
    {
      schema: {
        operationId: "prepareV2MemeIntent",
        summary: "Prepare a MEME create, buy, or sell Intent",
        description: `Decision 0101 (the Decision 0077 discipline). create: the creator deploys their draft (createToken with the reserved salt and metadataHash, optional first buy usd1Amount); a salt already used on chain is replaced first. buy: usd1Amount (fee included). sell: tokenAmount. Every docs/10 check runs at one snapshot block: curve TRADING (409 DATA_STALE MEME_CURVE_FULL / MEME_CURVE_NOT_TRADING), minimum buy 1 USD1 (422 MEME_BELOW_MIN_BUY), wallet cap 40,000,000 tokens (422 MEME_WALLET_CAP_EXCEEDED), balances (409 INSUFFICIENT_BALANCE MEME_USD1_BALANCE_INSUFFICIENT / MEME_SELL_EXCEEDS_BALANCE / MEME_GAS_INSUFFICIENT), minOut <= quote (422 MEME_MIN_OUT_ABOVE_QUOTE), and the Decision 0065 canary (403 POLICY_BLOCKED) with USD1 at par. When the USD1 (buy/create) or token (sell) allowance towards the curve is short, approval carries an exact approve to sign first (nonce N; the call is N+1). 503 CAPABILITY_UNAVAILABLE / MEME_WRITES_DISABLED while BSC_WRITES_ENABLED is off and MEME_MAINNET_SIGNING_CLOSED on chain 56. Idempotency-Key replays the same Intent. Decision 0151: kind create answers 410 MEME_CLASSIC_LAUNCH_RETIRED (nothing written) unless MEME_CLASSIC_CREATE_ENABLED is true; buy and sell are unchanged.`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: memeTokenIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: memeIntentRequestSchema,
        response: { 201: memeIntentResourceSchema, ...memeCreateCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: [
        assertNoQuery,
        assertDecimalStringFields(["usd1Amount", "tokenAmount", "minOut"]),
      ],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as TokenParams;
      const resource = await service.prepareIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.post(
    "/v2/meme/tokens/:memeTokenId/intents/:memeIntentId/broadcast-report",
    {
      schema: {
        operationId: "reportV2MemeIntentBroadcast",
        summary: "Report the device broadcast of a MEME Intent",
        description:
          "Same discipline as the Launch report (Decision 0077): prepared → broadcast_reported with the main transaction's hash (not the approve's), verified against the sealed payload when the launch slot already sees it (mismatch: 422 VALIDATION_FAILED / MEME_TX_PAYLOAD_MISMATCH). The same hash again returns the Intent unchanged; another hash is 409 DATA_STALE / MEME_INTENT_ALREADY_REPORTED; a report past expiresAt is accepted only when the transaction is already observable (else MEME_INTENT_EXPIRED). confirmed comes from the meme_event lane (TokenCreated / Trade of that transaction) or the receipt at the launch slot's confirmation depth; a reverted receipt is failed / MEME_TX_REVERTED, no receipt after the deadline plus grace is expired / MEME_TX_NOT_OBSERVED.",
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: memeIntentParamsSchema,
        querystring: emptyQueryStringSchema,
        body: memeIntentReportRequestSchema,
        response: { 200: memeIntentResourceSchema, ...memeCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly memeTokenId: string;
        readonly memeIntentId: string;
      };
      const resource = await service.reportIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeTokenId: params.memeTokenId,
        memeIntentId: params.memeIntentId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/meme/intents/:memeIntentId",
    {
      schema: {
        operationId: "getV2MemeIntent",
        summary: "Get one MEME Intent",
        description: `The same projection as the prepare 201 and the report 200, owner-scoped (another account's Intent is 404 NOT_FOUND). A read never advances state. ${unavailableNote}`,
        tags: ["meme"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: memeIntentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: memeIntentResourceSchema, ...memeReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly memeIntentId: string };
      const resource = await service.getIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        memeIntentId: params.memeIntentId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
