import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import type { MiningService } from "../../features/mining/mining-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  referralRulesResourceSchema,
  v2CommonHeadersSchema,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  miningAssetsResourceSchema,
  miningCommunityParamsSchema,
  miningCommunityResourceSchema,
  miningRankQuerySchema,
  miningRankResourceSchema,
  miningReadErrors,
  miningRewardsResourceSchema,
  miningRulesResourceSchema,
  miningSummaryResourceSchema,
} from "./mining-schemas.js";

/**
 * V2 mining module routes (D18/D19 slots, Decisions 0036 and 0043).
 * Registered only when `V2_MODULES_ENABLED` contains `mining`. Every route
 * is a read from the latest server snapshot under the formula version in
 * force; without one every power, estimate, and rank is unavailable and the
 * rules page shows the pending version marked as such.
 */

interface CommunityParams {
  readonly communityId: string;
}

export function registerV2MiningRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer } = dependencies;
  const service: MiningService = dependencies.miningService;

  app.get(
    "/v2/mining/summary",
    {
      schema: {
        operationId: "getV2MiningSummary",
        summary: "Get the caller's Mining summary",
        description:
          "Power and network power come from the latest complete snapshot under the approved, effective formula version; estimatedToday is budget × power ÷ networkPower under that version's placeholder daily output (MINING_NETWORK_POWER_ZERO while the network total is zero). A run that could not value a held asset publishes nothing (Decision 0057): the page keeps the last complete snapshot with snapshot.stale = true and snapshot.latestAttempt naming the unread holdings, or, without any complete snapshot, every number is MINING_SNAPSHOT_INCOMPLETE. A power of 0 is only ever an observed zero balance. Without a version in force everything is MINING_FORMULA_BASELINE_PENDING and the pending version is named; with one in force no slot emits that code. accumulated and claimable stay REWARD_AUTHORITY_PENDING; referralBoost is MINING_REFERRAL_BOOST_PENDING until a version approves the boost (Decision 0046). formula.scope = development_baseline marks the Decision 0043 placeholder.",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: miningSummaryResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getSummary({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/assets",
    {
      schema: {
        operationId: "getV2MiningAssets",
        summary: "Get the caller's per-asset power composition",
        description:
          "included lists the caller's power rows of the latest complete snapshot (holding × reference price × effective weight); excluded lists held assets the snapshot did not value, with the reason recorded by the latest attempt (MINING_PRICE_PAIR_NOT_FOUND, MINING_PRICE_NOT_FRESH, MINING_PRICE_PROXY_NOT_DECLARED) or re-derived from the same inputs (weight not configured, community weight pending or ambiguous). An excluded asset is unread, never zero. Every row carries the Asset Registry symbol. formula is the version in force; source is the same snapshot block as the summary, with stale and latestAttempt (Decision 0057). Without a complete snapshot under the version in force every block is unavailable and both lists are empty by contract.",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: miningAssetsResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getAssets({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/rewards",
    {
      schema: {
        operationId: "getV2MiningRewards",
        summary: "Get the caller's reward ledger",
        description:
          "claimable and accumulated stay unavailable with REWARD_AUTHORITY_PENDING and claimExecutable is false: the claim button never executes. estimatedToday is the same share-of-network-power estimate as the summary. The ledger structure exists but no route writes it.",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: miningRewardsResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getRewards({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/rank",
    {
      schema: {
        operationId: "getV2MiningRank",
        summary: "Get the user or community power ranking",
        description:
          "scope=users|communities. Rankings use only complete server snapshots under the formula version in force and list the accounts (or communities with an approved weight) holding positive power, rank() with shared positions on ties, at most 100 rows. Display rule: alias only for discoverable, non-anonymous profiles; otherwise the anonymous member label. myPosition is MINING_RANK_NOT_RANKED for a zero-power caller and MINING_RANK_NOT_APPLICABLE for the community scope. formula is the version in force; snapshot is the same block as the summary, with stale and latestAttempt (Decision 0057).",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: miningRankQuerySchema,
        response: { 200: miningRankResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as { readonly scope?: unknown };
      const resource = await service.getRank({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/communities/:communityId",
    {
      schema: {
        operationId: "getV2MiningCommunity",
        summary: "Get a community's Mining weight record and standing",
        description:
          "The reviewed weight (approved: decimal string + configVersion + reviewedAt; otherwise unavailable with reasonCode + reviewStatus) plus, under the latest snapshot of the version in force, the members' power on the bound asset, the caller's own contribution, the community's rank, and the participant count. Without a bound asset every block including weight is COMMUNITY_ASSET_NOT_BOUND (weight.reviewStatus not_applicable); bound without a weight approved under the version in force is COMMUNITY_WEIGHT_PENDING_REVIEW (reviewStatus pending_review).",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: miningCommunityParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: miningCommunityResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.getCommunity({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/rules",
    {
      schema: {
        operationId: "getV2MiningRules",
        summary: "Get the versioned Mining rules",
        description:
          "Lists the approved formula version (null without one) and the pending_approval versions, each with its scope, asset weights, daily output document, weight range (with the community range once pinned), and price-guard rule keys. baseline names the version in force. A development_baseline version publishes placeholder numbers that the client must label as such; a product draft publishes rule keys only.",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: miningRulesResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      const resource = await service.getRules();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/mining/referral/rules",
    {
      schema: {
        operationId: "getV2ReferralRules",
        summary: "Get the versioned referral boost rules",
        description:
          "Read-only static rule snapshot (moved from the community module; path preserved). The five levels are Mining Power boosts, never revenue or commission. Relationship counts and the invite code live on GET /v2/referral.",
        tags: ["mining"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: referralRulesResourceSchema, ...miningReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(service.referralRules());
    },
  );
}
