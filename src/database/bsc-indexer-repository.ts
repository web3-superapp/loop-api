import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  assetIdPatternSource,
  blockHashPatternSource,
  evmAddressPatternSource,
  transactionHashPatternSource,
} from "../features/chain/chain-contract.js";

/**
 * Storage for the narrow BSC indexer lanes and for the wallet activity /
 * pending projections built on them (Decision 0033).
 *
 * A segment's event rows and its checkpoint advance are written in one
 * transaction, so the checkpoint can never claim a block whose logs were not
 * committed. Reorged-out logs keep their row with `removed = true`.
 */

export const indexerLanes = Object.freeze([
  "erc20_transfer",
  "pool_event",
] as const);
export type IndexerLane = (typeof indexerLanes)[number];

const bigintStringSchema = z.string().regex(/^[0-9]+$/);

const checkpointRowSchema = z
  .object({
    last_block_number: bigintStringSchema,
    last_block_hash: z.string().regex(new RegExp(blockHashPatternSource)),
    started_from_block_number: bigintStringSchema,
    reorg_count: z.number().int().min(0),
    updated_at: z.date(),
  })
  .strict();

const transferRowSchema = z
  .object({
    transaction_hash: z
      .string()
      .regex(new RegExp(transactionHashPatternSource)),
    log_index: z.number().int().min(0),
    block_number: bigintStringSchema,
    block_hash: z.string().regex(new RegExp(blockHashPatternSource)),
    asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    from_address: z.string().regex(new RegExp(evmAddressPatternSource)),
    to_address: z.string().regex(new RegExp(evmAddressPatternSource)),
    raw_value: bigintStringSchema,
    removed: z.boolean(),
    observed_at: z.date(),
  })
  .strict();

export interface IndexerCheckpointRecord {
  readonly lastBlockNumber: string;
  readonly lastBlockHash: string;
  readonly startedFromBlockNumber: string;
  readonly reorgCount: number;
  readonly updatedAt: string;
}

export interface IndexedTransferInput {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly assetId: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly rawValue: string;
}

export interface IndexedTransferRecord extends IndexedTransferInput {
  readonly removed: boolean;
  readonly observedAt: string;
}

export interface CommitTransferSegmentInput {
  readonly chainId: string;
  readonly transfers: readonly IndexedTransferInput[];
  readonly checkpoint: {
    readonly lastBlockNumber: string;
    readonly lastBlockHash: string;
    readonly startedFromBlockNumber: string;
  };
  /**
   * When present, every stored log at or above this block is marked removed
   * inside the same transaction before the segment is replayed. This is the
   * reorg rewind path.
   */
  readonly rewindFromBlockNumber?: string;
}

export interface WalletTransferPage {
  readonly items: readonly IndexedTransferRecord[];
  readonly hasMore: boolean;
}

export interface ListWalletTransfersInput {
  readonly chainId: string;
  readonly address: string;
  readonly assetIds: readonly string[];
  readonly limit: number;
  readonly beforeBlockNumber?: string;
  readonly beforeLogIndex?: number;
}

export interface PendingTransferTotal {
  readonly assetId: string;
  readonly rawValue: string;
}

export interface BscIndexerRepository {
  getCheckpoint(
    lane: IndexerLane,
    chainId: string,
  ): Promise<IndexerCheckpointRecord | null>;
  commitTransferSegment(
    input: CommitTransferSegmentInput,
  ): Promise<IndexerCheckpointRecord>;
  listWalletTransfers(
    input: ListWalletTransfersInput,
  ): Promise<WalletTransferPage>;
  /**
   * Incoming, not-yet-confirmed value per asset. It is reported separately
   * from the confirmed balance and is never added into a spendable amount.
   */
  sumPendingIncoming(input: {
    readonly chainId: string;
    readonly address: string;
    readonly assetIds: readonly string[];
    readonly confirmedThroughBlockNumber: string;
  }): Promise<readonly PendingTransferTotal[]>;
}

export class BscIndexerUnavailableError extends Error {
  readonly code = "bsc_indexer_unavailable";

  constructor() {
    super("The BSC indexer repository is unavailable");
    this.name = "BscIndexerUnavailableError";
  }
}

function mapCheckpoint(row: unknown): IndexerCheckpointRecord {
  const parsed = checkpointRowSchema.parse(row);
  return Object.freeze({
    lastBlockNumber: parsed.last_block_number,
    lastBlockHash: parsed.last_block_hash,
    startedFromBlockNumber: parsed.started_from_block_number,
    reorgCount: parsed.reorg_count,
    updatedAt: parsed.updated_at.toISOString(),
  });
}

function mapTransfer(row: unknown): IndexedTransferRecord {
  const parsed = transferRowSchema.parse(row);
  return Object.freeze({
    transactionHash: parsed.transaction_hash,
    logIndex: parsed.log_index,
    blockNumber: parsed.block_number,
    blockHash: parsed.block_hash,
    assetId: parsed.asset_id,
    fromAddress: parsed.from_address,
    toAddress: parsed.to_address,
    rawValue: parsed.raw_value,
    removed: parsed.removed,
    observedAt: parsed.observed_at.toISOString(),
  });
}

const checkpointColumns = `
  last_block_number::text as last_block_number,
  last_block_hash,
  started_from_block_number::text as started_from_block_number,
  reorg_count,
  updated_at
`;

const transferColumns = `
  transaction_hash,
  log_index,
  block_number::text as block_number,
  block_hash,
  asset_id,
  from_address,
  to_address,
  raw_value::text as raw_value,
  removed,
  observed_at
`;

/** Maximum rows per multi-row INSERT; every batch stays in the caller's transaction. */
export const indexedTransferInsertBatchSize = 500;

const indexedTransferColumnCount = 9;

/**
 * Writes a segment as multi-row INSERTs rather than one statement per log.
 * Every batch runs inside the caller's transaction, so the segment and its
 * checkpoint still commit atomically; batching only removes a round trip per
 * row on a dense token.
 */
async function insertTransfers(
  client: PoolClient,
  chainId: string,
  transfers: readonly IndexedTransferInput[],
): Promise<void> {
  // A multi-row upsert cannot touch the same conflict key twice, so the
  // segment is de-duplicated on (transaction hash, log index) first. The chain
  // never emits that pair twice; this only keeps a malformed provider response
  // from failing the whole transaction.
  const unique = new Map<string, IndexedTransferInput>();
  for (const transfer of transfers) {
    unique.set(
      `${transfer.transactionHash}:${String(transfer.logIndex)}`,
      transfer,
    );
  }
  const deduplicated = [...unique.values()];

  for (
    let offset = 0;
    offset < deduplicated.length;
    offset += indexedTransferInsertBatchSize
  ) {
    const batch = deduplicated.slice(
      offset,
      offset + indexedTransferInsertBatchSize,
    );
    const values: unknown[] = [chainId];
    const tuples = batch.map((transfer, index) => {
      const base = index * indexedTransferColumnCount + 1;
      values.push(
        transfer.transactionHash,
        transfer.logIndex,
        transfer.blockNumber,
        transfer.blockHash,
        transfer.assetId,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.rawValue,
        false,
      );
      return `($1, $${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}::numeric, $${String(base + 4)}, $${String(base + 5)}, $${String(base + 6)}, $${String(base + 7)}, $${String(base + 8)}::numeric, $${String(base + 9)})`;
    });

    await client.query<Record<string, unknown>>({
      text: `
        insert into public.indexed_transfers (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          asset_id, from_address, to_address, raw_value, removed
        )
        values ${tuples.join(", ")}
        on conflict (chain_id, transaction_hash, log_index) do update set
          block_number = excluded.block_number,
          block_hash = excluded.block_hash,
          asset_id = excluded.asset_id,
          from_address = excluded.from_address,
          to_address = excluded.to_address,
          raw_value = excluded.raw_value,
          removed = false,
          observed_at = clock_timestamp()
      `,
      values,
    });
  }
}

export function createPostgresBscIndexerRepository(
  pool: Pool,
): BscIndexerRepository {
  return Object.freeze({
    async getCheckpoint(
      lane: IndexerLane,
      chainId: string,
    ): Promise<IndexerCheckpointRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${checkpointColumns}
          from public.indexer_checkpoints
          where lane = $1 and chain_id = $2
          limit 1
        `,
        values: [lane, chainId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapCheckpoint(row);
    },

    async commitTransferSegment(
      input: CommitTransferSegmentInput,
    ): Promise<IndexerCheckpointRecord> {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("begin");
        inTransaction = true;

        const rewindFrom = input.rewindFromBlockNumber;
        if (rewindFrom !== undefined) {
          await client.query<Record<string, unknown>>({
            text: `
              update public.indexed_transfers
              set removed = true, observed_at = clock_timestamp()
              where chain_id = $1 and block_number >= $2::numeric
            `,
            values: [input.chainId, rewindFrom],
          });
          await client.query<Record<string, unknown>>({
            text: `
              update public.indexed_pool_events
              set removed = true, observed_at = clock_timestamp()
              where chain_id = $1 and block_number >= $2::numeric
            `,
            values: [input.chainId, rewindFrom],
          });
        }

        await insertTransfers(client, input.chainId, input.transfers);

        const result = await client.query<Record<string, unknown>>({
          text: `
            insert into public.indexer_checkpoints (
              lane, chain_id, last_block_number, last_block_hash,
              started_from_block_number, reorg_count
            )
            values ('erc20_transfer', $1, $2::numeric, $3, $4::numeric, $5)
            on conflict (lane, chain_id) do update set
              last_block_number = excluded.last_block_number,
              last_block_hash = excluded.last_block_hash,
              reorg_count = public.indexer_checkpoints.reorg_count + $5,
              updated_at = clock_timestamp()
            returning ${checkpointColumns}
          `,
          values: [
            input.chainId,
            input.checkpoint.lastBlockNumber,
            input.checkpoint.lastBlockHash,
            input.checkpoint.startedFromBlockNumber,
            rewindFrom === undefined ? 0 : 1,
          ],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new BscIndexerUnavailableError();
        }
        await client.query("commit");
        inTransaction = false;
        return mapCheckpoint(row);
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("rollback");
          } catch {
            // The original failure stays authoritative.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async listWalletTransfers(
      input: ListWalletTransfersInput,
    ): Promise<WalletTransferPage> {
      const beforeBlockNumber = input.beforeBlockNumber ?? null;
      const beforeLogIndex = input.beforeLogIndex ?? null;
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${transferColumns}
          from public.indexed_transfers
          where chain_id = $1
            and asset_id = any($2::text[])
            and (from_address = $3 or to_address = $3)
            and (
              $4::numeric is null
              or block_number < $4::numeric
              or (block_number = $4::numeric and log_index < $5::int)
            )
          order by block_number desc, log_index desc
          limit $6
        `,
        values: [
          input.chainId,
          [...input.assetIds],
          input.address,
          beforeBlockNumber,
          beforeLogIndex,
          input.limit + 1,
        ],
      });
      const rows = result.rows.map(mapTransfer);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit)),
        hasMore: rows.length > input.limit,
      });
    },

    async sumPendingIncoming(input: {
      readonly chainId: string;
      readonly address: string;
      readonly assetIds: readonly string[];
      readonly confirmedThroughBlockNumber: string;
    }): Promise<readonly PendingTransferTotal[]> {
      if (input.assetIds.length === 0) {
        return Object.freeze([]);
      }
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select asset_id, sum(raw_value)::text as raw_value
          from public.indexed_transfers
          where chain_id = $1
            and asset_id = any($2::text[])
            and to_address = $3
            and from_address <> $3
            and not removed
            and block_number > $4::numeric
          group by asset_id
          order by asset_id asc
        `,
        values: [
          input.chainId,
          [...input.assetIds],
          input.address,
          input.confirmedThroughBlockNumber,
        ],
      });
      const rowSchema = z
        .object({ asset_id: z.string(), raw_value: bigintStringSchema })
        .strict();
      return Object.freeze(
        result.rows.map((row) => {
          const parsed = rowSchema.parse(row);
          return Object.freeze({
            assetId: parsed.asset_id,
            rawValue: parsed.raw_value,
          });
        }),
      );
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new BscIndexerUnavailableError());
}

export function createUnavailableBscIndexerRepository(): BscIndexerRepository {
  return Object.freeze({
    getCheckpoint: unavailable,
    commitTransferSegment: unavailable,
    listWalletTransfers: unavailable,
    sumPendingIncoming: unavailable,
  });
}
