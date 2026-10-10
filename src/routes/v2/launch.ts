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
import {
  HooksLaunchDeploymentError,
  type HooksLaunchDeploymentService,
} from "../../features/launch/hooks-launch-deployment.js";
import { InvalidHooksLaunchDraftError } from "../../features/launch/hooks-launch-config.js";
import {
  HooksLaunchProjectConfigUnavailableError,
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigService,
} from "../../features/launch/hooks-launch-project-config.js";
import {
  HooksLaunchSubmissionError,
  type HooksLaunchSubmissionService,
} from "../../features/launch/hooks-launch-submission.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
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
  hooksLaunchDeploymentJobSchema,
  hooksLaunchDeploymentParamsSchema,
  hooksLaunchDeploymentRequestSchema,
  hooksLaunchProjectConfigReadSchema,
  hooksLaunchProjectConfigRequestSchema,
  hooksLaunchProjectConfigResourceSchema,
  hooksLaunchSigningRequestQuerySchema,
  hooksLaunchSigningRequestResourceSchema,
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

interface HooksDeploymentParams {
  readonly projectId: string;
  readonly jobId: string;
}

/** Decision 0108: reason codes carried by a hooks-route 503. */
const hooksLaunchDisabledReason = "HOOKS_LAUNCH_DISABLED";
const hooksLaunchFactoryReason = "HOOKS_LAUNCH_FACTORY_UNAVAILABLE";
/** Decision 0119: the saved config was hashed for another sale period. */
const hooksFactoryTemplateMismatchReason = "HOOKS_FACTORY_TEMPLATE_MISMATCH";

function hooksUnavailable(reasonCode: string): V2ApiError {
  return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function projectConfigResource(record: HooksLaunchProjectConfigRecord) {
  return {
    projectId: record.projectId,
    version: record.version,
    templateVersion: record.templateVersion,
    config: record.config,
    updatedAt: record.updatedAt,
  };
}

function projectConfigError(error: unknown): never {
  if (error instanceof HooksLaunchProjectNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof HooksLaunchProjectVersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof InvalidHooksLaunchDraftError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof HooksLaunchProjectConfigUnavailableError) {
    throw hooksUnavailable(
      error.source === "factory"
        ? hooksLaunchFactoryReason
        : hooksLaunchDisabledReason,
    );
  }
  throw error;
}

function submissionError(error: unknown): never {
  if (error instanceof HooksLaunchSubmissionError) {
    switch (error.kind) {
      case "unavailable":
        throw hooksUnavailable(hooksLaunchFactoryReason);
      case "template_mismatch":
        throw hooksUnavailable(hooksFactoryTemplateMismatchReason);
      case "not_found":
        throw V2ApiError.notFound();
      case "conflict":
        throw V2ApiError.versionConflict();
      case "idempotency_conflict":
        throw V2ApiError.idempotencyConflict();
      case "not_approved":
        throw V2ApiError.fromCode("POLICY_BLOCKED", {
          reasonCode: "HOOKS_CONFIG_NOT_APPROVED",
        });
      case "not_cancellable":
        throw V2ApiError.fromCode("VERSION_CONFLICT", {
          reasonCode: "HOOKS_DEPLOYMENT_NOT_CANCELLABLE",
        });
      case "invalid":
        throw V2ApiError.invalidRequest();
    }
  }
  throw error;
}

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
  const hooksSubmissionService: HooksLaunchSubmissionService | undefined =
    dependencies.hooksLaunchSubmissionService;

  app.get(
    "/v2/launch/projects/:projectId/hooks-config",
    {
      schema: {
        operationId: "getV2HooksLaunchProjectConfig",
        summary: "Read the caller's fixed-template Hooks project configuration",
        description:
          "Decision 0108. Owner-scoped latest off-chain draft (null when none). A project the caller does not own is NOT_FOUND. Reading never publishes or activates a contract. Decision 0120: also returns approval (null without a draft; status approved only when the operator approved this draft version with the same configHash, otherwise awaiting_approval — saving a new version goes back to awaiting_approval), latestDeployment (the newest deployment task of the project, any version and status, same shape as GET hooks-deployments/{jobId}; null when none) and minSaleLeadSeconds (HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS: the earliest accepted nftSaleStartAt is now + this). 503 CAPABILITY_UNAVAILABLE (reasonCode HOOKS_LAUNCH_DISABLED) while HOOKS_LAUNCH_ENABLED is off or no database is configured.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: hooksLaunchProjectConfigReadSchema,
          ...launchReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksConfigService === undefined) {
        throw hooksUnavailable(hooksLaunchDisabledReason);
      }
      const params = request.params as ProjectParams;
      try {
        const ownerUserId = requireAuthenticatedLoopPrincipal(request).userId;
        const draft = await hooksConfigService.getDraft({
          ownerUserId,
          projectId: params.projectId,
        });
        // Decision 0120: approval state, newest deployment task and the
        // sale-start lead, so a cold-started app can resume the flow.
        const progress =
          draft === null
            ? null
            : await hooksConfigService.getProgress({
                ownerUserId,
                projectId: params.projectId,
                configVersion: draft.version,
              });
        let latestDeployment = null;
        if (progress !== null && progress.latestJobId !== null) {
          if (hooksSubmissionService === undefined) {
            throw hooksUnavailable(hooksLaunchDisabledReason);
          }
          try {
            latestDeployment = await hooksSubmissionService.getOwned(
              ownerUserId,
              params.projectId,
              progress.latestJobId,
            );
          } catch (error) {
            return submissionError(error);
          }
        }
        reply.header("cache-control", "no-store");
        return reply.code(200).send({
          draft: draft === null ? null : projectConfigResource(draft),
          approval:
            draft === null || progress === null
              ? null
              : {
                  configVersion: draft.version,
                  status:
                    progress.approvedAt === null
                      ? "awaiting_approval"
                      : "approved",
                  approvedAt: progress.approvedAt,
                },
          latestDeployment,
          minSaleLeadSeconds: hooksConfigService.minimumLeadSeconds,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return projectConfigError(error);
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
          "Decision 0108. Appends a new immutable draft version (compare-and-swap on expectedVersion; Idempotency-Key is rejected). The server derives the fixed hooks_launch_v1 economics and configHash; economic override keys are INVALID_REQUEST. Decision 0119: fixedEconomics.nftSaleDurationSeconds is the target Factory's on-chain nftSaleDuration() (3600 on the BSC Testnet 1-hour Factory, 604800 on a 7-day / pre-S141 Factory), read before hashing; without a configured or readable Factory the save is 503 CAPABILITY_UNAVAILABLE (reasonCode HOOKS_LAUNCH_FACTORY_UNAVAILABLE), never a constant. Saving a new version invalidates any earlier approval for signing. Never publishes, deploys, or activates.",
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
        throw hooksUnavailable(hooksLaunchDisabledReason);
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
        return reply.code(200).send(projectConfigResource(saved));
      } catch (error) {
        return projectConfigError(error);
      }
    },
  );

  app.get(
    "/v2/launch/projects/:projectId/hooks-config/signing-request",
    {
      schema: {
        operationId: "getV2HooksLaunchSigningRequest",
        summary: "Prepare the owner's BSC Testnet Hooks deployment signature",
        description:
          "Decision 0108. Owner-scoped, BSC Testnet (97) only. Resolves the opaque walletId in the caller's active wallet inventory, reads the latest draft and the Factory nonce (Factory code hash verified on every call), and returns EIP-712 typed data, the mined MEME salt (address suffix 6666) and Hook CREATE2 salt (permission bits 0x20CC). Never signs, stores, or broadcasts. 503 CAPABILITY_UNAVAILABLE: HOOKS_LAUNCH_DISABLED (switch off), HOOKS_LAUNCH_FACTORY_UNAVAILABLE (Factory not configured, RPC/code check failed, salt search exhausted, or busy: Retry-After 5), HOOKS_FACTORY_TEMPLATE_MISMATCH (Decision 0119: the saved config's fixedEconomics.nftSaleDurationSeconds is not the Factory's nftSaleDuration(); re-save the config and get it approved again).",
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
        throw hooksUnavailable(hooksLaunchDisabledReason);
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
        if (error instanceof HooksLaunchDeploymentError) {
          if (error.kind === "not_found") throw V2ApiError.notFound();
          if (error.kind === "invalid") throw V2ApiError.invalidRequest();
          if (error.kind === "template_mismatch") {
            throw hooksUnavailable(hooksFactoryTemplateMismatchReason);
          }
          if (error.kind === "busy") reply.header("retry-after", "5");
          throw hooksUnavailable(hooksLaunchFactoryReason);
        }
        throw error;
      }
    },
  );

  app.post(
    "/v2/launch/projects/:projectId/hooks-deployments",
    {
      schema: {
        operationId: "submitV2HooksLaunchDeployment",
        summary: "Verify and record a project-signed Testnet deployment task",
        description:
          "Decision 0108. Requires the latest config version to carry an independent operator approval (else 403 POLICY_BLOCKED, reasonCode HOOKS_CONFIG_NOT_APPROVED). Verifies the project wallet's low-S EIP-712 signature, deadline (<= 1 hour), Factory nonce, and both CREATE2 predictions, then creates or renews one awaiting_executor task. Exact Idempotency-Key replay returns the same task; a different body under the same key is IDEMPOTENCY_CONFLICT. Never broadcasts or activates; the response never contains the signature. Decision 0119: a config whose fixedEconomics.nftSaleDurationSeconds differs from the Factory nftSaleDuration() is 503 CAPABILITY_UNAVAILABLE (reasonCode HOOKS_FACTORY_TEMPLATE_MISMATCH), nothing recorded.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: projectIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: hooksLaunchDeploymentRequestSchema,
        response: {
          200: hooksLaunchDeploymentJobSchema,
          ...launchCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksSubmissionService === undefined) {
        throw hooksUnavailable(hooksLaunchDisabledReason);
      }
      try {
        const job = await hooksSubmissionService.submit({
          ownerUserId: requireAuthenticatedLoopPrincipal(request).userId,
          projectId: (request.params as ProjectParams).projectId,
          idempotencyKey: commandContext(request).idempotencyKey,
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(job);
      } catch (error) {
        return submissionError(error);
      }
    },
  );

  app.get(
    "/v2/launch/projects/:projectId/hooks-deployments/:jobId",
    {
      schema: {
        operationId: "getV2HooksLaunchDeployment",
        summary: "Read an owner-scoped Hooks deployment task",
        description:
          "Decision 0108 / 0112. A task of another account or project is NOT_FOUND. Returns the executor state (status, txHash, confirmations, predicted and deployed addresses, failure, the latest 100 events). The response never contains the saved signature or the raw transaction.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: hooksLaunchDeploymentParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: hooksLaunchDeploymentJobSchema, ...launchReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksSubmissionService === undefined) {
        throw hooksUnavailable(hooksLaunchDisabledReason);
      }
      const params = request.params as HooksDeploymentParams;
      let job;
      try {
        job = await hooksSubmissionService.getOwned(
          requireAuthenticatedLoopPrincipal(request).userId,
          params.projectId,
          params.jobId,
        );
      } catch (error) {
        return submissionError(error);
      }
      if (job === null) throw V2ApiError.notFound();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(job);
    },
  );

  app.delete(
    "/v2/launch/projects/:projectId/hooks-deployments/:jobId",
    {
      schema: {
        operationId: "cancelV2HooksLaunchDeployment",
        summary: "Cancel an owner-scoped task before any broadcast",
        description:
          "Decision 0108 / 0112. awaiting_executor -> cancelled; an already cancelled task is returned unchanged (idempotent). Once an executor has claimed the task it is 409 VERSION_CONFLICT (reasonCode HOOKS_DEPLOYMENT_NOT_CANCELLABLE). Cancelling does not revoke an EIP-712 signature already shared on chain.",
        tags: ["launch"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: hooksLaunchDeploymentParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: hooksLaunchDeploymentJobSchema,
          ...launchCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      if (hooksSubmissionService === undefined) {
        throw hooksUnavailable(hooksLaunchDisabledReason);
      }
      const params = request.params as HooksDeploymentParams;
      let job;
      try {
        job = await hooksSubmissionService.cancelOwned(
          requireAuthenticatedLoopPrincipal(request).userId,
          params.projectId,
          params.jobId,
        );
      } catch (error) {
        return submissionError(error);
      }
      if (job === null) throw V2ApiError.notFound();
      reply.header("cache-control", "no-store");
      return reply.code(200).send(job);
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
          "Owner-scoped, newest first, with an opaque cursor bound to the owner, route, and status filter. `limit` and `cursor` are mutually exclusive. Decision 0120: `kind` (all | ido | launch2) lists only one product; each item carries `kind`.",
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
        readonly kind?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listProjects({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
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
          "Creates a `draft` project owned by the caller: name, ticker, narrative, and official links. Decision 0120: optional `kind` (ido default | launch2) marks a MEME v2 project from the start. Attachments and KYB have no Provider and stay unavailable. Review is never self-served; only the Dev-only operator script `pnpm launch:review` advances it and writes the audit row.",
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
