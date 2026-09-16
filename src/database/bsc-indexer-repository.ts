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
    approval_coverage_from_block: bigintStringSchema.nullable(),
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
  /**
   * First block from which `Approval` logs are stored contiguously up to
   * `lastBlockNumber` (transfer lane only). `null` until the lane has
   * advanced under approval-aware code; lowered by a coverage backfill and
   * by a reorg replay, never raised. The pool lane always reports `null`.
   */
  readonly approvalCoverageFromBlockNumber: string | null;
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

export interface IndexedApprovalInput {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly assetId: string;
  readonly ownerAddress: string;
  readonly spenderAddress: string;
  readonly rawValue: string;
}

export interface IndexedApprovalRecord extends IndexedApprovalInput {
  readonly removed: boolean;
  readonly observedAt: string;
}

export interface CommitTransferSegmentInput {
  readonly chainId: string;
  readonly transfers: readonly IndexedTransferInput[];
  /**
   * `Approval` logs from the same block range (Decision 0035). They share the
   * transfer lane's checkpoint and rewind so an approval can never be claimed
   * for a block whose transfers were not stored, and vice versa.
   */
  readonly approvals?: readonly IndexedApprovalInput[];
  readonly checkpoint: {
    readonly lastBlockNumber: string;
    readonly lastBlockHash: string;
    readonly startedFromBlockNumber: string;
  };
  /**
   * First block of this segment whose `Approval` logs are included in
   * `approvals`. The lane's `approvalCoverageFromBlockNumber` becomes
   * `min(current, this)`, so a segment committed without it leaves coverage
   * untouched (and null coverage stays null).
   */
  readonly approvalCoverageFromBlockNumber?: string;
  /**
   * When present, every stored transfer at or above this block is marked
   * removed inside the same transaction before the segment is replayed. This
   * is the reorg rewind path. It touches only this lane's table: the
   * `pool_event` lane owns its own checkpoint and rewinds itself when S5b
   * delivers it, so one lane can never rewind another lane's rows past its
   * checkpoint.
   */
  readonly rewindFromBlockNumber?: string;
}

export const poolEventKinds = Object.freeze(["swap", "mint", "burn"] as const);
export type PoolEventKind = (typeof poolEventKinds)[number];

/** Signed integer string (int256) as emitted by a V3 Swap. */
const signedBigintStringSchema = z.string().regex(/^-?[0-9]+$/);

export interface IndexedPoolEventInput {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly poolId: string;
  readonly eventKind: PoolEventKind;
  /** Every decoded field as a canonical string; never a JavaScript number. */
  readonly payload: Readonly<Record<string, string>>;
  readonly amount0: string | null;
  readonly amount1: string | null;
  readonly sqrtPriceX96: string | null;
}

export interface IndexedPoolEventRecord extends IndexedPoolEventInput {
  readonly removed: boolean;
  readonly observedAt: string;
}

export interface CommitPoolEventSegmentInput {
  readonly chainId: string;
  readonly events: readonly IndexedPoolEventInput[];
  readonly checkpoint: {
    readonly lastBlockNumber: string;
    readonly lastBlockHash: string;
    readonly startedFromBlockNumber: string;
  };
  /** Reorg rewind for this lane only; it never touches `indexed_transfers`. */
  readonly rewindFromBlockNumber?: string;
}

export interface ListPoolSwapsInput {
  readonly poolIds: readonly string[];
  readonly limit: number;
  readonly beforeBlockNumber?: string;
  readonly beforeLogIndex?: number;
}

export interface PoolSwapPage {
  readonly items: readonly IndexedPoolEventRecord[];
  readonly hasMore: boolean;
}

/**
 * One time bucket of swaps. Prices are returned as the raw `sqrtPriceX96`
 * values at the bucket's boundaries and extremes; the service converts them
 * with exact integer arithmetic in the asset's orientation. Because price is
 * monotonic in sqrtPriceX96, min/max of the sqrt value give low/high.
 */
export interface SwapCandleBucket {
  readonly bucketStart: string;
  readonly openSqrtPriceX96: string;
  readonly closeSqrtPriceX96: string;
  readonly highSqrtPriceX96: string;
  readonly lowSqrtPriceX96: string;
  /** Sum of the absolute asset-side amount, smallest units. */
  readonly volumeRaw: string;
  readonly swapCount: number;
}

export interface AggregateSwapCandlesInput {
  readonly poolId: string;
  readonly intervalSeconds: number;
  readonly assetIsToken0: boolean;
  readonly fromTimestamp: string;
  readonly toTimestamp: string;
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

export interface ListWalletApprovalsInput {
  readonly chainId: string;
  readonly ownerAddress: string;
  readonly assetIds: readonly string[];
}

export interface CommitApprovalCoverageSegmentInput {
  readonly chainId: string;
  /** `Approval` logs for every block in `[fromBlockNumber, toBlockNumber]`. */
  readonly approvals: readonly IndexedApprovalInput[];
  readonly fromBlockNumber: string;
  readonly toBlockNumber: string;
}

export interface BscIndexerRepository {
  getCheckpoint(
    lane: IndexerLane,
    chainId: string,
  ): Promise<IndexerCheckpointRecord | null>;
  commitTransferSegment(
    input: CommitTransferSegmentInput,
  ): Promise<IndexerCheckpointRecord>;
  /**
   * Stores `Approval` logs for a block range the transfer lane has already
   * indexed and lowers `approvalCoverageFromBlockNumber` to `fromBlockNumber`.
   * It never moves `lastBlockNumber`, so a running lane and a coverage
   * backfill cannot disagree about where the lane is. Refused
   * (`BscIndexerUnavailableError`) when the lane has no checkpoint or the
   * range ends above it.
   */
  commitApprovalCoverageSegment(
    input: CommitApprovalCoverageSegmentInput,
  ): Promise<IndexerCheckpointRecord>;
  /**
   * Lowest indexed block in which the address sent or received a registry
   * asset, or `null` when the lane has never seen it. The approvals inventory
   * compares it with the approval coverage start.
   */
  earliestWalletActivityBlockNumber(input: {
    readonly chainId: string;
    readonly address: string;
  }): Promise<string | null>;
  /**
   * The latest non-removed `Approval` log per (asset, spender) for one owner,
   * newest first. It is the inventory candidate list; the current allowance is
   * always re-read over RPC before it is published.
   */
  listLatestApprovals(
    input: ListWalletApprovalsInput,
  ): Promise<readonly IndexedApprovalRecord[]>;
  /** Whether the owner has an indexed outgoing transfer to the address. */
  hasOutgoingTransferTo(input: {
    readonly chainId: string;
    readonly fromAddress: string;
    readonly toAddress: string;
  }): Promise<boolean>;
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
  commitPoolEventSegment(
    input: CommitPoolEventSegmentInput,
  ): Promise<IndexerCheckpointRecord>;
  listPoolSwaps(input: ListPoolSwapsInput): Promise<PoolSwapPage>;
  aggregateSwapCandles(
    input: AggregateSwapCandlesInput,
  ): Promise<readonly SwapCandleBucket[]>;
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
    approvalCoverageFromBlockNumber: parsed.approval_coverage_from_block,
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
  approval_coverage_from_block::text as approval_coverage_from_block,
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

const approvalRowSchema = z
  .object({
    transaction_hash: z
      .string()
      .regex(new RegExp(transactionHashPatternSource)),
    log_index: z.number().int().min(0),
    block_number: bigintStringSchema,
    block_hash: z.string().regex(new RegExp(blockHashPatternSource)),
    asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    owner_address: z.string().regex(new RegExp(evmAddressPatternSource)),
    spender_address: z.string().regex(new RegExp(evmAddressPatternSource)),
    raw_value: bigintStringSchema,
    removed: z.boolean(),
    observed_at: z.date(),
  })
  .strict();

const approvalColumns = `
  transaction_hash,
  log_index,
  block_number::text as block_number,
  block_hash,
  asset_id,
  owner_address,
  spender_address,
  raw_value::text as raw_value,
  removed,
  observed_at
`;

function mapApproval(row: unknown): IndexedApprovalRecord {
  const parsed = approvalRowSchema.parse(row);
  return Object.freeze({
    transactionHash: parsed.transaction_hash,
    logIndex: parsed.log_index,
    blockNumber: parsed.block_number,
    blockHash: parsed.block_hash,
    assetId: parsed.asset_id,
    ownerAddress: parsed.owner_address,
    spenderAddress: parsed.spender_address,
    rawValue: parsed.raw_value,
    removed: parsed.removed,
    observedAt: parsed.observed_at.toISOString(),
  });
}

const indexedApprovalColumnCount = 9;

async function insertApprovals(
  client: PoolClient,
  chainId: string,
  approvals: readonly IndexedApprovalInput[],
): Promise<void> {
  const unique = new Map<string, IndexedApprovalInput>();
  for (const approval of approvals) {
    unique.set(
      `${approval.transactionHash}:${String(approval.logIndex)}`,
      approval,
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
    const tuples = batch.map((approval, index) => {
      const base = index * indexedApprovalColumnCount + 1;
      values.push(
        approval.transactionHash,
        approval.logIndex,
        approval.blockNumber,
        approval.blockHash,
        approval.assetId,
        approval.ownerAddress,
        approval.spenderAddress,
        approval.rawValue,
        false,
      );
      return `($1, $${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}::numeric, $${String(base + 4)}, $${String(base + 5)}, $${String(base + 6)}, $${String(base + 7)}, $${String(base + 8)}::numeric, $${String(base + 9)})`;
    });
    await client.query<Record<string, unknown>>({
      text: `
        insert into public.indexed_approvals (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          asset_id, owner_address, spender_address, raw_value, removed
        )
        values ${tuples.join(", ")}
        on conflict (chain_id, transaction_hash, log_index) do update set
          block_number = excluded.block_number,
          block_hash = excluded.block_hash,
          asset_id = excluded.asset_id,
          owner_address = excluded.owner_address,
          spender_address = excluded.spender_address,
          raw_value = excluded.raw_value,
          removed = false,
          observed_at = clock_timestamp()
      `,
      values,
    });
  }
}

const poolEventRowSchema = z
  .object({
    transaction_hash: z
      .string()
      .regex(new RegExp(transactionHashPatternSource)),
    log_index: z.number().int().min(0),
    block_number: bigintStringSchema,
    block_hash: z.string().regex(new RegExp(blockHashPatternSource)),
    block_timestamp: z.date(),
    pool_id: z.string().uuid(),
    event_kind: z.enum(poolEventKinds),
    payload: z.record(z.string(), z.string()),
    amount0: signedBigintStringSchema.nullable(),
    amount1: signedBigintStringSchema.nullable(),
    sqrt_price_x96: bigintStringSchema.nullable(),
    removed: z.boolean(),
    observed_at: z.date(),
  })
  .strict();

const poolEventColumns = `
  transaction_hash,
  log_index,
  block_number::text as block_number,
  block_hash,
  block_timestamp,
  pool_id,
  event_kind,
  payload,
  amount0::text as amount0,
  amount1::text as amount1,
  sqrt_price_x96::text as sqrt_price_x96,
  removed,
  observed_at
`;

function mapPoolEvent(row: unknown): IndexedPoolEventRecord {
  const parsed = poolEventRowSchema.parse(row);
  return Object.freeze({
    transactionHash: parsed.transaction_hash,
    logIndex: parsed.log_index,
    blockNumber: parsed.block_number,
    blockHash: parsed.block_hash,
    blockTimestamp: parsed.block_timestamp.toISOString(),
    poolId: parsed.pool_id,
    eventKind: parsed.event_kind,
    payload: Object.freeze({ ...parsed.payload }),
    amount0: parsed.amount0,
    amount1: parsed.amount1,
    sqrtPriceX96: parsed.sqrt_price_x96,
    removed: parsed.removed,
    observedAt: parsed.observed_at.toISOString(),
  });
}

const indexedPoolEventColumnCount = 12;

async function insertPoolEvents(
  client: PoolClient,
  chainId: string,
  events: readonly IndexedPoolEventInput[],
): Promise<void> {
  const unique = new Map<string, IndexedPoolEventInput>();
  for (const event of events) {
    unique.set(`${event.transactionHash}:${String(event.logIndex)}`, event);
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
    const tuples = batch.map((event, index) => {
      const base = index * indexedPoolEventColumnCount + 1;
      values.push(
        event.transactionHash,
        event.logIndex,
        event.blockNumber,
        event.blockHash,
        event.blockTimestamp,
        event.poolId,
        event.eventKind,
        JSON.stringify(event.payload),
        event.amount0,
        event.amount1,
        event.sqrtPriceX96,
        false,
      );
      return `($1, $${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}::numeric, $${String(base + 4)}, $${String(base + 5)}::timestamptz, $${String(base + 6)}::uuid, $${String(base + 7)}, $${String(base + 8)}::jsonb, $${String(base + 9)}::numeric, $${String(base + 10)}::numeric, $${String(base + 11)}::numeric, $${String(base + 12)})`;
    });
    await client.query<Record<string, unknown>>({
      text: `
        insert into public.indexed_pool_events (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          block_timestamp, pool_id, event_kind, payload, amount0, amount1,
          sqrt_price_x96, removed
        )
        values ${tuples.join(", ")}
        on conflict (chain_id, transaction_hash, log_index) do update set
          block_number = excluded.block_number,
          block_hash = excluded.block_hash,
          block_timestamp = excluded.block_timestamp,
          pool_id = excluded.pool_id,
          event_kind = excluded.event_kind,
          payload = excluded.payload,
          amount0 = excluded.amount0,
          amount1 = excluded.amount1,
          sqrt_price_x96 = excluded.sqrt_price_x96,
          removed = false,
          observed_at = clock_timestamp()
      `,
      values,
    });
  }
}

/**
 * Advances one lane's checkpoint inside the caller's transaction. Each lane
 * owns its own row, so the transfer and pool lanes never overwrite each other.
 */
async function upsertCheckpoint(
  client: PoolClient,
  lane: IndexerLane,
  chainId: string,
  checkpoint: CommitTransferSegmentInput["checkpoint"],
  reorged: boolean,
  approvalCoverageFromBlockNumber: string | null,
): Promise<IndexerCheckpointRecord> {
  // `least` ignores nulls, so a segment without coverage keeps the stored
  // value and the pool lane (always null) never gains one.
  const result = await client.query<Record<string, unknown>>({
    text: `
      insert into public.indexer_checkpoints (
        lane, chain_id, last_block_number, last_block_hash,
        started_from_block_number, reorg_count, approval_coverage_from_block
      )
      values ($1, $2, $3::numeric, $4, $5::numeric, $6, $7::numeric)
      on conflict (lane, chain_id) do update set
        last_block_number = excluded.last_block_number,
        last_block_hash = excluded.last_block_hash,
        reorg_count = public.indexer_checkpoints.reorg_count + $6,
        approval_coverage_from_block = least(
          public.indexer_checkpoints.approval_coverage_from_block,
          excluded.approval_coverage_from_block
        ),
        updated_at = clock_timestamp()
      returning ${checkpointColumns}
    `,
    values: [
      lane,
      chainId,
      checkpoint.lastBlockNumber,
      checkpoint.lastBlockHash,
      checkpoint.startedFromBlockNumber,
      reorged ? 1 : 0,
      approvalCoverageFromBlockNumber,
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new BscIndexerUnavailableError();
  }
  return mapCheckpoint(row);
}

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
          // Approvals ride the same lane and rewind with it.
          await client.query<Record<string, unknown>>({
            text: `
              update public.indexed_approvals
              set removed = true, observed_at = clock_timestamp()
              where chain_id = $1 and block_number >= $2::numeric
            `,
            values: [input.chainId, rewindFrom],
          });
        }

        await insertTransfers(client, input.chainId, input.transfers);
        await insertApprovals(client, input.chainId, input.approvals ?? []);

        const committed = await upsertCheckpoint(
          client,
          "erc20_transfer",
          input.chainId,
          input.checkpoint,
          rewindFrom !== undefined,
          input.approvalCoverageFromBlockNumber ?? null,
        );
        await client.query("commit");
        inTransaction = false;
        return committed;
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

    async commitApprovalCoverageSegment(
      input: CommitApprovalCoverageSegmentInput,
    ): Promise<IndexerCheckpointRecord> {
      if (BigInt(input.toBlockNumber) < BigInt(input.fromBlockNumber)) {
        throw new BscIndexerUnavailableError();
      }
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("begin");
        inTransaction = true;
        // Lock the lane row so a concurrent segment commit cannot interleave
        // with the coverage update; the range must already be indexed.
        const current = await client.query<Record<string, unknown>>({
          text: `
            select ${checkpointColumns}
            from public.indexer_checkpoints
            where lane = 'erc20_transfer' and chain_id = $1
            for update
          `,
          values: [input.chainId],
        });
        const row = current.rows[0];
        if (
          row === undefined ||
          BigInt(mapCheckpoint(row).lastBlockNumber) <
            BigInt(input.toBlockNumber)
        ) {
          throw new BscIndexerUnavailableError();
        }
        await insertApprovals(client, input.chainId, input.approvals);
        const updated = await client.query<Record<string, unknown>>({
          text: `
            update public.indexer_checkpoints
            set approval_coverage_from_block = least(
                  approval_coverage_from_block, $2::numeric
                ),
                updated_at = clock_timestamp()
            where lane = 'erc20_transfer' and chain_id = $1
            returning ${checkpointColumns}
          `,
          values: [input.chainId, input.fromBlockNumber],
        });
        const committedRow = updated.rows[0];
        if (committedRow === undefined) {
          throw new BscIndexerUnavailableError();
        }
        await client.query("commit");
        inTransaction = false;
        return mapCheckpoint(committedRow);
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

    async earliestWalletActivityBlockNumber(input: {
      readonly chainId: string;
      readonly address: string;
    }): Promise<string | null> {
      // Preflight B1 (2026-09-16): one `min()` over `from = $2 or to = $2`
      // made the planner walk `indexed_transfers_block_idx` ascending and
      // filter the whole table (79M rows, 37.6 s on the development
      // database, cancelled by the 5 s statement timeout). Taking each
      // address side separately lets every branch finish with a single
      // backward step on its own `(chain_id, address, block_number desc)`
      // index; the outer `min` merges the two (0.07 ms on the same data).
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select min(sides.block_number)::text as block_number
          from (
            select min(block_number) as block_number
            from public.indexed_transfers
            where chain_id = $1
              and from_address = $2
              and not removed
            union all
            select min(block_number) as block_number
            from public.indexed_transfers
            where chain_id = $1
              and to_address = $2
              and not removed
          ) as sides
        `,
        values: [input.chainId, input.address],
      });
      const parsed = z
        .object({ block_number: bigintStringSchema.nullable() })
        .strict()
        .parse(result.rows[0] ?? { block_number: null });
      return parsed.block_number;
    },

    async listLatestApprovals(
      input: ListWalletApprovalsInput,
    ): Promise<readonly IndexedApprovalRecord[]> {
      if (input.assetIds.length === 0) {
        return Object.freeze([]);
      }
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select distinct on (asset_id, spender_address) ${approvalColumns}
          from public.indexed_approvals
          where chain_id = $1
            and owner_address = $2
            and asset_id = any($3::text[])
            and not removed
          order by asset_id, spender_address, block_number desc, log_index desc
        `,
        values: [input.chainId, input.ownerAddress, [...input.assetIds]],
      });
      const rows = result.rows.map(mapApproval);
      rows.sort((left, right) => {
        const byBlock = BigInt(right.blockNumber) - BigInt(left.blockNumber);
        if (byBlock !== 0n) {
          return byBlock > 0n ? 1 : -1;
        }
        return right.logIndex - left.logIndex;
      });
      return Object.freeze(rows);
    },

    async hasOutgoingTransferTo(input: {
      readonly chainId: string;
      readonly fromAddress: string;
      readonly toAddress: string;
    }): Promise<boolean> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select 1
          from public.indexed_transfers
          where chain_id = $1
            and from_address = $2
            and to_address = $3
            and not removed
          limit 1
        `,
        values: [input.chainId, input.fromAddress, input.toAddress],
      });
      return result.rows.length > 0;
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

    async commitPoolEventSegment(
      input: CommitPoolEventSegmentInput,
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
              update public.indexed_pool_events
              set removed = true, observed_at = clock_timestamp()
              where chain_id = $1 and block_number >= $2::numeric
            `,
            values: [input.chainId, rewindFrom],
          });
        }
        await insertPoolEvents(client, input.chainId, input.events);
        const committed = await upsertCheckpoint(
          client,
          "pool_event",
          input.chainId,
          input.checkpoint,
          rewindFrom !== undefined,
          null,
        );
        await client.query("commit");
        inTransaction = false;
        return committed;
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

    async listPoolSwaps(input: ListPoolSwapsInput): Promise<PoolSwapPage> {
      if (input.poolIds.length === 0) {
        return Object.freeze({ items: Object.freeze([]), hasMore: false });
      }
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${poolEventColumns}
          from public.indexed_pool_events
          where pool_id = any($1::uuid[])
            and event_kind = 'swap'
            and (
              $2::numeric is null
              or block_number < $2::numeric
              or (block_number = $2::numeric and log_index < $3::int)
            )
          order by block_number desc, log_index desc
          limit $4
        `,
        values: [
          [...input.poolIds],
          input.beforeBlockNumber ?? null,
          input.beforeLogIndex ?? null,
          input.limit + 1,
        ],
      });
      const rows = result.rows.map(mapPoolEvent);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit)),
        hasMore: rows.length > input.limit,
      });
    },

    async aggregateSwapCandles(
      input: AggregateSwapCandlesInput,
    ): Promise<readonly SwapCandleBucket[]> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          with swaps as (
            select
              block_number,
              log_index,
              sqrt_price_x96,
              abs(case when $3::boolean then amount0 else amount1 end) as amount_asset,
              date_bin(
                make_interval(secs => $2::int),
                block_timestamp,
                timestamptz 'epoch'
              ) as bucket
            from public.indexed_pool_events
            where pool_id = $1::uuid
              and event_kind = 'swap'
              and not removed
              and block_timestamp >= $4::timestamptz
              and block_timestamp < $5::timestamptz
          )
          select
            bucket,
            (array_agg(sqrt_price_x96::text order by block_number asc, log_index asc))[1]
              as open_sqrt,
            (array_agg(sqrt_price_x96::text order by block_number desc, log_index desc))[1]
              as close_sqrt,
            max(sqrt_price_x96)::text as high_sqrt,
            min(sqrt_price_x96)::text as low_sqrt,
            sum(amount_asset)::text as volume_raw,
            count(*)::int as swap_count
          from swaps
          group by bucket
          order by bucket asc
        `,
        values: [
          input.poolId,
          input.intervalSeconds,
          input.assetIsToken0,
          input.fromTimestamp,
          input.toTimestamp,
        ],
      });
      const bucketSchema = z
        .object({
          bucket: z.date(),
          open_sqrt: bigintStringSchema,
          close_sqrt: bigintStringSchema,
          high_sqrt: bigintStringSchema,
          low_sqrt: bigintStringSchema,
          volume_raw: bigintStringSchema,
          swap_count: z.number().int().min(1),
        })
        .strict();
      return Object.freeze(
        result.rows.map((row) => {
          const parsed = bucketSchema.parse(row);
          return Object.freeze({
            bucketStart: parsed.bucket.toISOString(),
            openSqrtPriceX96: parsed.open_sqrt,
            closeSqrtPriceX96: parsed.close_sqrt,
            highSqrtPriceX96: parsed.high_sqrt,
            lowSqrtPriceX96: parsed.low_sqrt,
            volumeRaw: parsed.volume_raw,
            swapCount: parsed.swap_count,
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
    commitApprovalCoverageSegment: unavailable,
    earliestWalletActivityBlockNumber: unavailable,
    commitTransferSegment: unavailable,
    listLatestApprovals: unavailable,
    hasOutgoingTransferTo: unavailable,
    listWalletTransfers: unavailable,
    sumPendingIncoming: unavailable,
    commitPoolEventSegment: unavailable,
    listPoolSwaps: unavailable,
    aggregateSwapCandles: unavailable,
  });
}
