import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { HooksLaunchDeploymentStatus } from "../features/launch/hooks-launch-deployment-status.js";
import {
  HooksLaunchSubmissionError,
  hooksLaunchBindingHash,
  type AcceptHooksLaunchSubmission,
  type HooksLaunchDeployedAddresses,
  type HooksLaunchDeploymentEventView,
  type HooksLaunchDeploymentJob,
  type HooksLaunchSubmissionRepository,
} from "../features/launch/hooks-launch-submission.js";

interface JobRow {
  job_id: string;
  project_id: string;
  config_version: number;
  factory_address: string;
  status: HooksLaunchDeploymentStatus;
  meme_address: string;
  hook_address: string;
  tx_hash: string | null;
  confirmations: number | null;
  activation_tx_hash: string | null;
  deployed_addresses: HooksLaunchDeployedAddresses | null;
  failure_code: string | null;
  failure_retryable: boolean | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  fingerprint?: string;
  binding_hash?: string;
}

interface EventRow {
  event_id: string;
  from_status: HooksLaunchDeploymentStatus | null;
  to_status: HooksLaunchDeploymentStatus;
  kind: string;
  tx_hash: string | null;
  block_number: string | null;
  block_hash: string | null;
  confirmations: number | null;
  error_code: string | null;
  created_at: Date;
}

/** Decision 0112: most recent events returned with a task (oldest first). */
export const hooksLaunchJobEventLimit = 100;

type Queryable = Pick<Pool, "query"> | PoolClient;

const deployedKeys = [
  "launchId",
  "meme",
  "hook",
  "nft",
  "curve",
  "gate",
  "escrow",
  "snapshots",
  "graduationAdapter",
  "buybackAdapter",
  "priceRecorder",
  "buybackExecutor",
] as const;

function deployed(
  value: HooksLaunchDeployedAddresses | null,
): HooksLaunchDeployedAddresses | null {
  if (value === null) return null;
  const result: Record<string, string> = {};
  for (const key of deployedKeys) {
    const entry = (value as unknown as Record<string, unknown>)[key];
    if (typeof entry !== "string") return null;
    result[key] = entry;
  }
  return result as unknown as HooksLaunchDeployedAddresses;
}

async function loadJob(
  queryable: Queryable,
  row: JobRow,
): Promise<HooksLaunchDeploymentJob> {
  const events = await queryable.query<EventRow>(
    `select * from (
       select event_id, from_status, to_status, kind, tx_hash,
         block_number::text as block_number, block_hash, confirmations,
         error_code, created_at
       from public.hooks_launch_deployment_events
       where job_id = $1 order by event_id desc limit $2
     ) recent order by event_id`,
    [row.job_id, hooksLaunchJobEventLimit],
  );
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    configVersion: row.config_version,
    chainId: 97,
    factoryAddress: row.factory_address,
    status: row.status,
    memeAddress: row.meme_address,
    hookAddress: row.hook_address,
    txHash: row.tx_hash,
    confirmations: row.confirmations,
    activationTxHash: row.activation_tx_hash,
    addresses: {
      predicted: { meme: row.meme_address, hook: row.hook_address },
      deployed: deployed(row.deployed_addresses),
    },
    failure:
      row.failure_code === null
        ? null
        : { code: row.failure_code, retryable: row.failure_retryable === true },
    attemptCount: row.attempt_count,
    events: events.rows.map((event): HooksLaunchDeploymentEventView => ({
      sequence: Number(event.event_id),
      fromStatus: event.from_status,
      toStatus: event.to_status,
      kind: event.kind,
      txHash: event.tx_hash,
      blockNumber: event.block_number,
      blockHash: event.block_hash,
      confirmations: event.confirmations,
      errorCode: event.error_code,
      createdAt: event.created_at.toISOString(),
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createPostgresHooksLaunchSubmissionRepository(
  pool: Pool,
): HooksLaunchSubmissionRepository {
  async function findReplay(owner: string, key: string) {
    const result = await pool.query<JobRow>(
      `select t.*,c.fingerprint from public.hooks_launch_submission_commands c join public.hooks_launch_deployment_tasks t using(job_id) where c.owner_user_id=$1 and c.idempotency_key=$2`,
      [owner, key],
    );
    const row = result.rows[0];
    return row
      ? { fingerprint: row.fingerprint!, job: await loadJob(pool, row) }
      : null;
  }
  return {
    findReplay,
    async getOwned(owner, projectId, jobId) {
      const result = await pool.query<JobRow>(
        `select * from public.hooks_launch_deployment_tasks where owner_user_id=$1 and project_id=$2 and job_id=$3`,
        [owner, projectId, jobId],
      );
      return result.rows[0] ? loadJob(pool, result.rows[0]) : null;
    },
    async cancelOwned(owner, projectId, jobId) {
      // Only the off-chain awaiting state is cancellable (Decision 0112: a
      // claimed task may already be signed or on chain).
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await client.query<JobRow>(
          `select * from public.hooks_launch_deployment_tasks where owner_user_id=$1 and project_id=$2 and job_id=$3 for update`,
          [owner, projectId, jobId],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          await client.query("commit");
          return null;
        }
        if (row.status === "cancelled") {
          await client.query("commit");
          return loadJob(pool, row);
        }
        if (row.status !== "awaiting_executor") {
          throw new HooksLaunchSubmissionError("not_cancellable");
        }
        const updated = await client.query<JobRow>(
          `update public.hooks_launch_deployment_tasks set status='cancelled' where job_id=$1 returning *`,
          [jobId],
        );
        await client.query(
          `insert into public.hooks_launch_deployment_events(job_id,from_status,to_status,kind) values($1,'awaiting_executor','cancelled','cancelled')`,
          [jobId],
        );
        await client.query("commit");
        return loadJob(pool, updated.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async accept(input: AcceptHooksLaunchSubmission) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const owned = await client.query(
          `select project_id from public.launch_projects where project_id=$1 and owner_user_id=$2 for update`,
          [input.projectId, input.ownerUserId],
        );
        if (owned.rowCount !== 1)
          throw new HooksLaunchSubmissionError("not_found");
        const previous = await client.query<JobRow>(
          `select t.*,c.fingerprint from public.hooks_launch_submission_commands c join public.hooks_launch_deployment_tasks t using(job_id) where c.owner_user_id=$1 and c.idempotency_key=$2`,
          [input.ownerUserId, input.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (
            previous.rows[0].fingerprint !== input.fingerprint ||
            previous.rows[0].project_id !== input.projectId
          )
            throw new HooksLaunchSubmissionError("idempotency_conflict");
          await client.query("commit");
          return loadJob(pool, previous.rows[0]);
        }
        const approved = await client.query<{
          config_version: number;
          config_hash: string;
          approved_hash: string | null;
        }>(
          `select c.config_version,c.config_hash,a.config_hash as approved_hash from public.hooks_launch_project_config_versions c left join public.hooks_launch_config_approvals a using(project_id,config_version) where c.project_id=$1 and c.owner_user_id=$2 order by c.config_version desc limit 1`,
          [input.projectId, input.ownerUserId],
        );
        const config = approved.rows[0];
        if (
          !config ||
          config.config_version !== input.request.configVersion ||
          config.config_hash !== input.request.configHash.toLowerCase()
        )
          throw new HooksLaunchSubmissionError("conflict");
        if (config.approved_hash !== config.config_hash)
          throw new HooksLaunchSubmissionError("not_approved");
        const bindingHash = hooksLaunchBindingHash({
          factoryAddress: input.factoryAddress,
          request: input.request,
          hookSalt: input.signedPayload.hookSalt,
          memeAddress: input.memeAddress,
          hookAddress: input.hookAddress,
        });
        const existing = await client.query<JobRow>(
          `select * from public.hooks_launch_deployment_tasks where project_id=$1 and config_version=$2 and status='awaiting_executor' for update`,
          [input.projectId, input.request.configVersion],
        );
        let row = existing.rows[0];
        if (row && row.binding_hash !== bindingHash)
          throw new HooksLaunchSubmissionError("conflict");
        if (!row) {
          const inserted = await client.query<JobRow>(
            `insert into public.hooks_launch_deployment_tasks(job_id,project_id,config_version,owner_user_id,chain_id,factory_address,project_owner,owner_nonce,binding_hash,meme_address,hook_address) values($1,$2,$3,$4,97,$5,$6,$7,$8,$9,$10) returning *`,
            [
              randomUUID(),
              input.projectId,
              input.request.configVersion,
              input.ownerUserId,
              input.factoryAddress,
              input.request.projectOwner.toLowerCase(),
              input.request.nonce,
              bindingHash,
              input.memeAddress,
              input.hookAddress,
            ],
          );
          row = inserted.rows[0]!;
          await client.query(
            `insert into public.hooks_launch_deployment_events(job_id,from_status,to_status,kind) values($1,null,'awaiting_executor','created')`,
            [row.job_id],
          );
        }
        await client.query(
          `insert into public.hooks_launch_deployment_authorizations(job_id,fingerprint,signed_payload) values($1,$2,$3::jsonb) on conflict do nothing`,
          [row.job_id, input.fingerprint, JSON.stringify(input.signedPayload)],
        );
        await client.query(
          `insert into public.hooks_launch_submission_commands(owner_user_id,idempotency_key,fingerprint,job_id) values($1,$2,$3,$4)`,
          [
            input.ownerUserId,
            input.idempotencyKey,
            input.fingerprint,
            row.job_id,
          ],
        );
        await client.query("commit");
        return loadJob(pool, row);
      } catch (error) {
        await client.query("rollback");
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          const replay = await findReplay(
            input.ownerUserId,
            input.idempotencyKey,
          );
          if (
            replay &&
            replay.fingerprint === input.fingerprint &&
            replay.job.projectId === input.projectId
          )
            return replay.job;
          throw new HooksLaunchSubmissionError(
            replay ? "idempotency_conflict" : "conflict",
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
