import type { Pool, PoolClient } from "pg";
import {
  launchSlotChainReference,
  submitterNonceLockKey,
} from "./launch2-snapshot-publication-repository.js";

import type { HooksLaunchDeploymentStatus } from "../features/launch/hooks-launch-deployment-status.js";
import type {
  HooksLaunchExecutorContext,
  HooksLaunchExecutorEventInput,
  HooksLaunchExecutorRepository,
  HooksLaunchExecutorTask,
  HooksLaunchTaskPatch,
} from "../features/launch/hooks-launch-executor.js";

/**
 * Decision 0112: PostgreSQL side of the Hooks deployment executor
 * (migration 000059). Every write re-checks the caller's lease inside one
 * transaction and appends its event row in the same transaction; the
 * signed transaction is committed before the caller sends it.
 */

interface TaskRow {
  job_id: string;
  project_id: string;
  config_version: number;
  chain_id: number;
  factory_address: string;
  project_owner: string;
  owner_nonce: string;
  binding_hash: string;
  meme_address: string;
  hook_address: string;
  status: HooksLaunchDeploymentStatus;
  claimed_by: string | null;
  attempt_count: number;
  executor_address: string | null;
  tx_hash: string | null;
  tx_nonce: string | null;
  raw_tx: string | null;
  block_number: string | null;
  block_hash: string | null;
  confirmations: number | null;
  launch_id: string | null;
  activation_tx_hash: string | null;
  activation_tx_nonce: string | null;
  activation_raw_tx: string | null;
  activation_block_number: string | null;
  activation_block_hash: string | null;
  activation_attempt_count: number;
  failure_code: string | null;
  failure_retryable: boolean | null;
}

const bigintOrNull = (value: string | null): bigint | null =>
  value === null ? null : BigInt(value);

function mapTask(row: TaskRow): HooksLaunchExecutorTask {
  return Object.freeze({
    jobId: row.job_id,
    projectId: row.project_id,
    configVersion: row.config_version,
    chainId: row.chain_id,
    factoryAddress: row.factory_address,
    projectOwner: row.project_owner,
    ownerNonce: row.owner_nonce,
    bindingHash: row.binding_hash,
    memeAddress: row.meme_address,
    hookAddress: row.hook_address,
    status: row.status,
    claimedBy: row.claimed_by,
    attemptCount: row.attempt_count,
    executorAddress: row.executor_address,
    txHash: row.tx_hash,
    txNonce: bigintOrNull(row.tx_nonce),
    rawTx: row.raw_tx,
    blockNumber: bigintOrNull(row.block_number),
    blockHash: row.block_hash,
    confirmations: row.confirmations,
    launchId: row.launch_id,
    activationTxHash: row.activation_tx_hash,
    activationTxNonce: bigintOrNull(row.activation_tx_nonce),
    activationRawTx: row.activation_raw_tx,
    activationBlockNumber: bigintOrNull(row.activation_block_number),
    activationBlockHash: row.activation_block_hash,
    activationAttemptCount: row.activation_attempt_count,
    failureCode: row.failure_code,
    failureRetryable: row.failure_retryable,
  });
}

/** `bigint` columns are selected as text so no value passes through a JS number. */
const taskColumns = `job_id, project_id, config_version, chain_id, factory_address,
  project_owner, owner_nonce, binding_hash, meme_address, hook_address, status,
  claimed_by, attempt_count, executor_address, tx_hash, tx_nonce::text as tx_nonce,
  raw_tx, block_number::text as block_number, block_hash, confirmations, launch_id,
  activation_tx_hash, activation_tx_nonce::text as activation_tx_nonce,
  activation_raw_tx, activation_block_number::text as activation_block_number,
  activation_block_hash, activation_attempt_count, failure_code, failure_retryable`;

const inFlight = ["claimed", "broadcast", "confirmed", "verified"];

const patchColumns: Record<
  keyof HooksLaunchTaskPatch,
  { readonly column: string; readonly cast?: string }
> = {
  executorAddress: { column: "executor_address" },
  txHash: { column: "tx_hash" },
  txNonce: { column: "tx_nonce", cast: "bigint" },
  rawTx: { column: "raw_tx" },
  blockNumber: { column: "block_number", cast: "bigint" },
  blockHash: { column: "block_hash" },
  confirmations: { column: "confirmations", cast: "integer" },
  launchId: { column: "launch_id" },
  deployedAddresses: { column: "deployed_addresses", cast: "jsonb" },
  verification: { column: "verification", cast: "jsonb" },
  activationTxHash: { column: "activation_tx_hash" },
  activationTxNonce: { column: "activation_tx_nonce", cast: "bigint" },
  activationRawTx: { column: "activation_raw_tx" },
  activationBlockNumber: { column: "activation_block_number", cast: "bigint" },
  activationBlockHash: { column: "activation_block_hash" },
  activationAttemptCount: {
    column: "activation_attempt_count",
    cast: "integer",
  },
  activatedAt: { column: "activated_at" },
  failureCode: { column: "failure_code" },
  failureRetryable: { column: "failure_retryable", cast: "boolean" },
};

function sqlValue(key: keyof HooksLaunchTaskPatch, value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (key === "deployedAddresses" || key === "verification") {
    return JSON.stringify(value);
  }
  return value;
}

async function insertEvent(
  client: PoolClient,
  input: {
    readonly jobId: string;
    readonly from: HooksLaunchDeploymentStatus | null;
    readonly to: HooksLaunchDeploymentStatus;
    readonly actor: string;
    readonly event: HooksLaunchExecutorEventInput;
  },
): Promise<void> {
  const { event } = input;
  await client.query(
    `insert into public.hooks_launch_deployment_events
       (job_id, from_status, to_status, kind, tx_hash, block_number, block_hash,
        confirmations, error_code, details, actor)
     values ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10::jsonb, $11)`,
    [
      input.jobId,
      input.from,
      input.to,
      event.kind,
      event.txHash ?? null,
      event.blockNumber === undefined || event.blockNumber === null
        ? null
        : event.blockNumber.toString(),
      event.blockHash ?? null,
      event.confirmations ?? null,
      event.errorCode ?? null,
      JSON.stringify(event.details ?? {}),
      input.actor,
    ],
  );
}

export function createPostgresHooksLaunchExecutorRepository(
  pool: Pool,
  options: {
    readonly leaseSeconds: number;
    /** Decision 0150: the launch slot (default 97, the pre-0150 constant). */
    readonly chainReference?: 56 | 97;
  },
): HooksLaunchExecutorRepository {
  const chainReference = launchSlotChainReference(options.chainReference);
  if (
    !Number.isSafeInteger(options.leaseSeconds) ||
    options.leaseSeconds < 10 ||
    options.leaseSeconds > 3_600
  ) {
    throw new Error("Hooks executor lease must be 10-3600 seconds");
  }
  const lease = `make_interval(secs => ${options.leaseSeconds})`;

  async function inTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
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

  async function lockOwned(
    client: PoolClient,
    jobId: string,
    executorId: string,
  ): Promise<TaskRow | null> {
    const locked = await client.query<TaskRow>(
      `select ${taskColumns} from public.hooks_launch_deployment_tasks
       where job_id = $1 and claimed_by = $2 and lease_expires_at > clock_timestamp()
       for update`,
      [jobId, executorId],
    );
    return locked.rows[0] ?? null;
  }

  return Object.freeze({
    async acquire(input) {
      return inTransaction(async (client) => {
        const picked = await client.query<TaskRow>(
          `select ${taskColumns} from public.hooks_launch_deployment_tasks
           where not (job_id = any($1::uuid[]))
             and chain_id = ${chainReference} and factory_address = $5 and (
             status in ('awaiting_executor', 'reorged')
             or (status = 'failed' and failure_retryable and attempt_count < $2
               and updated_at < clock_timestamp() - make_interval(secs => $3))
             or (status in ('claimed','broadcast','confirmed','verified')
               and (lease_expires_at < clock_timestamp() or claimed_by = $4)))
           order by created_at, job_id
           for update skip locked
           limit 1`,
          [
            input.exclude,
            input.maxAttempts,
            input.retryDelaySeconds,
            input.executorId,
            input.factoryAddress.toLowerCase(),
          ],
        );
        const row = picked.rows[0];
        if (row === undefined) return null;
        const lease_ = `claimed_by = $2, claimed_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + ${lease}`;
        let updated: TaskRow;
        if (row.status === "awaiting_executor" || row.status === "failed") {
          const result = await client.query<TaskRow>(
            `update public.hooks_launch_deployment_tasks
             set status = 'claimed', ${lease_}, attempt_count = attempt_count + 1,
               failure_code = null, failure_retryable = null
             where job_id = $1 returning ${taskColumns}`,
            [row.job_id, input.executorId],
          );
          updated = result.rows[0]!;
          await insertEvent(client, {
            jobId: row.job_id,
            from: row.status,
            to: "claimed",
            actor: input.executorId,
            event: {
              kind: row.status === "failed" ? "retry_claimed" : "claimed",
              details: { attempt: updated.attempt_count },
            },
          });
        } else if (row.status === "reorged") {
          if (row.activation_tx_hash !== null) {
            await client.query(
              `update public.hooks_launch_executor_nonces
               set state = 'released', released_at = clock_timestamp()
               where tx_hash = $1 and state = 'pending'`,
              [row.activation_tx_hash],
            );
          }
          const result = await client.query<TaskRow>(
            `update public.hooks_launch_deployment_tasks
             set status = 'claimed', ${lease_},
               activation_tx_hash = null, activation_tx_nonce = null,
               activation_raw_tx = null, activation_block_number = null,
               activation_block_hash = null
             where job_id = $1 returning ${taskColumns}`,
            [row.job_id, input.executorId],
          );
          updated = result.rows[0]!;
          await insertEvent(client, {
            jobId: row.job_id,
            from: "reorged",
            to: "claimed",
            actor: input.executorId,
            event: { kind: "reclaimed_after_reorg", txHash: row.tx_hash },
          });
        } else {
          const result = await client.query<TaskRow>(
            `update public.hooks_launch_deployment_tasks
             set claimed_by = $2,
               claimed_at = case when claimed_by = $2 then claimed_at else clock_timestamp() end,
               lease_expires_at = clock_timestamp() + ${lease}
             where job_id = $1 returning ${taskColumns}`,
            [row.job_id, input.executorId],
          );
          updated = result.rows[0]!;
          if (row.claimed_by !== input.executorId) {
            await insertEvent(client, {
              jobId: row.job_id,
              from: row.status,
              to: row.status,
              actor: input.executorId,
              event: {
                kind: "lease_taken_over",
                details: { previousExecutor: row.claimed_by },
              },
            });
          }
        }
        return mapTask(updated);
      });
    },

    async get(jobId) {
      const result = await pool.query<TaskRow>(
        `select ${taskColumns} from public.hooks_launch_deployment_tasks where job_id = $1`,
        [jobId],
      );
      return result.rows[0] === undefined ? null : mapTask(result.rows[0]);
    },

    async context(jobId): Promise<HooksLaunchExecutorContext> {
      const [config, authorizations] = await Promise.all([
        pool.query<{
          config_version: number;
          config_hash: string;
          approved_hash: string | null;
        }>(
          `select c.config_version, c.config_hash, a.config_hash as approved_hash
           from public.hooks_launch_deployment_tasks t
           join public.hooks_launch_project_config_versions c on c.project_id = t.project_id
           left join public.hooks_launch_config_approvals a
             on a.project_id = c.project_id and a.config_version = c.config_version
           where t.job_id = $1
           order by c.config_version desc limit 1`,
          [jobId],
        ),
        pool.query<{ signed_payload: unknown }>(
          `select signed_payload from public.hooks_launch_deployment_authorizations
           where job_id = $1 order by created_at desc limit 50`,
          [jobId],
        ),
      ]);
      const latest = config.rows[0];
      return Object.freeze({
        latestConfig:
          latest === undefined
            ? null
            : Object.freeze({
                version: latest.config_version,
                configHash: latest.config_hash,
                approvedHash: latest.approved_hash,
              }),
        authorizations: Object.freeze(
          authorizations.rows.map((row) =>
            Object.freeze({ signedPayload: row.signed_payload }),
          ),
        ),
      });
    },

    async transition(input) {
      return inTransaction(async (client) => {
        const row = await lockOwned(client, input.jobId, input.executorId);
        if (row === null || row.status !== input.from) return null;
        const sets: string[] = ["status = $2"];
        const values: unknown[] = [input.jobId, input.to];
        for (const [key, value] of Object.entries(input.patch) as [
          keyof HooksLaunchTaskPatch,
          unknown,
        ][]) {
          if (value === undefined) continue;
          const spec = patchColumns[key];
          if (key === "activatedAt") {
            sets.push(
              `${spec.column} = ${value === "now" ? "clock_timestamp()" : "null"}`,
            );
            continue;
          }
          values.push(sqlValue(key, value));
          sets.push(
            `${spec.column} = $${values.length}${spec.cast === undefined ? "" : `::${spec.cast}`}`,
          );
        }
        if (inFlight.includes(input.to)) {
          sets.push(`lease_expires_at = clock_timestamp() + ${lease}`);
        }
        const updated = await client.query<TaskRow>(
          `update public.hooks_launch_deployment_tasks set ${sets.join(", ")}
           where job_id = $1 returning ${taskColumns}`,
          values,
        );
        if (input.event !== null) {
          await insertEvent(client, {
            jobId: input.jobId,
            from: input.from,
            to: input.to,
            actor: input.executorId,
            event: input.event,
          });
        }
        return mapTask(updated.rows[0]!);
      });
    },

    async reserveAndRecord(input) {
      return inTransaction(async (client) => {
        const row = await lockOwned(client, input.jobId, input.executorId);
        if (row === null) return null;
        if (
          (input.purpose === "deploy" && row.status !== "claimed") ||
          (input.purpose === "activate" &&
            (row.status !== "verified" || row.activation_tx_hash !== null))
        ) {
          return null;
        }
        const executor = input.executorAddress.toLowerCase();
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [submitterNonceLockKey(executor, chainReference)],
        );
        // Decision 0118 / 0121: the snapshot publisher and the buyback
        // keeper may sign from the same account (same advisory lock); their
        // in-flight nonces are held too.
        const pending = await client.query<{ nonce: string }>(
          `select nonce::text as nonce from (
             select nonce from public.hooks_launch_executor_nonces
             where chain_id = ${chainReference} and executor_address = $1 and state = 'pending'
               and nonce >= $2::bigint
             union
             select tx_nonce from public.launch2_snapshot_publications
             where submitter_address = $1 and status in ('pending', 'broadcast')
               and tx_nonce is not null and tx_nonce >= $2::bigint
             union
             select tx_nonce from public.launch2_buyback_attempts
             where keeper_address = $1 and status in ('pending', 'broadcast')
               and tx_nonce is not null and tx_nonce >= $2::bigint
           ) as held(nonce)
           order by nonce`,
          [executor, input.chainPendingNonce.toString()],
        );
        // The lowest nonce at or above the chain's pending count that no
        // pending reservation holds (gaps from released nonces are reused).
        let nonce = input.chainPendingNonce;
        for (const reserved of pending.rows) {
          if (BigInt(reserved.nonce) === nonce) nonce += 1n;
          else if (BigInt(reserved.nonce) > nonce) break;
        }
        const signed = await input.sign(nonce);
        const txHash = signed.txHash.toLowerCase();
        const rawTx = signed.rawTx.toLowerCase();
        await client.query(
          `insert into public.hooks_launch_executor_nonces
             (chain_id, executor_address, nonce, job_id, purpose, tx_hash)
           values (${chainReference}, $1, $2::bigint, $3, $4, $5)`,
          [executor, nonce.toString(), input.jobId, input.purpose, txHash],
        );
        let updated: TaskRow;
        if (input.purpose === "deploy") {
          const result = await client.query<TaskRow>(
            `update public.hooks_launch_deployment_tasks
             set status = 'broadcast', executor_address = $2, tx_hash = $3,
               tx_nonce = $4::bigint, raw_tx = $5, block_number = null,
               block_hash = null, confirmations = null,
               lease_expires_at = clock_timestamp() + ${lease}
             where job_id = $1 returning ${taskColumns}`,
            [input.jobId, executor, txHash, nonce.toString(), rawTx],
          );
          updated = result.rows[0]!;
          await insertEvent(client, {
            jobId: input.jobId,
            from: "claimed",
            to: "broadcast",
            actor: input.executorId,
            event: {
              kind: "broadcast",
              txHash,
              details: { nonce: nonce.toString() },
            },
          });
        } else {
          const result = await client.query<TaskRow>(
            `update public.hooks_launch_deployment_tasks
             set activation_tx_hash = $2, activation_tx_nonce = $3::bigint,
               activation_raw_tx = $4, activation_block_number = null,
               activation_block_hash = null,
               activation_attempt_count = activation_attempt_count + 1,
               lease_expires_at = clock_timestamp() + ${lease}
             where job_id = $1 returning ${taskColumns}`,
            [input.jobId, txHash, nonce.toString(), rawTx],
          );
          updated = result.rows[0]!;
          await insertEvent(client, {
            jobId: input.jobId,
            from: "verified",
            to: "verified",
            actor: input.executorId,
            event: {
              kind: "activation_broadcast",
              txHash,
              details: { nonce: nonce.toString() },
            },
          });
        }
        return mapTask(updated);
      });
    },

    async reservationPending(txHash) {
      const result = await pool.query(
        `select 1 from public.hooks_launch_executor_nonces
         where tx_hash = $1 and state = 'pending' limit 1`,
        [txHash.toLowerCase()],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async releaseReservation(txHash) {
      await pool.query(
        `update public.hooks_launch_executor_nonces
         set state = 'released', released_at = clock_timestamp()
         where tx_hash = $1 and state = 'pending'`,
        [txHash.toLowerCase()],
      );
    },
  } satisfies HooksLaunchExecutorRepository);
}
