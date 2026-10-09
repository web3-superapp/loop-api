import { z } from "zod";
import {
  HooksLaunchSubmissionError,
  hooksLaunchSubmissionSchema,
} from "../../features/launch/hooks-launch-submission.js";
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
import type { HooksLaunchDeploymentService } from "../../features/launch/hooks-launch-deployment.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  type HooksLaunchProjectConfigService,
} from "../../features/launch/hooks-launch-project-config.js";
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
  eligibilityQuerySchema,
  eligibilityResourceSchema,
  historyResourceSchema,
  holdersResourceSchema,
  launchCommandErrors,
  launchDetailResourceSchema,
  launchIdParamsSchema,
  launchIntentRequestSchema,
  launchIntentErrors,
  launchIntentParamsSchema,
  launchIntentReportRequestSchema,
  launchIntentReportResourceSchema,
  launchIntentResourceSchema,
  launchReadErrors,
  milestonesResourceSchema,
  overviewResourceSchema,
  projectIdParamsSchema,
  projectListQuerySchema,
  projectListResourceSchema,
  projectResourceSchema,
  replaceProjectRequestSchema,
  hooksLaunchProjectConfigRequestSchema,
  hooksLaunchProjectConfigResourceSchema,
  hooksLaunchSigningRequestQuerySchema,
  hooksLaunchSigningRequestResourceSchema,
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
  const hooksConfigService: HooksLaunchProjectConfigService | undefined =
    dependencies.hooksLaunchProjectConfigService;
  const hooksDeploymentService: HooksLaunchDeploymentService | undefined =
    dependencies.hooksLaunchDeploymentService;

  app.get(
    "/v2/launch/projects/:projectId/hooks-config",
    {
      schema: {
        operationId: "getV2HooksLaunchProjectConfig",
        summary: "Read the caller's fixed-template Hooks project configuration",
        description:
          "Owner-scoped off-chain draft only. Reading this resource does not publish or activate any contract.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["draft", "contractVersion"],
            properties: {
              draft: {
                anyOf: [
                  hooksLaunchProjectConfigResourceSchema,
                  { type: "null" },
                ],
              },
              contractVersion: { type: "string", const: v2ContractVersion },
            },
          },
          ...launchReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksConfigService === undefined) {
        throw V2ApiError.capabilityUnavailable();
      }
      const params = request.params as ProjectParams;
      try {
        const draft = await hooksConfigService.getDraft({
          ownerUserId: requireAuthenticatedLoopPrincipal(request).userId,
          projectId: params.projectId,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send({
          draft: draft
            ? {
                projectId: draft.projectId,
                version: draft.version,
                templateVersion: draft.templateVersion,
                config: draft.config,
                updatedAt: draft.updatedAt,
              }
            : null,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        if (error instanceof HooksLaunchProjectNotFoundError) {
          throw V2ApiError.notFound();
        }
        throw error;
      }
    },
  );

  app.put(
    "/v2/launch/projects/:projectId/hooks-config",
    {
      schema: {
        operationId: "saveV2HooksLaunchProjectConfig",
        summary: "Save an owner-scoped fixed-template Hooks project draft",
        description:
          "Appends a versioned off-chain draft using immutable protocol economics. This route cannot publish, deploy, or activate a launch.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: hooksLaunchProjectConfigRequestSchema,
        response: {
          200: hooksLaunchProjectConfigResourceSchema,
          ...launchCommandErrors,
        },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksConfigService === undefined) {
        throw V2ApiError.capabilityUnavailable();
      }
      const params = request.params as ProjectParams;
      const body = request.body as {
        readonly expectedVersion: number;
        readonly config: unknown;
      };
      try {
        const saved = await hooksConfigService.saveDraft({
          ownerUserId: requireAuthenticatedLoopPrincipal(request).userId,
          projectId: params.projectId,
          expectedVersion: body.expectedVersion,
          body: body.config,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send({
          projectId: saved.projectId,
          version: saved.version,
          templateVersion: saved.templateVersion,
          config: saved.config,
          updatedAt: saved.updatedAt,
        });
      } catch (error) {
        if (error instanceof HooksLaunchProjectNotFoundError) {
          throw V2ApiError.notFound();
        }
        if (error instanceof HooksLaunchProjectVersionConflictError) {
          throw V2ApiError.versionConflict();
        }
        if (
          error instanceof Error &&
          error.message === "Invalid Hooks launch draft"
        ) {
          throw V2ApiError.invalidRequest();
        }
        throw error;
      }
    },
  );

  app.get(
    "/v2/launch/projects/:projectId/hooks-config/signing-request",
    {
      schema: {
        operationId: "getV2HooksLaunchSigningRequest",
        summary: "Prepare the owner's testnet Hooks deployment signature",
        description:
          "Owner-scoped and BSC Testnet-only. Reads the caller's registered active wallet, current config version and on-chain Factory nonce, then returns EIP-712 typed data and the Hook CREATE2 salt. It never signs or broadcasts.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: hooksLaunchSigningRequestQuerySchema,
        response: {
          200: hooksLaunchSigningRequestResourceSchema,
          ...launchReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksDeploymentService === undefined) {
        throw V2ApiError.capabilityUnavailable();
      }
      const params = request.params as ProjectParams;
      const query = request.query as { readonly walletId: string };
      try {
        const prepared = await hooksDeploymentService.prepareSigningRequest({
          ownerUserId: requireAuthenticatedLoopPrincipal(request).userId,
          projectId: params.projectId,
          walletId: query.walletId,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(prepared);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Hooks launch project not found") {
          throw V2ApiError.notFound();
        }
        if (message === "Hooks launch deployment busy; retry later") {
          reply.header("retry-after", "5");
          throw V2ApiError.capabilityUnavailable();
        }
        if (message.includes("unavailable")) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw V2ApiError.invalidRequest();
      }
    },
  );

  const deploymentJobSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "jobId",
      "projectId",
      "configVersion",
      "chainId",
      "factoryAddress",
      "status",
      "memeAddress",
      "hookAddress",
      "createdAt",
    ],
    properties: {
      jobId: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      configVersion: { type: "integer", minimum: 1 },
      chainId: { type: "integer", const: 97 },
      factoryAddress: { type: "string" },
      status: { type: "string", enum: ["awaiting_executor", "cancelled"] },
      memeAddress: { type: "string" },
      hookAddress: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  } as const;
  function submissionError(error: unknown): never {
    if (error instanceof HooksLaunchSubmissionError) {
      if (error.kind === "unavailable")
        throw V2ApiError.capabilityUnavailable();
      if (error.kind === "not_found") throw V2ApiError.notFound();
      if (error.kind === "conflict" || error.kind === "not_approved")
        throw V2ApiError.versionConflict();
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
  app.post(
    "/v2/launch/projects/:projectId/hooks-deployments",
    {
      schema: {
        operationId: "submitV2HooksLaunchDeployment",
        summary:
          "Verify and persist a project-signed testnet deployment request",
        description:
          "Requires the current independently approved config. Verifies project-wallet EIP-712 signature, Factory nonce and both CREATE2 predictions. Creates or renews an awaiting-executor task; never broadcasts or activates.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: projectIdParamsSchema,
        body: z.toJSONSchema(hooksLaunchSubmissionSchema, {
          target: "draft-7",
        }),
        response: { 200: deploymentJobSchema, ...launchCommandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const service = dependencies.hooksLaunchSubmissionService;
      if (!service) throw V2ApiError.capabilityUnavailable();
      try {
        const result = await service.submit({
          ownerUserId: requireAuthenticatedLoopPrincipal(request).userId,
          projectId: (request.params as ProjectParams).projectId,
          idempotencyKey: commandContext(request).idempotencyKey,
          body: request.body,
        });
        return reply.header("cache-control", "no-store").code(200).send(result);
      } catch (error) {
        return submissionError(error);
      }
    },
  );
  const jobParamsSchema = {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "jobId"],
    properties: {
      projectId: { type: "string", format: "uuid" },
      jobId: { type: "string", format: "uuid" },
    },
  } as const;
  app.get(
    "/v2/launch/projects/:projectId/hooks-deployments/:jobId",
    {
      schema: {
        operationId: "getV2HooksLaunchDeployment",
        summary: "Read an owner-scoped deployment task",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: jobParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: deploymentJobSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const service = dependencies.hooksLaunchSubmissionService;
      if (!service) throw V2ApiError.capabilityUnavailable();
      const { projectId, jobId } = request.params as {
        projectId: string;
        jobId: string;
      };
      try {
        const job = await service.getOwned(
          requireAuthenticatedLoopPrincipal(request).userId,
          projectId,
          jobId,
        );
        if (!job) throw V2ApiError.notFound();
        return reply.header("cache-control", "no-store").send(job);
      } catch (error) {
        return submissionError(error);
      }
    },
  );
  app.delete(
    "/v2/launch/projects/:projectId/hooks-deployments/:jobId",
    {
      schema: {
        operationId: "cancelV2HooksLaunchDeployment",
        summary: "Cancel an owner-scoped task before any broadcast",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: jobParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: deploymentJobSchema, ...launchReadErrors },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const service = dependencies.hooksLaunchSubmissionService;
      if (!service) throw V2ApiError.capabilityUnavailable();
      const { projectId, jobId } = request.params as {
        projectId: string;
        jobId: string;
      };
      try {
        const job = await service.cancelOwned(
          requireAuthenticatedLoopPrincipal(request).userId,
          projectId,
          jobId,
        );
        if (!job) throw V2ApiError.notFound();
        return reply.header("cache-control", "no-store").send(job);
      } catch (error) {
        return submissionError(error);
      }
    },
  );

  app.get(
    "/v2/launch/overview",
    {
      schema: {
        operationId: "getV2LaunchOverview",
        summary: "Get the Launch landing catalog",
        description:
          "Approved launches grouped by scheduleStatus from PostgreSQL: live, upcoming (scheduled), awaitingSchedule (approved but unscheduled, never shown as upcoming), ended. Each onChainState is the launch_event lane's getState projection (source chain) once the lane has a checkpoint (Decision 0077); otherwise unavailable with the reason. 'Graduated', eligibility, and staking stay unavailable. No supply, tax, or contract suffix is published.",
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
        requestId: request.id,
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
          "One independent state machine per venue + market type (03 §8.4). LISTED and FEATURED carry an evidence digest, the server time it was recorded, the operator-supplied platform time it became verifiable (observedAt, nullable), and the reviewer; Alpha never implies spot or perpetual. Recorded only by the Dev-only script `pnpm launch:milestone`.",
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
        querystring: eligibilityQuerySchema,
        response: { 200: eligibilityResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const query = request.query as { readonly roundIndex?: unknown };
      const resource = await service.getEligibility({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
        ...(query.roundIndex === undefined
          ? {}
          : { roundIndex: query.roundIndex }),
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
        summary: "Get internal-market holder facts",
        description:
          "holders: distinct buyers indexed by the launch_event lane at indexedBlockNumber. myPosition and walletCap: getPosition / getSaleConfig / getRounds / getRoundPosition for the caller's active wallet at one block (Decision 0077). Without a configured contract every block is unavailable exactly as before.",
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
      const resource = await service.getHolders({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
      });
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
          "purchaseRecords, entitlements, and refunds are three separate objects (03 §8.3), projected by the launch_event lane for the caller's wallets (Decision 0077). While source is unavailable every list is empty and an empty list is never 'no participation'. Decision 0087: while source is available, settlements lists the caller's Claimed (kind claimed) and Refunded (kind refunded) events.",
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
        summary: "Prepare a Launch purchase, claim, or refund Intent",
        description:
          "Decision 0077. 503 CAPABILITY_UNAVAILABLE with the unchanged body while BSC_WRITES_ENABLED is off or the Launch contract keys are blank. Otherwise every 06 §4.1 buy() check runs server-side at one snapshot block (LIVE, round window, not paused, minPurchase, wallet round/project caps, round/hard cap, deadline, allowlist proof) and the Decision 0065 canary applies with USD1 at 1 USD; a refusal carries detailsSafe.reasonCode. The 201 binds every 03 §8.2 field and the unsigned buy() transaction for the device signing exit. Idempotency-Key replays the same Intent. Separate from wallet intents; no sell or redeem exists. Decision 0087: body kind (default buy) also admits claim and claimRefund with walletId only. Both read the 0085 sale snapshot and getPosition at one block. claim needs entitlementState VESTING or COMPLETED, operationalState ACTIVE, and claimableTokens > 0; claimRefund needs saleState FAILED or CANCELLED with entitlementState REFUNDING, ACTIVE, and refundableUsd1 > 0. Refusals are 409 DATA_STALE with detailsSafe.reasonCode LAUNCH_CLAIM_NOT_OPEN, LAUNCH_REFUND_NOT_OPEN, LAUNCH_SALE_PAUSED, LAUNCH_NOT_PARTICIPANT, LAUNCH_NOTHING_TO_CLAIM, or LAUNCH_NOTHING_TO_REFUND. The 201 carries kind, roundId and roundIndex null, and the unsigned claim(saleId) / claimRefund(saleId) transaction.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launchIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launchIntentRequestSchema,
        response: { 201: launchIntentResourceSchema, ...launchIntentErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: [assertNoQuery, assertDecimalStringFields(["payAmount"])],
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as LaunchParams;
      const { resource } = await service.prepareIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.post(
    "/v2/launch/:launchId/intents/:launchIntentId/broadcast-report",
    {
      schema: {
        operationId: "reportV2LaunchIntentBroadcast",
        summary: "Report the device broadcast of a Launch Intent",
        description:
          "Decision 0077, same discipline as the wallet-intent broadcast report (0035): awaiting_signature → submitted with the reported txHash, verified against the sealed payload when the launch slot already sees the transaction (a mismatch is VALIDATION_FAILED / LAUNCH_TX_PAYLOAD_MISMATCH). Reporting the same hash again returns the Intent unchanged; another hash is DATA_STALE / LAUNCH_INTENT_ALREADY_REPORTED. A report past expiresAt is accepted only when the transaction is already observable. The report is pending evidence: state becomes confirmed when the launch_event lane indexes a Purchased log of that transaction or the reconcile lane reads its successful receipt at the launch slot's confirmation depth; a status 0x0 receipt settles it reverted, no receipt after the deadline plus grace expired (Decision 0080). History always reads the index. 503 CAPABILITY_UNAVAILABLE while BSC_WRITES_ENABLED is off or the contract keys are blank. Decision 0087: the same for claim / claimRefund Intents, confirmed by a Claimed / Refunded log of that transaction naming the Intent's wallet.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: launchIntentParamsSchema,
        querystring: emptyQueryStringSchema,
        body: launchIntentReportRequestSchema,
        response: {
          200: launchIntentReportResourceSchema,
          ...launchIntentErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly launchId: string;
        readonly launchIntentId: string;
      };
      const resource = await service.reportIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
        launchIntentId: params.launchIntentId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/launch/:launchId/intents/:launchIntentId",
    {
      schema: {
        operationId: "getV2LaunchIntent",
        summary: "Get one Launch Intent",
        description:
          "Decision 0081. The same launchIntent projection as the prepare 201 and the broadcast report: every 03 §8.2 field, the unsigned buy() transaction, state including the Decision 0080 settlements (reverted, expired, failed) and revertReason present only on a reverted Intent, and transactionHash as lowercase 0x-prefixed 64 hex or null. Readable only by the owning account; another account's Intent, an unknown id, or an Intent of another launch is NOT_FOUND without enumeration. 503 CAPABILITY_UNAVAILABLE with the unchanged body while BSC_WRITES_ENABLED is off or the contract keys are blank. A read never advances state; confirmation still comes only from the launch_event lane or the reconcile lane. Decision 0087: claim / claimRefund Intents carry kind; a buy has none.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: launchIntentParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: launchIntentResourceSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly launchId: string;
        readonly launchIntentId: string;
      };
      const resource = await service.getIntent({
        principal: requireAuthenticatedLoopPrincipal(request),
        launchId: params.launchId,
        launchIntentId: params.launchIntentId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
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
          "Only counts that PostgreSQL can prove: projects by review status, launches by schedule status, confirmed rounds, with source loop and observedAt. While a Launch contract is configured, onChain adds registered sales, total SUCCEEDED raise, and locked LP count from the launch_event lane (source loop_indexer, checkpoint block; Decision 0077). Total supply, distribution, and ecosystem tax are unavailable.",
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
