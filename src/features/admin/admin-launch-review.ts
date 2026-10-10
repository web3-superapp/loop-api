import type { LaunchChainReference } from "../chain/chain-contract.js";
import type { HooksLaunchDeploymentStatus } from "../launch/hooks-launch-deployment-status.js";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  HooksLaunchReviewError,
  type HooksLaunchReviewCommandResult,
  type HooksLaunchReviewErrorCode,
  type HooksLaunchReviewService,
} from "../launch/hooks-launch-review.js";
import { AdminApiError, adminReasonCodes } from "./admin-contract.js";
import {
  assertAdminPermission,
  requireAdminIdempotencyKey,
  type AdminRequestContext,
} from "./admin-accounts.js";
import {
  AdminRepositoryUnavailableError,
  type AdminAuditInput,
  type AdminAuditRecord,
  type AdminRepository,
} from "./admin-repository.js";

/**
 * Decision 0109: the platform-side Hooks launch review in the console.
 * Reads are the console's own projection (stage, versions, approvals,
 * testnet acceptances, deployment tasks with the predicted CREATE2
 * addresses — never a signature). The two writes run the Decision 0108
 * review service as the account's bound LOOP user, so the editor ≠
 * approver, owner ≠ approver, and acceptor ≠ editor / owner rules stay in
 * that service and its repository; the console adds the role gate and the
 * `admin_audit_log` intent / outcome rows (Decision 0105 pattern) beside
 * the service's own `ops_audit` row.
 */

export const adminLaunchStages = Object.freeze([
  "draft",
  "awaiting_approval",
  "approved",
  "accepted",
  "deploying",
  "activated",
] as const);
export type AdminLaunchStage = (typeof adminLaunchStages)[number];

export interface AdminLaunchEditor {
  /** `owner`: saved by the project owner in the App; `operator`: by an ops editor. */
  readonly kind: "owner" | "operator";
  readonly userId: string;
}

export interface AdminLaunchProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly ticker: string;
  readonly ownerUserId: string;
  readonly launchReviewStatus: string;
  readonly stage: AdminLaunchStage;
  readonly latestConfigVersion: number | null;
  readonly latestConfigHash: string | null;
  readonly latestEditedBy: AdminLaunchEditor | null;
  readonly latestApproval: {
    readonly approverUserId: string;
    readonly approvedAt: string;
  } | null;
  readonly latestAcceptanceOutcome: "passed" | "failed" | "incomplete" | null;
  readonly activeDeploymentJobId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Keyset position (microsecond text); never published. */
  readonly cursorKey: string;
}

export interface AdminLaunchConfigVersion {
  readonly version: number;
  readonly templateVersion: string;
  readonly configHash: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly editedBy: AdminLaunchEditor;
  readonly createdAt: string;
  readonly approval: {
    readonly approverUserId: string;
    readonly configHash: string;
    readonly reason: string;
    readonly approvedAt: string;
  } | null;
}

export interface AdminLaunchTestnetAcceptance {
  readonly acceptanceId: string;
  readonly configVersion: number;
  readonly chainId: number;
  readonly configHash: string;
  readonly contractManifestHash: string;
  readonly checklistVersion: string;
  readonly outcome: "passed" | "failed" | "incomplete";
  readonly evidence: readonly { label: string; uri: string }[];
  readonly acceptorUserId: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface AdminLaunchDeploymentEvent {
  readonly sequence: number;
  readonly fromStatus: HooksLaunchDeploymentStatus | null;
  readonly toStatus: HooksLaunchDeploymentStatus;
  readonly kind: string;
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly errorCode: string | null;
  /** Safe step details (failed check names, nonce, retryable flag). */
  readonly details: Readonly<Record<string, unknown>>;
  readonly actor: string | null;
  readonly createdAt: string;
}

export interface AdminLaunchDeploymentTask {
  readonly jobId: string;
  readonly configVersion: number;
  readonly status: HooksLaunchDeploymentStatus;
  readonly chainId: number;
  readonly factoryAddress: string;
  readonly projectOwner: string;
  readonly ownerNonce: string;
  readonly bindingHash: string;
  readonly predictedMemeAddress: string;
  readonly predictedHookAddress: string;
  readonly authorizationCount: number;
  readonly latestAuthorizationAt: string | null;
  /** Decision 0112 executor facts (null until the step happened). */
  readonly executorAddress: string | null;
  readonly claimedBy: string | null;
  readonly attemptCount: number;
  readonly txHash: string | null;
  readonly txNonce: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly confirmations: number | null;
  readonly launchId: string | null;
  readonly deployedAddresses: Readonly<Record<string, string>> | null;
  readonly verifiedChecks: readonly string[];
  readonly activationTxHash: string | null;
  readonly activationBlockNumber: string | null;
  readonly activatedAt: string | null;
  readonly failure: {
    readonly code: string;
    readonly retryable: boolean;
  } | null;
  readonly events: readonly AdminLaunchDeploymentEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Decision 0118: one server-side snapshot publication attempt of the
 * project's MEME v2 instance (newest attempt first). Signatures and the
 * raw transaction are never returned.
 */
export interface AdminLaunchSnapshotPublication {
  readonly publicationId: string;
  readonly instanceId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status:
    "pending" | "broadcast" | "confirmed" | "failed" | "mismatch";
  readonly cutoffBlock: string;
  readonly cutoffBlockHash: string;
  readonly memberCount: number;
  readonly root: string;
  readonly dataHash: string;
  readonly signerAddresses: readonly string[];
  readonly submitterAddress: string;
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly confirmations: number | null;
  readonly failure: {
    readonly code: string;
    readonly detail: string | null;
    readonly retryable: boolean | null;
  } | null;
  /** The `launch2_event` lane's verdict on this root (null until indexed). */
  readonly verification: "verified" | "mismatch" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Decision 0121: one buyback keeper attempt of the project's MEME v2
 * instance (newest first, at most 20). The raw transaction is never
 * returned.
 */
export interface AdminLaunchBuybackAttempt {
  readonly attemptId: string;
  readonly instanceId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status:
    "rejected" | "pending" | "broadcast" | "confirmed" | "failed";
  readonly simulation: "passed" | "reverted";
  readonly keeperAddress: string;
  readonly executorAddress: string;
  /** Raw USD1 units (18 decimals) of the simulated order. */
  readonly orderUsd1Wei: string | null;
  readonly simulatedGas: string | null;
  /** `rejected` / `failed`: the reason code and the contract error name. */
  readonly reason: {
    readonly code: string;
    readonly detail: string | null;
  } | null;
  readonly rejectionCount: number | null;
  readonly lastRejectedAt: string | null;
  readonly nextEligibleAt: string | null;
  readonly txHash: string | null;
  readonly txNonce: string | null;
  readonly blockNumber: string | null;
  readonly confirmations: number | null;
  /** The `launch2_buybacks` row of the transaction (ledger alignment). */
  readonly buybackId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Decision 0120: a platform administrator's retry grant for a blocked
 * snapshot publication (append-only). Attempts up to `releasedAttempt` no
 * longer block the publisher or count against its retry budget.
 */
export interface AdminLaunchSnapshotRelease {
  readonly releaseId: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly publicationId: string;
  readonly releasedAttempt: number;
  readonly releasedStatus: "failed" | "mismatch";
  readonly releasedFailureCode: string;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** Decision 0120: the sale ended with no holder (stage closed_no_holders). */
export interface AdminLaunchSnapshotClosure {
  readonly instanceId: string;
  readonly reason: "no_holders";
  readonly cutoffBlock: string;
  readonly cutoffBlockHash: string;
  readonly saleEndAt: string;
  readonly createdAt: string;
}

export interface AdminLaunchProjectDetail {
  readonly project: AdminLaunchProjectSummary;
  readonly versions: readonly AdminLaunchConfigVersion[];
  readonly testnetAcceptances: readonly AdminLaunchTestnetAcceptance[];
  readonly deploymentTasks: readonly AdminLaunchDeploymentTask[];
  readonly snapshotPublications: readonly AdminLaunchSnapshotPublication[];
  readonly buybackAttempts: readonly AdminLaunchBuybackAttempt[];
  readonly snapshotReleases: readonly AdminLaunchSnapshotRelease[];
  readonly snapshotClosure: AdminLaunchSnapshotClosure | null;
}

/**
 * Decision 0120: why a snapshot retry was refused. `not_found`: no project
 * or no MEME v2 instance; `conflict`: nothing to retry (no attempt, latest
 * attempt in flight / confirmed, already released, a root already on
 * chain, closed with no holder); `idempotency`: the key was used for
 * another request.
 */
export class AdminLaunchSnapshotRetryError extends Error {
  constructor(
    readonly kind: "not_found" | "conflict" | "idempotency",
    readonly reasonCode: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super("Snapshot retry refused");
    this.name = "AdminLaunchSnapshotRetryError";
  }
}

export const adminLaunchSnapshotRetryReasonCodes = Object.freeze({
  projectNotFound: "ADMIN_LAUNCH_PROJECT_NOT_FOUND",
  instanceNotFound: "LAUNCH2_INSTANCE_NOT_FOUND",
  nothingToRetry: "LAUNCH2_SNAPSHOT_NOTHING_TO_RETRY",
  notRetryable: "LAUNCH2_SNAPSHOT_NOT_RETRYABLE",
  alreadyReleased: "LAUNCH2_SNAPSHOT_ALREADY_RELEASED",
  alreadyOnChain: "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
  closedNoHolders: "LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS",
  idempotencyConflict: "ADMIN_IDEMPOTENCY_CONFLICT",
} as const);

/** `*` = every project; otherwise the project IDs the caller may read. */
export type AdminLaunchScope = "*" | readonly string[];

export interface AdminLaunchReviewRepository {
  /**
   * The bound operator's `launch.read` scopes (Decision 0108 grants); empty
   * when the operator is missing, disabled, or holds no such grant.
   */
  launchReadScopes(operatorUserId: string): Promise<readonly string[]>;
  listProjects(input: {
    readonly stage: AdminLaunchStage | null;
    readonly scope: AdminLaunchScope;
    readonly limit: number;
    readonly after: {
      readonly cursorKey: string;
      readonly projectId: string;
    } | null;
  }): Promise<readonly AdminLaunchProjectSummary[]>;
  getProject(input: {
    readonly projectId: string;
    readonly scope: AdminLaunchScope;
  }): Promise<AdminLaunchProjectDetail | null>;
  /**
   * Decision 0120: in one transaction, replays `releaseId` (same project and
   * reason) or locks the project's latest MEME v2 instance and its latest
   * publication attempt and appends a release when that attempt is
   * `failed` / `mismatch` and not yet released. Throws
   * `AdminLaunchSnapshotRetryError` for every refusal.
   */
  releaseSnapshotPublication(input: {
    readonly releaseId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly actorAccountId: string | null;
    readonly reason: string;
    readonly requestId: string;
  }): Promise<{
    readonly release: AdminLaunchSnapshotRelease;
    readonly replayed: boolean;
  }>;
}

export interface AdminLaunchReviewLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface AdminLaunchReviewConsoleService {
  listProjects(
    context: AdminRequestContext,
    query: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  getProject(
    context: AdminRequestContext,
    projectId: string,
  ): Promise<Record<string, unknown>>;
  approve(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    projectId: string,
    version: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  recordTestnetAcceptance(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    projectId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Decision 0120 (`console.write`: platform administrator). */
  retrySnapshotPublication(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    projectId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const versionPattern = /^[1-9][0-9]{0,9}$/u;
const maximumVersion = 2_147_483_647;
export const adminLaunchListLimits = Object.freeze({
  default: 20,
  maximum: 100,
});

/** Where a Decision 0108 refusal lands on the console catalog. */
export function adminLaunchReviewErrorProjection(
  code: HooksLaunchReviewErrorCode,
): AdminApiError {
  switch (code) {
    case "OPS_FORBIDDEN":
    case "OPS_SELF_APPROVAL":
    case "OPS_SELF_ACCEPTANCE":
      return new AdminApiError("PERMISSION_DENIED", { reasonCode: code });
    case "OPS_NOT_FOUND":
      return new AdminApiError("NOT_FOUND", { reasonCode: code });
    case "OPS_INVALID_COMMAND":
    case "OPS_INVALID_LAUNCH_CONFIG":
      return new AdminApiError("VALIDATION_FAILED", { reasonCode: code });
    case "OPS_LAUNCH_NOT_APPROVED":
    case "OPS_LAUNCH_CONFIG_NOT_APPROVED":
    case "OPS_VERSION_CONFLICT":
    case "OPS_IDEMPOTENCY_CONFLICT":
      return new AdminApiError("ADMIN_CONFLICT", { reasonCode: code });
    case "OPS_UNAVAILABLE":
      return new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.launchReviewUnavailable,
      });
    case "OPS_COMMAND_FAILED":
      return new AdminApiError("CAPABILITY_UNAVAILABLE", { reasonCode: code });
  }
}

function isoOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function auditReference(audit: AdminAuditRecord | null) {
  return audit === null
    ? null
    : Object.freeze({ auditId: audit.auditId, seq: audit.seq, at: audit.at });
}

export function createAdminLaunchReviewConsoleService(options: {
  readonly repository: AdminLaunchReviewRepository | null;
  /**
   * Decision 0117: the chain deployments go to (`LAUNCH_CHAIN_ID`), shown
   * next to the template's `fixedEconomics.chainId` (always 56).
   */
  readonly deploymentChainId: LaunchChainReference;
  readonly review: HooksLaunchReviewService;
  readonly audit: Pick<AdminRepository, "appendAudit">;
  readonly sessionSecret: string;
  readonly logger: AdminLaunchReviewLogger;
}): AdminLaunchReviewConsoleService {
  const cursorKey = createHmac("sha256", "loop-admin-launch-cursor-v1")
    .update(options.sessionSecret)
    .digest();

  function repository(): AdminLaunchReviewRepository {
    if (options.repository === null) {
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.databaseUnavailable,
      });
    }
    return options.repository;
  }

  function translate(error: unknown): never {
    if (error instanceof AdminApiError) throw error;
    if (error instanceof HooksLaunchReviewError) {
      throw adminLaunchReviewErrorProjection(error.code);
    }
    if (error instanceof AdminRepositoryUnavailableError) {
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.databaseUnavailable,
      });
    }
    throw error;
  }

  async function scopeOf(
    context: AdminRequestContext,
  ): Promise<AdminLaunchScope> {
    assertAdminPermission(context.principal, "launch.read");
    const operatorUserId = context.principal.operatorUserId;
    if (operatorUserId === null) {
      // Platform administrator and auditor read every project.
      return "*";
    }
    const scopes = await repository().launchReadScopes(operatorUserId);
    if (scopes.length === 0) {
      throw new AdminApiError("PERMISSION_DENIED", {
        reasonCode: "OPS_FORBIDDEN",
      });
    }
    return scopes.includes("*") ? "*" : scopes;
  }

  function encodeCursor(
    stage: string,
    item: AdminLaunchProjectSummary,
  ): string {
    const body = Buffer.from(
      JSON.stringify({ s: stage, k: item.cursorKey, p: item.projectId }),
    ).toString("base64url");
    const mac = createHmac("sha256", cursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${mac}`;
  }

  function decodeCursor(
    stage: string,
    cursor: unknown,
  ): { readonly cursorKey: string; readonly projectId: string } {
    if (typeof cursor !== "string" || cursor.length > 1_024) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const [body, mac, extra] = cursor.split(".");
    if (body === undefined || mac === undefined || extra !== undefined) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const expected = Buffer.from(
      createHmac("sha256", cursorKey).update(body).digest("base64url"),
    );
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const record = parsed as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      record["s"] !== stage ||
      typeof record["k"] !== "string" ||
      typeof record["p"] !== "string" ||
      !canonicalUuidPattern.test(record["p"])
    ) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    return { cursorKey: record["k"], projectId: record["p"] };
  }

  function projectSummary(item: AdminLaunchProjectSummary) {
    return Object.freeze({
      projectId: item.projectId,
      name: item.name,
      ticker: item.ticker,
      ownerUserId: item.ownerUserId,
      launchReviewStatus: item.launchReviewStatus,
      stage: item.stage,
      latestConfigVersion: item.latestConfigVersion,
      latestConfigHash: item.latestConfigHash,
      latestEditedBy: item.latestEditedBy,
      latestApproval: item.latestApproval,
      latestAcceptanceOutcome: item.latestAcceptanceOutcome,
      activeDeploymentJobId: item.activeDeploymentJobId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  async function intentAudit(
    input: AdminAuditInput,
  ): Promise<AdminAuditRecord> {
    try {
      return await options.audit.appendAudit(input);
    } catch (error) {
      options.logger.warn(
        {
          action: input.action,
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Launch review intent audit row was not written; action refused",
      );
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.auditUnavailable,
      });
    }
  }

  async function outcomeAudit(
    input: AdminAuditInput,
  ): Promise<AdminAuditRecord | null> {
    try {
      return await options.audit.appendAudit(input);
    } catch (error) {
      options.logger.warn(
        {
          action: input.action,
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Launch review outcome audit row was not written",
      );
      return null;
    }
  }

  function projectIdParam(value: string): string {
    if (!canonicalUuidPattern.test(value)) {
      throw new AdminApiError("NOT_FOUND", {
        reasonCode: adminReasonCodes.launchProjectNotFound,
      });
    }
    return value;
  }

  function reason(value: unknown): string {
    if (typeof value !== "string") {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || Array.from(trimmed).length > 500) {
      throw new AdminApiError("VALIDATION_FAILED", {
        reasonCode: "ADMIN_REASON_TEXT_INVALID",
      });
    }
    return trimmed;
  }

  /**
   * Runs one Decision 0108 command as the account's bound LOOP user with
   * the intent → execute → outcome audit rows.
   */
  async function run(
    context: AdminRequestContext,
    input: {
      readonly action: "launch.config.approve" | "testnet.acceptance.record";
      readonly operationId: string;
      readonly projectId: string;
      readonly reason: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<{
    readonly result: HooksLaunchReviewCommandResult;
    readonly audit: AdminAuditRecord | null;
  }> {
    const operatorUserId = context.principal.operatorUserId;
    if (operatorUserId === null) {
      throw new AdminApiError("PERMISSION_DENIED", {
        reasonCode: "OPS_FORBIDDEN",
      });
    }
    const base = {
      actor: context.principal.session.actor,
      actorAccountId: context.principal.session.accountId,
      targetType: "launch_project",
      targetId: input.projectId,
      requestId: context.requestId,
    } as const;
    const intent = await intentAudit({
      ...base,
      action: `${input.action}.requested`,
      before: null,
      after: {
        operationId: input.operationId,
        operatorUserId,
        ...input.payload,
      },
    });
    let result: HooksLaunchReviewCommandResult;
    try {
      result = await options.review.execute(operatorUserId, {
        operationId: input.operationId,
        action: input.action,
        target: input.projectId,
        reason: input.reason,
        payload: input.payload,
      });
    } catch (error) {
      const code =
        error instanceof HooksLaunchReviewError
          ? error.code
          : "OPS_COMMAND_FAILED";
      await outcomeAudit({
        ...base,
        action: `${input.action}.failed`,
        before: null,
        after: {
          requestedAuditId: intent.auditId,
          operationId: input.operationId,
          errorCode: code,
        },
      });
      return translate(
        error instanceof HooksLaunchReviewError
          ? error
          : new HooksLaunchReviewError("OPS_COMMAND_FAILED"),
      );
    }
    const audit = await outcomeAudit({
      ...base,
      action: `${input.action}.decided`,
      before: null,
      after: {
        requestedAuditId: intent.auditId,
        operationId: input.operationId,
        replayed: result.replayed,
      },
    });
    return { result, audit: audit ?? intent };
  }

  return Object.freeze({
    async listProjects(context, query) {
      try {
        const scope = await scopeOf(context);
        const stageValue = query["status"];
        let stage: AdminLaunchStage | null = null;
        if (stageValue !== undefined) {
          if (
            typeof stageValue !== "string" ||
            !(adminLaunchStages as readonly string[]).includes(stageValue)
          ) {
            throw new AdminApiError("INVALID_REQUEST");
          }
          stage = stageValue as AdminLaunchStage;
        }
        const limitValue = query["limit"];
        let limit: number = adminLaunchListLimits.default;
        if (limitValue !== undefined) {
          const parsed =
            typeof limitValue === "number"
              ? limitValue
              : typeof limitValue === "string" &&
                  /^[1-9][0-9]{0,2}$/u.test(limitValue)
                ? Number(limitValue)
                : Number.NaN;
          if (
            !Number.isInteger(parsed) ||
            parsed < 1 ||
            parsed > adminLaunchListLimits.maximum
          ) {
            throw new AdminApiError("INVALID_REQUEST");
          }
          limit = parsed;
        }
        const filter = stage ?? "";
        const after =
          query["cursor"] === undefined
            ? null
            : decodeCursor(filter, query["cursor"]);
        const rows = await repository().listProjects({
          stage,
          scope,
          limit: limit + 1,
          after,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return Object.freeze({
          items: page.map(projectSummary),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor(filter, last)
              : null,
          scope: scope === "*" ? "all" : "projects",
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getProject(context, projectId) {
      try {
        const scope = await scopeOf(context);
        const id = projectIdParam(projectId);
        const detail = await repository().getProject({ projectId: id, scope });
        if (detail === null) {
          throw new AdminApiError("NOT_FOUND", {
            reasonCode: adminReasonCodes.launchProjectNotFound,
          });
        }
        return Object.freeze({
          project: projectSummary(detail.project),
          versions: detail.versions,
          testnetAcceptances: detail.testnetAcceptances,
          deploymentTasks: detail.deploymentTasks,
          deploymentChainId: options.deploymentChainId,
          snapshotPublications: detail.snapshotPublications,
          buybackAttempts: detail.buybackAttempts,
          snapshotReleases: detail.snapshotReleases,
          snapshotClosure: detail.snapshotClosure,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async approve(context, idempotencyKey, projectId, version, body) {
      assertAdminPermission(context.principal, "launch.approve");
      const operationId = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const id = projectIdParam(projectId);
        if (!versionPattern.test(version) || Number(version) > maximumVersion) {
          throw new AdminApiError("NOT_FOUND", { reasonCode: "OPS_NOT_FOUND" });
        }
        const configHash = body["configHash"];
        if (
          typeof configHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/u.test(configHash)
        ) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        const { result, audit } = await run(context, {
          action: "launch.config.approve",
          operationId,
          projectId: id,
          reason: reason(body["reason"]),
          payload: { configVersion: Number(version), configHash },
        });
        const row = (result.result ?? {}) as Record<string, unknown>;
        return Object.freeze({
          operationId: result.operationId,
          replayed: result.replayed,
          approval: Object.freeze({
            projectId: stringOf(row["project_id"]),
            configVersion: Number(row["config_version"]),
            configHash: stringOf(row["config_hash"]),
            approverUserId: stringOf(row["approver_id"]),
            reason: stringOf(row["reason"]),
            approvedAt: isoOf(row["approved_at"]),
          }),
          audit: auditReference(audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async recordTestnetAcceptance(context, idempotencyKey, projectId, body) {
      assertAdminPermission(context.principal, "testnet.accept");
      const operationId = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const id = projectIdParam(projectId);
        const payload = {
          configVersion: body["configVersion"],
          configHash: body["configHash"],
          contractManifestHash: body["contractManifestHash"],
          checklistVersion: body["checklistVersion"],
          outcome: body["outcome"],
          evidence: body["evidence"],
        };
        const { result, audit } = await run(context, {
          action: "testnet.acceptance.record",
          operationId,
          projectId: id,
          reason: reason(body["reason"]),
          payload,
        });
        const row = (result.result ?? {}) as Record<string, unknown>;
        return Object.freeze({
          operationId: result.operationId,
          replayed: result.replayed,
          acceptance: Object.freeze({
            acceptanceId: stringOf(row["acceptance_id"]),
            projectId: stringOf(row["project_id"]),
            configVersion: Number(row["config_version"]),
            chainId: Number(row["chain_id"]),
            configHash: stringOf(row["config_hash"]),
            contractManifestHash: stringOf(row["contract_manifest_hash"]),
            checklistVersion: stringOf(row["checklist_version"]),
            outcome: stringOf(row["outcome"]),
            evidence: Array.isArray(row["evidence"]) ? row["evidence"] : [],
            acceptorUserId: stringOf(row["actor_id"]),
            reason: stringOf(row["reason"]),
            createdAt: isoOf(row["created_at"]),
          }),
          audit: auditReference(audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async retrySnapshotPublication(context, idempotencyKey, projectId, body) {
      assertAdminPermission(context.principal, "console.write");
      const releaseId = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const id = projectIdParam(projectId);
        const reasonText = reason(body["reason"]);
        const base = {
          actor: context.principal.session.actor,
          actorAccountId: context.principal.session.accountId,
          targetType: "launch_project",
          targetId: id,
          requestId: context.requestId,
        } as const;
        const intent = await intentAudit({
          ...base,
          action: "launch.snapshot.retry.requested",
          before: null,
          after: { releaseId, reason: reasonText },
        });
        let outcome: Awaited<
          ReturnType<AdminLaunchReviewRepository["releaseSnapshotPublication"]>
        >;
        try {
          outcome = await repository().releaseSnapshotPublication({
            releaseId,
            projectId: id,
            actor: context.principal.session.actor,
            actorAccountId: context.principal.session.accountId,
            reason: reasonText,
            requestId: context.requestId,
          });
        } catch (error) {
          await outcomeAudit({
            ...base,
            action: "launch.snapshot.retry.failed",
            before: null,
            after: {
              requestedAuditId: intent.auditId,
              releaseId,
              errorCode:
                error instanceof AdminLaunchSnapshotRetryError
                  ? error.reasonCode
                  : adminReasonCodes.databaseUnavailable,
            },
          });
          throw error;
        }
        const audit = await outcomeAudit({
          ...base,
          action: "launch.snapshot.retry.decided",
          before: {
            publicationId: outcome.release.publicationId,
            attempt: outcome.release.releasedAttempt,
            status: outcome.release.releasedStatus,
            failureCode: outcome.release.releasedFailureCode,
          },
          after: {
            requestedAuditId: intent.auditId,
            releaseId,
            instanceId: outcome.release.instanceId,
            nextAttempt: outcome.release.releasedAttempt + 1,
            replayed: outcome.replayed,
          },
        });
        return Object.freeze({
          operationId: outcome.release.releaseId,
          replayed: outcome.replayed,
          release: Object.freeze({
            ...outcome.release,
            nextAttempt: outcome.release.releasedAttempt + 1,
          }),
          audit: auditReference(audit ?? intent),
        });
      } catch (error) {
        if (error instanceof AdminLaunchSnapshotRetryError) {
          throw new AdminApiError(
            error.kind === "not_found" ? "NOT_FOUND" : "ADMIN_CONFLICT",
            { reasonCode: error.reasonCode, ...error.details },
          );
        }
        return translate(error);
      }
    },
  } satisfies AdminLaunchReviewConsoleService);
}
