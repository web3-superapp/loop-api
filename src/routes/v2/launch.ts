import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  hasIdempotencyKeyHeader,
  parseV2CommandMetadata,
} from "../../features/community/community-contract.js";
import { parseV2WriteRequestMetadata } from "../../features/session/session-contract.js";
import type { LaunchService } from "../../features/launch/launch-service.js";
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
  createProjectRequestSchema,
  economyResourceSchema,
  eligibilityResourceSchema,
  historyResourceSchema,
  holdersResourceSchema,
  launchCommandErrors,
  launchDetailResourceSchema,
  launchIdParamsSchema,
  launchIntentRequestSchema,
  launchReadErrors,
  milestonesResourceSchema,
  overviewResourceSchema,
  projectIdParamsSchema,
  projectListQuerySchema,
  projectListResourceSchema,
  projectResourceSchema,
  replaceProjectRequestSchema,
  stakeResourceSchema,
} from "./launch-schemas.js";

/**
 * V2 launch module routes (D17 slot, Decision 0036). Registered only when
 * `V2_MODULES_ENABLED` contains `launch`. The application flow is the only
 * write surface; every on-chain read answers with the four-axis
 * `unavailable` projection and the Intent route is unconditionally 503.
 */

interface ProjectParams {
  readonly projectId: string;
}

interface LaunchParams {
  readonly launchId: string;
}

function commandContext(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

/**
 * CAS replacements are idempotent through `expectedVersion`; a client
 * `Idempotency-Key` is rejected so a lost-response retry is never mistaken
 * for a durable command replay (Decision 0030 rule).
 */
const validateCasWriteHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2WriteRequestMetadata(request.raw.rawHeaders);
    if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

export function registerV2LaunchRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer } = dependencies;
  const service: LaunchService = dependencies.launchService;

  app.get(
    "/v2/launch/overview",
    {
      schema: {
        operationId: "getV2LaunchOverview",
        summary: "Get the Launch landing catalog",
        description:
          "Approved launches grouped by scheduleStatus (live / upcoming / ended) from PostgreSQL. 'Graduated' is a projection of the on-chain liquidity axis and stays unavailable (LAUNCH_CONTRACT_BASELINE_PENDING); eligibility and staking are unavailable. No supply, tax, or contract suffix is published.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: overviewResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      const resource = await service.getOverview();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/projects",
    {
      schema: {
        operationId: "listV2LaunchProjects",
        summary: "List the caller's Launch applications",
        description:
          "Owner-scoped, newest first, with an opaque cursor bound to the owner, route, and status filter. `limit` and `cursor` are mutually exclusive.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: projectListQuerySchema,
        response: { 200: projectListResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly status?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listProjects({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch/projects",
    {
      schema: {
        operationId: "createV2LaunchProject",
        summary: "Create a Launch application draft",
        description:
          "Creates a `draft` project owned by the caller: name, ticker, narrative, and official links. Attachments and KYB have no Provider and stay unavailable. Review is never self-served; only the Dev-only operator script `pnpm launch:review` advances it and writes the audit row.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createProjectRequestSchema,
        response: { 201: projectResourceSchema, ...launchCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.createProject({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/launch/projects/:projectId",
    {
      schema: {
        operationId: "getV2LaunchProject",
        summary: "Get one Launch application",
        description:
          "The owner sees the project in every review status; other accounts see only approved projects. Anything else is NOT_FOUND without enumeration.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: projectResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as ProjectParams;
      const resource = await service.getProject({
        principal: requireAuthenticatedLoopPrincipal(request),
        projectId: params.projectId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/launch/projects/:projectId",
    {
      schema: {
        operationId: "replaceV2LaunchProject",
        summary: "Replace the material of a draft or returned application",
        description:
          "Compare-and-swap keyed by expectedVersion; allowed only while reviewStatus is draft or returned (otherwise DATA_STALE). Each replacement increments materialVersion and appends a project_updated audit row. Idempotency-Key is not accepted.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: replaceProjectRequestSchema,
        response: { 200: projectResourceSchema, ...launchCommandErrors },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as ProjectParams;
      const resource = await service.replaceProject({
        principal: requireAuthenticatedLoopPrincipal(request),
        projectId: params.projectId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch/projects/:projectId/submit",
    {
      schema: {
        operationId: "submitV2LaunchProject",
        summary: "Submit an application for review",
        description:
          "draft | returned → submitted. Any other stored status is DATA_STALE. Submitting does not mean approval; the review result, configuration, and schedule come from the server state.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: projectResourceSchema, ...launchCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as ProjectParams;
      const resource = await service.submitProject({
        principal: requireAuthenticatedLoopPrincipal(request),
        projectId: params.projectId,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/projects/:projectId/milestones",
    {
      schema: {
        operationId: "listV2LaunchProjectMilestones",
        summary: "List external venue milestones for a project",
        description:
          "One independent state machine per venue + market type (03 §8.4). LISTED and FEATURED carry an evidence digest, time, and reviewer; Alpha never implies spot or perpetual. Recorded only by the Dev-only script `pnpm launch:milestone`.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: milestonesResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as ProjectParams;
      const resource = await service.getMilestones({
        principal: requireAuthenticatedLoopPrincipal(request),
        projectId: params.projectId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launches/:launchId",
    {
      schema: {
        operationId: "getV2Launch",
        summary: "Get one catalog launch record",
        description:
          "Project material, the configuration slots (pending_confirmation until the project confirms them), rounds 1..N, the four-axis on-chain projection (every axis unavailable, tuple digest and snapshot block null), the four graduation steps (all pending), and pool evidence (unavailable: no contract address).",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: launchDetailResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const resource = await service.getLaunch({ launchId: params.launchId });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/:launchId/eligibility",
    {
      schema: {
        operationId: "getV2LaunchEligibility",
        summary: "Get the caller's eligibility result for a launch",
        description:
          "mode comes from the confirmed configuration slot tierModeV1 (whitelist | community | activity); without a confirmed configuration it is unavailable with TIER_MODE_PENDING. The result is a server fact for a snapshot, never a tier upgrade, and never depends on staking.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: eligibilityResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const resource = await service.getEligibility({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/:launchId/holders",
    {
      schema: {
        operationId: "getV2LaunchHolders",
        summary: "Get internal-market holder facts (unavailable)",
        description:
          "Holder distribution, the caller's position, and the wallet cap all come from the Launch contract, which has no baseline; every block is unavailable and no fixture replaces it.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: holdersResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const resource = await service.getHolders({ launchId: params.launchId });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/:launchId/history",
    {
      schema: {
        operationId: "getV2LaunchHistory",
        summary: "Get the caller's participation records for a launch",
        description:
          "purchaseRecords, entitlements, and refunds are three separate objects (03 §8.3). Without an indexer for the Launch contract every list is empty and `source` is unavailable; an empty list here is never 'no participation'.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: historyResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const resource = await service.getHistory({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/launch/:launchId/intents",
    {
      schema: {
        operationId: "prepareV2LaunchIntent",
        summary: "Prepare a Launch purchase Intent (unavailable)",
        description:
          "Always 503 CAPABILITY_UNAVAILABLE (LAUNCH_CONTRACT_BASELINE_PENDING). No payload, digest, or launch_intents row is ever produced in this step; the request shape documents the eventual Intent (03 §8.2), which stays fully separate from wallet intents.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launchIntentRequestSchema,
        response: { ...launchCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: [assertNoQuery, assertDecimalStringFields(["payAmount"])],
      preHandler: authenticateLoopBearer,
    },
    (request): never => {
      const params = request.params as LaunchParams;
      return service.prepareIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
      });
    },
  );

  app.get(
    "/v2/launch/stake",
    {
      schema: {
        operationId: "getV2LaunchStake",
        summary: "Get the LOOP staking position (unavailable)",
        description:
          "Always unavailable with STAKING_CONTRACT_PENDING and executable=false: the loop-stake page renders but cannot execute, and eligibility never depends on it.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: stakeResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(service.getStake());
    },
  );

  app.get(
    "/v2/launch/economy",
    {
      schema: {
        operationId: "getV2LaunchEconomy",
        summary: "Get the public LOOP economy ledger",
        description:
          "Only counts that PostgreSQL can prove: projects by review status, launches by schedule status, confirmed rounds, with source loop_db and observedAt. Total supply, distribution, and ecosystem tax are unavailable.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: economyResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (_request, reply) => {
      const resource = await service.getEconomy();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
