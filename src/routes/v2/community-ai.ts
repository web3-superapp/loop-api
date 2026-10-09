import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { canonicalizeClientIp } from "../../core/http/client-ip.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import {
  communityAiAnswerParamsSchema,
  communityAiAnswerResourceSchema,
  communityAiAskRequestSchema,
  communityAiCommandErrors,
  communityAiOverviewResourceSchema,
  communityAiReadErrors,
  communityAiReportRequestSchema,
  communityAiReportResourceSchema,
} from "./community-ai-schemas.js";
import {
  assertNoBodyOrQueryV2,
  assertNoQuery,
  communityIdParamsSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Community AI routes (Decision 0066). Registered with the `community`
 * module; without `ANTHROPIC_API_KEY` the composed service is the closed one
 * and every path answers `503 CAPABILITY_UNAVAILABLE` with
 * `COMMUNITY_AI_RUNTIME_DEFERRED`, which is also what
 * `GET /v2/meta/capabilities` reports for `communityAi`.
 */

interface CommunityParams {
  readonly communityId: string;
}

interface AnswerParams extends CommunityParams {
  readonly answerId: string;
}

function readContext(request: FastifyRequest): {
  readonly principal: ReturnType<typeof requireAuthenticatedLoopPrincipal>;
  readonly canonicalClientIp: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
} {
  return {
    principal: requireAuthenticatedLoopPrincipal(request),
    canonicalClientIp: canonicalizeClientIp(request.ip),
    requestId: request.id,
    signal: request.signal,
  };
}

export function registerV2CommunityAiRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, communityAiService } = dependencies;

  app.get(
    "/v2/communities/:communityId/ai/overview",
    {
      schema: {
        operationId: "getV2CommunityAiOverview",
        summary:
          "Get the Community AI ability list, knowledge snapshot, and brief",
        description:
          "The eight abilities of the community-ai page, each `available` or `unavailable` with the reason no source backs it; `communityAnalytics` is present only for an owner or admin. `knowledge` publishes how many live sources this community has and when the newest was observed — never a document count, because LOOP ingests no documents. `brief` is today's discussion count plus a model-written summary, cached per community for one hour and available only to an active member.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: communityAiOverviewResourceSchema,
          ...communityAiReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await communityAiService.getOverview({
        communityId: params.communityId,
        ...readContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities/:communityId/ai/ask",
    {
      schema: {
        operationId: "askV2CommunityAi",
        summary: "Ask the community assistant a question",
        description:
          "Answers only from the sources this request assembled: the community profile, the bound asset's market facts, the community's mining numbers, the voice room state, and — for an active member only — up to 100 official-channel messages from the last 7 days. `citations` may name only those sources. The question is never logged and the messages are never stored. A Provider that cannot answer is `503 CAPABILITY_UNAVAILABLE` with the reason; no canned answer is ever returned. Quotas: 6 requests per account per minute and a per-community daily budget, both durable.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: communityAiAskRequestSchema,
        response: {
          200: communityAiAnswerResourceSchema,
          ...communityAiCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await communityAiService.ask({
        communityId: params.communityId,
        idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
          .idempotencyKey,
        body: request.body,
        ...readContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/communities/:communityId/ai/answers/:answerId/report",
    {
      schema: {
        operationId: "reportV2CommunityAiAnswer",
        summary: "Report a Community AI answer",
        description:
          "One report per (answer, account); a repeat returns the stored report. Only an answer the caller itself received can be reported — another account's answer ID is `404 NOT_FOUND` rather than `403`, so IDs cannot be enumerated.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityAiAnswerParamsSchema,
        querystring: emptyQueryStringSchema,
        body: communityAiReportRequestSchema,
        response: {
          201: communityAiReportResourceSchema,
          ...communityAiCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AnswerParams;
      const resource = await communityAiService.report({
        communityId: params.communityId,
        answerId: params.answerId,
        idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
          .idempotencyKey,
        body: request.body,
        ...readContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );
}
