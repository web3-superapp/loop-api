import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { publicClientKey } from "../../core/http/client-ip.js";
import { createFixedWindowRateLimiter } from "../../core/http/fixed-window-rate-limiter.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import { V2ApiError } from "../../core/http/v2-error.js";
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
import { createLaunch2CampaignPublicService } from "../../features/launch2/launch2-campaigns.js";
import { launch2RecentPoolTradesCacheMs } from "../../features/launch2/launch2-service.js";
import {
  launch2CandlesQuerySchema,
  launch2CandlesResourceSchema,
} from "./launch2-candles-schemas.js";
import {
  launch2BuybacksResourceSchema,
  launch2CommandErrors,
  launch2DetailQuerySchema,
  launch2DynamicClaimIntentResourceSchema,
  launch2DynamicClaimPrepareRequestSchema,
  launch2DynamicClaimReportRequestSchema,
  launch2DynamicClaimReportResourceSchema,
  launch2DynamicCommandErrors,
  launch2DynamicPoolQuerySchema,
  launch2DynamicPoolResourceSchema,
  launch2DynamicRewardsQuerySchema,
  launch2DynamicRewardsResourceSchema,
  launch2ErrorDescription,
  launch2InstanceDetailResourceSchema,
  launch2InstanceListResourceSchema,
  launch2InstanceParamsSchema,
  launch2NftMetadataParamsSchema,
  launch2NftMetadataResourceSchema,
  launch2IntentResourceSchema,
  launch2ListQuerySchema,
  launch2CampaignListResourceSchema,
  launch2OverviewResourceSchema,
  launch2NftPrepareRequestSchema,
  launch2PageQuerySchema,
  launch2PoolIntentResourceSchema,
  launch2PoolQuoteQuerySchema,
  launch2PoolQuoteResourceSchema,
  launch2PoolTradePrepareRequestSchema,
  launch2PoolTradesQuerySchema,
  launch2PoolTradesResourceSchema,
  launch2PositionsResourceSchema,
  launch2QuoteQuerySchema,
  launch2QuoteResourceSchema,
  launch2QuoteErrors,
  launch2ReadErrors,
  launch2RecentPoolTradesErrors,
  launch2RecentPoolTradesQuerySchema,
  launch2RecentPoolTradesResourceSchema,
  launch2TradePrepareRequestSchema,
} from "./launch2-schemas.js";

/**
 * MEME v2 (`launch2`, Decision 0114) routes. Registered only when
 * `V2_MODULES_ENABLED` contains `launch2`. Without the Hooks Factory pair on
 * the BSC Testnet launch slot (or with the store / RPC down) every route is
 * 503 CAPABILITY_UNAVAILABLE with `detailsSafe.reasonCode`. Prepares return
 * signing requests only; the device signs and broadcasts.
 */

const unavailableNote =
  "503 CAPABILITY_UNAVAILABLE with detailsSafe.reasonCode (LAUNCH2_FACTORY_NOT_CONFIGURED / LAUNCH2_CHAIN_NOT_CONFIGURED / LAUNCH2_REPOSITORY_UNAVAILABLE / LAUNCH2_CHAIN_READ_FAILED) while a dependency is missing.";

/** Decision 0136: the chain guard hold on every launch2 write path. */
const holdNote =
  "Decision 0136: 503 CAPABILITY_UNAVAILABLE / LAUNCH2_USD1_PAUSED | LAUNCH2_ADDRESS_FROZEN (detailsSafe.since = the chain guard incident's first_seen_at) while the chain guard holds the launch chain (unresolved USD1 pause, or one of our addresses frozen; chain-wide), and CHAIN_GUARD_REPOSITORY_UNAVAILABLE when that hold cannot be read; GET …/instances/{instanceId} shows the same hold as tradingHold.";

function idempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

/**
 * Decision 0173: NFT metadata may sit in a CDN / marketplace cache for five
 * minutes (the stage attribute moves) and be served stale for an hour.
 */
export const launch2NftMetadataCacheControl =
  "public, max-age=300, stale-while-revalidate=3600";

interface InstanceParams {
  readonly instanceId: string;
}

export function registerV2Launch2Routes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, launch2Service: service } = dependencies;
  // Decision 0174: the public recent-trades read keeps a per-visitor
  // ceiling (PUBLIC_RATE_LIMIT_PER_MINUTE, the public MEME surface's rule).
  const recentTradesLimiter = createFixedWindowRateLimiter({
    perWindow: dependencies.config.publicRateLimit.perMinute,
  });

  app.get(
    "/v2/launch2/instances",
    {
      schema: {
        operationId: "listV2Launch2Instances",
        summary: "List MEME v2 launch instances",
        description: `Activated Hooks launches the launch2_event lane indexed (the S132 deployment task is the registry), newest activation first. stage filters on the lane's stored stage (refreshed every lane tick); every row's stage and nextChangeAt are re-derived from the clock on answer. Signed keyset cursor; limit (<= 50, default 30) and cursor are mutually exclusive. ${unavailableNote} ${launch2ErrorDescription}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: launch2ListQuerySchema,
        response: {
          200: launch2InstanceListResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.listInstances({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query["stage"] === undefined ? {} : { stage: query["stage"] }),
        ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/overview",
    {
      schema: {
        operationId: "getV2Launch2Overview",
        summary: "Launchpad live activity feed and scoreboard",
        description: `Decision 0139. activity = the 30 newest indexed facts across the listed instances (same visibility as GET /v2/launch2/instances), newest first: curve_buy / curve_sell (curve trades and official-pool user swaps; buybacks excluded), nft_mint, graduated, buyback (executed), round_activated and reward_claimed (LoopDynamic). Read from the launch2_event lane's tables only, never the chain. stats: stage counts re-derived from the clock with the list's derivation (liveCount = nft_sale + priority + public), graduatedThisWeek since the server's UTC Monday 00:00, buybackUsd1Total and nftMintedTotal from the lane projection. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: launch2OverviewResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getOverview({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  const campaignService =
    dependencies.launch2CampaignService ??
    createLaunch2CampaignPublicService({
      repository: null,
      publicBaseUrl: "http://localhost",
    });

  app.get(
    "/v2/launch2/campaigns",
    {
      schema: {
        operationId: "listV2Launch2Campaigns",
        summary: "Launch desk operator campaign cards",
        description:
          "Decision 0140: the operator campaigns the console published, with endsAt > now and startsAt ≤ now + 7 days, at most 10, ordered pinned first, then sortOrder ascending, then startsAt ascending. state = live (startsAt ≤ now) | upcoming. coverUrl is the absolute cover URL (GET /v2/media/{id}.webp) or null. link.kind route = an App route string; url = an https URL. Read from the database only (independent of the Factory configuration); without it 503 CAPABILITY_UNAVAILABLE / LAUNCH2_REPOSITORY_UNAVAILABLE, never an empty list.",
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: launch2CampaignListResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await campaignService.listCampaigns({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId",
    {
      schema: {
        operationId: "getV2Launch2Instance",
        summary: "Get one MEME v2 launch instance",
        description: `Stage and nextChangeAt, the fixed template (read-only), every module address, NFT sale progress, the snapshot (root, cutoff, verification: the lane rebuilt the holder list from the NFT transfers and the root/cutoff reproduce), curve readings, graduation (official pool id, hook, fee), the buyback ledger summary, the 20 latest curve trades, and the viewer block (walletId query or the active wallet; null without one; Decision 0126: graduated instances add the wallet's memeBalance / usd1Balance at one block with ≤ 15 s cache and balanceStatus, plus poolTradeCount / lastPoolTradeAt of its own attributed pool trades). Decision 0122: a sale that ended with no NFT minted on a v3 Factory opens straight into public (snapshot.status opened_without_holders, snapshot.openedWithoutHolders); closed_no_holders is deprecated (pre-S144 Factories only). Decision 0136: tradingHold = {kind: usd1_paused | address_frozen, since} while the chain guard holds the launch chain (chain-wide; usd1_paused wins), else null (also null when CHAIN_GUARD_ENABLED is off or the hold cannot be read); the write routes refuse meanwhile. Not activated / unknown: 404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2DetailQuerySchema,
        response: {
          200: launch2InstanceDetailResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.getInstance({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        ...(query["walletId"] === undefined
          ? {}
          : { walletId: query["walletId"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/candles",
    {
      schema: {
        operationId: "listV2Launch2Candles",
        summary: "K-line of one MEME v2 instance (curve, then official pool)",
        description: `Decision 0171. One price series in chain order, read from the launch2_event lane's tables only (never the chain): curve trades priced at the marginal price after the trade, launch2PriceAt(running sold supply), and after graduation the official-pool swaps (OfficialTax and LoopDynamic) at price_e18 after the swap (the pool_last_price_e18 basis). Removed (reorged) facts never count. interval 1m | 5m | 15m | 1h | 4h | 1d (default 5m), buckets UTC-aligned (floor(epoch / step) × step); limit 1..500 (default 200) newest buckets ending at the bucket of now, or the last bucket with t < before. o = the previous close (launch2PriceAt(0) before the first trade), h / l include o, c = price after the bucket's last fact; v = MEME (buys + sells), q = USD1 (curve usd1_net + pool usd1_amount), n = facts. Empty buckets are flat at the previous close (v = q = 0, n = 0), so the series has no holes from the first trade to now. No trade yet: candles [] and latest = the curve start price at activation. source curve | pool | mixed (the page's prices). 422 VALIDATION_FAILED / LAUNCH2_CANDLE_INTERVAL_INVALID | LAUNCH2_CANDLE_LIMIT_INVALID | LAUNCH2_CANDLE_BEFORE_INVALID; not activated / unknown: 404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND (as the detail). ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2CandlesQuerySchema,
        response: {
          200: launch2CandlesResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listCandles({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        interval: query["interval"],
        limit: query["limit"],
        before: query["before"],
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/quote",
    {
      schema: {
        operationId: "getV2Launch2Quote",
        summary: "Quote a MEME v2 curve buy or sell with the executable MAX",
        description: `Reads the curve, the wallet's cumulative buy, and its USD1 / MEME balance at one block of the launch slot and recomputes CurveEngine (10% tax each way). buy amount = USD1 in (tax included); sell amount = MEME in. max = the executable maximum: buy = min(remaining 0.5% quota, remaining inventory) priced on the curve with tax, lowered to the USD1 balance; sell = the MEME balance bounded by the sold supply. An amount above max is quoted at max with exceedsMax true. minOut = expectedOut × (1 − slippageBps), deadline = now + LAUNCH2_QUOTE_TTL_SECONDS. In the priority hour eligibility says whether the wallet is in the verified snapshot. 409 DATA_STALE / LAUNCH2_STAGE_MISMATCH (detailsSafe.stage; upcoming, nft_sale, snapshot_pending and closed_no_holders are never quoted) | LAUNCH2_SELL_NOT_OPEN | LAUNCH2_SOLD_OUT | LAUNCH2_QUOTA_EXHAUSTED | LAUNCH2_INSTANCE_PAUSED | LAUNCH2_QUOTE_ZERO (the amount prices to 0 MEME / USD1); 409 INSUFFICIENT_BALANCE / LAUNCH2_USD1_BALANCE_INSUFFICIENT (buy) | LAUNCH2_MEME_BALANCE_INSUFFICIENT (sell) when the balance-limited max is 0 or the request capped to the balance prices to 0 (detailsSafe.maxAmountIn = balance, requiredAmountIn = requested amount, balanceUsd1 | balanceMeme; Decision 0170); 422 VALIDATION_FAILED / LAUNCH2_AMOUNT_INVALID. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2QuoteQuerySchema,
        response: { 200: launch2QuoteResourceSchema, ...launch2QuoteErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.quote({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        side: query["side"],
        amount: query["amount"],
        walletId: query["walletId"],
        ...(query["slippageBps"] === undefined
          ? {}
          : { slippageBps: query["slippageBps"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch2/instances/:instanceId/nft/prepare",
    {
      schema: {
        operationId: "prepareV2Launch2NftMint",
        summary: "Prepare the 100 USD1 project NFT mint",
        description: `Pre-checks at one block what ProjectNFT.mint enforces (activated, sale open by block time, one mint per address for life, 100 USD1 balance) and returns the unsigned mint() transaction for the device signing exit, preceded by an exact 100 USD1 approve to the NFT contract when the allowance is short (nonce N, the mint N+1). 409 DATA_STALE / LAUNCH2_STAGE_MISMATCH | LAUNCH2_NFT_ALREADY_MINTED; 409 INSUFFICIENT_BALANCE / LAUNCH2_USD1_BALANCE_INSUFFICIENT (detailsSafe.requiredUsd1, balanceUsd1) | LAUNCH2_GAS_INSUFFICIENT (detailsSafe.requiredBnb = the gas fee ceiling, balanceBnb); 403 POLICY_BLOCKED (Decision 0065 canary asset and ceilings, USD1 at par; Decision 0117: the NFT and the USD1 must be the activated instance's registered contracts, else LAUNCH2_COUNTERPARTY_NOT_INSTANCE); 503 LAUNCH2_WRITES_DISABLED while BSC_WRITES_ENABLED is off. Idempotency-Key replays the same Intent. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launch2NftPrepareRequestSchema,
        response: { 201: launch2IntentResourceSchema, ...launch2CommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const resource = await service.prepareNftMint({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.post(
    "/v2/launch2/instances/:instanceId/trade/prepare",
    {
      schema: {
        operationId: "prepareV2Launch2Trade",
        summary: "Prepare a MEME v2 curve buy or sell",
        description: `Takes the quote's amount, minOut, and deadline. A deadline in the past is 409 QUOTE_EXPIRED / LAUNCH2_QUOTE_EXPIRED (re-quote); more than 600 s ahead is 422 LAUNCH2_DEADLINE_TOO_FAR. Decision 0126: the deadline encoded in buy / sell (and the intent's deadline / expiresAt) is max(the quote's deadline, prepare time + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS, default 180 s). Re-quotes at one block: an amount above the executable MAX is 422 LAUNCH2_AMOUNT_ABOVE_MAX (detailsSafe.maxAmountIn, limitedBy) or 409 INSUFFICIENT_BALANCE when the balance is the bound (LAUNCH2_USD1_BALANCE_INSUFFICIENT with detailsSafe.maxAmountIn, balanceUsd1 | LAUNCH2_MEME_BALANCE_INSUFFICIENT with maxAmountIn, balanceMeme; LAUNCH2_GAS_INSUFFICIENT with requiredBnb = the gas fee ceiling, balanceBnb); a fresh expectedOut below minOut (another order filled first) is 409 DATA_STALE / LAUNCH2_PRICE_MOVED (detailsSafe.expectedOut) — refresh the quote in place. In the priority hour a buy carries the wallet's Merkle proof from the verified snapshot (403 POLICY_BLOCKED / LAUNCH2_NOT_IN_SNAPSHOT; 503 LAUNCH2_SNAPSHOT_UNVERIFIED when the lane could not reproduce the published root). Returns buy(amountInMax, minMemeOut, deadline, proof) / sell(memeIn, minUsd1Out, deadline) unsigned, with an exact approve first when the allowance is short. The contract still enforces minOut / deadline and refunds the unused USD1. Decision 0117: the curve, the USD1 and the MEME must be the activated instance's registered contracts, else 403 POLICY_BLOCKED / LAUNCH2_COUNTERPARTY_NOT_INSTANCE; the Decision 0065 canary asset and ceilings still apply. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launch2TradePrepareRequestSchema,
        response: { 201: launch2IntentResourceSchema, ...launch2CommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: [
        assertNoQuery,
        assertDecimalStringFields(["amount", "minOut"]),
      ],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const resource = await service.prepareTrade({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/pool/quote",
    {
      schema: {
        operationId: "getV2Launch2PoolQuote",
        summary:
          "Quote a graduated MEME v2 buy or sell on the official v4 pool",
        description: `Decision 0124. Graduated instances only: simulates OfficialPoolRouter.swapExactIn (minAmountOut 0) / swapExactOut (maxAmountIn unbounded) with eth_call from the wallet at one block (input-token balance and allowance overridden in the call only), on the PoolKey (min/max(USD1, MEME), fee 2500, tickSpacing 60, the instance hook) verified against officialPoolId. buy = USD1 → MEME, sell = MEME → USD1; the 2 % OfficialTaxHook tax is taken from the output (taxToken). minOut / maxIn apply slippageBps (default LAUNCH2_DEFAULT_SLIPPAGE_BPS); deadline = expiresAt = now + LAUNCH2_QUOTE_TTL_SECONDS (the quote's freshness; Decision 0126: the prepare re-simulates and encodes its own, longer deadline). 422 VALIDATION_FAILED / POOL_NOT_GRADUATED (detailsSafe.stage) | POOL_QUOTE_UNAVAILABLE (simulation reverted; detailsSafe.revertReason) | POOL_INSUFFICIENT_LIQUIDITY | POOL_QUOTE_ZERO | LAUNCH2_AMOUNT_INVALID; 409 DATA_STALE / LAUNCH2_INSTANCE_PAUSED; 503 CAPABILITY_UNAVAILABLE / POOL_ROUTER_NOT_CONFIGURED | POOL_ROUTER_CODE_MISMATCH | POOL_ROUTER_MANAGER_MISMATCH | POOL_KEY_MISMATCH | LAUNCH2_CHAIN_READ_FAILED. Decision 0131 — a LoopDynamic instance (no Hook at deployLaunch; the per-project LoopDynamicHook bound at graduation) quotes through LoopRouter.swapExactInput instead: exactIn only (exactOut is 422 LAUNCH2_EXACT_OUT_UNSUPPORTED); taxBps = the Hook's buy fee (MEME) / base sell fee (USD1); quote.dynamic carries the dynamic sell fee (dynamicTaxBps / dynamicTaxAmount, from a second base-fee-only simulation), armed / roundId after the candle roll, and rewardWeight (a buy's USD1 while armed); router = LoopRouter — Decision 0153: the instance's own Factory's loopRouter() (an older Factory's instance quotes and prepares through its older router). Its 503 reasons are LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED | LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH | LAUNCH2_DYNAMIC_FACTORY_UNKNOWN | LAUNCH2_DYNAMIC_ROUTER_MISMATCH | LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED | LAUNCH2_DYNAMIC_HOOK_MISMATCH | LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED; contract errors map to 422 LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED | LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED, 409 DATA_STALE / LAUNCH2_DYNAMIC_HOOK_BUSY. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2PoolQuoteQuerySchema,
        response: {
          200: launch2PoolQuoteResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.poolQuote({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        side: query["side"],
        mode: query["mode"],
        amount: query["amount"],
        walletId: query["walletId"],
        ...(query["slippageBps"] === undefined
          ? {}
          : { slippageBps: query["slippageBps"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch2/instances/:instanceId/pool/trade/prepare",
    {
      schema: {
        operationId: "prepareV2Launch2PoolTrade",
        summary:
          "Prepare a graduated MEME v2 buy or sell on the official v4 pool",
        description: `Decision 0124. Re-quotes like GET …/pool/quote at one block (Decision 0126: a fresh simulation at the prepare block, basis = that block; the encoded deadline and the intent's deadline / expiresAt = prepare time + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS, default 180 s, so the approve and the trade can both be signed) and returns the unsigned OfficialPoolRouter call for the device signing exit (to = the router, value 0, recipient = the wallet): swapExactIn(key, zeroForOne, amountIn, minOut, wallet, deadline) or swapExactOut(key, zeroForOne, amountOut, maxIn, wallet, deadline); kind pool_buy / pool_sell. approval = an exact approve of the input token (buy: USD1, sell: MEME) to the router for amountIn (exactIn) or maxIn (exactOut), null when the allowance already covers it (then the call is nonce N, else N+1). simulation = eth_call of the router call (allowance overridden while the approve is pending) and gas = its estimate × 1.2. The response carries the quote it was built from. 422 VALIDATION_FAILED / POOL_NOT_GRADUATED | POOL_QUOTE_UNAVAILABLE | POOL_INSUFFICIENT_LIQUIDITY | POOL_QUOTE_ZERO | LAUNCH2_AMOUNT_INVALID | LAUNCH2_WALLET_NOT_EMBEDDED; 409 INSUFFICIENT_BALANCE / LAUNCH2_USD1_BALANCE_INSUFFICIENT (detailsSafe.maxAmountIn = the balance, requiredAmountIn, balanceUsd1) | LAUNCH2_MEME_BALANCE_INSUFFICIENT (maxAmountIn, requiredAmountIn, balanceMeme) | LAUNCH2_GAS_INSUFFICIENT (requiredBnb = the gas fee ceiling, balanceBnb); 409 DATA_STALE / LAUNCH2_INSTANCE_PAUSED; 403 POLICY_BLOCKED (Decision 0065 canary asset / ceilings; Decision 0117 counterparties: the instance's MEME / USD1 and the code-hash-verified router only); 503 LAUNCH2_WRITES_DISABLED while BSC_WRITES_ENABLED is off and the pool quote 503 reasons. Idempotency-Key replays the same Intent. Decision 0131: a LoopDynamic instance prepares LoopRouter.swapExactInput(key, zeroForOne, amountIn, minOut, MIN/MAX_SQRT_PRICE±1, deadline) instead (exactIn only, 422 LAUNCH2_EXACT_OUT_UNSUPPORTED; the approve spender is LoopRouter; the trade pays and receives for the signing wallet); same kinds pool_buy / pool_sell and the quote's dynamic block. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launch2PoolTradePrepareRequestSchema,
        response: {
          201: launch2PoolIntentResourceSchema,
          ...launch2CommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: [assertNoQuery, assertDecimalStringFields(["amount"])],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const resource = await service.preparePoolTrade({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/pool/trades",
    {
      schema: {
        operationId: "listV2Launch2MyPoolTrades",
        summary: "List one wallet's official-pool trades of a MEME v2 instance",
        description: `Decision 0126. The caller's wallet (walletId, required; 404 when it is not one of the caller's wallets) — its official-pool swaps the launch2_event lane attributed: each OfficialPoolRouter Swap(poolId, payer, recipient, …) log is paired with the PoolManager Swap of the same pool in the same transaction (the PoolManager sender must be the router, the router log follows it, the input amounts agree); the payer is the trader. Swaps that did not go through the router (the buyback executor, other routers) are never attributed. Decision 0132: on a LoopDynamic pool (LoopRouter emits no event) a swap is the wallet whose transaction called LoopRouter directly (tx.from, tx.to = the Hook trustedRouter, one swap in the transaction); amountOut is net of the Hook fee; anything else stays anonymous. Newest first; limit <= 50 (default 20). poolTradeCount / lastPoolTradeAt cover all of the wallet's attributed trades. Before graduation the list is empty. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2PoolTradesQuerySchema,
        response: {
          200: launch2PoolTradesResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listPoolTrades({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        walletId: query["walletId"],
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/pool/recent-trades",
    {
      schema: {
        operationId: "listV2Launch2RecentPoolTrades",
        summary:
          "List the newest public official-pool trades of a MEME v2 instance",
        description: `Decision 0174. Public: no Bearer (the LOOP read headers stay required, no Idempotency-Key). The instance's newest official-pool user swaps of every wallet (the Decision 0127 / 0158 rule: never the buyback adapter / executor or a buyback transaction), newest first by block and log index; limit 1–50 (default 20, above 50 is 400 INVALID_REQUEST). Each item: txHash, blockNumber, at (swap time), side, memeAmount, usd1Amount (buy = USD1 paid; sell = USD1 received net of a USD1 pool fee), priceUsd1 (pool price after the swap), wallet = the Decision 0126 / 0132 attributed trader masked as 0x1234…abcd, null when anonymous. Before graduation items is []. One answer per (instance, limit) is reused for ${String(launch2RecentPoolTradesCacheMs / 1000)} s (observedAt = when it was read); 200 is Cache-Control: public, max-age=${String(launch2RecentPoolTradesCacheMs / 1000)}. 404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND. 429 RATE_LIMITED (Retry-After seconds) above PUBLIC_RATE_LIMIT_PER_MINUTE requests per visitor per minute (TRUST_PROXY / PUBLIC_CLIENT_IP_HEADERS name the visitor). ${unavailableNote}`,
        tags: ["launch2"],
        security: [],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2RecentPoolTradesQuerySchema,
        response: {
          200: launch2RecentPoolTradesResourceSchema,
          ...launch2RecentPoolTradesErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const retryAfter = recentTradesLimiter.admit(
        publicClientKey(
          request,
          dependencies.config.trustProxy,
          dependencies.config.publicRateLimit.clientIpHeaders,
        ),
      );
      if (retryAfter !== null) {
        reply.header("retry-after", String(retryAfter));
        throw V2ApiError.rateLimited();
      }
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listRecentPoolTrades({
        instanceId: params.instanceId,
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header(
        "cache-control",
        `public, max-age=${String(launch2RecentPoolTradesCacheMs / 1000)}`,
      );
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/dynamic-pool",
    {
      schema: {
        operationId: "getV2Launch2DynamicPool",
        summary:
          "Get the LoopDynamic pool and reward-round state of a MEME v2 instance",
        description: `Decision 0131. Every instance answers its hookKind: an OfficialTax instance is status not_applicable (every other field null); a LoopDynamic instance before graduation is not_graduated. A graduated LoopDynamic instance reads its indexed Hook (LoopHookBound) at one block, cross-checked (Decision 0153) against its own Factory — a trusted one (LAUNCH2_DYNAMIC_FACTORY_ADDRESS or a v3 LAUNCH2_LEGACY_FACTORIES entry): the Factory's loopHook(launchId), loopRouter() (trustedRouter, PoolManager, code hash) and routerRegistry() — and the indexed pool id (router = that Factory's LoopRouter): armed, currentRoundId, candle (5 min) and whether a roll is pending, currentDropWad, the dynamic fee cap (maxDynamicFeeWad; the sell rate is min(drop, cap), currentDynamicTaxBps) and the round close rule (Decision 0144: an armed round closes at the first candle that no longer falls — close ≥ open, flat included — on S193 Hooks; only on a rising close on pre-S193 Hooks), the pot (carry + the armed round's dynamic fees), the round's total buy weight, the viewer's weight (walletId query or the active wallet; null without one; Decision 0146: the chain's buyWeight with the projection's merged weight and weightReconciled), currentRoundBuyers (Decision 0146: the armed round's addresses by merged weight — BuyCredited + CreditMoved received − sent — with each one's attributions; any router's buy counts and is credited to the address receiving the MEME), the fee rates, routingPolicy / priceTiming, and the indexed round summary. 503 CAPABILITY_UNAVAILABLE / LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED | LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH | LAUNCH2_DYNAMIC_FACTORY_UNKNOWN (untrusted Factory) | LAUNCH2_DYNAMIC_ROUTER_MISMATCH (the current Factory's chain router / registry differ from the configuration) | LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED | LAUNCH2_DYNAMIC_HOOK_MISMATCH | LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED | LAUNCH2_CHAIN_READ_FAILED. Decision 0132: every such dependency 503 (after the instance is read) adds detailsSafe.hookKind (officialTax | loopDynamic, the registry row) so a client whose first read fails still picks the LoopDynamic panel. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2DynamicPoolQuerySchema,
        response: {
          200: launch2DynamicPoolResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.getDynamicPool({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        ...(query["walletId"] === undefined
          ? {}
          : { walletId: query["walletId"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/dynamic-pool/rewards",
    {
      schema: {
        operationId: "listV2Launch2DynamicRewards",
        summary: "List one wallet's LoopDynamic reward rounds",
        description: `Decision 0131. The caller's wallet (walletId, required; 404 when it is not one of the caller's wallets): every round in which it has buy weight, newest first (Decision 0146: any router's buy counts and is credited to the address receiving the MEME — weight = indexed BuyCredited to the wallet + CreditMoved received − CreditMoved sent, the chain's buyWeight; credits lists the round's entries with their attribution loopRouter | registryRouter | delivery | moved | unknown), limit <= 100 (default 50). status: open (round not closed yet), claimable (closed, allocation × weight / totalBuyWeight > 0, not claimed), claimed (indexed RewardClaimed), no_reward. claimableUsd1 is the projection's floor(allocation × weight / totalBuyWeight) — claim/prepare re-checks on chain. An OfficialTax instance answers hookKind officialTax with no rounds. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2DynamicRewardsQuerySchema,
        response: {
          200: launch2DynamicRewardsResourceSchema,
          ...launch2ReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listDynamicRewards({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        walletId: query["walletId"],
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch2/instances/:instanceId/dynamic-pool/claim/prepare",
    {
      schema: {
        operationId: "prepareV2Launch2DynamicClaim",
        summary:
          "Prepare a LoopDynamic reward claim (claim(roundId) on the Hook)",
        description: `Decision 0131. Simulates hook.claim(roundId) from the wallet at one block (claim rolls the 5-minute candle first, so a round the roll closes is claimable in the same transaction) and returns the unsigned claim(roundId) transaction (to = the instance's indexed Hook, value 0, no approval) as a launch2 intent of kind dynamic_claim for the device signing exit; claim = {roundId, hook, claimableUsd1}. 422 VALIDATION_FAILED / LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE (OfficialTax instance) | POOL_NOT_GRADUATED | LAUNCH2_DYNAMIC_ROUND_INVALID | LAUNCH2_WALLET_NOT_EMBEDDED; 409 DATA_STALE / LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED | LAUNCH2_DYNAMIC_HOOK_BUSY; 409 RESOURCE_CONFLICT / LAUNCH2_DYNAMIC_ALREADY_CLAIMED; 409 INSUFFICIENT_BALANCE / LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM | LAUNCH2_GAS_INSUFFICIENT; 403 POLICY_BLOCKED (canary asset / ceilings; the target must be the instance's bound Hook); 503 LAUNCH2_WRITES_DISABLED | LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED | LAUNCH2_DYNAMIC_FACTORY_UNKNOWN | LAUNCH2_DYNAMIC_ROUTER_MISMATCH | LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED | LAUNCH2_DYNAMIC_HOOK_MISMATCH (Decision 0153: checked against the instance's own Factory). Idempotency-Key replays the same Intent. ${unavailableNote} ${holdNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launch2DynamicClaimPrepareRequestSchema,
        response: {
          201: launch2DynamicClaimIntentResourceSchema,
          ...launch2DynamicCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const resource = await service.prepareDynamicClaim({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.post(
    "/v2/launch2/instances/:instanceId/dynamic-pool/claim/report",
    {
      schema: {
        operationId: "reportV2Launch2DynamicClaim",
        summary: "Report the hash of a sent LoopDynamic claim transaction",
        description: `Decision 0131. Records the device's transaction hash for one of the caller's dynamic_claim intents of this instance (once; re-reporting the same hash is idempotent, another hash is 409 RESOURCE_CONFLICT / LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT; an unknown / foreign intent is 404 NOT_FOUND / LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND). status confirmed once the launch2_event lane indexed that transaction's RewardClaimed for (round, wallet) — amountUsd1, claimedAt, blockNumber — else submitted (report again; the indexed log stays the truth, the report never moves money or ledgers). ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launch2DynamicClaimReportRequestSchema,
        response: {
          200: launch2DynamicClaimReportResourceSchema,
          ...launch2DynamicCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const resource = await service.reportDynamicClaim({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        body: request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/instances/:instanceId/buybacks",
    {
      schema: {
        operationId: "listV2Launch2Buybacks",
        summary: "List the NFT-escrow buybacks of a MEME v2 instance",
        description: `BuybackCompleted logs indexed by the launch2_event lane (100 USD1 per order, the last may be smaller; ≥ 10 s between successes), newest first, plus the ledger summary and a live read of the executor and escrow (paused, budget, next order and why it cannot run now: nextOrderBlockedReason, Decision 0122 — from quoteNextOrder().executable on the v3 Factory, which has no price protection; minMemeOut / referencePriceUsd1 / spotPriceUsd1 are null for v3 executions). A refusal reverts on chain and leaves no log, so refused attempts are not listed (outcome rejected is reserved for the keeper). live is null with liveUnavailable.reasonCode when the chain read fails. Signed cursor; limit <= 100 (default 30). ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2PageQuerySchema,
        response: { 200: launch2BuybacksResourceSchema, ...launch2ReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as InstanceParams;
      const query = request.query as Record<string, unknown>;
      const resource = await service.listBuybacks({
        principal: requireAuthenticatedLoopPrincipal(request),
        instanceId: params.instanceId,
        ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
        ...(query["limit"] === undefined ? {} : { limit: query["limit"] }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch2/me/positions",
    {
      schema: {
        operationId: "listV2Launch2MyPositions",
        summary: "List the caller's MEME v2 NFTs and curve positions",
        description: `Per instance and per wallet of the account: the minted NFT token id and NFTs held (from the NFT transfers), snapshot membership, curve bought / sold / net, and the cumulative buy that both rounds share against the 5,000,000 MEME (0.5%) cap — selling does not restore it. Decision 0126: a wallet whose only activity is official-pool trades (attributed through the router) is listed too; graduated rows carry memeBalance / usd1Balance read at one block (≤ 15 s cache, balanceStatus available | unavailable), curve-phase rows null with balanceStatus not_graduated; poolTradeCount / lastPoolTradeAt = the wallet's attributed pool trades. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: launch2PositionsResourceSchema, ...launch2ReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.listMyPositions({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
  // Decision 0173: public ERC-721 metadata — the stable target of a future
  // on-chain `_baseURI` (`<PUBLIC_BASE_URL>/v2/launch2/nft/<launchId>/`).
  // Like the logo proxy: no Bearer, no LOOP headers, CDN-cacheable.
  app.get(
    "/v2/launch2/nft/:launchId/:tokenId",
    {
      schema: {
        operationId: "getV2Launch2NftMetadata",
        summary: "Get the ERC-721 metadata of one MEME v2 project NFT",
        description: `Decision 0173. Public JSON resource (ERC-721 / OpenSea metadata keys); no authentication and no LOOP headers, like the token logo proxy — the path is the stable target of a future on-chain \`_baseURI\` (\`<base>/v2/launch2/nft/<launchId>/\` + tokenId) and must not change. Body: {name: "<project name> #<tokenId>", description: the project description or a fixed LOOP sentence, image: \`ipfs://<cid>\` of the pinned project NFT picture, else its https URL, else the logo, else null, image_gateway: the same picture over https (IPFS gateway URL) for clients without ipfs://, attributes: [{trait_type: "Project", value: ticker}, {trait_type: "Token ID", value: tokenId}, {trait_type: "Stage", value: stage}]}. No external_url (LOOP has no public project page URL yet). 200 with \`Cache-Control: ${launch2NftMetadataCacheControl}\` and \`Access-Control-Allow-Origin: *\`. 404 NOT_FOUND: LAUNCH2_INSTANCE_NOT_FOUND for an unknown (or not yet activated) launch id, LAUNCH2_NFT_NOT_MINTED for a tokenId above the instance's minted count; a malformed launchId / tokenId is 400 INVALID_REQUEST. Errors are \`no-store\`. ${unavailableNote}`,
        tags: ["launch2"],
        security: [],
        params: launch2NftMetadataParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: launch2NftMetadataResourceSchema,
          400: launch2ReadErrors[400],
          404: launch2ReadErrors[404],
          500: launch2ReadErrors[500],
          503: launch2ReadErrors[503],
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly launchId: string;
        readonly tokenId: string;
      };
      reply.header("access-control-allow-origin", "*");
      reply.header("cache-control", "no-store");
      const metadata = await service.getNftMetadata({
        launchId: params.launchId,
        tokenId: params.tokenId,
      });
      reply.header("cache-control", launch2NftMetadataCacheControl);
      return reply.code(200).send(metadata);
    },
  );
}
