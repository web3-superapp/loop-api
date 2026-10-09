import type { Pool } from "pg";
import { z } from "zod";

import {
  adminLaunchStages,
  type AdminLaunchConfigVersion,
  type AdminLaunchDeploymentTask,
  type AdminLaunchProjectSummary,
  type AdminLaunchReviewRepository,
  type AdminLaunchScope,
  type AdminLaunchTestnetAcceptance,
} from "../features/admin/admin-launch-review.js";
import { AdminRepositoryUnavailableError } from "../features/admin/admin-repository.js";

/**
 * Decision 0109: read projection of the Hooks launch review for the
 * console. Stage, in order of precedence, of the latest config version:
 * `deploying` (an `awaiting_executor` task) > `accepted` (a `passed` BSC
 * Testnet acceptance) > `approved` > `awaiting_approval`; `draft` when no
 * config version exists yet. Signed payloads are never selected.
 */

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const date = z.date().refine((value) => !Number.isNaN(value.getTime()));
const outcome = z.enum(["passed", "failed", "incomplete"]);

const summaryRowSchema = z
  .object({
    project_id: uuid,
    name: z.string(),
    ticker: z.string(),
    owner_user_id: uuid,
    review_status: z.string(),
    created_at: date,
    updated_at: date,
    cursor_key: z.string(),
    config_version: z.number().int().nullable(),
    config_hash: z.string().nullable(),
    config_owner_user_id: uuid.nullable(),
    edited_by_operator_id: uuid.nullable(),
    approver_id: uuid.nullable(),
    approved_at: date.nullable(),
    acceptance_outcome: outcome.nullable(),
    active_job_id: uuid.nullable(),
    stage: z.enum(adminLaunchStages),
  })
  .strict();

function mapSummary(raw: unknown): AdminLaunchProjectSummary {
  const row = summaryRowSchema.parse(raw);
  return Object.freeze({
    projectId: row.project_id,
    name: row.name,
    ticker: row.ticker,
    ownerUserId: row.owner_user_id,
    launchReviewStatus: row.review_status,
    stage: row.stage,
    latestConfigVersion: row.config_version,
    latestConfigHash: row.config_hash,
    latestEditedBy:
      row.config_version === null
        ? null
        : row.edited_by_operator_id !== null
          ? { kind: "operator" as const, userId: row.edited_by_operator_id }
          : {
              kind: "owner" as const,
              userId: row.config_owner_user_id ?? row.owner_user_id,
            },
    latestApproval:
      row.approver_id === null || row.approved_at === null
        ? null
        : {
            approverUserId: row.approver_id,
            approvedAt: row.approved_at.toISOString(),
          },
    latestAcceptanceOutcome: row.acceptance_outcome,
    activeDeploymentJobId: row.active_job_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    cursorKey: row.cursor_key,
  });
}

/** `$1` = all projects, `$2` = scoped project IDs. */
const summarySql = `
  select p.project_id, p.name, p.ticker, p.owner_user_id, p.review_status,
    p.created_at, p.updated_at,
    to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_key,
    c.config_version, c.config_hash, c.owner_user_id as config_owner_user_id,
    c.edited_by_operator_id,
    a.approver_id, a.approved_at,
    acc.outcome as acceptance_outcome,
    d.job_id as active_job_id,
    case
      when c.config_version is null then 'draft'
      when d.job_id is not null then 'deploying'
      when a.approver_id is null then 'awaiting_approval'
      when acc.has_passed then 'accepted'
      else 'approved'
    end as stage
  from public.launch_projects p
  left join lateral (
    select config_version, config_hash, owner_user_id, edited_by_operator_id
    from public.hooks_launch_project_config_versions
    where project_id = p.project_id
    order by config_version desc limit 1
  ) c on true
  left join lateral (
    select approver_id, approved_at
    from public.hooks_launch_config_approvals
    where project_id = p.project_id and config_version = c.config_version
  ) a on true
  left join lateral (
    select
      (array_agg(outcome order by created_at desc, acceptance_id desc))[1] as outcome,
      coalesce(bool_or(outcome = 'passed'), false) as has_passed
    from public.hooks_testnet_acceptances
    where project_id = p.project_id and config_version = c.config_version
  ) acc on true
  left join lateral (
    select job_id
    from public.hooks_launch_deployment_tasks
    where project_id = p.project_id and config_version = c.config_version
      and status = 'awaiting_executor'
    limit 1
  ) d on true
  where ($1::boolean or p.project_id::text = any($2::text[]))
`;

const versionRowSchema = z
  .object({
    config_version: z.number().int().positive(),
    template_version: z.string(),
    config_hash: z.string(),
    config: z.record(z.string(), z.unknown()),
    owner_user_id: uuid,
    edited_by_operator_id: uuid.nullable(),
    created_at: date,
    approver_id: uuid.nullable(),
    approval_hash: z.string().nullable(),
    approval_reason: z.string().nullable(),
    approved_at: date.nullable(),
  })
  .strict();

const configKeys = [
  "name",
  "ticker",
  "logoAssetUrl",
  "description",
  "links",
  "nftSaleStartAt",
  "buybackRecipient",
  "templateHash",
  "fixedEconomics",
] as const;

function mapVersion(raw: unknown): AdminLaunchConfigVersion {
  const row = versionRowSchema.parse(raw);
  const config: Record<string, unknown> = {};
  for (const key of configKeys) {
    config[key] = row.config[key] ?? null;
  }
  return Object.freeze({
    version: row.config_version,
    templateVersion: row.template_version,
    configHash: row.config_hash,
    config: Object.freeze(config),
    editedBy:
      row.edited_by_operator_id === null
        ? { kind: "owner" as const, userId: row.owner_user_id }
        : { kind: "operator" as const, userId: row.edited_by_operator_id },
    createdAt: row.created_at.toISOString(),
    approval:
      row.approver_id === null ||
      row.approval_hash === null ||
      row.approval_reason === null ||
      row.approved_at === null
        ? null
        : Object.freeze({
            approverUserId: row.approver_id,
            configHash: row.approval_hash,
            reason: row.approval_reason,
            approvedAt: row.approved_at.toISOString(),
          }),
  });
}

const acceptanceRowSchema = z
  .object({
    acceptance_id: uuid,
    config_version: z.number().int().positive(),
    chain_id: z.number().int(),
    config_hash: z.string(),
    contract_manifest_hash: z.string(),
    checklist_version: z.string(),
    outcome,
    evidence: z.array(z.object({ label: z.string(), uri: z.string() }).strip()),
    actor_id: uuid,
    reason: z.string(),
    created_at: date,
  })
  .strict();

function mapAcceptance(raw: unknown): AdminLaunchTestnetAcceptance {
  const row = acceptanceRowSchema.parse(raw);
  return Object.freeze({
    acceptanceId: row.acceptance_id,
    configVersion: row.config_version,
    chainId: row.chain_id,
    configHash: row.config_hash,
    contractManifestHash: row.contract_manifest_hash,
    checklistVersion: row.checklist_version,
    outcome: row.outcome,
    evidence: Object.freeze(row.evidence),
    acceptorUserId: row.actor_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  });
}

const taskRowSchema = z
  .object({
    job_id: uuid,
    config_version: z.number().int().positive(),
    status: z.enum(["awaiting_executor", "cancelled"]),
    chain_id: z.number().int(),
    factory_address: z.string(),
    project_owner: z.string(),
    owner_nonce: z.string(),
    binding_hash: z.string(),
    meme_address: z.string(),
    hook_address: z.string(),
    authorization_count: z.number().int().nonnegative(),
    latest_authorization_at: date.nullable(),
    created_at: date,
  })
  .strict();

function mapTask(raw: unknown): AdminLaunchDeploymentTask {
  const row = taskRowSchema.parse(raw);
  return Object.freeze({
    jobId: row.job_id,
    configVersion: row.config_version,
    status: row.status,
    chainId: row.chain_id,
    factoryAddress: row.factory_address,
    projectOwner: row.project_owner,
    ownerNonce: row.owner_nonce,
    bindingHash: row.binding_hash,
    predictedMemeAddress: row.meme_address,
    predictedHookAddress: row.hook_address,
    authorizationCount: row.authorization_count,
    latestAuthorizationAt: row.latest_authorization_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

function scopeParameters(scope: AdminLaunchScope): [boolean, string[]] {
  return scope === "*" ? [true, []] : [false, [...scope]];
}

export const adminLaunchDetailMaximumRows = 200;

export function createPostgresAdminLaunchReviewRepository(
  pool: Pool,
): AdminLaunchReviewRepository {
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new AdminRepositoryUnavailableError({ cause: error });
    }
  }

  return Object.freeze({
    async launchReadScopes(operatorUserId) {
      return guarded(async () => {
        const result = await pool.query<{ scope: string }>(
          `select g.scope from public.ops_grants g
           join public.ops_operators o on o.user_id = g.user_id and o.enabled
           where g.user_id = $1 and g.permission = 'launch.read'
           order by g.scope`,
          [operatorUserId],
        );
        return Object.freeze(result.rows.map((row) => row.scope));
      });
    },

    async listProjects(input) {
      return guarded(async () => {
        const [all, scoped] = scopeParameters(input.scope);
        const result = await pool.query(
          `with base as (${summarySql})
           select * from base
           where ($3::text is null or stage = $3)
             and ($4::timestamptz is null
               or created_at < $4::timestamptz
               or (created_at = $4::timestamptz and project_id < $5::uuid))
           order by created_at desc, project_id desc
           limit $6`,
          [
            all,
            scoped,
            input.stage,
            input.after?.cursorKey ?? null,
            input.after?.projectId ?? null,
            input.limit,
          ],
        );
        return Object.freeze(result.rows.map(mapSummary));
      });
    },

    async getProject(input) {
      return guarded(async () => {
        const [all, scoped] = scopeParameters(input.scope);
        const summary = await pool.query(
          `with base as (${summarySql}) select * from base where project_id = $3`,
          [all, scoped, input.projectId],
        );
        if (summary.rows[0] === undefined) {
          return null;
        }
        const [versions, acceptances, tasks] = await Promise.all([
          pool.query(
            `select c.config_version, c.template_version, c.config_hash, c.config,
               c.owner_user_id, c.edited_by_operator_id, c.created_at,
               a.approver_id, a.config_hash as approval_hash,
               a.reason as approval_reason, a.approved_at
             from public.hooks_launch_project_config_versions c
             left join public.hooks_launch_config_approvals a
               using (project_id, config_version)
             where c.project_id = $1
             order by c.config_version desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
          pool.query(
            `select acceptance_id, config_version, chain_id, config_hash,
               contract_manifest_hash, checklist_version, outcome, evidence,
               actor_id, reason, created_at
             from public.hooks_testnet_acceptances
             where project_id = $1
             order by created_at desc, acceptance_id desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
          pool.query(
            `select t.job_id, t.config_version, t.status, t.chain_id,
               t.factory_address, t.project_owner, t.owner_nonce,
               t.binding_hash, t.meme_address, t.hook_address,
               (select count(*)::integer from public.hooks_launch_deployment_authorizations z
                 where z.job_id = t.job_id) as authorization_count,
               (select max(z.created_at) from public.hooks_launch_deployment_authorizations z
                 where z.job_id = t.job_id) as latest_authorization_at,
               t.created_at
             from public.hooks_launch_deployment_tasks t
             where t.project_id = $1
             order by t.created_at desc, t.job_id desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
        ]);
        return Object.freeze({
          project: mapSummary(summary.rows[0]),
          versions: Object.freeze(versions.rows.map(mapVersion)),
          testnetAcceptances: Object.freeze(
            acceptances.rows.map(mapAcceptance),
          ),
          deploymentTasks: Object.freeze(tasks.rows.map(mapTask)),
        });
      });
    },
  } satisfies AdminLaunchReviewRepository);
}
