import type { Pool, PoolClient } from "pg";

import { parseHooksLaunchDraft } from "../features/launch/hooks-launch-config.js";
import {
  HooksLaunchReviewError,
  hooksLaunchCommandHash,
  hooksLaunchCommandPermission,
  type HooksLaunchOpsPermission,
  type HooksLaunchReviewCommand,
  type HooksLaunchReviewPage,
  type HooksLaunchReviewRepository,
} from "../features/launch/hooks-launch-review.js";

/**
 * Decision 0108: PostgreSQL Hooks launch review (ported from the requirer
 * branch ops repository, launch/testnet commands only). Every command runs
 * in one transaction: operator + grant check (row-locked, so a concurrent
 * revoke serializes), operationId idempotency, the business insert, the
 * operation record, and the success audit commit together. A rejected or
 * failed command writes a sanitized audit row after rollback.
 */

const minimumLeadSeconds = 86_400;

async function authorize(
  client: Pick<PoolClient, "query">,
  actor: string,
  permission: HooksLaunchOpsPermission,
  scope: string,
): Promise<void> {
  const operator = await client.query(
    "select user_id from public.ops_operators where user_id = $1 and enabled for share",
    [actor],
  );
  if (!operator.rowCount) throw new HooksLaunchReviewError("OPS_FORBIDDEN");
  const grant = await client.query(
    "select 1 from public.ops_grants where user_id = $1 and permission = $2 and scope in ('*', $3) for share",
    [actor, permission, scope],
  );
  if (!grant.rowCount) throw new HooksLaunchReviewError("OPS_FORBIDDEN");
}

/** Read-path grant check inside the read-only snapshot (no row locks). */
async function grantedScopes(
  client: Pick<PoolClient, "query">,
  actor: string,
  permission: HooksLaunchOpsPermission,
): Promise<readonly string[]> {
  const operator = await client.query(
    "select 1 from public.ops_operators where user_id = $1 and enabled",
    [actor],
  );
  if (!operator.rowCount) throw new HooksLaunchReviewError("OPS_FORBIDDEN");
  const grants = await client.query<{ scope: string }>(
    "select scope from public.ops_grants where user_id = $1 and permission = $2",
    [actor, permission],
  );
  if (!grants.rowCount) throw new HooksLaunchReviewError("OPS_FORBIDDEN");
  return grants.rows.map((row) => row.scope);
}

function page(
  rows: readonly Record<string, unknown>[],
  key: string,
): HooksLaunchReviewPage {
  const last = rows[49];
  return {
    items: rows.slice(0, 50),
    nextCursor: rows.length > 50 && last ? String(last[key]) : null,
  };
}

async function readOnly<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // One consistent snapshot for the grant check and the page.
    await client.query("begin isolation level repeatable read read only");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockApprovedProject(
  client: PoolClient,
  projectId: string,
  mode: "update" | "share",
): Promise<{ readonly ownerUserId: string }> {
  const project = await client.query<{
    owner_user_id: string;
    review_status: string;
  }>(
    `select owner_user_id, review_status from public.launch_projects where project_id = $1 for ${mode}`,
    [projectId],
  );
  const row = project.rows[0];
  if (!row) throw new HooksLaunchReviewError("OPS_NOT_FOUND");
  if (row.review_status !== "approved") {
    throw new HooksLaunchReviewError("OPS_LAUNCH_NOT_APPROVED");
  }
  return { ownerUserId: row.owner_user_id };
}

async function saveConfig(
  client: PoolClient,
  actor: string,
  command: Extract<HooksLaunchReviewCommand, { action: "launch.config.save" }>,
  nowUnixSeconds: number,
): Promise<unknown> {
  const projectId = command.target;
  const project = await lockApprovedProject(client, projectId, "update");
  const current = await client.query<{ latest_version: number | null }>(
    "select max(config_version)::integer as latest_version from public.hooks_launch_project_config_versions where project_id = $1",
    [projectId],
  );
  const currentVersion = current.rows[0]?.latest_version ?? 0;
  if (currentVersion !== command.payload.expectedVersion) {
    throw new HooksLaunchReviewError("OPS_VERSION_CONFLICT");
  }
  let config;
  try {
    config = parseHooksLaunchDraft(command.payload.config, {
      nowUnixSeconds: String(nowUnixSeconds),
      minimumLeadSeconds,
    });
  } catch {
    throw new HooksLaunchReviewError("OPS_INVALID_LAUNCH_CONFIG");
  }
  const inserted = await client.query(
    `insert into public.hooks_launch_project_config_versions (
       project_id, config_version, owner_user_id, template_version,
       config_hash, config, edited_by_operator_id
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     returning project_id, config_version, template_version, config_hash,
       edited_by_operator_id, created_at`,
    [
      projectId,
      currentVersion + 1,
      project.ownerUserId,
      config.templateVersion,
      config.configHash,
      JSON.stringify(config),
      actor,
    ],
  );
  return inserted.rows[0];
}

async function approveConfig(
  client: PoolClient,
  actor: string,
  command: Extract<
    HooksLaunchReviewCommand,
    { action: "launch.config.approve" }
  >,
): Promise<unknown> {
  const projectId = command.target;
  const project = await lockApprovedProject(client, projectId, "share");
  const config = (
    await client.query<{
      config_hash: string;
      owner_user_id: string;
      edited_by_operator_id: string | null;
      latest_version: number;
    }>(
      `select c.config_hash, c.owner_user_id, c.edited_by_operator_id,
         (select max(config_version)::integer
            from public.hooks_launch_project_config_versions
            where project_id = c.project_id) as latest_version
       from public.hooks_launch_project_config_versions c
       where c.project_id = $1 and c.config_version = $2
       for share`,
      [projectId, command.payload.configVersion],
    )
  ).rows[0];
  if (!config) throw new HooksLaunchReviewError("OPS_NOT_FOUND");
  // The editor of a version is the operator who saved it, or the project
  // owner for an owner-saved draft. Neither may approve it, and the project
  // owner may never approve their own project.
  const editor = config.edited_by_operator_id ?? config.owner_user_id;
  if (
    editor === actor ||
    config.owner_user_id === actor ||
    project.ownerUserId === actor
  ) {
    throw new HooksLaunchReviewError("OPS_SELF_APPROVAL");
  }
  if (
    config.config_hash !== command.payload.configHash.toLowerCase() ||
    config.latest_version !== command.payload.configVersion
  ) {
    throw new HooksLaunchReviewError("OPS_VERSION_CONFLICT");
  }
  const inserted = await client.query(
    `insert into public.hooks_launch_config_approvals (
       project_id, config_version, config_hash, approver_id, reason
     ) values ($1, $2, $3, $4, $5)
     on conflict (project_id, config_version) do nothing
     returning project_id, config_version, config_hash, approver_id, reason, approved_at`,
    [
      projectId,
      command.payload.configVersion,
      command.payload.configHash.toLowerCase(),
      actor,
      command.reason,
    ],
  );
  if (!inserted.rowCount) {
    throw new HooksLaunchReviewError("OPS_VERSION_CONFLICT");
  }
  return inserted.rows[0];
}

async function recordAcceptance(
  client: PoolClient,
  actor: string,
  command: Extract<
    HooksLaunchReviewCommand,
    { action: "testnet.acceptance.record" }
  >,
): Promise<unknown> {
  const projectId = command.target;
  const record = command.payload;
  const approved = (
    await client.query<{
      owner_user_id: string;
      edited_by_operator_id: string | null;
    }>(
      `select c.owner_user_id, c.edited_by_operator_id
       from public.hooks_launch_config_approvals a
       join public.hooks_launch_project_config_versions c
         using (project_id, config_version)
       where a.project_id = $1 and a.config_version = $2
         and c.config_hash = $3 and a.config_hash = c.config_hash
       for share of a, c`,
      [projectId, record.configVersion, record.configHash.toLowerCase()],
    )
  ).rows[0];
  if (!approved) {
    throw new HooksLaunchReviewError("OPS_LAUNCH_CONFIG_NOT_APPROVED");
  }
  const editor = approved.edited_by_operator_id ?? approved.owner_user_id;
  if (editor === actor || approved.owner_user_id === actor) {
    throw new HooksLaunchReviewError("OPS_SELF_ACCEPTANCE");
  }
  const inserted = await client.query(
    `insert into public.hooks_testnet_acceptances (
       acceptance_id, project_id, config_version, chain_id, config_hash,
       contract_manifest_hash, checklist_version, outcome, evidence, actor_id, reason
     ) values ($1, $2, $3, 97, $4, $5, $6, $7, $8::jsonb, $9, $10)
     returning acceptance_id, project_id, config_version, chain_id, config_hash,
       contract_manifest_hash, checklist_version, outcome, evidence, actor_id,
       reason, created_at`,
    [
      command.operationId,
      projectId,
      record.configVersion,
      record.configHash.toLowerCase(),
      record.contractManifestHash.toLowerCase(),
      record.checklistVersion,
      record.outcome,
      JSON.stringify(record.evidence),
      actor,
      command.reason,
    ],
  );
  return inserted.rows[0];
}

export function createPostgresHooksLaunchReviewRepository(
  pool: Pool,
  options: { readonly now?: () => number } = {},
): HooksLaunchReviewRepository {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  return Object.freeze({
    async session(actor: string) {
      return readOnly(pool, async (client) => {
        const operator = await client.query<{ label: string }>(
          "select label from public.ops_operators where user_id = $1 and enabled",
          [actor],
        );
        const row = operator.rows[0];
        if (!row) throw new HooksLaunchReviewError("OPS_FORBIDDEN");
        const grants = await client.query<{
          permission: string;
          scope: string;
        }>(
          "select permission, scope from public.ops_grants where user_id = $1 order by permission, scope",
          [actor],
        );
        return {
          operatorId: actor,
          label: row.label,
          grants: grants.rows.map((grant) => ({
            permission: grant.permission,
            scope: grant.scope,
          })),
        };
      });
    },
    async listProjects(actor: string, before?: string) {
      return readOnly(pool, async (client) => {
        const scopes = await grantedScopes(client, actor, "launch.read");
        const result = await client.query<Record<string, unknown>>(
          `select p.project_id, p.owner_user_id, p.name, p.ticker, p.review_status,
             p.record_version, p.updated_at,
             c.config_version, c.template_version, c.config_hash, c.config,
             c.edited_by_operator_id, c.created_at as config_updated_at,
             a.approver_id as config_approver_id,
             a.approved_at as config_approved_at,
             d.job_id as deployment_job_id, d.status as deployment_status,
             d.meme_address as predicted_meme_address,
             d.hook_address as predicted_hook_address
           from public.launch_projects p
           left join lateral (
             select config_version, template_version, config_hash, config,
               edited_by_operator_id, created_at
             from public.hooks_launch_project_config_versions
             where project_id = p.project_id
             order by config_version desc limit 1
           ) c on true
           left join lateral (
             select approver_id, approved_at
             from public.hooks_launch_config_approvals
             where project_id = p.project_id and config_version = c.config_version
             limit 1
           ) a on true
           left join lateral (
             select job_id, status, meme_address, hook_address
             from public.hooks_launch_deployment_tasks
             where project_id = p.project_id and config_version = c.config_version
             order by created_at desc, job_id desc limit 1
           ) d on true
           where ($1 or p.project_id::text = any($2::text[]))
             and ($3::uuid is null or p.project_id < $3::uuid)
           order by p.project_id desc limit 51`,
          [scopes.includes("*"), scopes, before ?? null],
        );
        return page(result.rows, "project_id");
      });
    },
    async listTestnetAcceptances(actor: string, before?: string) {
      return readOnly(pool, async (client) => {
        const scopes = await grantedScopes(client, actor, "testnet.read");
        const result = await client.query<Record<string, unknown>>(
          `select acceptance_id, project_id, config_version, chain_id, config_hash,
             contract_manifest_hash, checklist_version, outcome, evidence,
             actor_id, reason, created_at
           from public.hooks_testnet_acceptances
           where ($1 or project_id::text = any($2::text[]))
             and ($3::uuid is null or acceptance_id < $3::uuid)
           order by acceptance_id desc limit 51`,
          [scopes.includes("*"), scopes, before ?? null],
        );
        return page(result.rows, "acceptance_id");
      });
    },
    async execute(actor: string, command: HooksLaunchReviewCommand) {
      const hash = hooksLaunchCommandHash(command);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '3s'");
        await authorize(
          client,
          actor,
          hooksLaunchCommandPermission(command.action),
          command.target,
        );
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`ops:${command.operationId}`],
        );
        const existing = (
          await client.query<{
            actor_id: string;
            request_hash: string;
            result: unknown;
          }>(
            "select actor_id, request_hash, result from public.ops_operations where operation_id = $1",
            [command.operationId],
          )
        ).rows[0];
        if (existing) {
          if (existing.actor_id !== actor || existing.request_hash !== hash) {
            throw new HooksLaunchReviewError("OPS_IDEMPOTENCY_CONFLICT");
          }
          await client.query("commit");
          return {
            operationId: command.operationId,
            result: existing.result,
            replayed: true,
          };
        }
        let result: unknown;
        if (command.action === "launch.config.save") {
          result = await saveConfig(client, actor, command, now());
        } else if (command.action === "launch.config.approve") {
          result = await approveConfig(client, actor, command);
        } else {
          result = await recordAcceptance(client, actor, command);
        }
        await client.query(
          "insert into public.ops_operations (operation_id, actor_id, action, target, request_hash, result) values ($1, $2, $3, $4, $5, $6::jsonb)",
          [
            command.operationId,
            actor,
            command.action,
            command.target,
            hash,
            JSON.stringify(result),
          ],
        );
        await client.query(
          "insert into public.ops_audit (operation_id, actor_id, action, target, reason, outcome) values ($1, $2, $3, $4, $5, 'succeeded')",
          [
            command.operationId,
            actor,
            command.action,
            command.target,
            command.reason,
          ],
        );
        await client.query("commit");
        return { operationId: command.operationId, result, replayed: false };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const code =
          error instanceof HooksLaunchReviewError
            ? error.code
            : "OPS_COMMAND_FAILED";
        // No request payload, token, or provider response enters failure
        // audit. An actor that is not a LOOP user fails the FK and is
        // dropped: the audit never invents an identity.
        await client
          .query(
            "insert into public.ops_audit (operation_id, actor_id, action, target, reason, outcome, code) values ($1, $2, $3, $4, $5, $6, $7)",
            [
              command.operationId,
              actor,
              command.action,
              command.target,
              command.reason,
              error instanceof HooksLaunchReviewError ? "rejected" : "unknown",
              code,
            ],
          )
          .catch(() => undefined);
        if (error instanceof HooksLaunchReviewError) throw error;
        throw new HooksLaunchReviewError("OPS_COMMAND_FAILED");
      } finally {
        client.release();
      }
    },
  } satisfies HooksLaunchReviewRepository);
}
