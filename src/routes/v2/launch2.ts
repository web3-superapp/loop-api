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
  launch2BuybacksResourceSchema,
  launch2CommandErrors,
  launch2DetailQuerySchema,
  launch2ErrorDescription,
  launch2InstanceDetailResourceSchema,
  launch2InstanceListResourceSchema,
  launch2InstanceParamsSchema,
  launch2IntentResourceSchema,
  launch2ListQuerySchema,
  launch2NftPrepareRequestSchema,
  launch2PageQuerySchema,
  launch2PositionsResourceSchema,
  launch2QuoteQuerySchema,
  launch2QuoteResourceSchema,
  launch2ReadErrors,
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

function idempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

interface InstanceParams {
  readonly instanceId: string;
}

export function registerV2Launch2Routes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, launch2Service: service } = dependencies;

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
    "/v2/launch2/instances/:instanceId",
    {
      schema: {
        operationId: "getV2Launch2Instance",
        summary: "Get one MEME v2 launch instance",
        description: `Stage and nextChangeAt, the fixed template (read-only), every module address, NFT sale progress, the snapshot (root, cutoff, verification: the lane rebuilt the holder list from the NFT transfers and the root/cutoff reproduce), curve readings, graduation (official pool id, hook, fee), the buyback ledger summary, the 20 latest curve trades, and the viewer block (walletId query or the active wallet; null without one). Not activated / unknown: 404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND. ${unavailableNote}`,
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
    "/v2/launch2/instances/:instanceId/quote",
    {
      schema: {
        operationId: "getV2Launch2Quote",
        summary: "Quote a MEME v2 curve buy or sell with the executable MAX",
        description: `Reads the curve, the wallet's cumulative buy, and its USD1 / MEME balance at one block of the launch slot and recomputes CurveEngine (10% tax each way). buy amount = USD1 in (tax included); sell amount = MEME in. max = the executable maximum: buy = min(remaining 0.5% quota, remaining inventory) priced on the curve with tax, lowered to the USD1 balance; sell = the MEME balance bounded by the sold supply. An amount above max is quoted at max with exceedsMax true. minOut = expectedOut × (1 − slippageBps), deadline = now + LAUNCH2_QUOTE_TTL_SECONDS. In the priority hour eligibility says whether the wallet is in the verified snapshot. 409 DATA_STALE / LAUNCH2_STAGE_MISMATCH (detailsSafe.stage; upcoming, nft_sale and snapshot_pending are never quoted) | LAUNCH2_SELL_NOT_OPEN | LAUNCH2_SOLD_OUT | LAUNCH2_QUOTA_EXHAUSTED | LAUNCH2_INSTANCE_PAUSED; 422 VALIDATION_FAILED / LAUNCH2_AMOUNT_INVALID. ${unavailableNote}`,
        tags: ["launch2"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launch2InstanceParamsSchema,
        querystring: launch2QuoteQuerySchema,
        response: { 200: launch2QuoteResourceSchema, ...launch2ReadErrors },
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
        description: `Pre-checks at one block what ProjectNFT.mint enforces (activated, sale open by block time, one mint per address for life, 100 USD1 balance) and returns the unsigned mint() transaction for the device signing exit, preceded by an exact 100 USD1 approve to the NFT contract when the allowance is short (nonce N, the mint N+1). 409 DATA_STALE / LAUNCH2_STAGE_MISMATCH | LAUNCH2_NFT_ALREADY_MINTED; 409 INSUFFICIENT_BALANCE / LAUNCH2_USD1_BALANCE_INSUFFICIENT | LAUNCH2_GAS_INSUFFICIENT; 403 POLICY_BLOCKED (Decision 0065 canary asset and ceilings, USD1 at par; Decision 0117: the NFT and the USD1 must be the activated instance's registered contracts, else LAUNCH2_COUNTERPARTY_NOT_INSTANCE); 503 LAUNCH2_WRITES_DISABLED while BSC_WRITES_ENABLED is off. Idempotency-Key replays the same Intent. ${unavailableNote}`,
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
        description: `Takes the quote's amount, minOut, and deadline. A deadline in the past is 409 QUOTE_EXPIRED / LAUNCH2_QUOTE_EXPIRED (re-quote); more than 600 s ahead is 422 LAUNCH2_DEADLINE_TOO_FAR. Re-quotes at one block: an amount above the executable MAX is 422 LAUNCH2_AMOUNT_ABOVE_MAX (detailsSafe.maxAmountIn, limitedBy) or 409 INSUFFICIENT_BALANCE when the balance is the bound; a fresh expectedOut below minOut (another order filled first) is 409 DATA_STALE / LAUNCH2_PRICE_MOVED (detailsSafe.expectedOut) — refresh the quote in place. In the priority hour a buy carries the wallet's Merkle proof from the verified snapshot (403 POLICY_BLOCKED / LAUNCH2_NOT_IN_SNAPSHOT; 503 LAUNCH2_SNAPSHOT_UNVERIFIED when the lane could not reproduce the published root). Returns buy(amountInMax, minMemeOut, deadline, proof) / sell(memeIn, minUsd1Out, deadline) unsigned, with an exact approve first when the allowance is short. The contract still enforces minOut / deadline and refunds the unused USD1. Decision 0117: the curve, the USD1 and the MEME must be the activated instance's registered contracts, else 403 POLICY_BLOCKED / LAUNCH2_COUNTERPARTY_NOT_INSTANCE; the Decision 0065 canary asset and ceilings still apply. ${unavailableNote}`,
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
    "/v2/launch2/instances/:instanceId/buybacks",
    {
      schema: {
        operationId: "listV2Launch2Buybacks",
        summary: "List the NFT-escrow buybacks of a MEME v2 instance",
        description: `BuybackCompleted logs indexed by the launch2_event lane (100 USD1 per order, the last may be smaller; ≥ 10 s between successes), newest first, plus the ledger summary and a live read of the executor and escrow (paused, budget, next order and the protection that would refuse it now: nextOrderBlockedReason). A protection refusal reverts on chain and leaves no log, so refused attempts are not listed (outcome rejected is reserved for the keeper). live is null with liveUnavailable.reasonCode when the chain read fails. Signed cursor; limit <= 100 (default 30). ${unavailableNote}`,
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
        description: `Per instance and per wallet of the account: the minted NFT token id and NFTs held (from the NFT transfers), snapshot membership, curve bought / sold / net, and the cumulative buy that both rounds share against the 5,000,000 MEME (0.5%) cap — selling does not restore it. Wallet-to-wallet MEME transfers after graduation are not tracked. ${unavailableNote}`,
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
}
