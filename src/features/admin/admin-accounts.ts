import { createHmac, randomUUID } from "node:crypto";

import { AdminApiError, adminReasonCodes } from "./admin-contract.js";
import {
  AdminArgon2BusyError,
  hashAdminPassword,
  verifyAdminPassword,
  type AdminSession,
} from "./admin-auth.js";
import {
  AdminRepositoryUnavailableError,
  AdminStateConflictError,
  AdminTargetNotFoundError,
  AdminValidationError,
  type AdminAuditInput,
  type AdminAuditRecord,
} from "./admin-repository.js";
import {
  adminOperatorRoles,
  adminRoleOpsGrants,
  adminRolePermissions,
  isAdminRole,
  type AdminOpsGrant,
  type AdminPermission,
  type AdminRole,
} from "./admin-roles.js";

/**
 * Decision 0109: individual console accounts. The platform administrator
 * creates, disables, resets, and (Decision 0111) unlocks accounts; every account write carries a
 * UUIDv4 `Idempotency-Key`, lands with its `admin_audit_log` row in the
 * same transaction, and, for reviewer / testnet acceptor accounts, writes
 * the bound LOOP user's `ops_operators` / `ops_grants` through the Decision
 * 0108 bootstrap (with its `ops_audit` row) in that transaction too.
 */

export interface AdminAccountRecord {
  readonly accountId: string;
  readonly username: string;
  readonly role: AdminRole;
  readonly operatorUserId: string | null;
  readonly passwordMustChange: boolean;
  readonly credentialsVersion: number;
  readonly credentialsChangedAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt: string | null;
  readonly disabledBy: string | null;
}

export interface AdminAccountCredentialRecord extends AdminAccountRecord {
  readonly passwordHash: string;
}

export interface AdminOperatorState {
  /**
   * Decision 0130: the bound user's `loop_users.loop_id` (what the App's
   * Me page shows); null only if the user row is gone.
   */
  readonly loopId: string | null;
  readonly enabled: boolean | null;
  readonly grants: readonly { permission: string; scope: string }[];
}

export interface AdminAccountListItem extends AdminAccountRecord {
  /** The bound LOOP user's operator state (null when unbound). */
  readonly operator: AdminOperatorState | null;
  /**
   * Decision 0111: until when the account's login name is locked
   * (`admin_login_attempts`, scope `username`); null when not locked now.
   */
  readonly lockedUntil: string | null;
}

export type AdminAccountCommandAction =
  | "account.create"
  | "account.disable"
  | "account.reset_password"
  | "account.unlock";

export interface AdminAccountCommand {
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly action: AdminAccountCommandAction;
  /** Keyed SHA-256 (hex) of the canonical request. */
  readonly fingerprint: string;
}

export interface AdminAccountWriteResult {
  readonly account: AdminAccountListItem;
  /** Null for an exact replay of an earlier key. */
  readonly audit: AdminAuditRecord | null;
  readonly replayed: boolean;
  readonly changed: boolean;
}

export interface AdminAccountRepository {
  findByUsername(
    username: string,
  ): Promise<AdminAccountCredentialRecord | null>;
  get(accountId: string): Promise<AdminAccountCredentialRecord | null>;
  /**
   * Decision 0130: the `loop_users.id` whose `loop_id` is exactly this
   * (already upper-cased) LOOP ID; null when no user has it.
   */
  findOperatorUserIdByLoopId(loopId: string): Promise<string | null>;
  /** Newest first, at most `adminAccountListMaximum`. */
  list(): Promise<readonly AdminAccountListItem[]>;
  create(input: {
    readonly command: AdminAccountCommand;
    readonly accountId: string;
    readonly username: string;
    readonly passwordHash: string;
    readonly role: AdminRole;
    readonly operatorUserId: string | null;
    readonly operatorLabel: string | null;
    readonly opsGrants: readonly AdminOpsGrant[];
    /** Project IDs the grants are scoped to; each must exist. */
    readonly projectIds: readonly string[];
    readonly audit: Omit<AdminAuditInput, "before" | "after" | "targetId">;
  }): Promise<AdminAccountWriteResult>;
  disable(input: {
    readonly command: AdminAccountCommand;
    readonly accountId: string;
    readonly reasonCode: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after" | "targetId">;
  }): Promise<AdminAccountWriteResult>;
  resetPassword(input: {
    readonly command: AdminAccountCommand;
    readonly accountId: string;
    readonly passwordHash: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after" | "targetId">;
  }): Promise<AdminAccountWriteResult>;
  /**
   * Decision 0111: deletes the account's login-name bucket
   * (`admin_login_attempts`, scope `username`, key = the lower-cased
   * username); address buckets stay. No bucket → `changed: false`, no
   * audit row. A disabled account is refused (terminal).
   */
  unlock(input: {
    readonly command: AdminAccountCommand;
    readonly accountId: string;
    readonly reasonCode: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after" | "targetId">;
  }): Promise<AdminAccountWriteResult>;
  /**
   * The holder's own change: compare-and-set on `credentialsVersion`, so a
   * concurrent reset wins and this change is refused.
   */
  changeOwnPassword(input: {
    readonly accountId: string;
    readonly expectedCredentialsVersion: number;
    readonly passwordHash: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after" | "targetId">;
  }): Promise<{
    readonly account: AdminAccountRecord;
    readonly audit: AdminAuditRecord;
  }>;
}

export const adminAccountListMaximum = 500;
/**
 * Decision 0111: the path segment that names the ADMIN_USERNAME bootstrap
 * administrator on account routes (it has no account ID); unlocking it is
 * 409 ADMIN_ACCOUNT_ENVIRONMENT.
 */
export const adminBootstrapAccountPathId = "bootstrap";
export const adminOperatorLabelMaximumLength = 80;
export const adminAccountProjectScopeMaximum = 20;

/** The resolved caller of a console request (Decision 0109). */
export interface AdminPrincipal {
  readonly session: AdminSession;
  readonly role: AdminRole;
  /** Empty while `passwordChangeRequired`. */
  readonly permissions: readonly AdminPermission[];
  readonly operatorUserId: string | null;
  readonly passwordChangeRequired: boolean;
}

export interface AdminRequestContext {
  readonly principal: AdminPrincipal;
  readonly requestId: string;
}

export function adminPrincipalFromAccount(
  session: AdminSession,
  account: AdminAccountRecord | null,
): AdminPrincipal {
  if (account === null) {
    return Object.freeze({
      session,
      role: "platform_admin",
      permissions: adminRolePermissions("platform_admin"),
      operatorUserId: null,
      passwordChangeRequired: false,
    });
  }
  return Object.freeze({
    session,
    role: account.role,
    permissions: account.passwordMustChange
      ? Object.freeze([])
      : adminRolePermissions(account.role),
    operatorUserId: account.operatorUserId,
    passwordChangeRequired: account.passwordMustChange,
  });
}

/** Refuses unless the principal holds the permission (Decision 0109). */
export function assertAdminPermission(
  principal: AdminPrincipal,
  permission: AdminPermission,
): void {
  if (principal.passwordChangeRequired) {
    throw new AdminApiError("PERMISSION_DENIED", {
      reasonCode: adminReasonCodes.passwordChangeRequired,
    });
  }
  if (!principal.permissions.includes(permission)) {
    throw new AdminApiError("PERMISSION_DENIED", {
      reasonCode: adminReasonCodes.roleForbidden,
      permission,
    });
  }
}

const usernamePattern = /^[A-Za-z0-9._@-]{1,64}$/u;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Decision 0130: the App-visible LOOP ID, any case on input. */
export const adminOperatorLoopIdPattern = /^LOOP-[A-Z0-9]{8}$/iu;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const adminPasswordMinimumLength = 12;
export const adminPasswordMaximumLength = 256;

/** `Idempotency-Key` of a console write: a canonical lower-case UUIDv4. */
export function requireAdminIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new AdminApiError("INVALID_REQUEST", {
      reasonCode: adminReasonCodes.idempotencyKeyRequired,
    });
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  const encoded: unknown = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "null";
}

function translate(error: unknown): never {
  if (error instanceof AdminApiError) throw error;
  if (error instanceof AdminStateConflictError) {
    throw new AdminApiError("ADMIN_CONFLICT", {
      reasonCode: error.reasonCode,
      ...error.details,
    });
  }
  if (error instanceof AdminTargetNotFoundError) {
    throw new AdminApiError("NOT_FOUND", { reasonCode: error.reasonCode });
  }
  if (error instanceof AdminValidationError) {
    throw new AdminApiError("VALIDATION_FAILED", {
      reasonCode: error.reasonCode,
      ...error.details,
    });
  }
  if (error instanceof AdminRepositoryUnavailableError) {
    throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: adminReasonCodes.databaseUnavailable,
    });
  }
  if (error instanceof AdminArgon2BusyError) {
    throw new AdminApiError("ADMIN_LOGIN_BUSY", { retryAfterSeconds: 1 });
  }
  throw error;
}

function password(value: unknown): string {
  if (typeof value !== "string") {
    throw new AdminApiError("INVALID_REQUEST");
  }
  const length = Array.from(value).length;
  if (
    value.length < adminPasswordMinimumLength ||
    value.length > adminPasswordMaximumLength ||
    length < adminPasswordMinimumLength ||
    forbiddenTextCharacters.test(value)
  ) {
    throw new AdminApiError("VALIDATION_FAILED", {
      reasonCode: adminReasonCodes.passwordInvalid,
      minimumLength: adminPasswordMinimumLength,
      maximumLength: adminPasswordMaximumLength,
    });
  }
  return value;
}

/** The public view of an account; never a hash. */
export function projectAdminAccount(record: AdminAccountListItem) {
  return Object.freeze({
    accountId: record.accountId,
    username: record.username,
    role: record.role,
    permissions: adminRolePermissions(record.role),
    status: record.disabledAt === null ? "active" : "disabled",
    operatorUserId: record.operatorUserId,
    operator: record.operator,
    locked: record.lockedUntil !== null,
    lockedUntil: record.lockedUntil,
    passwordChangeRequired: record.passwordMustChange,
    credentialsChangedAt: record.credentialsChangedAt,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    disabledAt: record.disabledAt,
    disabledBy: record.disabledBy,
  });
}

function auditReference(audit: AdminAuditRecord | null) {
  return audit === null
    ? null
    : Object.freeze({ auditId: audit.auditId, seq: audit.seq, at: audit.at });
}

export interface AdminAccountService {
  list(context: AdminRequestContext): Promise<Record<string, unknown>>;
  create(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly status: 200 | 201; readonly body: unknown }>;
  disable(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    accountId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  resetPassword(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    accountId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Decision 0111: clears the account's login-name lock. */
  unlock(
    context: AdminRequestContext,
    idempotencyKey: unknown,
    accountId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** The holder's own password change (any account role). */
  changeOwnPassword(
    context: AdminRequestContext,
    body: Readonly<Record<string, unknown>>,
  ): Promise<AdminAccountRecord>;
}

export function createAdminAccountService(options: {
  readonly repository: AdminAccountRepository | null;
  /** ADMIN_USERNAME: never creatable as a table account. */
  readonly bootstrapUsername: string;
  readonly sessionSecret: string;
}): AdminAccountService {
  const fingerprintKey = createHmac("sha256", "loop-admin-account-command-v1")
    .update(options.sessionSecret)
    .digest();

  function repository(): AdminAccountRepository {
    if (options.repository === null) {
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.databaseUnavailable,
      });
    }
    return options.repository;
  }

  function command(
    context: AdminRequestContext,
    key: string,
    action: AdminAccountCommandAction,
    request: unknown,
  ): AdminAccountCommand {
    // Keyed so a stored fingerprint of a request carrying a password cannot
    // be brute-forced offline without ADMIN_SESSION_SECRET.
    const fingerprint = createHmac("sha256", fingerprintKey)
      .update(canonical({ action, request }))
      .digest("hex");
    return Object.freeze({
      idempotencyKey: key,
      actor: context.principal.session.actor,
      actorAccountId: context.principal.session.accountId,
      action,
      fingerprint,
    });
  }

  function auditBase(context: AdminRequestContext, action: string) {
    return Object.freeze({
      actor: context.principal.session.actor,
      actorAccountId: context.principal.session.accountId,
      action,
      targetType: "admin_account",
      requestId: context.requestId,
    });
  }

  function writeResource(result: AdminAccountWriteResult) {
    return Object.freeze({
      account: projectAdminAccount(result.account),
      changed: result.changed,
      replayed: result.replayed,
      audit: auditReference(result.audit),
    });
  }

  function accountIdParam(value: string): string {
    if (!canonicalUuidPattern.test(value)) {
      throw new AdminApiError("NOT_FOUND", {
        reasonCode: adminReasonCodes.accountNotFound,
      });
    }
    return value;
  }

  return Object.freeze({
    async list(context) {
      assertAdminPermission(context.principal, "accounts.read");
      try {
        const items = await repository().list();
        return Object.freeze({
          items: items.map(projectAdminAccount),
          bootstrap: Object.freeze({
            username: options.bootstrapUsername,
            role: "platform_admin" as const,
            source: "environment" as const,
          }),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async create(context, idempotencyKey, body) {
      assertAdminPermission(context.principal, "accounts.manage");
      const key = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const username = body["username"];
        const role = body["role"];
        if (typeof username !== "string" || !usernamePattern.test(username)) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        if (!isAdminRole(role)) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        if (
          username.toLowerCase() === options.bootstrapUsername.toLowerCase()
        ) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.accountUsernameTaken,
          });
        }
        const secret = password(body["password"]);
        const operatorUserIdValue = body["operatorUserId"] ?? null;
        const operatorLoopIdValue = body["operatorLoopId"] ?? null;
        const labelValue = body["operatorLabel"] ?? null;
        const projectIdsValue = body["projectIds"] ?? null;
        let operatorUserId: string | null = null;
        let operatorLabel: string | null = null;
        let projectIds: readonly string[] | null = null;
        if (adminOperatorRoles.has(role)) {
          if (operatorUserIdValue === null && operatorLoopIdValue === null) {
            throw new AdminApiError("VALIDATION_FAILED", {
              reasonCode: adminReasonCodes.accountOperatorRequired,
            });
          }
          if (
            operatorUserIdValue !== null &&
            (typeof operatorUserIdValue !== "string" ||
              !canonicalUuidPattern.test(operatorUserIdValue))
          ) {
            throw new AdminApiError("INVALID_REQUEST");
          }
          if (
            operatorLoopIdValue !== null &&
            (typeof operatorLoopIdValue !== "string" ||
              !adminOperatorLoopIdPattern.test(operatorLoopIdValue))
          ) {
            throw new AdminApiError("INVALID_REQUEST");
          }
          operatorUserId = operatorUserIdValue;
          if (operatorLoopIdValue !== null) {
            // Decision 0130: the operator may type the LOOP ID the App
            // shows; it resolves to the user ID, which stays the binding.
            const loopId = operatorLoopIdValue.toUpperCase();
            const resolved =
              await repository().findOperatorUserIdByLoopId(loopId);
            if (resolved === null) {
              throw new AdminApiError("VALIDATION_FAILED", {
                reasonCode: adminReasonCodes.accountOperatorLoopIdUnknown,
                operatorLoopId: loopId,
              });
            }
            if (operatorUserId !== null && operatorUserId !== resolved) {
              throw new AdminApiError("VALIDATION_FAILED", {
                reasonCode: adminReasonCodes.accountOperatorIdentityMismatch,
                operatorLoopId: loopId,
              });
            }
            operatorUserId = resolved;
          }
          if (labelValue === null) {
            operatorLabel = username;
          } else if (
            typeof labelValue !== "string" ||
            labelValue.trim().length === 0 ||
            Array.from(labelValue.trim()).length >
              adminOperatorLabelMaximumLength ||
            forbiddenTextCharacters.test(labelValue)
          ) {
            throw new AdminApiError("VALIDATION_FAILED", {
              reasonCode: adminReasonCodes.operatorLabelInvalid,
            });
          } else {
            operatorLabel = labelValue.trim();
          }
          if (projectIdsValue !== null) {
            if (
              !Array.isArray(projectIdsValue) ||
              projectIdsValue.length === 0 ||
              projectIdsValue.length > adminAccountProjectScopeMaximum ||
              projectIdsValue.some(
                (entry) =>
                  typeof entry !== "string" ||
                  !canonicalUuidPattern.test(entry),
              )
            ) {
              throw new AdminApiError("INVALID_REQUEST");
            }
            projectIds = Object.freeze(
              [...new Set(projectIdsValue as string[])].sort(),
            );
          }
        } else if (
          operatorUserIdValue !== null ||
          operatorLoopIdValue !== null ||
          labelValue !== null ||
          projectIdsValue !== null
        ) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: adminReasonCodes.accountOperatorNotAllowed,
          });
        }
        const request = {
          username,
          role,
          password: secret,
          operatorUserId,
          operatorLabel,
          projectIds,
        };
        const passwordHash = await hashAdminPassword(secret);
        const result = await repository().create({
          command: command(context, key, "account.create", request),
          accountId: randomUUID(),
          username,
          passwordHash,
          role,
          operatorUserId,
          operatorLabel,
          opsGrants: adminRoleOpsGrants(role, projectIds),
          projectIds: projectIds ?? [],
          audit: auditBase(context, "account.create"),
        });
        return Object.freeze({
          status: result.replayed ? (200 as const) : (201 as const),
          body: writeResource(result),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async disable(context, idempotencyKey, accountId, body) {
      assertAdminPermission(context.principal, "accounts.manage");
      const key = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const id = accountIdParam(accountId);
        const reasonCode = body["reasonCode"];
        if (
          typeof reasonCode !== "string" ||
          !reasonCodePattern.test(reasonCode)
        ) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: "ADMIN_REASON_CODE_INVALID",
          });
        }
        if (id === context.principal.session.accountId) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.accountSelf,
          });
        }
        const result = await repository().disable({
          command: command(context, key, "account.disable", {
            accountId: id,
            reasonCode,
          }),
          accountId: id,
          reasonCode,
          audit: auditBase(context, "account.disable"),
        });
        return writeResource(result);
      } catch (error) {
        return translate(error);
      }
    },

    async resetPassword(context, idempotencyKey, accountId, body) {
      assertAdminPermission(context.principal, "accounts.manage");
      const key = requireAdminIdempotencyKey(idempotencyKey);
      try {
        const id = accountIdParam(accountId);
        const secret = password(body["password"]);
        if (id === context.principal.session.accountId) {
          // Your own password goes through POST /session/password.
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.accountSelf,
          });
        }
        const passwordHash = await hashAdminPassword(secret);
        const result = await repository().resetPassword({
          command: command(context, key, "account.reset_password", {
            accountId: id,
            password: secret,
          }),
          accountId: id,
          passwordHash,
          audit: auditBase(context, "account.reset_password"),
        });
        return writeResource(result);
      } catch (error) {
        return translate(error);
      }
    },

    async unlock(context, idempotencyKey, accountId, body) {
      assertAdminPermission(context.principal, "accounts.manage");
      const key = requireAdminIdempotencyKey(idempotencyKey);
      try {
        // The ADMIN_USERNAME administrator has no account ID; its name
        // bucket is cleared by waiting or by the deployment operator.
        const target = accountId.toLowerCase();
        if (
          target === adminBootstrapAccountPathId ||
          target === options.bootstrapUsername.toLowerCase()
        ) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.accountEnvironment,
          });
        }
        const id = accountIdParam(accountId);
        const reasonCode = body["reasonCode"];
        if (
          typeof reasonCode !== "string" ||
          !reasonCodePattern.test(reasonCode)
        ) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: "ADMIN_REASON_CODE_INVALID",
          });
        }
        const result = await repository().unlock({
          command: command(context, key, "account.unlock", {
            accountId: id,
            reasonCode,
          }),
          accountId: id,
          reasonCode,
          audit: auditBase(context, "account.unlock"),
        });
        return writeResource(result);
      } catch (error) {
        return translate(error);
      }
    },

    async changeOwnPassword(context, body) {
      const principal = context.principal;
      try {
        if (
          principal.session.accountId === null ||
          principal.session.credentialsVersion === null
        ) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.accountEnvironment,
          });
        }
        const current = body["currentPassword"];
        if (typeof current !== "string" || current.length > 1_024) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        const next = password(body["newPassword"]);
        if (next === current) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: adminReasonCodes.passwordInvalid,
          });
        }
        const account = await repository().get(principal.session.accountId);
        if (account === null || account.disabledAt !== null) {
          throw new AdminApiError("ADMIN_SESSION_REQUIRED");
        }
        if (!(await verifyAdminPassword(current, account.passwordHash))) {
          throw new AdminApiError("ADMIN_LOGIN_INVALID");
        }
        const passwordHash = await hashAdminPassword(next);
        const result = await repository().changeOwnPassword({
          accountId: account.accountId,
          expectedCredentialsVersion: principal.session.credentialsVersion,
          passwordHash,
          audit: auditBase(context, "account.password_change"),
        });
        return result.account;
      } catch (error) {
        return translate(error);
      }
    },
  } satisfies AdminAccountService);
}
