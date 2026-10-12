import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { adminReasonCodes } from "../features/admin/admin-contract.js";
import type {
  AdminAccountCommand,
  AdminAccountCredentialRecord,
  AdminAccountListItem,
  AdminAccountRecord,
  AdminAccountRepository,
  AdminAccountWriteResult,
  AdminOperatorState,
} from "../features/admin/admin-accounts.js";
import { adminAccountListMaximum } from "../features/admin/admin-accounts.js";
import {
  AdminRepositoryUnavailableError,
  AdminStateConflictError,
  AdminTargetNotFoundError,
  AdminValidationError,
  type AdminAuditInput,
  type AdminAuditRecord,
} from "../features/admin/admin-repository.js";
import { adminLoginUsernameKey } from "../features/admin/admin-login-attempts.js";
import { adminRoles } from "../features/admin/admin-roles.js";
import {
  HooksLaunchOperatorUserNotFoundError,
  provisionHooksLaunchOperator,
} from "./hooks-launch-review-repository.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * Decision 0109: PostgreSQL side of the console accounts. Every write runs
 * in one transaction: the `Idempotency-Key` claim (advisory lock + command
 * row), the account change, the bound operator's grants through the
 * Decision 0108 bootstrap (`ops_audit` row included), and the
 * `admin_audit_log` row. A refused write leaves nothing behind.
 */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const accountRowSchema = z
  .object({
    id: uuidSchema,
    username: z.string(),
    password_hash: z.string(),
    role: z.enum(adminRoles),
    operator_user_id: uuidSchema.nullable(),
    password_must_change: z.boolean(),
    credentials_version: z.number().int().positive(),
    credentials_changed_at: dateSchema,
    created_at: dateSchema,
    created_by: z.string(),
    disabled_at: dateSchema.nullable(),
    disabled_by: z.string().nullable(),
  })
  .strict();

const accountColumns = `
  a.id, a.username, a.password_hash, a.role, a.operator_user_id,
  a.password_must_change, a.credentials_version, a.credentials_changed_at,
  a.created_at, a.created_by, a.disabled_at, a.disabled_by
`;

const operatorStateSchema = z
  .object({
    loopId: z.string().nullable(),
    enabled: z.boolean().nullable(),
    grants: z.array(
      z.object({ permission: z.string(), scope: z.string() }).strict(),
    ),
  })
  .strict();

function mapAccount(raw: unknown): AdminAccountCredentialRecord {
  const row = accountRowSchema.parse(raw);
  return Object.freeze({
    accountId: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    operatorUserId: row.operator_user_id,
    passwordMustChange: row.password_must_change,
    credentialsVersion: row.credentials_version,
    credentialsChangedAt: row.credentials_changed_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    disabledBy: row.disabled_by,
  });
}

function publicAccount(
  record: AdminAccountCredentialRecord,
): AdminAccountRecord {
  return Object.freeze({
    accountId: record.accountId,
    username: record.username,
    role: record.role,
    operatorUserId: record.operatorUserId,
    passwordMustChange: record.passwordMustChange,
    credentialsVersion: record.credentialsVersion,
    credentialsChangedAt: record.credentialsChangedAt,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    disabledAt: record.disabledAt,
    disabledBy: record.disabledBy,
  });
}

/** Audit snapshot of an account: never the hash. */
function snapshot(record: AdminAccountRecord) {
  return {
    accountId: record.accountId,
    username: record.username,
    role: record.role,
    operatorUserId: record.operatorUserId,
    passwordChangeRequired: record.passwordMustChange,
    credentialsVersion: record.credentialsVersion,
    disabledAt: record.disabledAt,
  };
}

const auditRowSchema = z
  .object({
    audit_id: uuidSchema,
    seq: z.string().regex(/^[1-9][0-9]{0,18}$/u),
    at: dateSchema,
    actor: z.string(),
    actor_account_id: uuidSchema.nullable(),
    action: z.string(),
    target_type: z.string(),
    target_id: z.string().nullable(),
    before: z.unknown(),
    after: z.unknown(),
    request_id: uuidSchema,
  })
  .strict();

async function insertAudit(
  client: PoolClient,
  input: AdminAuditInput,
): Promise<AdminAuditRecord> {
  const result = await client.query({
    text: `
      insert into public.admin_audit_log (
        audit_id, actor, actor_account_id, action, target_type, target_id,
        before, after, request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      returning audit_id, seq::text as seq, at, actor, actor_account_id,
        action, target_type, target_id, before, after, request_id
    `,
    values: [
      randomUUID(),
      input.actor,
      input.actorAccountId ?? null,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.requestId,
    ],
  });
  const row = auditRowSchema.parse(result.rows[0]);
  return Object.freeze({
    auditId: row.audit_id,
    seq: Number(row.seq),
    at: row.at.toISOString(),
    actor: row.actor,
    actorAccountId: row.actor_account_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before ?? null,
    after: row.after ?? null,
    requestId: row.request_id,
  });
}

function constraintOf(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  ) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : "";
  }
  return null;
}

function translate(error: unknown): never {
  if (
    error instanceof AdminStateConflictError ||
    error instanceof AdminTargetNotFoundError ||
    error instanceof AdminValidationError ||
    error instanceof AdminRepositoryUnavailableError
  ) {
    throw error;
  }
  if (error instanceof HooksLaunchOperatorUserNotFoundError) {
    throw new AdminValidationError(adminReasonCodes.accountOperatorUnknown);
  }
  const constraint = constraintOf(error);
  if (constraint === "admin_accounts_username_key") {
    throw new AdminStateConflictError(adminReasonCodes.accountUsernameTaken);
  }
  if (constraint === "admin_accounts_active_operator_key") {
    throw new AdminStateConflictError(adminReasonCodes.accountOperatorBound);
  }
  throw new AdminRepositoryUnavailableError({ cause: error });
}

function unavailable(): AdminRepositoryUnavailableError {
  return new AdminRepositoryUnavailableError();
}

async function readOperator(
  client: Pick<PoolClient, "query">,
  userId: string,
): Promise<AdminOperatorState> {
  const operator = await client.query<{ enabled: boolean }>(
    "select enabled from public.ops_operators where user_id = $1",
    [userId],
  );
  const grants = await client.query<{ permission: string; scope: string }>(
    "select permission, scope from public.ops_grants where user_id = $1 order by permission, scope",
    [userId],
  );
  const user = await client.query<{ loop_id: string }>(
    "select loop_id from public.loop_users where id = $1",
    [userId],
  );
  return Object.freeze({
    loopId: user.rows[0]?.loop_id ?? null,
    enabled: operator.rows[0]?.enabled ?? null,
    grants: Object.freeze(
      grants.rows.map((row) =>
        Object.freeze({ permission: row.permission, scope: row.scope }),
      ),
    ),
  });
}

/** Decision 0111: the account's login-name lock, if it holds now. */
async function readLockedUntil(
  client: Pick<PoolClient, "query">,
  username: string,
): Promise<string | null> {
  const result = await client.query<{ locked_until: Date }>(
    `select locked_until from public.admin_login_attempts
     where scope = 'username' and subject_key = $1
       and locked_until > clock_timestamp()`,
    [adminLoginUsernameKey(username)],
  );
  const lockedUntil = result.rows[0]?.locked_until;
  return lockedUntil === undefined
    ? null
    : dateSchema.parse(lockedUntil).toISOString();
}

async function listItem(
  client: Pick<PoolClient, "query">,
  record: AdminAccountCredentialRecord,
): Promise<AdminAccountListItem> {
  return Object.freeze({
    ...publicAccount(record),
    operator:
      record.operatorUserId === null
        ? null
        : await readOperator(client, record.operatorUserId),
    lockedUntil: await readLockedUntil(client, record.username),
  });
}

async function lockAccount(
  client: PoolClient,
  accountId: string,
): Promise<AdminAccountCredentialRecord> {
  const result = await client.query(
    `select ${accountColumns} from public.admin_accounts a where a.id = $1 for update`,
    [accountId],
  );
  if (result.rows[0] === undefined) {
    throw new AdminTargetNotFoundError(adminReasonCodes.accountNotFound);
  }
  return mapAccount(result.rows[0]);
}

/**
 * Claims the key: null when new (the caller writes the command row after
 * its change), or the target account of an exact earlier replay. The same
 * key under another actor, action, or request is a conflict.
 */
async function claim(
  client: PoolClient,
  command: AdminAccountCommand,
): Promise<string | null> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `admin-account:${command.idempotencyKey}`,
  ]);
  const existing = await client.query<{
    actor: string;
    actor_account_id: string | null;
    action: string;
    target_account_id: string;
    request_fingerprint: string;
  }>(
    `select actor, actor_account_id, action, target_account_id, request_fingerprint
     from public.admin_account_commands where idempotency_key = $1`,
    [command.idempotencyKey],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    row.actor !== command.actor ||
    row.actor_account_id !== command.actorAccountId ||
    row.action !== command.action ||
    row.request_fingerprint !== command.fingerprint
  ) {
    throw new AdminStateConflictError(adminReasonCodes.idempotencyConflict);
  }
  return row.target_account_id;
}

async function record(
  client: PoolClient,
  command: AdminAccountCommand,
  targetAccountId: string,
): Promise<void> {
  await client.query(
    `insert into public.admin_account_commands (
       idempotency_key, actor, actor_account_id, action, target_account_id,
       request_fingerprint
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      command.idempotencyKey,
      command.actor,
      command.actorAccountId,
      command.action,
      targetAccountId,
      command.fingerprint,
    ],
  );
}

async function replay(
  client: PoolClient,
  accountId: string,
): Promise<AdminAccountWriteResult> {
  const account = await lockAccount(client, accountId);
  return Object.freeze({
    account: await listItem(client, account),
    audit: null,
    replayed: true,
    changed: false,
  });
}

export function createPostgresAdminAccountRepository(
  pool: Pool,
): AdminAccountRepository {
  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withV2Transaction(pool, unavailable, async (client) => {
        await client.query("set local lock_timeout = '3s'");
        return work(client);
      });
    } catch (error) {
      return translate(error);
    }
  }

  return Object.freeze({
    async findByUsername(username) {
      try {
        const result = await pool.query(
          `select ${accountColumns} from public.admin_accounts a where a.username = $1`,
          [username],
        );
        return result.rows[0] === undefined ? null : mapAccount(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async get(accountId) {
      try {
        const result = await pool.query(
          `select ${accountColumns} from public.admin_accounts a where a.id = $1`,
          [accountId],
        );
        return result.rows[0] === undefined ? null : mapAccount(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async findOperatorUserIdByLoopId(loopId) {
      try {
        const result = await pool.query<{ id: string }>(
          "select id from public.loop_users where loop_id = $1",
          [loopId],
        );
        const row = result.rows[0];
        return row === undefined ? null : uuidSchema.parse(row.id);
      } catch (error) {
        return translate(error);
      }
    },

    async list() {
      try {
        const result = await pool.query(
          `select ${accountColumns},
             case when a.operator_user_id is null then null else jsonb_build_object(
               'loopId', u.loop_id,
               'enabled', o.enabled,
               'grants', coalesce((
                 select jsonb_agg(jsonb_build_object('permission', g.permission, 'scope', g.scope)
                                  order by g.permission, g.scope)
                 from public.ops_grants g where g.user_id = a.operator_user_id
               ), '[]'::jsonb)
             ) end as operator_state,
             l.locked_until
           from public.admin_accounts a
           left join public.ops_operators o on o.user_id = a.operator_user_id
           left join public.loop_users u on u.id = a.operator_user_id
           left join public.admin_login_attempts l
             on l.scope = 'username'
             and l.subject_key = lower(a.username)
             and l.locked_until > clock_timestamp()
           order by a.created_at desc, a.id desc
           limit $1`,
          [adminAccountListMaximum],
        );
        return Object.freeze(
          result.rows.map((raw: Record<string, unknown>) => {
            const {
              operator_state: state,
              locked_until: lockedUntil,
              ...row
            } = raw;
            const account = mapAccount(row);
            return Object.freeze({
              ...publicAccount(account),
              operator:
                state === null || state === undefined
                  ? null
                  : operatorStateSchema.parse(state),
              lockedUntil:
                lockedUntil === null || lockedUntil === undefined
                  ? null
                  : dateSchema.parse(lockedUntil).toISOString(),
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async create(input) {
      return transaction(async (client) => {
        const earlier = await claim(client, input.command);
        if (earlier !== null) {
          return replay(client, earlier);
        }
        if (input.operatorUserId !== null) {
          const loopUser = await client.query(
            "select 1 from public.loop_users where id = $1",
            [input.operatorUserId],
          );
          if (!loopUser.rowCount) {
            throw new AdminValidationError(
              adminReasonCodes.accountOperatorUnknown,
            );
          }
        }
        for (const projectId of input.projectIds) {
          const project = await client.query(
            "select 1 from public.launch_projects where project_id = $1",
            [projectId],
          );
          if (!project.rowCount) {
            throw new AdminValidationError(
              adminReasonCodes.accountProjectUnknown,
              { projectId },
            );
          }
        }
        const inserted = await client.query(
          `with t as (select clock_timestamp() as now)
           insert into public.admin_accounts as a (
             id, username, password_hash, role, operator_user_id,
             password_must_change, credentials_version,
             credentials_changed_at, created_at, created_by
           )
           select $1, $2, $3, $4, $5, true, 1, t.now, t.now, $6 from t
           returning ${accountColumns}`,
          [
            input.accountId,
            input.username,
            input.passwordHash,
            input.role,
            input.operatorUserId,
            input.command.actor,
          ],
        );
        const account = mapAccount(inserted.rows[0]);
        let operator: Awaited<
          ReturnType<typeof provisionHooksLaunchOperator>
        > | null = null;
        if (input.operatorUserId !== null) {
          operator = await provisionHooksLaunchOperator(
            client,
            {
              userId: input.operatorUserId,
              revoke: false,
              label: input.operatorLabel ?? input.username,
              grants: input.opsGrants,
            },
            {
              kind: "admin_console",
              adminActor: input.command.actor,
              adminAccountId: input.command.actorAccountId,
            },
            `后台账号 ${input.username} (${input.role}) 绑定运营授权`,
          );
        }
        await record(client, input.command, account.accountId);
        const audit = await insertAudit(client, {
          ...input.audit,
          targetId: account.accountId,
          before: null,
          after: {
            ...snapshot(account),
            operatorGrants: operator?.after.grants ?? null,
            idempotencyKey: input.command.idempotencyKey,
          },
        });
        return Object.freeze({
          account: await listItem(client, account),
          audit,
          replayed: false,
          changed: true,
        });
      });
    },

    async disable(input) {
      return transaction(async (client) => {
        const earlier = await claim(client, input.command);
        if (earlier !== null) {
          return replay(client, earlier);
        }
        const current = await lockAccount(client, input.accountId);
        if (current.disabledAt !== null) {
          await record(client, input.command, current.accountId);
          return Object.freeze({
            account: await listItem(client, current),
            audit: null,
            replayed: false,
            changed: false,
          });
        }
        const updated = mapAccount(
          (
            await client.query(
              `update public.admin_accounts as a
               set disabled_at = greatest(clock_timestamp(), a.created_at),
                   disabled_by = $2
               where a.id = $1
               returning ${accountColumns}`,
              [input.accountId, input.command.actor],
            )
          ).rows[0],
        );
        let operator: Awaited<
          ReturnType<typeof provisionHooksLaunchOperator>
        > | null = null;
        if (updated.operatorUserId !== null) {
          operator = await provisionHooksLaunchOperator(
            client,
            { userId: updated.operatorUserId, revoke: true },
            {
              kind: "admin_console",
              adminActor: input.command.actor,
              adminAccountId: input.command.actorAccountId,
            },
            `后台账号 ${updated.username} 停用，撤销运营授权 (${input.reasonCode})`,
          );
        }
        await record(client, input.command, updated.accountId);
        const audit = await insertAudit(client, {
          ...input.audit,
          targetId: updated.accountId,
          before: snapshot(current),
          after: {
            ...snapshot(updated),
            reasonCode: input.reasonCode,
            // Decision 0111: the bound ops operator is disabled in this
            // transaction (formula approval and the launch review stop).
            operatorEnabledBefore: operator?.before.enabled ?? null,
            operatorEnabled: operator?.after.enabled ?? null,
            idempotencyKey: input.command.idempotencyKey,
          },
        });
        return Object.freeze({
          account: await listItem(client, updated),
          audit,
          replayed: false,
          changed: true,
        });
      });
    },

    async resetPassword(input) {
      return transaction(async (client) => {
        const earlier = await claim(client, input.command);
        if (earlier !== null) {
          return replay(client, earlier);
        }
        const current = await lockAccount(client, input.accountId);
        if (current.disabledAt !== null) {
          throw new AdminStateConflictError(adminReasonCodes.accountDisabled);
        }
        const updated = mapAccount(
          (
            await client.query(
              `update public.admin_accounts as a
               set password_hash = $2,
                   password_must_change = true,
                   credentials_version = a.credentials_version + 1,
                   credentials_changed_at = greatest(clock_timestamp(), a.credentials_changed_at)
               where a.id = $1
               returning ${accountColumns}`,
              [input.accountId, input.passwordHash],
            )
          ).rows[0],
        );
        await record(client, input.command, updated.accountId);
        const audit = await insertAudit(client, {
          ...input.audit,
          targetId: updated.accountId,
          before: snapshot(current),
          after: {
            ...snapshot(updated),
            idempotencyKey: input.command.idempotencyKey,
          },
        });
        return Object.freeze({
          account: await listItem(client, updated),
          audit,
          replayed: false,
          changed: true,
        });
      });
    },

    async unlock(input) {
      return transaction(async (client) => {
        const earlier = await claim(client, input.command);
        if (earlier !== null) {
          return replay(client, earlier);
        }
        const current = await lockAccount(client, input.accountId);
        if (current.disabledAt !== null) {
          throw new AdminStateConflictError(adminReasonCodes.accountDisabled);
        }
        // Only the name bucket: address buckets count every name tried
        // from an address and are not one account's to clear.
        const removed = await client.query<{
          failure_count: number;
          locked_until: Date | null;
          locked: boolean;
        }>(
          `delete from public.admin_login_attempts
           where scope = 'username' and subject_key = $1
           returning failure_count, locked_until,
             coalesce(locked_until > clock_timestamp(), false) as locked`,
          [adminLoginUsernameKey(current.username)],
        );
        await record(client, input.command, current.accountId);
        const bucket = removed.rows[0];
        if (bucket === undefined) {
          return Object.freeze({
            account: await listItem(client, current),
            audit: null,
            replayed: false,
            changed: false,
          });
        }
        const audit = await insertAudit(client, {
          ...input.audit,
          targetId: current.accountId,
          before: {
            ...snapshot(current),
            scope: "username",
            failureCount: bucket.failure_count,
            locked: bucket.locked,
            lockedUntil:
              bucket.locked_until === null
                ? null
                : dateSchema.parse(bucket.locked_until).toISOString(),
          },
          after: {
            ...snapshot(current),
            scope: "username",
            failureCount: 0,
            locked: false,
            lockedUntil: null,
            reasonCode: input.reasonCode,
            idempotencyKey: input.command.idempotencyKey,
          },
        });
        return Object.freeze({
          account: await listItem(client, current),
          audit,
          replayed: false,
          changed: true,
        });
      });
    },

    async changeOwnPassword(input) {
      return transaction(async (client) => {
        const current = await lockAccount(client, input.accountId);
        if (current.disabledAt !== null) {
          throw new AdminStateConflictError(adminReasonCodes.accountDisabled);
        }
        if (current.credentialsVersion !== input.expectedCredentialsVersion) {
          throw new AdminStateConflictError(adminReasonCodes.updatedAtMismatch);
        }
        const updated = mapAccount(
          (
            await client.query(
              `update public.admin_accounts as a
               set password_hash = $2,
                   password_must_change = false,
                   credentials_version = a.credentials_version + 1,
                   credentials_changed_at = greatest(clock_timestamp(), a.credentials_changed_at)
               where a.id = $1
               returning ${accountColumns}`,
              [input.accountId, input.passwordHash],
            )
          ).rows[0],
        );
        const audit = await insertAudit(client, {
          ...input.audit,
          targetId: updated.accountId,
          before: snapshot(current),
          after: snapshot(updated),
        });
        return Object.freeze({ account: publicAccount(updated), audit });
      });
    },
  } satisfies AdminAccountRepository);
}
