import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { z } from "zod";

import {
  launchChainIds,
  type LaunchChainId,
} from "../features/chain/chain-contract.js";
import {
  LaunchChainRepositoryUnavailableError,
  LaunchIntentIdempotencyConflictError,
  LaunchIntentReportConflictError,
  LaunchSaleRegistrationError,
  launchIntentStates,
  launchAllowlistModes,
  launchEventLane,
  type CommitLaunchSegmentInput,
  type LaunchAllowlistMode,
  type LaunchAllowlistRootRecord,
  type LaunchChainRepository,
  type LaunchCheckpointRecord,
  type LaunchIntentRecord,
  type LaunchStateProjectionRecord,
  type RegisterLaunchSaleInput,
} from "../features/launch/launch-chain-repository.js";
import {
  launchEntitlementStates,
  launchLiquidityStates,
  launchOperationalStates,
  launchSaleStates,
} from "../features/launch/launch-contract.js";
import {
  bytes32ToColumn,
  columnToBytes32,
} from "../features/launch/launch-merkle.js";
import {
  claimV2Command,
  lockV2Owner,
  toIsoString,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";

/**
 * PostgreSQL side of the Launch chain facts (Decision 0077). The lane
 * commits a segment in one transaction: rewind, raw events, the derived
 * projections of every touched launch, the `getState` axes, confirmation
 * states, and the checkpoint. Projections are recomputed from
 * `launch_indexed_events`, never incremented, so a replayed or rewound
 * segment converges to the same rows with the same opaque IDs.
 */

export const launchIntentDigestVersion = "launch_intent_v1" as const;
export const launchIntentIdempotencyScope = "v2_launch_intent" as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = z.string().regex(uuidPattern);
const uuidV4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const blockSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const rawSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const dateSchema = z.date();

function unavailable(): LaunchChainRepositoryUnavailableError {
  return new LaunchChainRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof LaunchChainRepositoryUnavailableError ||
    error instanceof LaunchIntentIdempotencyConflictError ||
    error instanceof LaunchIntentReportConflictError ||
    error instanceof LaunchSaleRegistrationError
  ) {
    throw error;
  }
  throw unavailable();
}

const checkpointRowSchema = z.object({
  last_block_number: blockSchema,
  last_block_hash: hashSchema,
  started_from_block_number: blockSchema,
  updated_at: dateSchema,
});

const projectionRowSchema = z.object({
  launch_id: uuidSchema,
  sale_state: z.enum(launchSaleStates),
  entitlement_state: z.enum(launchEntitlementStates),
  liquidity_state: z.enum(launchLiquidityStates),
  operational_state: z.enum(launchOperationalStates),
  state_tuple_digest: sha256Schema,
  state_config_version: sha256Schema,
  snapshot_block_number: blockSchema,
  snapshot_block_hash: hashSchema,
});

const rootRowSchema = z.object({
  allowlist_root_id: uuidSchema,
  launch_id: uuidSchema,
  round_index: z.number().int(),
  snapshot_block: blockSchema,
  snapshot_block_hash: hashSchema,
  root: sha256Schema,
  leaf_count: z.number().int().min(1),
  mode: z.enum(launchAllowlistModes),
  members: z.array(addressSchema),
  computed_at: dateSchema,
});

function mapRoot(raw: unknown): LaunchAllowlistRootRecord {
  const row = rootRowSchema.parse(raw);
  return Object.freeze({
    allowlistRootId: row.allowlist_root_id,
    launchId: row.launch_id,
    roundIndex: row.round_index,
    snapshotBlock: row.snapshot_block,
    snapshotBlockHash: row.snapshot_block_hash,
    root: columnToBytes32(row.root),
    leafCount: row.leaf_count,
    mode: row.mode,
    members: Object.freeze([...row.members]),
    computedAt: toIsoString(row.computed_at),
  });
}

const intentColumns = `
  intent_id, owner_user_id, wallet_id, launch_id, project_id, round_id,
  round_index, sale_id::text as sale_id, chain_id, quote_asset_id, project_asset_id,
  pay_amount_raw::text as pay_amount_raw,
  expected_receive_raw::text as expected_receive_raw,
  min_token_amount_raw::text as min_token_amount_raw,
  config_version, wallet_cumulative_raw::text as wallet_cumulative_raw,
  contract_address, state_tuple_digest,
  snapshot_block_number::text as snapshot_block_number, snapshot_block_hash,
  payload_digest, state, deadline, eligibility_proof, unsigned_transaction,
  policy, expires_at, created_at, transaction_hash, payload_verified, reported_at,
  receipt, reason_code, revert_reason
`;

const intentReceiptSchema = z.object({
  status: z.enum(["success", "reverted"]),
  blockNumber: blockSchema,
  blockHash: hashSchema,
  gasUsed: rawSchema,
  effectiveGasPrice: rawSchema,
  confirmations: z.number().int().nonnegative(),
  observedAt: z.string(),
});

const intentRowSchema = z.object({
  intent_id: uuidSchema,
  owner_user_id: uuidSchema,
  wallet_id: uuidSchema,
  launch_id: uuidSchema,
  project_id: uuidSchema,
  round_id: uuidSchema,
  round_index: z.number().int(),
  sale_id: z.string(),
  chain_id: z.enum(launchChainIds),
  quote_asset_id: z.string(),
  project_asset_id: z.string(),
  pay_amount_raw: rawSchema,
  expected_receive_raw: rawSchema,
  min_token_amount_raw: rawSchema,
  config_version: z.string(),
  wallet_cumulative_raw: rawSchema,
  contract_address: addressSchema,
  state_tuple_digest: sha256Schema,
  snapshot_block_number: blockSchema,
  snapshot_block_hash: hashSchema,
  payload_digest: sha256Schema,
  state: z.enum(launchIntentStates),
  deadline: dateSchema,
  eligibility_proof: z.array(z.string()),
  unsigned_transaction: z.record(z.string(), z.unknown()),
  policy: z.record(z.string(), z.unknown()),
  expires_at: dateSchema,
  created_at: dateSchema,
  transaction_hash: hashSchema.nullable(),
  payload_verified: z.boolean(),
  reported_at: dateSchema.nullable(),
  receipt: intentReceiptSchema.nullable(),
  reason_code: z.string().nullable(),
  revert_reason: z.string().nullable(),
});

function mapIntent(raw: unknown): LaunchIntentRecord {
  const row = intentRowSchema.parse(raw);
  return Object.freeze({
    intentId: row.intent_id,
    ownerUserId: row.owner_user_id,
    walletId: row.wallet_id,
    launchId: row.launch_id,
    projectId: row.project_id,
    roundId: row.round_id,
    roundIndex: row.round_index,
    saleId: row.sale_id,
    chainId: row.chain_id,
    quoteAssetId: row.quote_asset_id,
    projectAssetId: row.project_asset_id,
    payAmountRaw: row.pay_amount_raw,
    expectedReceiveRaw: row.expected_receive_raw,
    minTokenAmountRaw: row.min_token_amount_raw,
    configVersion: row.config_version,
    walletCumulativeRaw: row.wallet_cumulative_raw,
    contractAddress: row.contract_address,
    stateTupleDigest: columnToBytes32(row.state_tuple_digest),
    snapshotBlockNumber: row.snapshot_block_number,
    snapshotBlockHash: row.snapshot_block_hash,
    payloadDigest: row.payload_digest,
    state: row.state,
    deadline: toIsoString(row.deadline),
    eligibilityProof: Object.freeze([...row.eligibility_proof]),
    unsignedTransaction: Object.freeze({ ...row.unsigned_transaction }),
    policy: Object.freeze({ ...row.policy }),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    transactionHash: row.transaction_hash,
    payloadVerified: row.payload_verified,
    reportedAt: row.reported_at === null ? null : toIsoString(row.reported_at),
    receipt: row.receipt === null ? null : Object.freeze({ ...row.receipt }),
    reasonCode: row.reason_code,
    revertReason: row.revert_reason,
  });
}

/**
 * The single LOOP wallet a chain address resolves to. An address that two
 * accounts both list is ambiguous and resolves to nothing: no fact is
 * attributed to an account on a guess.
 */
const resolvedWalletsCte = `
  resolved as (
    select
      aw.address,
      (array_agg(aw.wallet_id order by aw.is_active desc, aw.first_seen_at, aw.wallet_id))[1] as wallet_id,
      (array_agg(aw.owner_user_id order by aw.is_active desc, aw.first_seen_at, aw.wallet_id))[1] as owner_user_id
    from public.account_wallets as aw
    where aw.chain_type = 'ethereum'
      and aw.address in (
        select e.wallet_address
        from public.launch_indexed_events as e
        where e.launch_id = $1 and e.wallet_address is not null
      )
    group by aw.address
    having count(distinct aw.owner_user_id) = 1
  )
`;

async function reprojectLaunch(
  client: DatabaseClient,
  launchId: string,
  confirmedThroughBlockNumber: string,
): Promise<void> {
  // Purchases: one row per Purchased log (reorged rows are kept).
  await client.query({
    text: `
      with ${resolvedWalletsCte}
      insert into public.purchase_records (
        launch_id, round_id, owner_user_id, wallet_id, quote_asset_id,
        paid_raw, expected_tokens_raw, transaction_hash, log_index,
        block_number, block_hash, confirmation_state, removed, chain_id, round_index,
        intent_id
      )
      select
        e.launch_id, r.round_id, w.owner_user_id, w.wallet_id, l.quote_asset_id,
        (e.payload ->> 'usd1Amount')::numeric,
        (e.payload ->> 'tokenAmount')::numeric,
        e.transaction_hash, e.log_index, e.block_number, e.block_hash,
        case
          when e.removed then 'reorged'
          when e.block_number <= $2::numeric then 'confirmed'
          else 'pending'
        end,
        e.removed, e.chain_id, (e.payload ->> 'roundId')::integer,
        (
          select li.intent_id from public.launch_intents as li
          where li.transaction_hash = e.transaction_hash
            and li.wallet_id = w.wallet_id
          limit 1
        )
      from public.launch_indexed_events as e
      join public.launches as l on l.launch_id = e.launch_id
      join resolved as w on w.address = e.wallet_address
      left join public.launch_rounds as r
        on r.launch_id = e.launch_id
        and r.round_index = (e.payload ->> 'roundId')::integer
      where e.launch_id = $1
        and e.event_name = 'Purchased'
        and l.quote_asset_id is not null
      on conflict (transaction_hash, log_index) do update set
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        removed = excluded.removed,
        confirmation_state = excluded.confirmation_state,
        intent_id = coalesce(excluded.intent_id, public.purchase_records.intent_id),
        observed_at = clock_timestamp()
    `,
    values: [launchId, confirmedThroughBlockNumber],
  });
  // A reported Intent is confirmed by a surviving Purchased log of its
  // transaction or by a finalized success receipt the reconcile lane stored
  // (Decision 0080, first evidence wins); a reorg of the log alone sends it
  // back to submitted. A Purchased log also confirms an Intent the lane
  // expired, since evidence outranks the absence of a receipt. `reverted`
  // and `failed` are never touched: a reverted transaction emits no log.
  await client.query({
    text: `
      update public.launch_intents as li
      set
        state = case
          when exists (
            select 1 from public.launch_indexed_events as e
            where e.launch_id = li.launch_id and e.event_name = 'Purchased'
              and e.transaction_hash = li.transaction_hash and not e.removed
          ) or li.receipt ->> 'status' = 'success' then 'confirmed'
          when li.state = 'expired' then 'expired'
          else 'submitted'
        end,
        updated_at = clock_timestamp()
      where li.launch_id = $1
        and li.transaction_hash is not null
        and li.state in ('submitted', 'confirmed', 'expired')
    `,
    values: [launchId],
  });

  // Entitlements exist only after SaleFinalized(SUCCEEDED) and the vesting
  // schedule; the frozen amount is the wallet's observed purchased tokens.
  const entitled = await client.query<{ wallet_id: string }>({
    text: `
      with ${resolvedWalletsCte},
      finalized as (
        select block_number
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'SaleFinalized' and not removed
          and payload ->> 'outcome' = 'SUCCEEDED'
        order by block_number desc, log_index desc
        limit 1
      ),
      vesting as (
        select payload
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'VestingScheduleCreated' and not removed
        order by block_number desc, log_index desc
        limit 1
      ),
      bought as (
        select wallet_address, sum((payload ->> 'tokenAmount')::numeric) as total
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'Purchased' and not removed
        group by wallet_address
      ),
      claimed as (
        select wallet_address, max((payload ->> 'cumulativeClaimed')::numeric) as claimed
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'Claimed' and not removed
        group by wallet_address
      )
      insert into public.entitlements (
        launch_id, owner_user_id, wallet_id, project_asset_id, total_raw,
        claimed_raw, vesting_schedule, state, frozen_at_block
      )
      select
        $1, w.owner_user_id, w.wallet_id, l.project_asset_id, b.total,
        coalesce(c.claimed, 0), v.payload,
        case
          when coalesce(c.claimed, 0) = 0 then 'frozen'
          when coalesce(c.claimed, 0) < b.total then 'partially_claimed'
          else 'claimed'
        end,
        f.block_number
      from bought as b
      join resolved as w on w.address = b.wallet_address
      join public.launches as l on l.launch_id = $1
      cross join finalized as f
      cross join vesting as v
      left join claimed as c on c.wallet_address = b.wallet_address
      where l.project_asset_id is not null
        and b.total > 0
        and coalesce(c.claimed, 0) <= b.total
      on conflict (launch_id, wallet_id) do update set
        total_raw = excluded.total_raw,
        claimed_raw = excluded.claimed_raw,
        vesting_schedule = excluded.vesting_schedule,
        state = excluded.state,
        frozen_at_block = excluded.frozen_at_block,
        updated_at = clock_timestamp()
      returning wallet_id
    `,
    values: [launchId],
  });
  await client.query({
    text: `
      delete from public.entitlements
      where launch_id = $1 and not (wallet_id = any($2::uuid[]))
    `,
    values: [launchId, entitled.rows.map((row) => row.wallet_id)],
  });

  // Refund liabilities: one per wallet, 100 % of the frozen USD1.
  const liable = await client.query<{ wallet_id: string }>({
    text: `
      with ${resolvedWalletsCte},
      frozen as (
        select distinct on (wallet_address)
          wallet_address, (payload ->> 'usd1Amount')::numeric as amount, block_number
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'RefundLiabilityFrozen' and not removed
        order by wallet_address, block_number desc, log_index desc
      ),
      refunded as (
        select wallet_address, max((payload ->> 'cumulativeRefunded')::numeric) as refunded
        from public.launch_indexed_events
        where launch_id = $1 and event_name = 'Refunded' and not removed
        group by wallet_address
      )
      insert into public.refund_liabilities (
        launch_id, owner_user_id, wallet_id, quote_asset_id, amount_raw,
        refunded_raw, state, frozen_at_block
      )
      select
        $1, w.owner_user_id, w.wallet_id, l.quote_asset_id, fr.amount,
        coalesce(rf.refunded, 0),
        case
          when coalesce(rf.refunded, 0) = 0 then 'frozen'
          when coalesce(rf.refunded, 0) < fr.amount then 'partially_refunded'
          else 'refunded'
        end,
        fr.block_number
      from frozen as fr
      join resolved as w on w.address = fr.wallet_address
      join public.launches as l on l.launch_id = $1
      left join refunded as rf on rf.wallet_address = fr.wallet_address
      where l.quote_asset_id is not null
        and coalesce(rf.refunded, 0) <= fr.amount
      on conflict (launch_id, wallet_id) do update set
        amount_raw = excluded.amount_raw,
        refunded_raw = excluded.refunded_raw,
        state = excluded.state,
        frozen_at_block = excluded.frozen_at_block,
        updated_at = clock_timestamp()
      returning wallet_id
    `,
    values: [launchId],
  });
  const liableWallets = liable.rows.map((row) => row.wallet_id);
  await client.query({
    text: `
      delete from public.refund_claims
      where refund_liability_id in (
        select refund_liability_id from public.refund_liabilities
        where launch_id = $1 and not (wallet_id = any($2::uuid[]))
      )
    `,
    values: [launchId, liableWallets],
  });
  await client.query({
    text: `
      delete from public.refund_liabilities
      where launch_id = $1 and not (wallet_id = any($2::uuid[]))
    `,
    values: [launchId, liableWallets],
  });
  // One refund claim per Refunded log (reorged rows are kept, removed).
  await client.query({
    text: `
      insert into public.refund_claims (
        refund_liability_id, wallet_id, amount_raw, state, transaction_hash,
        log_index, block_number, removed
      )
      select
        rl.refund_liability_id, rl.wallet_id, (e.payload ->> 'usd1Amount')::numeric,
        'confirmed', e.transaction_hash, e.log_index, e.block_number, e.removed
      from public.launch_indexed_events as e
      join public.account_wallets as aw
        on aw.address = e.wallet_address and aw.chain_type = 'ethereum'
      join public.refund_liabilities as rl
        on rl.launch_id = e.launch_id and rl.wallet_id = aw.wallet_id
      where e.launch_id = $1 and e.event_name = 'Refunded'
      on conflict (transaction_hash, log_index)
        where transaction_hash is not null and log_index is not null
      do update set
        removed = excluded.removed,
        block_number = excluded.block_number,
        updated_at = clock_timestamp()
    `,
    values: [launchId],
  });

  // Pool and LP facts: the latest surviving event of each kind.
  await client.query({
    text: `
      with latest as (
        select distinct on (event_name) event_name, payload
        from public.launch_indexed_events
        where launch_id = $1 and not removed
          and event_name in ('PoolPrepared', 'LiquidityAdded', 'LPNFTLocked')
        order by event_name, block_number desc, log_index desc
      ),
      pool_address as (
        select coalesce(
          (select payload ->> 'pool' from latest where event_name = 'LiquidityAdded'),
          (select payload ->> 'pool' from latest where event_name = 'PoolPrepared')
        ) as address
      )
      update public.launches as l set
        pool_address = pa.address,
        pool_id = (
          select p.pool_id from public.pools as p
          where p.chain_id = l.chain_id and p.address = pa.address
        ),
        lp_token_id = coalesce(
          (select (payload ->> 'lpTokenId')::numeric from latest where event_name = 'LPNFTLocked'),
          (select (payload ->> 'lpTokenId')::numeric from latest where event_name = 'LiquidityAdded')
        ),
        lp_unlock_at = (
          select to_timestamp((payload ->> 'unlockAt')::numeric)
          from latest where event_name = 'LPNFTLocked'
        ),
        updated_at = clock_timestamp()
      from pool_address as pa
      where l.launch_id = $1
    `,
    values: [launchId],
  });
}

export function createPostgresLaunchChainRepository(
  pool: Pool,
): LaunchChainRepository {
  const repository: LaunchChainRepository = {
    async getCheckpoint(chainId: LaunchChainId) {
      try {
        const result = await pool.query({
          text: `
            select
              last_block_number::text as last_block_number, last_block_hash,
              started_from_block_number::text as started_from_block_number, updated_at
            from public.indexer_checkpoints
            where lane = $1 and chain_id = $2
          `,
          values: [launchEventLane, chainId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = checkpointRowSchema.parse(raw);
        const record: LaunchCheckpointRecord = Object.freeze({
          lastBlockNumber: row.last_block_number,
          lastBlockHash: row.last_block_hash,
          startedFromBlockNumber: row.started_from_block_number,
          updatedAt: toIsoString(row.updated_at),
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async resetCheckpoint(chainId: LaunchChainId) {
      try {
        const result = await pool.query({
          text: `delete from public.indexer_checkpoints where lane = $1 and chain_id = $2`,
          values: [launchEventLane, chainId],
        });
        return (result.rowCount ?? 0) > 0;
      } catch (error) {
        return translate(error);
      }
    },

    async listRegisteredSales(input) {
      try {
        const result = await pool.query<{
          launch_id: string;
          sale_id: string;
          chain_id: LaunchChainId;
          contract_address: string;
          contract_version: string;
        }>({
          text: `
            select launch_id, sale_id::text as sale_id, chain_id, contract_address, contract_version
            from public.launches
            where sale_id is not null
              and chain_id = $1 and contract_address = $2 and contract_version = $3
            order by sale_id
          `,
          values: [input.chainId, input.contractAddress, input.contractVersion],
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              launchId: row.launch_id,
              saleId: row.sale_id,
              chainId: row.chain_id,
              contractAddress: row.contract_address,
              contractVersion: row.contract_version,
            }),
          ),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async commitSegment(input: CommitLaunchSegmentInput) {
      try {
        const confirmedThrough = blockSchema.parse(
          input.confirmedThroughBlockNumber,
        );
        await withV2Transaction(pool, unavailable, async (client) => {
          const touched = new Set<string>();
          if (input.rewindFromBlockNumber !== undefined) {
            const rewound = await client.query<{ launch_id: string }>({
              text: `
                update public.launch_indexed_events
                set removed = true, observed_at = clock_timestamp()
                where chain_id = $1 and block_number >= $2::numeric and not removed
                returning launch_id
              `,
              values: [
                input.chainId,
                blockSchema.parse(input.rewindFromBlockNumber),
              ],
            });
            for (const row of rewound.rows) {
              touched.add(row.launch_id);
            }
          }
          for (const event of input.events) {
            await client.query({
              text: `
                insert into public.launch_indexed_events (
                  chain_id, transaction_hash, log_index, block_number, block_hash,
                  contract_address, sale_id, launch_id, event_name, wallet_address,
                  payload, removed
                )
                values ($1, $2, $3, $4::numeric, $5, $6, $7::numeric, $8, $9, $10, $11::jsonb, $12)
                on conflict (chain_id, transaction_hash, log_index) do update set
                  block_number = excluded.block_number,
                  block_hash = excluded.block_hash,
                  payload = excluded.payload,
                  removed = excluded.removed,
                  observed_at = clock_timestamp()
              `,
              values: [
                input.chainId,
                hashSchema.parse(event.transactionHash),
                event.logIndex,
                blockSchema.parse(event.blockNumber),
                hashSchema.parse(event.blockHash),
                addressSchema.parse(event.contractAddress),
                event.saleId,
                uuidSchema.parse(event.launchId),
                event.eventName,
                event.walletAddress,
                JSON.stringify(event.payload),
                event.removed,
              ],
            });
            touched.add(event.launchId);
          }
          for (const launchId of [...touched].sort()) {
            await reprojectLaunch(client, launchId, confirmedThrough);
          }
          for (const projection of input.projections) {
            await client.query({
              text: `
                update public.launches set
                  sale_state = $2,
                  entitlement_state = $3,
                  liquidity_state = $4,
                  operational_state = $5,
                  state_tuple_digest = $6,
                  state_config_version = $7,
                  snapshot_block_number = $8::numeric,
                  snapshot_block_hash = $9,
                  record_version = record_version + 1,
                  updated_at = clock_timestamp()
                where launch_id = $1
              `,
              values: [
                uuidSchema.parse(projection.launchId),
                projection.saleState,
                projection.entitlementState,
                projection.liquidityState,
                projection.operationalState,
                bytes32ToColumn(projection.stateTupleDigest),
                bytes32ToColumn(projection.configVersion),
                blockSchema.parse(projection.snapshotBlockNumber),
                hashSchema.parse(projection.snapshotBlockHash),
              ],
            });
          }
          await client.query({
            text: `
              update public.purchase_records
              set confirmation_state = 'confirmed', observed_at = clock_timestamp()
              where chain_id = $1 and not removed and confirmation_state = 'pending'
                and block_number <= $2::numeric
            `,
            values: [input.chainId, confirmedThrough],
          });
          await client.query({
            text: `
              insert into public.indexer_checkpoints (
                lane, chain_id, last_block_number, last_block_hash,
                started_from_block_number, reorg_count
              )
              values ($1, $2, $3::numeric, $4, $5::numeric, $6)
              on conflict (lane, chain_id) do update set
                last_block_number = excluded.last_block_number,
                last_block_hash = excluded.last_block_hash,
                reorg_count = public.indexer_checkpoints.reorg_count + $6,
                updated_at = clock_timestamp()
            `,
            values: [
              launchEventLane,
              input.chainId,
              blockSchema.parse(input.checkpoint.lastBlockNumber),
              hashSchema.parse(input.checkpoint.lastBlockHash),
              blockSchema.parse(input.checkpoint.startedFromBlockNumber),
              input.rewindFromBlockNumber === undefined ? 0 : 1,
            ],
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listStateProjections(launchIds) {
      try {
        if (launchIds.length === 0) {
          return new Map();
        }
        const result = await pool.query({
          text: `
            select
              launch_id, sale_state, entitlement_state, liquidity_state, operational_state,
              state_tuple_digest, state_config_version,
              snapshot_block_number::text as snapshot_block_number, snapshot_block_hash
            from public.launches
            where launch_id = any($1::uuid[])
              and sale_state <> 'unavailable'
              and state_config_version is not null
          `,
          values: [launchIds.map((id) => uuidSchema.parse(id))],
        });
        const map = new Map<string, LaunchStateProjectionRecord>();
        for (const raw of result.rows) {
          const row = projectionRowSchema.parse(raw);
          map.set(
            row.launch_id,
            Object.freeze({
              launchId: row.launch_id,
              saleState: row.sale_state,
              entitlementState: row.entitlement_state,
              liquidityState: row.liquidity_state,
              operationalState: row.operational_state,
              configVersion: columnToBytes32(row.state_config_version),
              stateTupleDigest: columnToBytes32(row.state_tuple_digest),
              snapshotBlockNumber: row.snapshot_block_number,
              snapshotBlockHash: row.snapshot_block_hash,
            }),
          );
        }
        return map;
      } catch (error) {
        return translate(error);
      }
    },

    async countHolders(launchId) {
      try {
        const result = await pool.query<{ count: number }>({
          text: `
            select count(distinct wallet_address)::int as count
            from public.launch_indexed_events
            where launch_id = $1 and event_name = 'Purchased' and not removed
          `,
          values: [uuidSchema.parse(launchId)],
        });
        return result.rows[0]?.count ?? 0;
      } catch (error) {
        return translate(error);
      }
    },

    async listHistory(input) {
      try {
        const launchId = uuidSchema.parse(input.launchId);
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const limit = z.number().int().min(1).max(500).parse(input.limit);
        const [purchases, entitlements, refunds] = await Promise.all([
          pool.query<Record<string, unknown>>({
            text: `
              select
                pr.purchase_record_id, pr.wallet_id,
                coalesce(pr.round_id, r.round_id) as round_id, pr.round_index,
                pr.paid_raw::text as paid_raw,
                pr.expected_tokens_raw::text as expected_tokens_raw,
                pr.transaction_hash, pr.log_index,
                pr.block_number::text as block_number, pr.block_hash,
                pr.confirmation_state, pr.observed_at
              from public.purchase_records as pr
              left join public.launch_rounds as r
                on r.launch_id = pr.launch_id and r.round_index = pr.round_index
              where pr.launch_id = $1 and pr.owner_user_id = $2 and pr.round_index is not null
              order by pr.block_number desc, pr.log_index desc
              limit $3
            `,
            values: [launchId, ownerUserId, limit],
          }),
          pool.query<Record<string, unknown>>({
            text: `
              select entitlement_id, wallet_id, total_raw::text as total_raw,
                claimed_raw::text as claimed_raw, state,
                frozen_at_block::text as frozen_at_block
              from public.entitlements
              where launch_id = $1 and owner_user_id = $2
              order by created_at, entitlement_id
              limit $3
            `,
            values: [launchId, ownerUserId, limit],
          }),
          pool.query<Record<string, unknown>>({
            text: `
              select refund_liability_id, wallet_id, amount_raw::text as amount_raw,
                refunded_raw::text as refunded_raw, state,
                frozen_at_block::text as frozen_at_block
              from public.refund_liabilities
              where launch_id = $1 and owner_user_id = $2
              order by created_at, refund_liability_id
              limit $3
            `,
            values: [launchId, ownerUserId, limit],
          }),
        ]);
        return Object.freeze({
          purchaseRecords: Object.freeze(
            purchases.rows.map((row) =>
              Object.freeze({
                purchaseRecordId: uuidSchema.parse(row["purchase_record_id"]),
                walletId: uuidSchema.parse(row["wallet_id"]),
                roundId:
                  row["round_id"] === null
                    ? null
                    : uuidSchema.parse(row["round_id"]),
                roundIndex: z.number().int().parse(row["round_index"]),
                usd1Amount: rawSchema.parse(row["paid_raw"]),
                tokenAmount: rawSchema.parse(row["expected_tokens_raw"]),
                transactionHash: hashSchema.parse(row["transaction_hash"]),
                logIndex: z.number().int().parse(row["log_index"]),
                blockNumber: blockSchema.parse(row["block_number"]),
                blockHash: hashSchema.parse(row["block_hash"]),
                confirmationState: z
                  .enum(["pending", "confirmed", "reorged"])
                  .parse(row["confirmation_state"]),
                observedAt: toIsoString(dateSchema.parse(row["observed_at"])),
              }),
            ),
          ),
          entitlements: Object.freeze(
            entitlements.rows.map((row) =>
              Object.freeze({
                entitlementId: uuidSchema.parse(row["entitlement_id"]),
                walletId: uuidSchema.parse(row["wallet_id"]),
                entitledTokens: rawSchema.parse(row["total_raw"]),
                claimedTokens: rawSchema.parse(row["claimed_raw"]),
                state: z
                  .enum(["frozen", "partially_claimed", "claimed"])
                  .parse(row["state"]),
                frozenAtBlock: blockSchema
                  .nullable()
                  .parse(row["frozen_at_block"]),
              }),
            ),
          ),
          refunds: Object.freeze(
            refunds.rows.map((row) =>
              Object.freeze({
                refundLiabilityId: uuidSchema.parse(row["refund_liability_id"]),
                walletId: uuidSchema.parse(row["wallet_id"]),
                refundableUsd1: rawSchema.parse(row["amount_raw"]),
                refundedUsd1: rawSchema.parse(row["refunded_raw"]),
                state: z
                  .enum(["frozen", "partially_refunded", "refunded"])
                  .parse(row["state"]),
                frozenAtBlock: blockSchema
                  .nullable()
                  .parse(row["frozen_at_block"]),
              }),
            ),
          ),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getEconomyChain(input) {
      try {
        const result = await pool.query<{
          registered: number;
          raised: string;
          locked: number;
        }>({
          text: `
            with sales as (
              select launch_id from public.launches
              where sale_id is not null and chain_id = $1
                and contract_address = $2 and contract_version = $3
            )
            select
              (select count(*)::int from sales) as registered,
              (
                select coalesce(sum((e.payload ->> 'totalRaisedUsd1')::numeric), 0)::text
                from public.launch_indexed_events as e
                where e.launch_id in (select launch_id from sales)
                  and e.event_name = 'SaleFinalized' and not e.removed
                  and e.payload ->> 'outcome' = 'SUCCEEDED'
              ) as raised,
              (
                select count(distinct e.launch_id)::int
                from public.launch_indexed_events as e
                where e.launch_id in (select launch_id from sales)
                  and e.event_name = 'LPNFTLocked' and not e.removed
              ) as locked
          `,
          values: [input.chainId, input.contractAddress, input.contractVersion],
        });
        const row = result.rows[0];
        return Object.freeze({
          registeredSaleCount: row?.registered ?? 0,
          totalRaisedUsd1: rawSchema.parse(row?.raised ?? "0"),
          lockedLpCount: row?.locked ?? 0,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async importAllowlist(input) {
      try {
        const launchId = uuidSchema.parse(input.launchId);
        const addresses = [...new Set(input.addresses)].map((address) =>
          addressSchema.parse(address),
        );
        return await withV2Transaction(pool, unavailable, async (client) => {
          const inserted = await client.query({
            text: `
              insert into public.launch_allowlists (launch_id, round_index, address, source)
              select $1, $2, address, $4 from unnest($3::text[]) as address
              on conflict (launch_id, round_index, address) do nothing
            `,
            values: [launchId, input.roundIndex, addresses, input.source],
          });
          const count = inserted.rowCount ?? 0;
          return Object.freeze({
            inserted: count,
            existing: addresses.length - count,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listAllowlist(launchId, roundIndex) {
      try {
        const result = await pool.query<{ address: string }>({
          text: `
            select address from public.launch_allowlists
            where launch_id = $1 and round_index = $2
            order by address
          `,
          values: [uuidSchema.parse(launchId), roundIndex],
        });
        return Object.freeze(result.rows.map((row) => row.address));
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunityMemberWallets(input) {
      try {
        const result = await pool.query<{ address: string }>({
          text: `
            select distinct aw.address
            from public.community_memberships as m
            join public.account_wallets as aw on aw.owner_user_id = m.owner_user_id
            where m.community_id = $1
              and m.status = 'active'
              and m.joined_at <= $2::timestamptz
              and aw.chain_type = 'ethereum'
              and aw.status = 'active'
              and aw.first_seen_at <= $2::timestamptz
            order by aw.address
          `,
          values: [uuidSchema.parse(input.communityId), input.at],
        });
        return Object.freeze(result.rows.map((row) => row.address));
      } catch (error) {
        return translate(error);
      }
    },

    async listActiveMinerWallets(input) {
      try {
        const result = await pool.query<{ address: string }>({
          text: `
            select distinct aw.address
            from public.mining_snapshot_powers as p
            join public.mining_snapshots as s on s.snapshot_id = p.snapshot_id
            join public.account_wallets as aw on aw.owner_user_id = p.owner_user_id
            where s.computed_at > $1::timestamptz
              and s.computed_at <= $2::timestamptz
              and s.status = 'complete'
              and p.power::numeric > 0
              and aw.chain_type = 'ethereum'
              and aw.status = 'active'
              and aw.first_seen_at <= $2::timestamptz
            order by aw.address
          `,
          values: [input.since, input.until],
        });
        return Object.freeze(result.rows.map((row) => row.address));
      } catch (error) {
        return translate(error);
      }
    },

    async insertAllowlistRoot(input) {
      try {
        const members = input.members.map((address) =>
          addressSchema.parse(address),
        );
        const mode: LaunchAllowlistMode = z
          .enum(launchAllowlistModes)
          .parse(input.mode);
        const result = await pool.query({
          text: `
            insert into public.launch_round_allowlist_roots (
              launch_id, round_index, snapshot_block, snapshot_block_hash,
              root, leaf_count, mode, members
            )
            values ($1, $2, $3::numeric, $4, $5, $6, $7, $8::jsonb)
            on conflict (launch_id, round_index, snapshot_block, root) do nothing
            returning allowlist_root_id, launch_id, round_index,
              snapshot_block::text as snapshot_block, snapshot_block_hash,
              root, leaf_count, mode, members, computed_at
          `,
          values: [
            uuidSchema.parse(input.launchId),
            input.roundIndex,
            blockSchema.parse(input.snapshotBlock),
            hashSchema.parse(input.snapshotBlockHash),
            bytes32ToColumn(input.root),
            members.length,
            mode,
            JSON.stringify(members),
          ],
        });
        if (result.rows[0] !== undefined) {
          return mapRoot(result.rows[0]);
        }
        const existing = await pool.query({
          text: `
            select allowlist_root_id, launch_id, round_index,
              snapshot_block::text as snapshot_block, snapshot_block_hash,
              root, leaf_count, mode, members, computed_at
            from public.launch_round_allowlist_roots
            where launch_id = $1 and round_index = $2
              and snapshot_block = $3::numeric and root = $4
          `,
          values: [
            input.launchId,
            input.roundIndex,
            input.snapshotBlock,
            bytes32ToColumn(input.root),
          ],
        });
        return mapRoot(existing.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async listAllowlistRoots(launchId, roundIndex) {
      try {
        const result = await pool.query({
          text: `
            select allowlist_root_id, launch_id, round_index,
              snapshot_block::text as snapshot_block, snapshot_block_hash,
              root, leaf_count, mode, members, computed_at
            from public.launch_round_allowlist_roots
            where launch_id = $1 and round_index = $2
            order by computed_at desc, allowlist_root_id
          `,
          values: [uuidSchema.parse(launchId), roundIndex],
        });
        return Object.freeze(result.rows.map(mapRoot));
      } catch (error) {
        return translate(error);
      }
    },

    async createIntent(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const idempotencyKey = uuidV4Schema.parse(input.idempotencyKey);
        const requestSha256 = sha256Schema.parse(input.requestSha256);
        const claim = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            await lockV2Owner(client, ownerUserId, unavailable);
            const recordId = await claimV2Command(
              client,
              {
                ownerUserId,
                scope: launchIntentIdempotencyScope,
                digestVersion: launchIntentDigestVersion,
                idempotencyKey,
                requestSha256,
              },
              () => new LaunchIntentIdempotencyConflictError(),
            );
            const existing = await client.query({
              text: `select ${intentColumns} from public.launch_intents where idempotency_record_id = $1`,
              values: [recordId],
            });
            return {
              recordId,
              existing:
                existing.rows[0] === undefined
                  ? null
                  : mapIntent(existing.rows[0]),
            };
          },
        );
        if (claim.existing !== null) {
          return Object.freeze({ created: false, intent: claim.existing });
        }
        // Chain reads happen outside any transaction; a concurrent replay
        // of the same key loses the unique idempotency_record_id race.
        const built = await input.build();
        const inserted = await pool.query({
          text: `
            insert into public.launch_intents (
              intent_id, owner_user_id, wallet_id, launch_id, project_id, round_id,
              chain_id, quote_asset_id, project_asset_id, direction, pay_amount_raw,
              expected_receive_raw, config_version, wallet_cumulative_raw,
              contract_address, state_tuple_digest, snapshot_block_number,
              snapshot_block_hash, payload_digest, state, expires_at,
              sale_id, round_index, min_token_amount_raw, deadline,
              eligibility_proof, unsigned_transaction, policy, idempotency_record_id
            )
            values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, 'buy', $10::numeric, $11::numeric,
              $12, $13::numeric, $14, $15, $16::numeric, $17, $18, $19, $20::timestamptz,
              $21::numeric, $22, $23::numeric, $24::timestamptz, $25::jsonb, $26::jsonb,
              $27::jsonb, $28
            )
            on conflict (idempotency_record_id) do nothing
            returning ${intentColumns}
          `,
          values: [
            uuidSchema.parse(built.intentId),
            ownerUserId,
            uuidSchema.parse(built.walletId),
            uuidSchema.parse(built.launchId),
            uuidSchema.parse(built.projectId),
            uuidSchema.parse(built.roundId),
            built.chainId,
            built.quoteAssetId,
            built.projectAssetId,
            rawSchema.parse(built.payAmountRaw),
            rawSchema.parse(built.expectedReceiveRaw),
            built.configVersion,
            rawSchema.parse(built.walletCumulativeRaw),
            addressSchema.parse(built.contractAddress),
            bytes32ToColumn(built.stateTupleDigest),
            blockSchema.parse(built.snapshotBlockNumber),
            hashSchema.parse(built.snapshotBlockHash),
            sha256Schema.parse(built.payloadDigest),
            built.state,
            built.expiresAt,
            built.saleId,
            built.roundIndex,
            rawSchema.parse(built.minTokenAmountRaw),
            built.deadline,
            JSON.stringify(built.eligibilityProof),
            JSON.stringify(built.unsignedTransaction),
            JSON.stringify(built.policy),
            claim.recordId,
          ],
        });
        if (inserted.rows[0] !== undefined) {
          return Object.freeze({
            created: true,
            intent: mapIntent(inserted.rows[0]),
          });
        }
        const winner = await pool.query({
          text: `select ${intentColumns} from public.launch_intents where idempotency_record_id = $1`,
          values: [claim.recordId],
        });
        return Object.freeze({
          created: false,
          intent: mapIntent(winner.rows[0]),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getIntent(input) {
      try {
        const result = await pool.query({
          text: `
            select ${intentColumns} from public.launch_intents
            where owner_user_id = $1 and launch_id = $2 and intent_id = $3
          `,
          values: [
            uuidSchema.parse(input.ownerUserId),
            uuidSchema.parse(input.launchId),
            uuidSchema.parse(input.intentId),
          ],
        });
        return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async reportIntentBroadcast(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const intentId = uuidSchema.parse(input.intentId);
        const transactionHash = hashSchema.parse(input.transactionHash);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await client.query({
            text: `select ${intentColumns} from public.launch_intents
                   where owner_user_id = $1 and intent_id = $2 for update`,
            values: [ownerUserId, intentId],
          });
          if (current.rows[0] === undefined) {
            throw unavailable();
          }
          const record = mapIntent(current.rows[0]);
          if (record.transactionHash !== null) {
            if (record.transactionHash !== transactionHash) {
              throw new LaunchIntentReportConflictError();
            }
            return record;
          }
          const taken = await client.query({
            text: `select 1 from public.launch_intents where transaction_hash = $1`,
            values: [transactionHash],
          });
          if ((taken.rowCount ?? 0) > 0) {
            throw new LaunchIntentReportConflictError();
          }
          const updated = await client.query({
            text: `
              update public.launch_intents as li set
                transaction_hash = $3,
                payload_verified = $4,
                reported_at = clock_timestamp(),
                state = case when exists (
                  select 1 from public.launch_indexed_events as e
                  where e.launch_id = li.launch_id and e.event_name = 'Purchased'
                    and e.transaction_hash = $3 and not e.removed
                ) then 'confirmed' else 'submitted' end,
                reconcile_after = null,
                updated_at = clock_timestamp()
              where owner_user_id = $1 and intent_id = $2
              returning ${intentColumns}
            `,
            values: [
              ownerUserId,
              intentId,
              transactionHash,
              input.payloadVerified,
            ],
          });
          await client.query({
            text: `
              update public.purchase_records set intent_id = $1
              where transaction_hash = $2 and wallet_id = $3 and intent_id is null
            `,
            values: [intentId, transactionHash, record.walletId],
          });
          return mapIntent(updated.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async leaseReconcilableIntents(input) {
      try {
        const limit = z.number().int().min(1).max(100).parse(input.limit);
        const leaseMs = z
          .number()
          .int()
          .min(1)
          .max(3_600_000)
          .parse(input.leaseMs);
        const result = await pool.query({
          text: `
            update public.launch_intents
            set reconcile_after =
              clock_timestamp() + ($3::integer * interval '1 millisecond')
            where intent_id in (
              select intent_id from public.launch_intents
              where chain_id = $1
                and state = 'submitted'
                and transaction_hash is not null
                and (reconcile_after is null or reconcile_after <= clock_timestamp())
              order by reconcile_after nulls first, intent_id
              limit $2
              for update skip locked
            )
            returning ${intentColumns}
          `,
          values: [input.chainId, limit, leaseMs],
        });
        return Object.freeze(result.rows.map(mapIntent));
      } catch (error) {
        return translate(error);
      }
    },

    async markIntentPayloadVerified(input) {
      try {
        await pool.query({
          text: `
            update public.launch_intents
            set payload_verified = true, updated_at = clock_timestamp()
            where intent_id = $1 and transaction_hash = $2 and not payload_verified
          `,
          values: [
            uuidSchema.parse(input.intentId),
            hashSchema.parse(input.transactionHash),
          ],
        });
      } catch (error) {
        return translate(error);
      }
    },

    async settleIntent(input) {
      try {
        const receipt =
          input.receipt === null
            ? null
            : JSON.stringify(intentReceiptSchema.parse(input.receipt));
        const result = await pool.query({
          text: `
            update public.launch_intents
            set
              state = $3,
              reason_code = $4,
              revert_reason = $5,
              receipt = coalesce($6::jsonb, receipt),
              reconcile_after = null,
              updated_at = clock_timestamp()
            where intent_id = $1 and transaction_hash = $2 and state = 'submitted'
            returning ${intentColumns}
          `,
          values: [
            uuidSchema.parse(input.intentId),
            hashSchema.parse(input.transactionHash),
            z
              .enum(["confirmed", "reverted", "failed", "expired"])
              .parse(input.toState),
            input.reasonCode,
            input.revertReason,
            receipt,
          ],
        });
        return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async registerSale(input: RegisterLaunchSaleInput) {
      try {
        const launchId = uuidSchema.parse(input.launchId);
        const saleId = z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .parse(input.saleId);
        const requestId = uuidV4Schema.parse(input.requestId);
        await withV2Transaction(pool, unavailable, async (client) => {
          const current = await client.query<{
            project_id: string;
            chain_id: string;
            sale_id: string | null;
            review_status: string;
          }>({
            text: `
              select l.project_id, l.chain_id, l.sale_id::text as sale_id, p.review_status
              from public.launches as l
              join public.launch_projects as p on p.project_id = l.project_id
              where l.launch_id = $1
              for update of l
            `,
            values: [launchId],
          });
          const row = current.rows[0];
          if (row === undefined || row.review_status !== "approved") {
            throw new LaunchSaleRegistrationError("LAUNCH_NOT_FOUND");
          }
          if (row.sale_id !== null) {
            throw new LaunchSaleRegistrationError(
              row.sale_id === saleId
                ? "LAUNCH_SALE_ALREADY_REGISTERED"
                : "LAUNCH_SALE_REGISTERED_DIFFERENTLY",
            );
          }
          const taken = await client.query({
            text: `
              select 1 from public.launches
              where chain_id = $1 and contract_address = $2 and sale_id = $3::numeric
            `,
            values: [row.chain_id, input.contractAddress, saleId],
          });
          if ((taken.rowCount ?? 0) > 0) {
            throw new LaunchSaleRegistrationError("LAUNCH_SALE_ID_TAKEN");
          }
          const usd1AssetId = `${row.chain_id}:${addressSchema.parse(input.quoteTokenAddress)}`;
          const projectAssetId = `${row.chain_id}:${addressSchema.parse(input.projectTokenAddress)}`;
          await client.query({
            text: `
              update public.launches set
                sale_id = $2::numeric,
                contract_address = $3,
                contract_version = $4,
                config_version_onchain = $5,
                quote_asset_id = $6,
                project_asset_id = $7,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where launch_id = $1
            `,
            values: [
              launchId,
              saleId,
              addressSchema.parse(input.contractAddress),
              input.contractVersion,
              hashSchema.parse(input.configVersionOnchain),
              usd1AssetId,
              projectAssetId,
            ],
          });
          await client.query({
            text: `
              insert into public.launch_review_events (
                project_id, actor_type, actor_user_id, event_type, from_status,
                to_status, reason_code, request_id
              )
              values ($1, 'operator', null, 'sale_registered', 'approved', 'approved', 'sale_registered', $2)
            `,
            values: [row.project_id, requestId],
          });
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}

export function newLaunchIntentId(): string {
  return randomUUID();
}
