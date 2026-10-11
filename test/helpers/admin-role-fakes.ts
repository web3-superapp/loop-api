import { randomUUID } from "node:crypto";

import { hashAdminPassword } from "../../src/features/admin/admin-auth.js";
import { adminReasonCodes } from "../../src/features/admin/admin-contract.js";
import type {
  AdminAccountCommand,
  AdminAccountCredentialRecord,
  AdminAccountListItem,
  AdminAccountRepository,
  AdminOperatorState,
} from "../../src/features/admin/admin-accounts.js";
import {
  AdminLaunchSnapshotRetryError,
  type AdminLaunchProjectSummary,
  type AdminLaunchReviewRepository,
  type AdminLaunchSnapshotRelease,
} from "../../src/features/admin/admin-launch-review.js";
import {
  AdminStateConflictError,
  AdminTargetNotFoundError,
  type AdminAuditInput,
  type AdminRepository,
} from "../../src/features/admin/admin-repository.js";
import type { AdminRole } from "../../src/features/admin/admin-roles.js";
import {
  HooksLaunchReviewError,
  type HooksLaunchReviewCommand,
  type HooksLaunchReviewRepository,
} from "../../src/features/launch/hooks-launch-review.js";

/**
 * Decision 0109 in-memory fakes: console accounts (with the same
 * idempotency, terminal disable, and credentials-version semantics as
 * PostgreSQL), the launch read projection, and a Decision 0108 review
 * repository that enforces grants and self-approval like the real one.
 */

export interface InMemoryAdminAccounts extends AdminAccountRepository {
  readonly accounts: Map<string, AdminAccountCredentialRecord>;
  readonly operators: Map<string, AdminOperatorState>;
  /** Decision 0111: lower-cased username → lockedUntil (ISO). */
  readonly locks: Map<string, string>;
  seed(input: {
    readonly username: string;
    readonly password: string;
    readonly role: AdminRole;
    readonly operatorUserId?: string | null;
    readonly passwordMustChange?: boolean;
  }): Promise<AdminAccountCredentialRecord>;
}

export function createInMemoryAdminAccounts(
  audit: Pick<AdminRepository, "appendAudit">,
): InMemoryAdminAccounts {
  const accounts = new Map<string, AdminAccountCredentialRecord>();
  const operators = new Map<string, AdminOperatorState>();
  const locks = new Map<string, string>();
  const commands = new Map<
    string,
    AdminAccountCommand & { readonly target: string }
  >();

  function item(record: AdminAccountCredentialRecord): AdminAccountListItem {
    return {
      ...record,
      operator:
        record.operatorUserId === null
          ? null
          : (operators.get(record.operatorUserId) ?? {
              enabled: null,
              grants: [],
            }),
      lockedUntil: locks.get(record.username.toLowerCase()) ?? null,
    };
  }

  function claim(command: AdminAccountCommand): string | null {
    const existing = commands.get(command.idempotencyKey);
    if (existing === undefined) return null;
    if (
      existing.actor !== command.actor ||
      existing.actorAccountId !== command.actorAccountId ||
      existing.action !== command.action ||
      existing.fingerprint !== command.fingerprint
    ) {
      throw new AdminStateConflictError(adminReasonCodes.idempotencyConflict);
    }
    return existing.target;
  }

  function lock(accountId: string): AdminAccountCredentialRecord {
    const record = accounts.get(accountId);
    if (record === undefined) {
      throw new AdminTargetNotFoundError(adminReasonCodes.accountNotFound);
    }
    return record;
  }

  async function writeAudit(
    base: Omit<AdminAuditInput, "before" | "after" | "targetId">,
    targetId: string,
    after: unknown,
  ) {
    return audit.appendAudit({ ...base, targetId, before: null, after });
  }

  const repository: InMemoryAdminAccounts = {
    accounts,
    operators,
    locks,
    async seed(input) {
      const now = new Date().toISOString();
      const record: AdminAccountCredentialRecord = {
        accountId: randomUUID(),
        username: input.username,
        passwordHash: await hashAdminPassword(input.password),
        role: input.role,
        operatorUserId: input.operatorUserId ?? null,
        passwordMustChange: input.passwordMustChange ?? false,
        credentialsVersion: 1,
        credentialsChangedAt: now,
        createdAt: now,
        createdBy: "operator",
        disabledAt: null,
        disabledBy: null,
      };
      accounts.set(record.accountId, record);
      return record;
    },
    findByUsername(username) {
      return Promise.resolve(
        [...accounts.values()].find((entry) => entry.username === username) ??
          null,
      );
    },
    get(accountId) {
      return Promise.resolve(accounts.get(accountId) ?? null);
    },
    list() {
      return Promise.resolve([...accounts.values()].reverse().map(item));
    },
    async create(input) {
      const earlier = claim(input.command);
      if (earlier !== null) {
        return {
          account: item(lock(earlier)),
          audit: null,
          replayed: true,
          changed: false,
        };
      }
      for (const existing of accounts.values()) {
        if (existing.username.toLowerCase() === input.username.toLowerCase()) {
          throw new AdminStateConflictError(
            adminReasonCodes.accountUsernameTaken,
          );
        }
        if (
          input.operatorUserId !== null &&
          existing.operatorUserId === input.operatorUserId &&
          existing.disabledAt === null
        ) {
          throw new AdminStateConflictError(
            adminReasonCodes.accountOperatorBound,
          );
        }
      }
      const now = new Date().toISOString();
      const record: AdminAccountCredentialRecord = {
        accountId: input.accountId,
        username: input.username,
        passwordHash: input.passwordHash,
        role: input.role,
        operatorUserId: input.operatorUserId,
        passwordMustChange: true,
        credentialsVersion: 1,
        credentialsChangedAt: now,
        createdAt: now,
        createdBy: input.command.actor,
        disabledAt: null,
        disabledBy: null,
      };
      accounts.set(record.accountId, record);
      if (input.operatorUserId !== null) {
        operators.set(input.operatorUserId, {
          enabled: true,
          grants: input.opsGrants.map((grant) => ({ ...grant })),
        });
      }
      commands.set(input.command.idempotencyKey, {
        ...input.command,
        target: record.accountId,
      });
      const auditRecord = await writeAudit(input.audit, record.accountId, {
        role: record.role,
      });
      return {
        account: item(record),
        audit: auditRecord,
        replayed: false,
        changed: true,
      };
    },
    async disable(input) {
      const earlier = claim(input.command);
      if (earlier !== null) {
        return {
          account: item(lock(earlier)),
          audit: null,
          replayed: true,
          changed: false,
        };
      }
      const current = lock(input.accountId);
      commands.set(input.command.idempotencyKey, {
        ...input.command,
        target: current.accountId,
      });
      if (current.disabledAt !== null) {
        return {
          account: item(current),
          audit: null,
          replayed: false,
          changed: false,
        };
      }
      const updated = {
        ...current,
        disabledAt: new Date().toISOString(),
        disabledBy: input.command.actor,
      };
      accounts.set(updated.accountId, updated);
      if (updated.operatorUserId !== null) {
        const state = operators.get(updated.operatorUserId);
        operators.set(updated.operatorUserId, {
          enabled: false,
          grants: state?.grants ?? [],
        });
      }
      const auditRecord = await writeAudit(input.audit, updated.accountId, {
        reasonCode: input.reasonCode,
      });
      return {
        account: item(updated),
        audit: auditRecord,
        replayed: false,
        changed: true,
      };
    },
    async resetPassword(input) {
      const earlier = claim(input.command);
      if (earlier !== null) {
        return {
          account: item(lock(earlier)),
          audit: null,
          replayed: true,
          changed: false,
        };
      }
      const current = lock(input.accountId);
      if (current.disabledAt !== null) {
        throw new AdminStateConflictError(adminReasonCodes.accountDisabled);
      }
      const updated = {
        ...current,
        passwordHash: input.passwordHash,
        passwordMustChange: true,
        credentialsVersion: current.credentialsVersion + 1,
        credentialsChangedAt: new Date().toISOString(),
      };
      accounts.set(updated.accountId, updated);
      commands.set(input.command.idempotencyKey, {
        ...input.command,
        target: updated.accountId,
      });
      const auditRecord = await writeAudit(
        input.audit,
        updated.accountId,
        null,
      );
      return {
        account: item(updated),
        audit: auditRecord,
        replayed: false,
        changed: true,
      };
    },
    async unlock(input) {
      const earlier = claim(input.command);
      if (earlier !== null) {
        return {
          account: item(lock(earlier)),
          audit: null,
          replayed: true,
          changed: false,
        };
      }
      const current = lock(input.accountId);
      if (current.disabledAt !== null) {
        throw new AdminStateConflictError(adminReasonCodes.accountDisabled);
      }
      commands.set(input.command.idempotencyKey, {
        ...input.command,
        target: current.accountId,
      });
      const key = current.username.toLowerCase();
      if (!locks.has(key)) {
        return {
          account: item(current),
          audit: null,
          replayed: false,
          changed: false,
        };
      }
      locks.delete(key);
      const auditRecord = await writeAudit(input.audit, current.accountId, {
        reasonCode: input.reasonCode,
      });
      return {
        account: item(current),
        audit: auditRecord,
        replayed: false,
        changed: true,
      };
    },
    async changeOwnPassword(input) {
      const current = lock(input.accountId);
      if (current.credentialsVersion !== input.expectedCredentialsVersion) {
        throw new AdminStateConflictError(adminReasonCodes.updatedAtMismatch);
      }
      const updated = {
        ...current,
        passwordHash: input.passwordHash,
        passwordMustChange: false,
        credentialsVersion: current.credentialsVersion + 1,
        credentialsChangedAt: new Date().toISOString(),
      };
      accounts.set(updated.accountId, updated);
      const auditRecord = await writeAudit(
        input.audit,
        updated.accountId,
        null,
      );
      return { account: updated, audit: auditRecord };
    },
  };
  return repository;
}

export function launchProjectFixture(
  overrides: Partial<AdminLaunchProjectSummary> = {},
): AdminLaunchProjectSummary {
  return {
    projectId: randomUUID(),
    name: "Project",
    ticker: "MEME",
    ownerUserId: randomUUID(),
    kind: "launch2",
    launchReviewStatus: "approved",
    materialVersion: 1,
    rejection: null,
    materialApproval: null,
    communityId: null,
    community: null,
    stage: "awaiting_approval",
    latestConfigVersion: 1,
    latestConfigHash: `0x${"ab".repeat(32)}`,
    latestEditedBy: { kind: "owner", userId: randomUUID() },
    latestApproval: null,
    latestRejection: null,
    latestAcceptanceOutcome: null,
    activeDeploymentJobId: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    cursorKey: "2026-10-09T00:00:00.000000Z",
    ...overrides,
  };
}

export function createInMemoryAdminLaunchReview(
  projects: readonly AdminLaunchProjectSummary[],
  operatorScopes: Map<string, readonly string[]>,
): AdminLaunchReviewRepository {
  // Decision 0120: every project has one instance whose attempt 1 failed
  // non-retryably; one release per project.
  const releases = new Map<string, AdminLaunchSnapshotRelease>();
  function visible(
    scope: "*" | readonly string[],
  ): AdminLaunchProjectSummary[] {
    return projects.filter(
      (project) => scope === "*" || scope.includes(project.projectId),
    );
  }
  return {
    launchReadScopes: (operatorUserId) =>
      Promise.resolve(operatorScopes.get(operatorUserId) ?? []),
    listProjects: (input) =>
      Promise.resolve(
        visible(input.scope)
          .filter(
            (project) => input.stage === null || project.stage === input.stage,
          )
          .filter(
            (project) => input.kind === null || project.kind === input.kind,
          )
          .filter(
            (project) =>
              input.after === null || project.projectId < input.after.projectId,
          )
          .sort((a, b) => (a.projectId < b.projectId ? 1 : -1))
          .slice(0, input.limit),
      ),
    getProject: (input) => {
      const project = visible(input.scope).find(
        (entry) => entry.projectId === input.projectId,
      );
      return Promise.resolve(
        project === undefined
          ? null
          : {
              project,
              versions: [],
              testnetAcceptances: [],
              deploymentTasks: [],
              snapshotPublications: [],
              buybackAttempts: [],
              snapshotReleases: [...releases.values()].filter(
                (release) => release.projectId === project.projectId,
              ),
              snapshotClosure: null,
              projectRejections: [],
            },
      );
    },
    releaseSnapshotPublication: (input) => {
      const existing = releases.get(input.releaseId);
      if (existing !== undefined) {
        if (
          existing.projectId !== input.projectId ||
          existing.reason !== input.reason
        ) {
          return Promise.reject(
            new AdminLaunchSnapshotRetryError(
              "idempotency",
              "ADMIN_IDEMPOTENCY_CONFLICT",
            ),
          );
        }
        return Promise.resolve({ release: existing, replayed: true });
      }
      if (!projects.some((project) => project.projectId === input.projectId)) {
        return Promise.reject(
          new AdminLaunchSnapshotRetryError(
            "not_found",
            "ADMIN_LAUNCH_PROJECT_NOT_FOUND",
          ),
        );
      }
      if (
        [...releases.values()].some(
          (release) => release.projectId === input.projectId,
        )
      ) {
        return Promise.reject(
          new AdminLaunchSnapshotRetryError(
            "conflict",
            "LAUNCH2_SNAPSHOT_ALREADY_RELEASED",
          ),
        );
      }
      const release: AdminLaunchSnapshotRelease = {
        releaseId: input.releaseId,
        projectId: input.projectId,
        instanceId: "7d3f5a1e-2b4c-4d6e-8f90-a1b2c3d4e5f6",
        publicationId: "6c2e4f0d-1a3b-4c5d-9e8f-0a1b2c3d4e5f",
        releasedAttempt: 1,
        releasedStatus: "failed",
        releasedFailureCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
        actor: input.actor,
        reason: input.reason,
        createdAt: "2026-10-10T00:00:00.000Z",
      };
      releases.set(input.releaseId, release);
      return Promise.resolve({ release, replayed: false });
    },
  };
}

/**
 * Grants + self-approval/acceptance like the PostgreSQL repository:
 * `owners` maps projectId → owner (= editor of every version here).
 */
export function createFakeHooksReview(input: {
  readonly grants: Map<string, readonly string[]>;
  readonly owners: Map<string, string>;
}): HooksLaunchReviewRepository & {
  readonly executed: HooksLaunchReviewCommand[];
} {
  const executed: HooksLaunchReviewCommand[] = [];
  const operations = new Map<
    string,
    { actor: string; body: string; result: unknown }
  >();
  return {
    executed,
    session: () => Promise.reject(new Error("unused")),
    listProjects: () => Promise.reject(new Error("unused")),
    listTestnetAcceptances: () => Promise.reject(new Error("unused")),
    execute(actor, command) {
      const permission =
        command.action === "launch.config.approve" ||
        command.action === "launch.config.reject" ||
        command.action === "launch.project.approve" ||
        command.action === "launch.project.reject"
          ? "launch.approve"
          : command.action === "testnet.acceptance.record"
            ? "testnet.accept"
            : "launch.edit";
      if (!(input.grants.get(actor) ?? []).includes(permission)) {
        return Promise.reject(new HooksLaunchReviewError("OPS_FORBIDDEN"));
      }
      const body = JSON.stringify(command);
      const earlier = operations.get(command.operationId);
      if (earlier !== undefined) {
        if (earlier.actor !== actor || earlier.body !== body) {
          return Promise.reject(
            new HooksLaunchReviewError("OPS_IDEMPOTENCY_CONFLICT"),
          );
        }
        // Like ops_operations.result: the stored JSON (dates as strings).
        return Promise.resolve({
          operationId: command.operationId,
          result: JSON.parse(JSON.stringify(earlier.result)) as unknown,
          replayed: true,
        });
      }
      const owner = input.owners.get(command.target);
      if (owner === undefined) {
        return Promise.reject(new HooksLaunchReviewError("OPS_NOT_FOUND"));
      }
      if (owner === actor) {
        return Promise.reject(
          new HooksLaunchReviewError(
            command.action === "testnet.acceptance.record"
              ? "OPS_SELF_ACCEPTANCE"
              : "OPS_SELF_APPROVAL",
          ),
        );
      }
      executed.push(command);
      const now = new Date();
      const result =
        command.action === "launch.config.approve"
          ? {
              project_id: command.target,
              config_version: command.payload.configVersion,
              config_hash: command.payload.configHash.toLowerCase(),
              approver_id: actor,
              reason: command.reason,
              approved_at: now,
            }
          : command.action === "launch.config.reject"
            ? {
                project_id: command.target,
                config_version: command.payload.configVersion,
                config_hash: command.payload.configHash.toLowerCase(),
                reviewer_id: actor,
                reason_code: command.payload.reasonCode,
                note: command.payload.note,
                rejected_at: now,
              }
            : command.action === "launch.project.approve"
              ? {
                  approval_id: command.operationId,
                  project_id: command.target,
                  material_version: command.payload.materialVersion,
                  reviewer_user_id: actor,
                  reason: command.reason,
                  launch_id: "11111111-1111-4111-8111-111111111111",
                  created_at: now,
                }
              : command.action === "launch.project.reject"
                ? {
                    rejection_id: command.operationId,
                    project_id: command.target,
                    material_version: command.payload.materialVersion,
                    reviewer_user_id: actor,
                    reason_code: command.payload.reasonCode,
                    note: command.payload.note,
                    created_at: now,
                  }
                : command.action === "testnet.acceptance.record"
                  ? {
                      acceptance_id: command.operationId,
                      project_id: command.target,
                      config_version: command.payload.configVersion,
                      chain_id: 97,
                      config_hash: command.payload.configHash.toLowerCase(),
                      contract_manifest_hash:
                        command.payload.contractManifestHash.toLowerCase(),
                      checklist_version: command.payload.checklistVersion,
                      outcome: command.payload.outcome,
                      evidence: command.payload.evidence,
                      actor_id: actor,
                      reason: command.reason,
                      created_at: now,
                    }
                  : {};
      operations.set(command.operationId, { actor, body, result });
      return Promise.resolve({
        operationId: command.operationId,
        result,
        replayed: false,
      });
    },
  };
}
