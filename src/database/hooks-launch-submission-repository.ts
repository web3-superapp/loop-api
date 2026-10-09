import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { keccak256, toBytes } from "viem";
import {
  HooksLaunchSubmissionError,
  type AcceptHooksLaunchSubmission,
  type HooksLaunchDeploymentJob,
  type HooksLaunchSubmissionRepository,
} from "../features/launch/hooks-launch-submission.js";
interface JobRow {
  job_id: string;
  project_id: string;
  config_version: number;
  factory_address: string;
  status: "awaiting_executor" | "cancelled";
  meme_address: string;
  hook_address: string;
  created_at: Date;
  fingerprint?: string;
  binding_hash?: string;
}
function job(row: JobRow): HooksLaunchDeploymentJob {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    configVersion: row.config_version,
    chainId: 97,
    factoryAddress: row.factory_address,
    status: row.status,
    memeAddress: row.meme_address,
    hookAddress: row.hook_address,
    createdAt: row.created_at.toISOString(),
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
    return row ? { fingerprint: row.fingerprint!, job: job(row) } : null;
  }
  return {
    findReplay,
    async getOwned(owner, projectId, jobId) {
      const result = await pool.query<JobRow>(
        `select * from public.hooks_launch_deployment_tasks where owner_user_id=$1 and project_id=$2 and job_id=$3`,
        [owner, projectId, jobId],
      );
      return result.rows[0] ? job(result.rows[0]) : null;
    },
    async cancelOwned(owner, projectId, jobId) {
      // Only the off-chain awaiting state is cancellable. No chain action exists here.
      const result = await pool.query<JobRow>(
        `update public.hooks_launch_deployment_tasks set status='cancelled' where owner_user_id=$1 and project_id=$2 and job_id=$3 and status='awaiting_executor' returning *`,
        [owner, projectId, jobId],
      );
      if (result.rows[0]) return job(result.rows[0]);
      const existing = await pool.query<JobRow>(
        `select * from public.hooks_launch_deployment_tasks where owner_user_id=$1 and project_id=$2 and job_id=$3`,
        [owner, projectId, jobId],
      );
      return existing.rows[0] ? job(existing.rows[0]) : null;
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
            throw new HooksLaunchSubmissionError("conflict");
          await client.query("commit");
          return job(previous.rows[0]);
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
        const stableRequest = {
          ...input.request,
          deadline: undefined,
          configHash: input.request.configHash.toLowerCase(),
          projectOwner: input.request.projectOwner.toLowerCase(),
          buybackRecipient: input.request.buybackRecipient.toLowerCase(),
          memeSalt: input.request.memeSalt.toLowerCase(),
        };
        const bindingHash = keccak256(
          toBytes(
            JSON.stringify([
              input.factoryAddress,
              stableRequest,
              input.signedPayload.hookSalt.toLowerCase(),
              input.memeAddress,
              input.hookAddress,
            ]),
          ),
        );
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
        return job(row);
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
          throw new HooksLaunchSubmissionError("conflict");
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
