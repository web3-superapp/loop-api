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
 * V2 mining module routes (D18/D19 slots, Decision 0036). Registered only
 * when `V2_MODULES_ENABLED` contains `mining`. Every route is a read; with no
 * approved formula every power, reward, and rank is unavailable and the
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
          "Power, network power, today's estimate, accumulated, claimable, and referral boost are unavailable until a formula version is approved (MINING_FORMULA_BASELINE_PENDING) and a reward authority exists (REWARD_AUTHORITY_PENDING). The pending formula version is named so the client can label it.",
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
        summary: "Get the caller's per-asset power composition (unavailable)",
        description:
          "Per-asset contribution, exclusion state, and reference price all derive from an approved formula and price-guard rules; every block is unavailable and the lists are empty by contract, never by absence of holdings.",
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
        summary: "Get the caller's reward ledger (unavailable)",
        description:
          "claimable stays unavailable with REWARD_AUTHORITY_PENDING and claimExecutable is false: the claim button never executes in this step. The ledger structure exists but no route writes it.",
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
        summary: "Get the user or community power ranking (unavailable)",
        description:
          "scope=users|communities. Rankings use only confirmed server snapshots and stay unavailable until one exists under an approved formula. Display rule: alias only for discoverable, non-anonymous profiles; otherwise the anonymous member label.",
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
        summary: "Get a community's Mining weight record",
        description:
          "The reviewed weight (approved: decimal string + configVersion + reviewedAt; otherwise unavailable with COMMUNITY_WEIGHT_PENDING_REVIEW). Community power, the caller's contribution, rank, and participant count are unavailable without an approved formula.",
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
          "Lists the approved formula version (null in this step) and the pending_approval versions, each with rule keys for the expression, daily output, weight range, and price guard (TWAP, multi-period/multi-source, liquidity cap). No weight number or reward promise is published before approval.",
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
