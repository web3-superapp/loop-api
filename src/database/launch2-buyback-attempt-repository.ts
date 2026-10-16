import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  Launch2BuybackAttemptRecord,
  Launch2BuybackAttemptRepository,
  Launch2BuybackAttemptStatus,
  Launch2BuybackKeeperCandidate,
} from "../features/launch2/launch2-buyback-keeper.js";
import {
  launchSlotChainReference,
  submitterNonceLockKey,
} from "./launch2-snapshot-publication-repository.js";

/**
 * Decision 0121: PostgreSQL side of the buyback keeper. A passing
 * simulation is inserted (`pending`) before anything is signed; the
 * keeper's signed transaction is recorded on the row under the account's
 * nonce lock — the same advisory key and in-flight nonce set as the Hooks
 * executor and the snapshot publisher (Decision 0112) — before it is sent.
 * Refusals refresh one `rejected` row per consecutive reason. The guard
 * trigger of migration 000065 enforces the status machine.
 */

type Row = Record<string, unknown>;

/** Every attempt column, numbers as text (also inside `row_to_json`). */
const attemptColumns = `
  attempt_id::text as attempt_id, instance_id::text as instance_id, attempt,
  status, keeper_address, executor_address, simulation,
  order_usd1::text as order_usd1, simulated_gas::text as simulated_gas,
  reason_code, reason_detail, rejection_count, last_rejected_at,
  next_eligible_at, tx_hash, tx_nonce::text as tx_nonce, raw_tx,
  block_number::text as block_number, block_hash, confirmations,
  buyback_id::text as buyback_id, created_at, updated_at
`;

const activePredicate = `(status in ('pending', 'broadcast')
  or (status = 'confirmed' and buyback_id is null))`;

/** Dates from pg or from `row_to_json` text, as ISO-8601 UTC. */
function iso(value: unknown): string {
  return new Date(value as Date | string).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function mapLaunch2BuybackAttempt(
  row: Row,
): Launch2BuybackAttemptRecord {
  return Object.freeze({
    attemptId: row["attempt_id"] as string,
    instanceId: row["instance_id"] as string,
    attempt: Number(row["attempt"]),
    status: row["status"] as Launch2BuybackAttemptStatus,
    keeperAddress: row["keeper_address"] as string,
    executorAddress: row["executor_address"] as string,
    simulation: row["simulation"] as "passed" | "reverted",
    orderUsd1: textOrNull(row["order_usd1"]),
    simulatedGas: textOrNull(row["simulated_gas"]),
    reasonCode: textOrNull(row["reason_code"]),
    reasonDetail: textOrNull(row["reason_detail"]),
    rejectionCount: numberOrNull(row["rejection_count"]),
    lastRejectedAt: nullableIso(row["last_rejected_at"]),
    nextEligibleAt: nullableIso(row["next_eligible_at"]),
    txHash: textOrNull(row["tx_hash"]),
    txNonce: textOrNull(row["tx_nonce"]),
    rawTx: textOrNull(row["raw_tx"]),
    blockNumber: textOrNull(row["block_number"]),
    blockHash: textOrNull(row["block_hash"]),
    confirmations: numberOrNull(row["confirmations"]),
    buybackId: textOrNull(row["buyback_id"]),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  });
}

function attemptOrNull(value: unknown): Launch2BuybackAttemptRecord | null {
  return value === null || value === undefined
    ? null
    : mapLaunch2BuybackAttempt(value as Row);
}

/** The in-flight nonces of one account across every server-side signer. */
export async function heldKeeperNonces(
  client: PoolClient,
  address: string,
  fromNonce: bigint,
  chainReference: 56 | 97 = 97,
): Promise<readonly bigint[]> {
  const held = await client.query<{ nonce: string }>(
    `select nonce::text as nonce from (
       select nonce from public.hooks_launch_executor_nonces
       where chain_id = ${launchSlotChainReference(chainReference)} and executor_address = $1 and state = 'pending'
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
    [address, fromNonce.toString()],
  );
  return held.rows.map((entry) => BigInt(entry.nonce));
}

export function createPostgresLaunch2BuybackAttemptRepository(
  pool: Pool,
  options: { readonly chainReference?: 56 | 97 } = {},
): Launch2BuybackAttemptRepository {
  const chainReference = launchSlotChainReference(options.chainReference);
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

  return Object.freeze<Launch2BuybackAttemptRepository>({
    async listCandidates(chainId) {
      const result = await pool.query<Row>(
        `
          select i.instance_id::text, i.factory_address,
            i.buyback_executor_address,
            i.escrow_address, i.stage = 'graduated' as graduated,
            i.buyback_paused,
            (select row_to_json(a) from (
              select ${attemptColumns} from public.launch2_buyback_attempts p
              where p.instance_id = i.instance_id and ${activePredicate}
            ) a) as active,
            (select row_to_json(a) from (
              select ${attemptColumns} from public.launch2_buyback_attempts p
              where p.instance_id = i.instance_id
              order by p.attempt desc limit 1
            ) a) as latest,
            coalesce((select max(p.attempt) from public.launch2_buyback_attempts p
              where p.instance_id = i.instance_id), 0) as last_attempt
          from public.launch2_instances i
          where i.chain_id = $1 and i.activated_at is not null
            and (i.stage = 'graduated'
              or exists (select 1 from public.launch2_buyback_attempts p
                where p.instance_id = i.instance_id and ${activePredicate}))
          order by i.graduated_at nulls last, i.instance_id
        `,
        [chainId],
      );
      return result.rows.map((row): Launch2BuybackKeeperCandidate =>
        Object.freeze({
          instanceId: row["instance_id"] as string,
          factoryAddress: row["factory_address"] as string,
          buybackExecutor: row["buyback_executor_address"] as string,
          escrow: row["escrow_address"] as string,
          graduated: row["graduated"] === true,
          buybackPaused: row["buyback_paused"] === true,
          active: attemptOrNull(row["active"]),
          latest: attemptOrNull(row["latest"]),
          lastAttempt: Number(row["last_attempt"]),
        }),
      );
    },

    async recordRejection(input) {
      return inTransaction(async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`launch2_buyback_keeper:${input.instanceId}`],
        );
        const latest = await client.query<Row>(
          `select ${attemptColumns} from public.launch2_buyback_attempts
           where instance_id = $1 order by attempt desc limit 1 for update`,
          [input.instanceId],
        );
        const previous = latest.rows[0];
        if (
          previous !== undefined &&
          previous["status"] === "rejected" &&
          previous["reason_code"] === input.reasonCode &&
          (previous["reason_detail"] ?? null) === input.reasonDetail
        ) {
          const count = Number(previous["rejection_count"]) + 1;
          const updated = await client.query<Row>(
            `update public.launch2_buyback_attempts set
               rejection_count = $2,
               last_rejected_at = clock_timestamp(),
               next_eligible_at = clock_timestamp() + make_interval(secs => $3)
             where attempt_id = $1
             returning ${attemptColumns}`,
            [
              previous["attempt_id"],
              count,
              Math.max(0, Math.floor(input.backoffSeconds(count))),
            ],
          );
          return {
            record: mapLaunch2BuybackAttempt(updated.rows[0]!),
            repeated: true,
          };
        }
        const attempt =
          previous === undefined ? 1 : Number(previous["attempt"]) + 1;
        const inserted = await client.query<Row>(
          `insert into public.launch2_buyback_attempts (
             attempt_id, instance_id, chain_id, attempt, status,
             keeper_address, executor_address, simulation, order_usd1,
             reason_code, reason_detail, rejection_count, last_rejected_at,
             next_eligible_at
           ) values ($1, $2, $3, $4, 'rejected', $5, $6, 'reverted',
             $7::numeric, $8, $9, 1, clock_timestamp(),
             clock_timestamp() + make_interval(secs => $10))
           returning ${attemptColumns}`,
          [
            randomUUID(),
            input.instanceId,
            input.chainId,
            attempt,
            input.keeperAddress.toLowerCase(),
            input.executorAddress.toLowerCase(),
            input.orderUsd1,
            input.reasonCode,
            input.reasonDetail,
            Math.max(0, Math.floor(input.backoffSeconds(1))),
          ],
        );
        return {
          record: mapLaunch2BuybackAttempt(inserted.rows[0]!),
          repeated: false,
        };
      });
    },

    async insertPending(input) {
      const result = await pool.query<Row>(
        `insert into public.launch2_buyback_attempts (
           attempt_id, instance_id, chain_id, attempt, status, keeper_address,
           executor_address, simulation, order_usd1, simulated_gas
         ) values ($1, $2, $3, $4, 'pending', $5, $6, 'passed', $7::numeric,
           $8::bigint)
         on conflict do nothing
         returning ${attemptColumns}`,
        [
          randomUUID(),
          input.instanceId,
          input.chainId,
          input.attempt,
          input.keeperAddress.toLowerCase(),
          input.executorAddress.toLowerCase(),
          input.orderUsd1,
          input.simulatedGas,
        ],
      );
      return result.rows[0] === undefined
        ? null
        : mapLaunch2BuybackAttempt(result.rows[0]);
    },

    async reserveAndRecordTx(input) {
      return inTransaction(async (client) => {
        const keeper = input.keeperAddress.toLowerCase();
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [submitterNonceLockKey(keeper, chainReference)],
        );
        const locked = await client.query<Row>(
          `select status, tx_hash from public.launch2_buyback_attempts
           where attempt_id = $1 for update`,
          [input.attemptId],
        );
        const row = locked.rows[0];
        if (
          row === undefined ||
          row["status"] !== "pending" ||
          row["tx_hash"] !== null
        ) {
          return null;
        }
        let nonce = input.chainPendingNonce;
        for (const reserved of await heldKeeperNonces(
          client,
          keeper,
          input.chainPendingNonce,
          chainReference,
        )) {
          if (reserved === nonce) nonce += 1n;
          else if (reserved > nonce) break;
        }
        const signed = await input.sign(nonce);
        const updated = await client.query<Row>(
          `update public.launch2_buyback_attempts
           set tx_hash = $2, tx_nonce = $3::bigint, raw_tx = $4
           where attempt_id = $1
           returning ${attemptColumns}`,
          [
            input.attemptId,
            signed.txHash.toLowerCase(),
            nonce.toString(),
            signed.rawTx.toLowerCase(),
          ],
        );
        return mapLaunch2BuybackAttempt(updated.rows[0]!);
      });
    },

    async transition(input) {
      const inclusion = input.inclusion;
      const result = await pool.query<Row>(
        `
          update public.launch2_buyback_attempts set
            status = $3,
            block_number = case when $4::boolean then $5::bigint else block_number end,
            block_hash = case when $4::boolean then $6 else block_hash end,
            confirmations = case when $4::boolean then $7::integer else confirmations end,
            reason_code = case when $3 = 'failed' then $8 else null end,
            reason_detail = case when $3 = 'failed' then $9 else null end,
            next_eligible_at = case when $3 = 'failed'
              then clock_timestamp() + make_interval(secs => $10::integer)
              else null end,
            broadcast_at = case when $3 = 'broadcast' and broadcast_at is null
              then clock_timestamp() else broadcast_at end,
            confirmed_at = case when $3 = 'confirmed' then clock_timestamp()
              when $3 = 'broadcast' then null else confirmed_at end
          where attempt_id = $1 and status = $2
          returning ${attemptColumns}
        `,
        [
          input.attemptId,
          input.from,
          input.to,
          inclusion !== undefined,
          inclusion?.blockNumber ?? null,
          inclusion?.blockHash ?? null,
          inclusion?.confirmations ?? null,
          input.failure?.code ?? null,
          input.failure?.detail ?? null,
          input.failure?.retryAfterSeconds ?? 0,
        ],
      );
      return result.rows[0] === undefined
        ? null
        : mapLaunch2BuybackAttempt(result.rows[0]);
    },

    async findLedgerBuyback(input) {
      const result = await pool.query<{ buyback_id: string }>(
        `select buyback_id::text from public.launch2_buybacks
         where instance_id = $1 and transaction_hash = $2
           and outcome = 'executed' and not removed
         order by log_index limit 1`,
        [input.instanceId, input.txHash.toLowerCase()],
      );
      return result.rows[0]?.buyback_id ?? null;
    },

    async align(input) {
      const result = await pool.query<Row>(
        `update public.launch2_buyback_attempts set buyback_id = $2
         where attempt_id = $1 and status = 'confirmed' and buyback_id is null
         returning ${attemptColumns}`,
        [input.attemptId, input.buybackId],
      );
      return result.rows[0] === undefined
        ? null
        : mapLaunch2BuybackAttempt(result.rows[0]);
    },
  });
}
