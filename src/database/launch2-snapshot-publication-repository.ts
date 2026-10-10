import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  Launch2PublicationCandidate,
  Launch2PublicationRecord,
  Launch2PublicationRepository,
  Launch2PublicationStatus,
} from "../features/launch2/launch2-snapshot-publisher.js";

/**
 * Decision 0118: PostgreSQL side of the snapshot publisher. The attestation
 * row is inserted before any chain signature exists; the submitter's signed
 * transaction is recorded on the row (under the account's nonce lock,
 * shared with the Hooks executor — Decision 0112) before it is sent; the
 * guard trigger of migration 000063 enforces the status machine.
 */

/** The advisory lock key the Hooks executor uses for the same account. */
export function submitterNonceLockKey(address: string): string {
  return `hooks_launch_executor_nonce:97:${address.toLowerCase()}`;
}

type Row = Record<string, unknown>;

const publicationColumns = `
  publication_id::text, instance_id::text, attempt, status, snapshots_address,
  cutoff_block::text, cutoff_block_hash, sale_end_at, member_count, root,
  data_hash, signer_addresses, signatures, submitter_address, tx_hash,
  tx_nonce::text, raw_tx, block_number::text, block_hash, confirmations,
  failure_code, failure_detail, failure_retryable, created_at, updated_at
`;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((item) => typeof item === "string"))
    : Object.freeze([]);
}

/** Dates from pg or from `row_to_json` text, as ISO-8601 UTC. */
function iso(value: unknown): string {
  return new Date(value as Date | string).toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapPublication(row: Row): Launch2PublicationRecord {
  return Object.freeze({
    publicationId: row["publication_id"] as string,
    instanceId: row["instance_id"] as string,
    attempt: Number(row["attempt"]),
    status: row["status"] as Launch2PublicationStatus,
    snapshots: row["snapshots_address"] as string,
    cutoffBlock: row["cutoff_block"] as string,
    cutoffBlockHash: row["cutoff_block_hash"] as string,
    saleEndAt: iso(row["sale_end_at"]),
    memberCount: Number(row["member_count"]),
    root: row["root"] as string,
    dataHash: row["data_hash"] as string,
    signerAddresses: stringArray(row["signer_addresses"]),
    signatures: stringArray(row["signatures"]),
    submitterAddress: row["submitter_address"] as string,
    txHash: textOrNull(row["tx_hash"]),
    txNonce: textOrNull(row["tx_nonce"]),
    rawTx: textOrNull(row["raw_tx"]),
    blockNumber: textOrNull(row["block_number"]),
    blockHash: textOrNull(row["block_hash"]),
    confirmations:
      row["confirmations"] === null ? null : Number(row["confirmations"]),
    failureCode: textOrNull(row["failure_code"]),
    failureDetail: textOrNull(row["failure_detail"]),
    failureRetryable:
      typeof row["failure_retryable"] === "boolean"
        ? row["failure_retryable"]
        : null,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  });
}

export function createPostgresLaunch2PublicationRepository(
  pool: Pool,
): Launch2PublicationRepository {
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

  return Object.freeze<Launch2PublicationRepository>({
    async listCandidates(chainId) {
      const result = await pool.query<Row>(
        `
          select i.instance_id::text, i.launch_id, i.nft_address,
            i.snapshots_address, i.deploy_block_number::text,
            i.nft_sale_start, i.hold_reason, i.graduated_at is not null as graduated,
            i.snapshot_root, i.snapshot_verification,
            coalesce((select max(p.attempt) from public.launch2_snapshot_publications p
              where p.instance_id = i.instance_id), 0) as last_attempt,
            (select count(*)::integer from public.launch2_snapshot_publications p
              where p.instance_id = i.instance_id and p.status = 'failed'
                and p.failure_retryable) as retryable_failures,
            (select p.failure_code from public.launch2_snapshot_publications p
              where p.instance_id = i.instance_id
                and (p.status = 'mismatch' or (p.status = 'failed' and not p.failure_retryable))
              order by p.attempt desc limit 1) as blocking_code,
            (select max(p.updated_at) from public.launch2_snapshot_publications p
              where p.instance_id = i.instance_id and p.status = 'failed') as last_failed_at,
            (select row_to_json(a) from (
              select ${publicationColumns}
              from public.launch2_snapshot_publications p
              where p.instance_id = i.instance_id
                and p.status in ('pending', 'broadcast', 'confirmed')
            ) a) as active
          from public.launch2_instances i
          where i.chain_id = $1 and i.activated_at is not null
            and (
              exists (select 1 from public.launch2_snapshot_publications p
                where p.instance_id = i.instance_id and p.status in ('pending', 'broadcast'))
              or (i.graduated_at is null and i.snapshot_verification is distinct from 'verified'))
          order by i.nft_sale_start, i.instance_id
        `,
        [chainId],
      );
      return result.rows.map((row): Launch2PublicationCandidate =>
        Object.freeze({
          instanceId: row["instance_id"] as string,
          launchId: row["launch_id"] as string,
          nft: row["nft_address"] as string,
          snapshots: row["snapshots_address"] as string,
          deployBlockNumber: row["deploy_block_number"] as string,
          nftSaleStart: iso(row["nft_sale_start"]),
          holdReason: textOrNull(row["hold_reason"]),
          graduated: row["graduated"] === true,
          snapshotRoot: textOrNull(row["snapshot_root"]),
          snapshotVerification: textOrNull(row["snapshot_verification"]) as
            "verified" | "mismatch" | null,
          active:
            row["active"] === null || row["active"] === undefined
              ? null
              : mapPublication(row["active"] as Row),
          lastAttempt: Number(row["last_attempt"]),
          retryableFailures: Number(row["retryable_failures"]),
          blockingCode: textOrNull(row["blocking_code"]),
          lastFailedAt:
            row["last_failed_at"] === null ||
            row["last_failed_at"] === undefined
              ? null
              : iso(row["last_failed_at"]),
        }),
      );
    },

    async insertPending(input) {
      const result = await pool.query<Row>(
        `
          insert into public.launch2_snapshot_publications (
            publication_id, instance_id, chain_id, attempt, snapshots_address,
            cutoff_block, cutoff_block_hash, sale_end_at, members, member_count,
            root, data_hash, signer_addresses, signatures, submitter_address
          ) values ($1, $2, $3, $4, $5, $6::bigint, $7, $8::timestamptz,
            $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
          on conflict do nothing
          returning ${publicationColumns}
        `,
        [
          randomUUID(),
          input.instanceId,
          input.chainId,
          input.attempt,
          input.snapshots,
          input.cutoffBlock,
          input.cutoffBlockHash,
          input.saleEndAt,
          JSON.stringify(input.members),
          input.members.length,
          input.root,
          input.dataHash,
          JSON.stringify(input.signerAddresses),
          JSON.stringify(input.signatures),
          input.submitterAddress,
        ],
      );
      return result.rows[0] === undefined
        ? null
        : mapPublication(result.rows[0]);
    },

    async reserveAndRecordTx(input) {
      return inTransaction(async (client) => {
        const submitter = input.submitterAddress.toLowerCase();
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [submitterNonceLockKey(submitter)],
        );
        const locked = await client.query<Row>(
          `select status, tx_hash from public.launch2_snapshot_publications
           where publication_id = $1 for update`,
          [input.publicationId],
        );
        const row = locked.rows[0];
        if (
          row === undefined ||
          row["status"] !== "pending" ||
          row["tx_hash"] !== null
        ) {
          return null;
        }
        // Nonces the account holds in flight: Hooks executor reservations
        // and this table's pending / broadcast transactions.
        const held = await client.query<{ nonce: string }>(
          `select nonce::text as nonce from public.hooks_launch_executor_nonces
             where chain_id = 97 and executor_address = $1 and state = 'pending'
               and nonce >= $2::bigint
           union
           select tx_nonce::text from public.launch2_snapshot_publications
             where submitter_address = $1 and status in ('pending', 'broadcast')
               and tx_nonce is not null and tx_nonce >= $2::bigint
           order by 1`,
          [submitter, input.chainPendingNonce.toString()],
        );
        let nonce = input.chainPendingNonce;
        for (const reserved of held.rows
          .map((entry) => BigInt(entry.nonce))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          if (reserved === nonce) nonce += 1n;
          else if (reserved > nonce) break;
        }
        const signed = await input.sign(nonce);
        const updated = await client.query<Row>(
          `update public.launch2_snapshot_publications
           set tx_hash = $2, tx_nonce = $3::bigint, raw_tx = $4
           where publication_id = $1
           returning ${publicationColumns}`,
          [
            input.publicationId,
            signed.txHash.toLowerCase(),
            nonce.toString(),
            signed.rawTx.toLowerCase(),
          ],
        );
        return mapPublication(updated.rows[0]!);
      });
    },

    async transition(input) {
      const inclusion = input.inclusion;
      const result = await pool.query<Row>(
        `
          update public.launch2_snapshot_publications set
            status = $3,
            block_number = case when $4::boolean then $5::bigint else block_number end,
            block_hash = case when $4::boolean then $6 else block_hash end,
            confirmations = case when $4::boolean then $7::integer else confirmations end,
            failure_code = case when $3 in ('failed', 'mismatch') then $8 else null end,
            failure_detail = case when $3 in ('failed', 'mismatch') then $9 else null end,
            failure_retryable = case when $3 = 'failed' then $10::boolean else null end,
            broadcast_at = case when $3 = 'broadcast' and broadcast_at is null
              then clock_timestamp() else broadcast_at end,
            confirmed_at = case when $3 = 'confirmed' then clock_timestamp()
              when $3 = 'broadcast' then null else confirmed_at end
          where publication_id = $1 and status = $2
          returning ${publicationColumns}
        `,
        [
          input.publicationId,
          input.from,
          input.to,
          inclusion !== undefined,
          inclusion?.blockNumber ?? null,
          inclusion?.blockHash ?? null,
          inclusion?.confirmations ?? null,
          input.failure?.code ?? null,
          input.failure?.detail ?? null,
          input.failure?.retryable ?? null,
        ],
      );
      return result.rows[0] === undefined
        ? null
        : mapPublication(result.rows[0]);
    },
  });
}
