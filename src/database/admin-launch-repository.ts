import type { Pool } from "pg";
import { z } from "zod";

import {
  AdminLaunchSnapshotRetryError,
  adminLaunchSnapshotRetryReasonCodes,
  adminLaunchStages,
  type AdminLaunchSnapshotClosure,
  type AdminLaunchSnapshotRelease,
  type AdminLaunchConfigVersion,
  type AdminLaunchDeploymentTask,
  type AdminLaunchSnapshotPublication,
  type AdminLaunchBuybackAttempt,
  type AdminLaunchProjectSummary,
  type AdminLaunchReviewRepository,
  type AdminLaunchScope,
  type AdminLaunchTestnetAcceptance,
} from "../features/admin/admin-launch-review.js";
import { AdminRepositoryUnavailableError } from "../features/admin/admin-repository.js";
import { hooksLaunchDeploymentStatuses } from "../features/launch/hooks-launch-deployment-status.js";

/**
 * Decision 0109: read projection of the Hooks launch review for the
 * console. Stage, in order of precedence, of the latest config version:
 * `activated` (Decision 0112: an activated task) > `deploying` (a task the
 * executor still owns: awaiting_executor … verified, reorged, retryable
 * failed) > `accepted` (a `passed` BSC
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
    kind: z.enum(["ido", "launch2"]),
    material_version: z.number().int().positive(),
    rejection_reason_code: z.string().nullable(),
    rejection_note: z.string().nullable(),
    rejection_reviewer_id: uuid.nullable(),
    rejection_material_version: z.number().int().nullable(),
    rejected_at: date.nullable(),
    material_approver_id: uuid.nullable(),
    material_approved_version: z.number().int().nullable(),
    material_approved_at: date.nullable(),
    community_id: uuid.nullable(),
    community_name: z.string().nullable(),
    community_verification_status: z
      .enum(["pending", "verified", "rejected"])
      .nullable(),
    community_bound_asset_key: z.string().nullable(),
    community_binding: z.string().nullable(),
    created_at: date,
    updated_at: date,
    cursor_key: z.string(),
    config_version: z.number().int().nullable(),
    config_hash: z.string().nullable(),
    config_owner_user_id: uuid.nullable(),
    edited_by_operator_id: uuid.nullable(),
    approver_id: uuid.nullable(),
    approved_at: date.nullable(),
    config_reviewer_id: uuid.nullable(),
    config_rejected_at: date.nullable(),
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
    kind: row.kind,
    launchReviewStatus: row.review_status,
    materialVersion: row.material_version,
    rejection:
      row.review_status !== "rejected" ||
      row.rejection_reason_code === null ||
      row.rejection_reviewer_id === null ||
      row.rejected_at === null ||
      row.rejection_material_version === null
        ? null
        : Object.freeze({
            reasonCode: row.rejection_reason_code,
            note: row.rejection_note,
            reviewerUserId: row.rejection_reviewer_id,
            materialVersion: row.rejection_material_version,
            rejectedAt: row.rejected_at.toISOString(),
          }),
    materialApproval:
      row.material_approver_id === null ||
      row.material_approved_version === null ||
      row.material_approved_at === null
        ? null
        : Object.freeze({
            approverUserId: row.material_approver_id,
            materialVersion: row.material_approved_version,
            approvedAt: row.material_approved_at.toISOString(),
          }),
    communityId: row.community_id,
    community:
      row.community_id === null ||
      row.community_name === null ||
      row.community_verification_status === null
        ? null
        : Object.freeze({
            communityId: row.community_id,
            name: row.community_name,
            verificationStatus: row.community_verification_status,
            boundAssetKey: row.community_bound_asset_key,
            binding: row.community_binding,
          }),
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
    latestRejection:
      row.config_reviewer_id === null || row.config_rejected_at === null
        ? null
        : {
            reviewerUserId: row.config_reviewer_id,
            rejectedAt: row.config_rejected_at.toISOString(),
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
    p.kind, p.material_version,
    rj.reason_code as rejection_reason_code, rj.note as rejection_note,
    rj.reviewer_user_id as rejection_reviewer_id,
    rj.material_version as rejection_material_version,
    rj.created_at as rejected_at,
    ma.reviewer_user_id as material_approver_id,
    ma.material_version as material_approved_version,
    ma.created_at as material_approved_at,
    p.community_id, co.name as community_name,
    co.verification_status as community_verification_status,
    co.bound_asset_key as community_bound_asset_key,
    (select i.community_binding from public.launch2_instances i
      where i.project_id = p.project_id
      order by i.registered_at desc, i.instance_id desc limit 1)
      as community_binding,
    p.created_at, p.updated_at,
    to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_key,
    c.config_version, c.config_hash, c.owner_user_id as config_owner_user_id,
    c.edited_by_operator_id,
    a.approver_id, a.approved_at,
    r.reviewer_id as config_reviewer_id, r.rejected_at as config_rejected_at,
    acc.outcome as acceptance_outcome,
    case when d.status = 'activated' then null else d.job_id end as active_job_id,
    case
      when c.config_version is null then 'draft'
      when d.status = 'activated' then 'activated'
      when d.job_id is not null then 'deploying'
      when a.approver_id is null and r.reviewer_id is not null then 'rejected'
      when a.approver_id is null then 'awaiting_approval'
      when acc.has_passed then 'accepted'
      else 'approved'
    end as stage
  from public.launch_projects p
  left join public.communities co on co.community_id = p.community_id
  left join lateral (
    select reviewer_user_id, material_version, created_at
    from public.launch_project_approvals
    where project_id = p.project_id
    order by created_at desc, approval_id desc limit 1
  ) ma on true
  left join lateral (
    select reason_code, note, reviewer_user_id, material_version, created_at
    from public.launch_project_rejections
    where project_id = p.project_id
    order by created_at desc, rejection_id desc limit 1
  ) rj on true
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
    select reviewer_id, rejected_at
    from public.hooks_launch_config_rejections
    where project_id = p.project_id and config_version = c.config_version
  ) r on true
  left join lateral (
    select
      (array_agg(outcome order by created_at desc, acceptance_id desc))[1] as outcome,
      coalesce(bool_or(outcome = 'passed'), false) as has_passed
    from public.hooks_testnet_acceptances
    where project_id = p.project_id and config_version = c.config_version
  ) acc on true
  left join lateral (
    select job_id, status
    from public.hooks_launch_deployment_tasks
    where project_id = p.project_id and config_version = c.config_version
      and (status in ('awaiting_executor','claimed','broadcast','confirmed',
        'verified','reorged','activated')
        or (status = 'failed' and failure_retryable))
    order by created_at desc
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
    rejection_reviewer_id: uuid.nullable(),
    rejection_hash: z.string().nullable(),
    rejection_reason_code: z.string().nullable(),
    rejection_note: z.string().nullable(),
    rejected_at: date.nullable(),
  })
  .strict();

const configKeys = [
  "name",
  "ticker",
  "logoAssetUrl",
  // Decision 0173: null when the version has no project NFT picture.
  "nftImageAssetUrl",
  "nftImageCid",
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
    rejection:
      row.rejection_reviewer_id === null ||
      row.rejection_hash === null ||
      row.rejection_reason_code === null ||
      row.rejected_at === null
        ? null
        : Object.freeze({
            reviewerUserId: row.rejection_reviewer_id,
            configHash: row.rejection_hash,
            reasonCode: row.rejection_reason_code,
            note: row.rejection_note,
            rejectedAt: row.rejected_at.toISOString(),
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

const nullableHash = z.string().nullable();
const eventRowSchema = z
  .object({
    sequence: z.union([z.number(), z.string()]),
    fromStatus: z.enum(hooksLaunchDeploymentStatuses).nullable(),
    toStatus: z.enum(hooksLaunchDeploymentStatuses),
    kind: z.string(),
    txHash: nullableHash,
    blockNumber: z.union([z.string(), z.number()]).nullable(),
    blockHash: nullableHash,
    confirmations: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
    actor: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

const taskRowSchema = z
  .object({
    job_id: uuid,
    config_version: z.number().int().positive(),
    status: z.enum(hooksLaunchDeploymentStatuses),
    chain_id: z.number().int(),
    factory_address: z.string(),
    project_owner: z.string(),
    owner_nonce: z.string(),
    binding_hash: z.string(),
    meme_address: z.string(),
    hook_address: z.string(),
    authorization_count: z.number().int().nonnegative(),
    latest_authorization_at: date.nullable(),
    executor_address: z.string().nullable(),
    claimed_by: z.string().nullable(),
    attempt_count: z.number().int().nonnegative(),
    tx_hash: nullableHash,
    tx_nonce: z.string().nullable(),
    block_number: z.string().nullable(),
    block_hash: nullableHash,
    confirmations: z.number().int().nullable(),
    launch_id: nullableHash,
    deployed_addresses: z.record(z.string(), z.string()).nullable(),
    verification: z.record(z.string(), z.unknown()).nullable(),
    activation_tx_hash: nullableHash,
    activation_block_number: z.string().nullable(),
    activated_at: date.nullable(),
    failure_code: z.string().nullable(),
    failure_retryable: z.boolean().nullable(),
    events: z.array(eventRowSchema),
    created_at: date,
    updated_at: date,
  })
  .strict();

function mapTask(raw: unknown): AdminLaunchDeploymentTask {
  const row = taskRowSchema.parse(raw);
  const checks = row.verification?.["checks"];
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
    executorAddress: row.executor_address,
    claimedBy: row.claimed_by,
    attemptCount: row.attempt_count,
    txHash: row.tx_hash,
    txNonce: row.tx_nonce,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    confirmations: row.confirmations,
    launchId: row.launch_id,
    deployedAddresses:
      row.deployed_addresses === null
        ? null
        : Object.freeze({ ...row.deployed_addresses }),
    verifiedChecks: Object.freeze(
      Array.isArray(checks)
        ? checks.filter((value): value is string => typeof value === "string")
        : [],
    ),
    activationTxHash: row.activation_tx_hash,
    activationBlockNumber: row.activation_block_number,
    activatedAt: row.activated_at?.toISOString() ?? null,
    failure:
      row.failure_code === null
        ? null
        : Object.freeze({
            code: row.failure_code,
            retryable: row.failure_retryable === true,
          }),
    events: Object.freeze(
      row.events.map((event) =>
        Object.freeze({
          sequence: Number(event.sequence),
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          kind: event.kind,
          txHash: event.txHash,
          blockNumber:
            event.blockNumber === null ? null : String(event.blockNumber),
          blockHash: event.blockHash,
          confirmations: event.confirmations,
          errorCode: event.errorCode,
          details: Object.freeze({ ...event.details }),
          actor: event.actor,
          createdAt: new Date(event.createdAt).toISOString(),
        }),
      ),
    ),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function scopeParameters(scope: AdminLaunchScope): [boolean, string[]] {
  return scope === "*" ? [true, []] : [false, [...scope]];
}

export const adminLaunchDetailMaximumRows = 200;
/** Decision 0121: the console shows the newest 20 keeper attempts. */
export const adminLaunchBuybackAttemptRows = 20;

function mapBuybackAttempt(
  row: Record<string, unknown>,
): AdminLaunchBuybackAttempt {
  const at = (value: unknown): string | null =>
    value === null || value === undefined
      ? null
      : new Date(value as Date | string).toISOString();
  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const reasonCode = text(row["reason_code"]);
  return Object.freeze({
    attemptId: String(row["attempt_id"]),
    instanceId: String(row["instance_id"]),
    jobId: String(row["job_id"]),
    attempt: Number(row["attempt"]),
    status: row["status"] as AdminLaunchBuybackAttempt["status"],
    simulation: row["simulation"] as AdminLaunchBuybackAttempt["simulation"],
    keeperAddress: String(row["keeper_address"]),
    executorAddress: String(row["executor_address"]),
    orderUsd1Wei: text(row["order_usd1"]),
    simulatedGas: text(row["simulated_gas"]),
    reason:
      reasonCode === null
        ? null
        : Object.freeze({
            code: reasonCode,
            detail: text(row["reason_detail"]),
          }),
    rejectionCount:
      row["rejection_count"] === null ? null : Number(row["rejection_count"]),
    lastRejectedAt: at(row["last_rejected_at"]),
    nextEligibleAt: at(row["next_eligible_at"]),
    txHash: text(row["tx_hash"]),
    txNonce: text(row["tx_nonce"]),
    blockNumber: text(row["block_number"]),
    confirmations:
      row["confirmations"] === null ? null : Number(row["confirmations"]),
    buybackId: text(row["buyback_id"]),
    createdAt: at(row["created_at"])!,
    updatedAt: at(row["updated_at"])!,
  });
}

function mapPublication(
  row: Record<string, unknown>,
): AdminLaunchSnapshotPublication {
  const at = (value: unknown): string =>
    new Date(value as Date | string).toISOString();
  const failureCode =
    typeof row["failure_code"] === "string" ? row["failure_code"] : null;
  const verification = row["verification"];
  return Object.freeze({
    publicationId: String(row["publication_id"]),
    instanceId: String(row["instance_id"]),
    jobId: String(row["job_id"]),
    action:
      row["action"] === "open_without_holders"
        ? "open_without_holders"
        : "publish_snapshot",
    attempt: Number(row["attempt"]),
    status: row["status"] as AdminLaunchSnapshotPublication["status"],
    cutoffBlock: String(row["cutoff_block"]),
    cutoffBlockHash: String(row["cutoff_block_hash"]),
    memberCount: Number(row["member_count"]),
    root: String(row["root"]),
    dataHash: String(row["data_hash"]),
    signerAddresses: Array.isArray(row["signer_addresses"])
      ? Object.freeze((row["signer_addresses"] as unknown[]).map(String))
      : Object.freeze([]),
    submitterAddress: String(row["submitter_address"]),
    txHash: typeof row["tx_hash"] === "string" ? row["tx_hash"] : null,
    blockNumber:
      typeof row["block_number"] === "string" ? row["block_number"] : null,
    confirmations:
      row["confirmations"] === null ? null : Number(row["confirmations"]),
    failure:
      failureCode === null
        ? null
        : Object.freeze({
            code: failureCode,
            detail:
              typeof row["failure_detail"] === "string"
                ? row["failure_detail"]
                : null,
            retryable:
              typeof row["failure_retryable"] === "boolean"
                ? row["failure_retryable"]
                : null,
          }),
    verification:
      verification === "verified" || verification === "mismatch"
        ? verification
        : null,
    createdAt: at(row["created_at"]),
    updatedAt: at(row["updated_at"]),
  });
}

function mapRelease(row: Record<string, unknown>): AdminLaunchSnapshotRelease {
  return Object.freeze({
    releaseId: String(row["release_id"]),
    projectId: String(row["project_id"]),
    instanceId: String(row["instance_id"]),
    publicationId: String(row["released_publication_id"]),
    releasedAttempt: Number(row["released_attempt"]),
    releasedStatus: row["released_status"] as "failed" | "mismatch",
    releasedFailureCode: String(row["released_failure_code"]),
    actor: String(row["actor"]),
    reason: String(row["reason"]),
    createdAt: new Date(row["created_at"] as Date | string).toISOString(),
  });
}

function mapClosure(row: Record<string, unknown>): AdminLaunchSnapshotClosure {
  return Object.freeze({
    instanceId: String(row["instance_id"]),
    reason: "no_holders" as const,
    cutoffBlock: String(row["cutoff_block"]),
    cutoffBlockHash: String(row["cutoff_block_hash"]),
    saleEndAt: new Date(row["sale_end_at"] as Date | string).toISOString(),
    createdAt: new Date(row["created_at"] as Date | string).toISOString(),
  });
}

const releaseColumns = `release_id::text, project_id::text, instance_id::text,
  released_publication_id::text, released_attempt, released_status,
  released_failure_code, actor, reason, created_at`;

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
             and ($7::text is null or kind = $7)
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
            input.kind,
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
        const [
          versions,
          acceptances,
          tasks,
          publications,
          attempts,
          releases,
          closures,
          projectRejections,
        ] = await Promise.all([
          pool.query(
            `select c.config_version, c.template_version, c.config_hash, c.config,
               c.owner_user_id, c.edited_by_operator_id, c.created_at,
               a.approver_id, a.config_hash as approval_hash,
               a.reason as approval_reason, a.approved_at,
               r.reviewer_id as rejection_reviewer_id,
               r.config_hash as rejection_hash,
               r.reason_code as rejection_reason_code,
               r.note as rejection_note, r.rejected_at
             from public.hooks_launch_project_config_versions c
             left join public.hooks_launch_config_approvals a
               using (project_id, config_version)
             left join public.hooks_launch_config_rejections r
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
               t.executor_address, t.claimed_by, t.attempt_count, t.tx_hash,
               t.tx_nonce::text as tx_nonce, t.block_number::text as block_number,
               t.block_hash, t.confirmations, t.launch_id, t.deployed_addresses,
               t.verification, t.activation_tx_hash,
               t.activation_block_number::text as activation_block_number,
               t.activated_at, t.failure_code, t.failure_retryable,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'sequence', e.event_id, 'fromStatus', e.from_status,
                   'toStatus', e.to_status, 'kind', e.kind, 'txHash', e.tx_hash,
                   'blockNumber', e.block_number::text, 'blockHash', e.block_hash,
                   'confirmations', e.confirmations, 'errorCode', e.error_code,
                   'details', e.details, 'actor', e.actor,
                   'createdAt', e.created_at) order by e.event_id)
                 from (
                   select * from public.hooks_launch_deployment_events
                   where job_id = t.job_id order by event_id desc limit 100
                 ) e
               ), '[]'::jsonb) as events,
               t.created_at, t.updated_at
             from public.hooks_launch_deployment_tasks t
             where t.project_id = $1
             order by t.created_at desc, t.job_id desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
          pool.query(
            `select p.publication_id::text, p.instance_id::text, i.job_id::text,
               p.action, p.attempt, p.status, p.cutoff_block::text as cutoff_block,
               p.cutoff_block_hash, p.member_count, p.root, p.data_hash,
               p.signer_addresses, p.submitter_address, p.tx_hash,
               p.block_number::text as block_number, p.confirmations,
               p.failure_code, p.failure_detail, p.failure_retryable,
               case when i.snapshot_root = p.root then i.snapshot_verification end
                 as verification,
               p.created_at, p.updated_at
             from public.launch2_snapshot_publications p
             join public.launch2_instances i using (instance_id)
             where i.project_id = $1
             order by p.created_at desc, p.attempt desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
          pool.query(
            `select a.attempt_id::text, a.instance_id::text, i.job_id::text,
               a.attempt, a.status, a.simulation, a.keeper_address,
               a.executor_address, a.order_usd1::text as order_usd1,
               a.simulated_gas::text as simulated_gas, a.reason_code,
               a.reason_detail, a.rejection_count, a.last_rejected_at,
               a.next_eligible_at, a.tx_hash, a.tx_nonce::text as tx_nonce,
               a.block_number::text as block_number, a.confirmations,
               a.buyback_id::text as buyback_id, a.created_at, a.updated_at
             from public.launch2_buyback_attempts a
             join public.launch2_instances i using (instance_id)
             where i.project_id = $1
             order by a.attempt desc, a.created_at desc
             limit $2`,
            [input.projectId, adminLaunchBuybackAttemptRows],
          ),
          pool.query(
            `select ${releaseColumns}
             from public.launch2_snapshot_publication_releases
             where project_id = $1
             order by created_at desc, released_attempt desc
             limit $2`,
            [input.projectId, adminLaunchDetailMaximumRows],
          ),
          pool.query(
            `select c.instance_id::text, c.cutoff_block::text as cutoff_block,
               c.cutoff_block_hash, c.sale_end_at, c.created_at
             from public.launch2_snapshot_closures c
             join public.launch2_instances i using (instance_id)
             where i.project_id = $1
             order by i.registered_at desc, i.instance_id desc
             limit 1`,
            [input.projectId],
          ),
          // Decision 0122: every catalog rejection, newest first.
          pool.query(
            `select rejection_id::text, material_version, reason_code, note,
               reviewer_user_id::text, created_at
             from public.launch_project_rejections
             where project_id = $1
             order by created_at desc, rejection_id desc
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
          snapshotPublications: Object.freeze(
            publications.rows.map(mapPublication),
          ),
          buybackAttempts: Object.freeze(attempts.rows.map(mapBuybackAttempt)),
          snapshotReleases: Object.freeze(releases.rows.map(mapRelease)),
          snapshotClosure:
            closures.rows[0] === undefined
              ? null
              : mapClosure(closures.rows[0] as Record<string, unknown>),
          projectRejections: Object.freeze(
            projectRejections.rows.map((row: Record<string, unknown>) =>
              Object.freeze({
                rejectionId: String(row["rejection_id"]),
                materialVersion: Number(row["material_version"]),
                reasonCode: String(row["reason_code"]),
                note: typeof row["note"] === "string" ? row["note"] : null,
                reviewerUserId: String(row["reviewer_user_id"]),
                rejectedAt: new Date(
                  row["created_at"] as Date | string,
                ).toISOString(),
              }),
            ),
          ),
        });
      });
    },

    async releaseSnapshotPublication(input) {
      const codes = adminLaunchSnapshotRetryReasonCodes;
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw new AdminRepositoryUnavailableError({ cause: error });
      }
      try {
        await client.query("begin");
        const replay = await client.query(
          `select ${releaseColumns} from public.launch2_snapshot_publication_releases
           where release_id = $1`,
          [input.releaseId],
        );
        if (replay.rows[0] !== undefined) {
          const existing = mapRelease(
            replay.rows[0] as Record<string, unknown>,
          );
          await client.query("rollback");
          if (
            existing.projectId !== input.projectId ||
            existing.reason !== input.reason ||
            existing.actor !== input.actor
          ) {
            throw new AdminLaunchSnapshotRetryError(
              "idempotency",
              codes.idempotencyConflict,
            );
          }
          return Object.freeze({ release: existing, replayed: true });
        }
        const project = await client.query(
          "select 1 from public.launch_projects where project_id = $1",
          [input.projectId],
        );
        if (project.rowCount !== 1) {
          throw new AdminLaunchSnapshotRetryError(
            "not_found",
            codes.projectNotFound,
          );
        }
        const instance = await client.query<{
          instance_id: string;
          snapshot_root: string | null;
          closed: boolean;
        }>(
          `select i.instance_id::text,
             -- Decision 0122: a zero-holder opening is on chain too.
             coalesce(i.snapshot_root, i.opened_without_holders_tx) as snapshot_root,
             exists (select 1 from public.launch2_snapshot_closures c
               where c.instance_id = i.instance_id) as closed
           from public.launch2_instances i
           where i.project_id = $1
           order by i.registered_at desc, i.instance_id desc
           limit 1
           for update of i`,
          [input.projectId],
        );
        const target = instance.rows[0];
        if (target === undefined) {
          throw new AdminLaunchSnapshotRetryError(
            "not_found",
            codes.instanceNotFound,
          );
        }
        if (target.closed) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.closedNoHolders,
          );
        }
        if (target.snapshot_root !== null) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.alreadyOnChain,
          );
        }
        const latest = await client.query<{
          publication_id: string;
          attempt: number;
          status: string;
          failure_code: string | null;
        }>(
          `select publication_id::text, attempt, status, failure_code
           from public.launch2_snapshot_publications
           where instance_id = $1
           order by attempt desc
           limit 1
           for update`,
          [target.instance_id],
        );
        const publication = latest.rows[0];
        if (publication === undefined) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.nothingToRetry,
          );
        }
        if (
          (publication.status !== "failed" &&
            publication.status !== "mismatch") ||
          publication.failure_code === null
        ) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.notRetryable,
            { status: publication.status },
          );
        }
        const released = await client.query(
          `select 1 from public.launch2_snapshot_publication_releases
           where instance_id = $1 and released_attempt >= $2`,
          [target.instance_id, publication.attempt],
        );
        if ((released.rowCount ?? 0) > 0) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.alreadyReleased,
          );
        }
        const inserted = await client.query(
          `insert into public.launch2_snapshot_publication_releases (
             release_id, instance_id, project_id, released_publication_id,
             released_attempt, released_status, released_failure_code,
             actor, actor_account_id, reason, request_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           returning ${releaseColumns}`,
          [
            input.releaseId,
            target.instance_id,
            input.projectId,
            publication.publication_id,
            publication.attempt,
            publication.status,
            publication.failure_code,
            input.actor,
            input.actorAccountId,
            input.reason,
            input.requestId,
          ],
        );
        await client.query("commit");
        return Object.freeze({
          release: mapRelease(inserted.rows[0] as Record<string, unknown>),
          replayed: false,
        });
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (error instanceof AdminLaunchSnapshotRetryError) throw error;
        // A concurrent grant for the same attempt or key loses the race.
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
          throw new AdminLaunchSnapshotRetryError(
            "conflict",
            codes.alreadyReleased,
          );
        }
        throw new AdminRepositoryUnavailableError({ cause: error });
      } finally {
        client.release();
      }
    },
  } satisfies AdminLaunchReviewRepository);
}
