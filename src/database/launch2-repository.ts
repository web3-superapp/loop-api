import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  launch2EventLane,
  launch2HoldReasons,
  isLaunch2Stage,
  type Launch2HoldReason,
  type Launch2Stage,
} from "../features/launch2/launch2-contract.js";
import {
  launch2PriceAt,
  launch2ReserveAt,
} from "../features/launch2/launch2-curve-math.js";
import {
  Launch2IdempotencyConflictError,
  Launch2RepositoryUnavailableError,
  type CreateLaunch2IntentRecord,
  type Launch2BuybackRecord,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2LaneEvent,
  type Launch2LaneInstance,
  type Launch2PositionRecord,
  type Launch2Repository,
  type Launch2TradeRecord,
} from "../features/launch2/launch2-ports.js";
import { admitCanaryExposure } from "./canary-exposure.js";
import {
  claimV2Command,
  lockV2Owner,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";

/**
 * Decision 0114: PostgreSQL side of the launch2 read model. The lane
 * commits one block segment per transaction — reorg rewind (facts marked
 * `removed`), raw + typed facts (idempotent upserts keyed by
 * `(chain, tx, logIndex)`), the per-instance projection recomputed from
 * every non-removed fact, and the `launch2_event` checkpoint. Amounts are
 * `numeric(78,0)` read back as decimal strings, never JS numbers.
 */

export const launch2IntentIdempotencyScope = "launch2_intent";
export const launch2IntentDigestVersion = "launch2_intent_v1";

const zeroAddress = "0x0000000000000000000000000000000000000000";

class CallerCallbackError extends Error {
  constructor(readonly callerError: unknown) {
    super("Caller callback failed");
    this.name = "CallerCallbackError";
  }
}

function unavailable(): Error {
  return new Launch2RepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (error instanceof CallerCallbackError) {
    throw error.callerError;
  }
  if (
    error instanceof Launch2RepositoryUnavailableError ||
    error instanceof Launch2IdempotencyConflictError
  ) {
    throw error;
  }
  throw new Launch2RepositoryUnavailableError();
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Launch2RepositoryUnavailableError();
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString(10);
  }
  throw new Launch2RepositoryUnavailableError();
}

function iso(row: Row, key: string): string {
  return toIsoString(row[key] as Date | string);
}

function nullableIso(row: Row, key: string): string | null {
  return toNullableIsoString((row[key] ?? null) as Date | string | null);
}

function holdOf(value: unknown): Launch2HoldReason | null {
  return typeof value === "string" &&
    (launch2HoldReasons as readonly string[]).includes(value)
    ? (value as Launch2HoldReason)
    : null;
}

function stageOf(value: unknown): Launch2Stage {
  if (!isLaunch2Stage(value)) {
    throw new Launch2RepositoryUnavailableError();
  }
  return value;
}

const instanceColumns = `
  instance_id::text, job_id::text, project_id::text, config_version,
  owner_user_id::text, chain_id, factory_address, launch_id, config_hash,
  project_owner, name, ticker, logo_url, meme_address, hook_address,
  nft_address, curve_address, gate_address, escrow_address,
  snapshots_address, graduation_adapter_address, buyback_adapter_address,
  price_recorder_address, buyback_executor_address, buyback_recipient,
  nft_sale_start, deploy_block_number::text, activation_block_number::text,
  deployed_event_seen, activated_at, hold_reason, stage, next_change_at,
  nft_minted_count::text, sold_supply::text, reserve_usd1::text,
  price_e18::text, trade_count::text, buy_volume_usd1::text, tax_usd1::text,
  snapshot_root, snapshot_data_hash, snapshot_cutoff_block::text,
  snapshot_cutoff_block_hash, snapshot_published_at,
  snapshot_published_block::text, snapshot_transaction_hash,
  snapshot_verification, snapshot_member_count, snapshot_signers,
  graduated_at, graduation_block::text, graduation_transaction_hash,
  official_pool_id, buyback_paused, buyback_count::text, buyback_usd1::text,
  buyback_meme::text, last_buyback_at, projected_at, registered_at,
  coalesce(activated_at, registered_at) as sort_at,
  (select jsonb_build_object(
      'status', p.status, 'txHash', p.tx_hash,
      'cutoffBlock', p.cutoff_block::text, 'memberCount', p.member_count)
    from public.launch2_snapshot_publications p
    where p.instance_id = launch2_instances.instance_id
    order by p.attempt desc limit 1) as snapshot_publication
`;

/** Decision 0118: the latest snapshot publication attempt, if any. */
function publicationOf(
  value: unknown,
): Launch2InstanceRecord["snapshotPublication"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (
    status !== "pending" &&
    status !== "broadcast" &&
    status !== "confirmed" &&
    status !== "failed" &&
    status !== "mismatch"
  ) {
    throw new Launch2RepositoryUnavailableError();
  }
  return Object.freeze({
    status,
    txHash: typeof record["txHash"] === "string" ? record["txHash"] : null,
    cutoffBlock: String(record["cutoffBlock"]),
    memberCount: Number(record["memberCount"]),
  });
}

function mapInstance(row: Row): Launch2InstanceRecord {
  const snapshotRoot = nullableText(row, "snapshot_root");
  const verification = nullableText(row, "snapshot_verification");
  const graduatedAt = nullableIso(row, "graduated_at");
  const signers = row["snapshot_signers"];
  return Object.freeze({
    instanceId: text(row, "instance_id"),
    jobId: text(row, "job_id"),
    projectId: text(row, "project_id"),
    configVersion: Number(row["config_version"]),
    ownerUserId: text(row, "owner_user_id"),
    chainId: text(row, "chain_id"),
    factoryAddress: text(row, "factory_address"),
    launchId: text(row, "launch_id"),
    configHash: text(row, "config_hash"),
    projectOwner: text(row, "project_owner"),
    name: text(row, "name"),
    ticker: text(row, "ticker"),
    logoUrl: nullableText(row, "logo_url"),
    addresses: Object.freeze({
      meme: text(row, "meme_address"),
      hook: text(row, "hook_address"),
      nft: text(row, "nft_address"),
      curve: text(row, "curve_address"),
      gate: text(row, "gate_address"),
      escrow: text(row, "escrow_address"),
      snapshots: text(row, "snapshots_address"),
      graduationAdapter: text(row, "graduation_adapter_address"),
      buybackAdapter: text(row, "buyback_adapter_address"),
      priceRecorder: text(row, "price_recorder_address"),
      buybackExecutor: text(row, "buyback_executor_address"),
    }),
    buybackRecipient: text(row, "buyback_recipient"),
    nftSaleStart: iso(row, "nft_sale_start"),
    deployBlockNumber: text(row, "deploy_block_number"),
    activationBlockNumber: nullableText(row, "activation_block_number"),
    deployedEventSeen: row["deployed_event_seen"] === true,
    activatedAt: nullableIso(row, "activated_at"),
    holdReason: holdOf(row["hold_reason"]),
    stage: stageOf(row["stage"]),
    nextChangeAt: nullableIso(row, "next_change_at"),
    nftMintedCount: text(row, "nft_minted_count"),
    soldSupply: text(row, "sold_supply"),
    reserveUsd1: text(row, "reserve_usd1"),
    priceE18: text(row, "price_e18"),
    tradeCount: text(row, "trade_count"),
    buyVolumeUsd1: text(row, "buy_volume_usd1"),
    taxUsd1: text(row, "tax_usd1"),
    snapshot:
      snapshotRoot === null
        ? null
        : Object.freeze({
            root: snapshotRoot,
            dataHash: nullableText(row, "snapshot_data_hash"),
            cutoffBlock: text(row, "snapshot_cutoff_block"),
            cutoffBlockHash: nullableText(row, "snapshot_cutoff_block_hash"),
            publishedAt: iso(row, "snapshot_published_at"),
            publishedBlock: nullableText(row, "snapshot_published_block"),
            transactionHash: nullableText(row, "snapshot_transaction_hash"),
            verification:
              verification === "verified" || verification === "mismatch"
                ? verification
                : null,
            memberCount:
              row["snapshot_member_count"] === null
                ? null
                : Number(row["snapshot_member_count"]),
            signers: Array.isArray(signers)
              ? Object.freeze(signers.map(String))
              : null,
          }),
    snapshotPublication: publicationOf(row["snapshot_publication"]),
    graduation:
      graduatedAt === null
        ? null
        : Object.freeze({
            graduatedAt,
            blockNumber: nullableText(row, "graduation_block"),
            transactionHash: nullableText(row, "graduation_transaction_hash"),
            poolId: text(row, "official_pool_id"),
          }),
    buyback: Object.freeze({
      paused: row["buyback_paused"] === true,
      count: text(row, "buyback_count"),
      usd1: text(row, "buyback_usd1"),
      meme: text(row, "buyback_meme"),
      lastAt: nullableIso(row, "last_buyback_at"),
    }),
    registeredAt: iso(row, "registered_at"),
    projectedAt: iso(row, "projected_at"),
  });
}

function secondsToTimestamp(seconds: string): string {
  return new Date(Number(BigInt(seconds)) * 1000).toISOString();
}

async function insertFact(
  client: DatabaseClient,
  chainId: string,
  event: Launch2LaneEvent,
): Promise<void> {
  const a = event.args;
  const at = secondsToTimestamp(event.at);
  const base = [
    chainId,
    event.transactionHash,
    event.logIndex,
    event.blockNumber,
    event.blockHash,
    event.instanceId,
  ];
  await client.query({
    text: `
      insert into public.launch2_events (
        chain_id, transaction_hash, log_index, block_number, block_hash,
        instance_id, contract_address, event_name, payload, event_at, removed
      )
      values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, false)
      on conflict (chain_id, transaction_hash, log_index) do update set
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        instance_id = excluded.instance_id,
        contract_address = excluded.contract_address,
        event_name = excluded.event_name,
        payload = excluded.payload,
        event_at = excluded.event_at,
        removed = false,
        observed_at = clock_timestamp()
    `,
    values: [
      ...base,
      event.contractAddress,
      event.eventName,
      JSON.stringify(a),
      at,
    ],
  });
  const upsertTail = `
    on conflict (chain_id, transaction_hash, log_index) do update set
      block_number = excluded.block_number,
      block_hash = excluded.block_hash,
      removed = false,
      observed_at = clock_timestamp()`;
  if (event.eventName === "NftMinted") {
    await client.query({
      text: `
        insert into public.launch2_nft_mints (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, payer_address, token_id, amount_usd1, minted_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, $8::numeric, $9::numeric, $10::timestamptz)
        ${upsertTail}
      `,
      values: [...base, a["payer"], a["tokenId"], a["amount"], at],
    });
  } else if (event.eventName === "CurveBought") {
    const reserveIn = BigInt(a["reserveIn"] ?? "0");
    const tax = BigInt(a["platformTax"] ?? "0");
    await client.query({
      text: `
        insert into public.launch2_trades (
          trade_id, chain_id, transaction_hash, log_index, block_number,
          block_hash, instance_id, side, trader_address, meme_amount,
          usd1_gross, usd1_net, tax_usd1, refund_usd1, cumulative_bought,
          sold_after, traded_at
        )
        values ($7, $1, $2, $3, $4::numeric, $5, $6, 'buy', $8, $9::numeric,
          $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
          null, $15::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        randomUUID(),
        a["buyer"],
        a["memeOut"],
        (reserveIn + tax).toString(10),
        reserveIn.toString(10),
        tax.toString(10),
        a["usd1Refund"],
        a["cumulativeBought"],
        at,
      ],
    });
  } else if (event.eventName === "CurveSold") {
    const out = BigInt(a["usd1Out"] ?? "0");
    const tax = BigInt(a["platformTax"] ?? "0");
    await client.query({
      text: `
        insert into public.launch2_trades (
          trade_id, chain_id, transaction_hash, log_index, block_number,
          block_hash, instance_id, side, trader_address, meme_amount,
          usd1_gross, usd1_net, tax_usd1, refund_usd1, cumulative_bought,
          sold_after, traded_at
        )
        values ($7, $1, $2, $3, $4::numeric, $5, $6, 'sell', $8, $9::numeric,
          $10::numeric, $11::numeric, $12::numeric, 0, null, $13::numeric,
          $14::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        randomUUID(),
        a["seller"],
        a["memeIn"],
        (out + tax).toString(10),
        out.toString(10),
        tax.toString(10),
        a["nextSoldSupply"],
        at,
      ],
    });
  } else if (event.eventName === "BuybackCompleted") {
    await client.query({
      text: `
        insert into public.launch2_buybacks (
          buyback_id, chain_id, transaction_hash, log_index, block_number,
          block_hash, instance_id, outcome, reason_code, usd1_spent,
          meme_delivered, min_meme_out, reference_price_e18, spot_price_e18,
          executed_at
        )
        values ($7, $1, $2, $3, $4::numeric, $5, $6, 'executed', null,
          $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric,
          $13::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        randomUUID(),
        a["usd1Spent"],
        a["memeDelivered"],
        a["minMemeOut"],
        a["referencePrice"],
        a["spotPrice"],
        at,
      ],
    });
  }
}

/**
 * Recomputes one instance from its non-removed facts. The curve figures use
 * the TypeScript port of CurveMath (sold supply = Σ buys − Σ sells, exact
 * because MEME cannot move off the curve before graduation).
 */
async function reproject(
  client: DatabaseClient,
  instanceId: string,
  checkpointBlock: string,
  activationGraceBlocks: number,
): Promise<void> {
  const facts = await client.query<Row>({
    text: `
      select
        (select payload from public.launch2_events
          where instance_id = $1 and not removed and event_name = 'LaunchDeployed'
          order by block_number desc, log_index desc limit 1) as deployed,
        (select jsonb_build_object('payload', payload, 'block', block_number::text)
          from public.launch2_events
          where instance_id = $1 and not removed and event_name = 'LaunchActivated'
          order by block_number, log_index limit 1) as activated,
        (select jsonb_build_object('payload', payload, 'block', block_number::text,
            'tx', transaction_hash)
          from public.launch2_events
          where instance_id = $1 and not removed and event_name = 'SnapshotPublished'
          order by block_number, log_index limit 1) as snapshot,
        (select jsonb_build_object('payload', payload, 'block', block_number::text,
            'tx', transaction_hash, 'at', extract(epoch from event_at)::bigint::text)
          from public.launch2_events
          where instance_id = $1 and not removed and event_name = 'Graduated'
          order by block_number, log_index limit 1) as graduated,
        (select event_name from public.launch2_events
          where instance_id = $1 and not removed
            and event_name in ('BuybackPausedEvent', 'BuybackResumed')
          order by block_number desc, log_index desc limit 1) as pause_event,
        (select count(*)::text from public.launch2_nft_mints
          where instance_id = $1 and not removed) as minted,
        (select coalesce(sum(case when side = 'buy' then meme_amount else -meme_amount end), 0)::text
          from public.launch2_trades where instance_id = $1 and not removed) as sold,
        (select count(*)::text from public.launch2_trades
          where instance_id = $1 and not removed) as trades,
        (select coalesce(sum(usd1_gross) filter (where side = 'buy'), 0)::text
          from public.launch2_trades where instance_id = $1 and not removed) as buy_volume,
        (select coalesce(sum(tax_usd1), 0)::text
          from public.launch2_trades where instance_id = $1 and not removed) as tax,
        (select jsonb_build_object('count', count(*)::text,
            'usd1', coalesce(sum(usd1_spent), 0)::text,
            'meme', coalesce(sum(meme_delivered), 0)::text,
            'last', max(executed_at))
          from public.launch2_buybacks
          where instance_id = $1 and not removed and outcome = 'executed') as buybacks,
        i.meme_address, i.nft_address, i.curve_address, i.hook_address,
        i.project_owner, i.activation_block_number::text as activation_block,
        i.snapshot_root
      from public.launch2_instances i
      where i.instance_id = $1
      for update of i
    `,
    values: [instanceId],
  });
  const row = facts.rows[0];
  if (row === undefined) return;
  const deployed = row["deployed"] as Record<string, string> | null;
  const activated = row["activated"] as {
    payload: Record<string, string>;
    block: string;
  } | null;
  const snapshot = row["snapshot"] as {
    payload: Record<string, string>;
    block: string;
    tx: string;
  } | null;
  const graduated = row["graduated"] as {
    payload: Record<string, string>;
    block: string;
    tx: string;
    at: string;
  } | null;
  const buybacks = row["buybacks"] as {
    count: string;
    usd1: string;
    meme: string;
    last: string | null;
  };
  let hold: Launch2HoldReason | null = null;
  if (
    deployed !== null &&
    (deployed["meme"] !== row["meme_address"] ||
      deployed["nft"] !== row["nft_address"] ||
      deployed["curve"] !== row["curve_address"] ||
      deployed["hook"] !== row["hook_address"] ||
      deployed["projectOwner"] !== row["project_owner"])
  ) {
    hold = "LAUNCH2_DEPLOYED_EVENT_MISMATCH";
  } else if (
    activated === null &&
    row["activation_block"] !== null &&
    BigInt(checkpointBlock) >=
      BigInt(row["activation_block"] as string) + BigInt(activationGraceBlocks)
  ) {
    hold = "LAUNCH2_ACTIVATION_MISSING";
  }
  let sold = BigInt(row["sold"] as string);
  if (sold < 0n) sold = 0n;
  const reserve = launch2ReserveAt(sold);
  const price = launch2PriceAt(sold);
  const root = snapshot?.payload["root"] ?? null;
  if (root !== row["snapshot_root"]) {
    // A rewound or replaced publication: the rebuilt list is stale.
    await client.query({
      text: `delete from public.launch2_snapshot_members where instance_id = $1`,
      values: [instanceId],
    });
  }
  await client.query({
    text: `
      update public.launch2_instances set
        deployed_event_seen = $2,
        activated_at = $3::timestamptz,
        activated_block_number = $4::numeric,
        hold_reason = $5,
        nft_minted_count = $6::numeric,
        sold_supply = $7::numeric,
        reserve_usd1 = $8::numeric,
        price_e18 = $9::numeric,
        trade_count = $10::numeric,
        buy_volume_usd1 = $11::numeric,
        tax_usd1 = $12::numeric,
        snapshot_root = $13,
        snapshot_data_hash = $14,
        snapshot_cutoff_block = $15::numeric,
        snapshot_cutoff_block_hash = $16,
        snapshot_published_at = $17::timestamptz,
        snapshot_published_block = $18::numeric,
        snapshot_transaction_hash = $19,
        snapshot_verification = case when $13 is distinct from snapshot_root then null else snapshot_verification end,
        snapshot_member_count = case when $13 is distinct from snapshot_root then null else snapshot_member_count end,
        snapshot_signers = case when $13 is distinct from snapshot_root then null else snapshot_signers end,
        graduated_at = $20::timestamptz,
        graduation_block = $21::numeric,
        graduation_transaction_hash = $22,
        official_pool_id = $23,
        buyback_paused = $24,
        buyback_count = $25::numeric,
        buyback_usd1 = $26::numeric,
        buyback_meme = $27::numeric,
        last_buyback_at = $28::timestamptz,
        projected_at = clock_timestamp()
      where instance_id = $1
    `,
    values: [
      instanceId,
      deployed !== null,
      activated === null
        ? null
        : secondsToTimestamp(activated.payload["activatedAt"] ?? "0"),
      activated?.block ?? null,
      hold,
      row["minted"],
      sold.toString(10),
      reserve.toString(10),
      price.toString(10),
      row["trades"],
      row["buy_volume"],
      row["tax"],
      root,
      snapshot?.payload["dataHash"] ?? null,
      snapshot?.payload["cutoffBlock"] ?? null,
      snapshot?.payload["cutoffBlockHash"] ?? null,
      snapshot === null
        ? null
        : secondsToTimestamp(snapshot.payload["publishedAt"] ?? "0"),
      snapshot?.payload["publishedBlock"] ?? snapshot?.block ?? null,
      snapshot?.tx ?? null,
      graduated === null ? null : secondsToTimestamp(graduated.at),
      graduated?.block ?? null,
      graduated?.tx ?? null,
      graduated?.payload["officialPoolId"] ?? null,
      row["pause_event"] === "BuybackPausedEvent",
      buybacks.count,
      buybacks.usd1,
      buybacks.meme,
      buybacks.last,
    ],
  });
  await reprojectPositions(client, instanceId);
}

async function reprojectPositions(
  client: DatabaseClient,
  instanceId: string,
): Promise<void> {
  await client.query({
    text: `delete from public.launch2_positions where instance_id = $1`,
    values: [instanceId],
  });
  await client.query({
    text: `
      with transfers as (
        select payload ->> 'to' as holder, 1 as delta, event_at
        from public.launch2_events
        where instance_id = $1 and not removed and event_name = 'Transfer'
          and payload ->> 'to' <> $2
        union all
        select payload ->> 'from', -1, event_at
        from public.launch2_events
        where instance_id = $1 and not removed and event_name = 'Transfer'
          and payload ->> 'from' <> $2
      ),
      held as (
        select holder, sum(delta)::integer as n, max(event_at) as last
        from transfers group by holder
      ),
      mints as (
        select payer_address as holder, min(token_id) as token_id, max(minted_at) as last
        from public.launch2_nft_mints
        where instance_id = $1 and not removed group by payer_address
      ),
      trades as (
        select trader_address as holder,
          coalesce(sum(meme_amount) filter (where side = 'buy'), 0) as bought,
          coalesce(sum(meme_amount) filter (where side = 'sell'), 0) as sold,
          coalesce(max(cumulative_bought), 0) as cumulative,
          coalesce(sum(usd1_gross) filter (where side = 'buy'), 0) as spent,
          coalesce(sum(usd1_net) filter (where side = 'sell'), 0) as received,
          coalesce(sum(tax_usd1), 0) as tax,
          count(*) filter (where side = 'buy')::integer as buys,
          count(*) filter (where side = 'sell')::integer as sells,
          max(traded_at) as last
        from public.launch2_trades
        where instance_id = $1 and not removed group by trader_address
      ),
      holders as (
        select holder from held union select holder from mints
        union select holder from trades
      )
      insert into public.launch2_positions (
        instance_id, holder_address, nft_minted_token_id, nft_held,
        curve_bought, curve_sold, cumulative_bought, usd1_spent,
        usd1_received, tax_usd1, buy_count, sell_count, snapshot_member,
        last_activity_at
      )
      select $1, h.holder, m.token_id, greatest(coalesce(held.n, 0), 0),
        coalesce(t.bought, 0), coalesce(t.sold, 0), coalesce(t.cumulative, 0),
        coalesce(t.spent, 0), coalesce(t.received, 0), coalesce(t.tax, 0),
        coalesce(t.buys, 0), coalesce(t.sells, 0),
        exists (select 1 from public.launch2_snapshot_members s
          where s.instance_id = $1 and s.member_address = h.holder
            and s.proof is not null),
        greatest(held.last, m.last, t.last)
      from holders h
      left join held on held.holder = h.holder
      left join mints m on m.holder = h.holder
      left join trades t on t.holder = h.holder
      where h.holder ~ '^0x[0-9a-f]{40}$'
    `,
    values: [instanceId, zeroAddress],
  });
}

function mapLaneInstance(row: Row): Launch2LaneInstance {
  const instance = mapInstance(row);
  return Object.freeze({
    instanceId: instance.instanceId,
    launchId: instance.launchId,
    addresses: instance.addresses,
    deployBlockNumber: instance.deployBlockNumber,
    nftSaleStart: instance.nftSaleStart,
    holdReason: instance.holdReason,
    graduated: instance.graduation !== null,
    snapshotPublishedAt: instance.snapshot?.publishedAt ?? null,
    activatedAt: instance.activatedAt,
    stage: instance.stage,
    nextChangeAt: instance.nextChangeAt,
  });
}

function mapPosition(row: Row): Launch2PositionRecord {
  return Object.freeze({
    instanceId: text(row, "instance_id"),
    holderAddress: text(row, "holder_address"),
    nftMintedTokenId: nullableText(row, "nft_minted_token_id"),
    nftHeld: Number(row["nft_held"]),
    curveBought: text(row, "curve_bought"),
    curveSold: text(row, "curve_sold"),
    cumulativeBought: text(row, "cumulative_bought"),
    usd1Spent: text(row, "usd1_spent"),
    usd1Received: text(row, "usd1_received"),
    taxUsd1: text(row, "tax_usd1"),
    buyCount: Number(row["buy_count"]),
    sellCount: Number(row["sell_count"]),
    snapshotMember: row["snapshot_member"] === true,
    lastActivityAt: nullableIso(row, "last_activity_at"),
  });
}

function mapIntent(row: Row): Launch2IntentRecord {
  return Object.freeze({
    intentId: text(row, "intent_id"),
    ownerUserId: text(row, "owner_user_id"),
    instanceId: text(row, "instance_id"),
    walletId: text(row, "wallet_id"),
    walletAddress: text(row, "wallet_address"),
    kind: text(row, "kind") as Launch2IntentRecord["kind"],
    chainId: text(row, "chain_id"),
    contractAddress: text(row, "contract_address"),
    amountIn: text(row, "amount_in"),
    expectedOut: text(row, "expected_out"),
    minOut: text(row, "min_out"),
    taxUsd1: text(row, "tax_usd1"),
    refundUsd1: text(row, "refund_usd1"),
    deadline: iso(row, "deadline"),
    snapshotBlockNumber: text(row, "snapshot_block_number"),
    snapshotBlockHash: text(row, "snapshot_block_hash"),
    calldata: row["calldata"] as Record<string, unknown>,
    unsignedTransaction: row["unsigned_transaction"] as Record<string, unknown>,
    approval: (row["approval"] ?? null) as Record<string, unknown> | null,
    policy: row["policy"] as Record<string, unknown>,
    payloadDigest: text(row, "payload_digest"),
    state: "prepared",
    expiresAt: iso(row, "expires_at"),
    createdAt: iso(row, "created_at"),
  });
}

const intentColumns = `
  intent_id::text, owner_user_id::text, instance_id::text, wallet_id::text,
  wallet_address, kind, chain_id, contract_address, amount_in::text,
  expected_out::text, min_out::text, tax_usd1::text, refund_usd1::text,
  deadline, snapshot_block_number::text, snapshot_block_hash, calldata,
  unsigned_transaction, approval, policy, payload_digest, expires_at,
  created_at
`;

export function createPostgresLaunch2Repository(pool: Pool): Launch2Repository {
  async function query<T extends Row>(
    textSql: string,
    values: readonly unknown[],
  ): Promise<T[]> {
    try {
      const result = await pool.query<T>({
        text: textSql,
        values: [...values],
      });
      return result.rows;
    } catch (error) {
      return translate(error);
    }
  }

  return Object.freeze<Launch2Repository>({
    async registerActivatedInstances(input) {
      const rows = await query<{ instance_id: string }>(
        `
          insert into public.launch2_instances (
            instance_id, job_id, project_id, config_version, owner_user_id,
            chain_id, factory_address, launch_id, config_hash, project_owner,
            name, ticker, logo_url, meme_address, hook_address, nft_address,
            curve_address, gate_address, escrow_address, snapshots_address,
            graduation_adapter_address, buyback_adapter_address,
            price_recorder_address, buyback_executor_address,
            buyback_recipient, nft_sale_start, deploy_block_number,
            activation_block_number, price_e18
          )
          select gen_random_uuid(), t.job_id, t.project_id, t.config_version,
            t.owner_user_id, $1, t.factory_address, t.launch_id, v.config_hash,
            t.project_owner, v.config ->> 'name', v.config ->> 'ticker',
            nullif(v.config ->> 'logoAssetUrl', ''),
            lower(t.deployed_addresses ->> 'meme'),
            lower(t.deployed_addresses ->> 'hook'),
            lower(t.deployed_addresses ->> 'nft'),
            lower(t.deployed_addresses ->> 'curve'),
            lower(t.deployed_addresses ->> 'gate'),
            lower(t.deployed_addresses ->> 'escrow'),
            lower(t.deployed_addresses ->> 'snapshots'),
            lower(t.deployed_addresses ->> 'graduationAdapter'),
            lower(t.deployed_addresses ->> 'buybackAdapter'),
            lower(t.deployed_addresses ->> 'priceRecorder'),
            lower(t.deployed_addresses ->> 'buybackExecutor'),
            lower(v.config ->> 'buybackRecipient'),
            to_timestamp((v.config ->> 'nftSaleStartAt')::numeric),
            t.block_number, t.activation_block_number, $3::numeric
          from public.hooks_launch_deployment_tasks t
          join public.hooks_launch_project_config_versions v
            on v.project_id = t.project_id and v.config_version = t.config_version
          where t.status = 'activated'
            and t.factory_address = $2
            and t.chain_id = 97
            and not exists (
              select 1 from public.launch2_instances i where i.job_id = t.job_id)
          on conflict do nothing
          returning instance_id::text
        `,
        [
          input.chainId,
          input.factoryAddress.toLowerCase(),
          launch2PriceAt(0n).toString(10),
        ],
      );
      return rows.map((row) => row.instance_id);
    },

    async listLaneInstances(chainId) {
      const rows = await query<Row>(
        `select ${instanceColumns} from public.launch2_instances
         where chain_id = $1 order by deploy_block_number, instance_id`,
        [chainId],
      );
      return rows.map(mapLaneInstance);
    },

    async getCheckpoint(chainId) {
      const rows = await query<Row>(
        `select last_block_number::text, last_block_hash,
           started_from_block_number::text, updated_at
         from public.indexer_checkpoints where lane = $1 and chain_id = $2`,
        [launch2EventLane, chainId],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : Object.freeze({
            lastBlockNumber: text(row, "last_block_number"),
            lastBlockHash: text(row, "last_block_hash"),
            startedFromBlockNumber: text(row, "started_from_block_number"),
            updatedAt: iso(row, "updated_at"),
          });
    },

    async commitSegment(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const touched = new Set<string>();
          if (input.rewindFromBlockNumber !== undefined) {
            for (const table of [
              "launch2_events",
              "launch2_nft_mints",
              "launch2_trades",
              "launch2_buybacks",
            ]) {
              const rewound = await client.query<{ instance_id: string }>({
                text: `
                  update public.${table}
                  set removed = true, observed_at = clock_timestamp()
                  where chain_id = $1 and block_number >= $2::numeric and not removed
                  returning instance_id::text
                `,
                values: [input.chainId, input.rewindFromBlockNumber],
              });
              for (const row of rewound.rows) touched.add(row.instance_id);
            }
          }
          for (const event of input.events) {
            await insertFact(client, input.chainId, event);
            touched.add(event.instanceId);
          }
          // An activation the lane should have seen by now (its block plus
          // the grace) and did not: re-checked although no fact changed.
          const overdue = await client.query<{ instance_id: string }>({
            text: `
              select instance_id::text from public.launch2_instances
              where chain_id = $1 and activated_at is null and hold_reason is null
                and activation_block_number is not null
                and activation_block_number + $2 <= $3::numeric
            `,
            values: [
              input.chainId,
              input.activationGraceBlocks,
              input.checkpoint.lastBlockNumber,
            ],
          });
          for (const row of overdue.rows) touched.add(row.instance_id);
          for (const instanceId of [...touched].sort()) {
            await reproject(
              client,
              instanceId,
              input.checkpoint.lastBlockNumber,
              input.activationGraceBlocks,
            );
          }
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
                started_from_block_number = least(
                  public.indexer_checkpoints.started_from_block_number,
                  excluded.started_from_block_number),
                reorg_count = public.indexer_checkpoints.reorg_count + $6,
                updated_at = clock_timestamp()
            `,
            values: [
              launch2EventLane,
              input.chainId,
              input.checkpoint.lastBlockNumber,
              input.checkpoint.lastBlockHash,
              input.checkpoint.startedFromBlockNumber,
              input.rewindFromBlockNumber === undefined ? 0 : 1,
            ],
          });
          return Object.freeze({
            storedCount: input.events.length,
            touched: touched.size,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listSnapshotsToVerify(chainId) {
      const rows = await query<Row>(
        `select instance_id::text, launch_id, nft_address, snapshots_address,
           snapshot_root, snapshot_data_hash, snapshot_cutoff_block::text,
           snapshot_cutoff_block_hash, snapshot_transaction_hash
         from public.launch2_instances
         where chain_id = $1 and snapshot_root is not null
           and snapshot_verification is null
         order by instance_id`,
        [chainId],
      );
      return rows.map((row) =>
        Object.freeze({
          instanceId: text(row, "instance_id"),
          launchId: text(row, "launch_id"),
          nft: text(row, "nft_address"),
          snapshots: text(row, "snapshots_address"),
          root: text(row, "snapshot_root"),
          dataHash: text(row, "snapshot_data_hash"),
          cutoffBlock: text(row, "snapshot_cutoff_block"),
          cutoffBlockHash: text(row, "snapshot_cutoff_block_hash"),
          transactionHash: text(row, "snapshot_transaction_hash"),
        }),
      );
    },

    async nftHoldersAt(input) {
      const rows = await query<{ holder: string; n: number }>(
        `
          select holder, sum(delta)::integer as n from (
            select payload ->> 'to' as holder, 1 as delta
            from public.launch2_events
            where instance_id = $1 and not removed and event_name = 'Transfer'
              and block_number <= $2::numeric and payload ->> 'to' <> $3
            union all
            select payload ->> 'from', -1
            from public.launch2_events
            where instance_id = $1 and not removed and event_name = 'Transfer'
              and block_number <= $2::numeric and payload ->> 'from' <> $3
          ) as moves
          group by holder having sum(delta) > 0
          order by holder
        `,
        [input.instanceId, input.blockNumber, zeroAddress],
      );
      return rows.map((row) => ({
        address: row.holder,
        balance: Number(row.n),
      }));
    },

    async recordSnapshotVerification(input) {
      try {
        await withV2Transaction(pool, unavailable, async (client) => {
          const updated = await client.query({
            text: `
              update public.launch2_instances set
                snapshot_verification = $3,
                snapshot_member_count = $4,
                snapshot_signers = $5::jsonb
              where instance_id = $1 and snapshot_root = $2
              returning instance_id
            `,
            values: [
              input.instanceId,
              input.root,
              input.verification,
              input.members.length,
              input.signers === null ? null : JSON.stringify(input.signers),
            ],
          });
          if (updated.rowCount === 0) return;
          await client.query({
            text: `delete from public.launch2_snapshot_members where instance_id = $1`,
            values: [input.instanceId],
          });
          for (const member of input.members) {
            await client.query({
              text: `
                insert into public.launch2_snapshot_members (
                  instance_id, member_address, leaf, proof, nft_balance
                ) values ($1, $2, $3, $4::jsonb, $5)
              `,
              values: [
                input.instanceId,
                member.memberAddress,
                member.leaf,
                member.proof === null ? null : JSON.stringify(member.proof),
                member.nftBalance,
              ],
            });
          }
          await client.query({
            text: `
              update public.launch2_positions p set snapshot_member = exists (
                select 1 from public.launch2_snapshot_members s
                where s.instance_id = p.instance_id
                  and s.member_address = p.holder_address and s.proof is not null)
              where p.instance_id = $1
            `,
            values: [input.instanceId],
          });
        });
      } catch (error) {
        translate(error);
      }
    },

    async updateStages(updates) {
      let changed = 0;
      for (const update of updates) {
        const rows = await query<Row>(
          `update public.launch2_instances
           set stage = $2, next_change_at = $3::timestamptz
           where instance_id = $1
             and (stage is distinct from $2 or next_change_at is distinct from $3::timestamptz)
           returning instance_id`,
          [update.instanceId, update.stage, update.nextChangeAt],
        );
        changed += rows.length;
      }
      return changed;
    },

    async listInstances(input) {
      const rows = await query<Row>(
        `
          select ${instanceColumns} from public.launch2_instances
          where chain_id = $1
            and (activated_at is not null or hold_reason is not null)
            and ($2::text is null or stage = $2)
            and ($3::timestamptz is null
              or (coalesce(activated_at, registered_at), instance_id) < ($3::timestamptz, $4::uuid))
          order by coalesce(activated_at, registered_at) desc, instance_id desc
          limit $5
        `,
        [
          input.chainId,
          input.stage,
          input.after?.activatedAt ?? null,
          input.after?.instanceId ?? null,
          input.limit,
        ],
      );
      return rows.map(mapInstance);
    },

    async getInstance(instanceId) {
      const rows = await query<Row>(
        `select ${instanceColumns} from public.launch2_instances where instance_id = $1`,
        [instanceId],
      );
      return rows[0] === undefined ? null : mapInstance(rows[0]);
    },

    async listPositions(input) {
      if (input.holderAddresses.length === 0) return [];
      const rows = await query<Row>(
        `
          select p.instance_id::text, p.holder_address,
            p.nft_minted_token_id::text, p.nft_held, p.curve_bought::text,
            p.curve_sold::text, p.cumulative_bought::text, p.usd1_spent::text,
            p.usd1_received::text, p.tax_usd1::text, p.buy_count, p.sell_count,
            p.snapshot_member, p.last_activity_at
          from public.launch2_positions p
          join public.launch2_instances i on i.instance_id = p.instance_id
          where p.holder_address = any($1::text[])
            and ($2::uuid is null or p.instance_id = $2::uuid)
            and (i.activated_at is not null or i.hold_reason is not null)
          order by p.last_activity_at desc nulls last, p.instance_id, p.holder_address
          limit 200
        `,
        [
          input.holderAddresses.map((address) => address.toLowerCase()),
          input.instanceId,
        ],
      );
      return rows.map(mapPosition);
    },

    async getSnapshotMember(input) {
      const rows = await query<Row>(
        `select member_address, leaf, proof, nft_balance
         from public.launch2_snapshot_members
         where instance_id = $1 and member_address = $2`,
        [input.instanceId, input.address.toLowerCase()],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : Object.freeze({
            memberAddress: text(row, "member_address"),
            leaf: text(row, "leaf"),
            proof: Array.isArray(row["proof"])
              ? Object.freeze((row["proof"] as unknown[]).map(String))
              : null,
            nftBalance: Number(row["nft_balance"]),
          });
    },

    async listBuybacks(input) {
      const rows = await query<Row>(
        `
          select buyback_id::text, outcome, reason_code, usd1_spent::text,
            meme_delivered::text, min_meme_out::text,
            reference_price_e18::text, spot_price_e18::text, executed_at,
            transaction_hash, block_number::text
          from public.launch2_buybacks
          where instance_id = $1 and not removed
            and ($2::timestamptz is null or (executed_at, buyback_id) < ($2::timestamptz, $3::uuid))
          order by executed_at desc, buyback_id desc
          limit $4
        `,
        [
          input.instanceId,
          input.after?.executedAt ?? null,
          input.after?.buybackId ?? null,
          input.limit,
        ],
      );
      return rows.map((row): Launch2BuybackRecord =>
        Object.freeze({
          buybackId: text(row, "buyback_id"),
          outcome:
            text(row, "outcome") === "rejected" ? "rejected" : "executed",
          reasonCode: nullableText(row, "reason_code"),
          usd1Spent: text(row, "usd1_spent"),
          memeDelivered: text(row, "meme_delivered"),
          minMemeOut: text(row, "min_meme_out"),
          referencePriceE18: text(row, "reference_price_e18"),
          spotPriceE18: text(row, "spot_price_e18"),
          executedAt: iso(row, "executed_at"),
          transactionHash: text(row, "transaction_hash"),
          blockNumber: text(row, "block_number"),
        }),
      );
    },

    async listTrades(input) {
      const rows = await query<Row>(
        `
          select trade_id::text, side, trader_address, meme_amount::text,
            usd1_gross::text, usd1_net::text, tax_usd1::text,
            refund_usd1::text, cumulative_bought::text, sold_after::text,
            traded_at, transaction_hash, block_number::text
          from public.launch2_trades
          where instance_id = $1 and not removed
          order by block_number desc, log_index desc
          limit $2
        `,
        [input.instanceId, input.limit],
      );
      return rows.map((row): Launch2TradeRecord =>
        Object.freeze({
          tradeId: text(row, "trade_id"),
          side: text(row, "side") === "sell" ? "sell" : "buy",
          traderAddress: text(row, "trader_address"),
          memeAmount: text(row, "meme_amount"),
          usd1Gross: text(row, "usd1_gross"),
          usd1Net: text(row, "usd1_net"),
          taxUsd1: text(row, "tax_usd1"),
          refundUsd1: text(row, "refund_usd1"),
          cumulativeBought: nullableText(row, "cumulative_bought"),
          soldAfter: nullableText(row, "sold_after"),
          tradedAt: iso(row, "traded_at"),
          transactionHash: text(row, "transaction_hash"),
          blockNumber: text(row, "block_number"),
        }),
      );
    },

    async createIntent(input) {
      try {
        const claim = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            await lockV2Owner(client, input.ownerUserId, unavailable);
            const recordId = await claimV2Command(
              client,
              {
                ownerUserId: input.ownerUserId,
                scope: launch2IntentIdempotencyScope,
                digestVersion: launch2IntentDigestVersion,
                idempotencyKey: input.idempotencyKey,
                requestSha256: input.requestSha256,
              },
              () => new Launch2IdempotencyConflictError(),
            );
            const existing = await client.query<Row>({
              text: `select ${intentColumns} from public.launch2_intents where idempotency_record_id = $1`,
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
        // Chain reads happen outside any transaction; a refusal rolls the
        // claim back so the key stays usable.
        let built: CreateLaunch2IntentRecord;
        try {
          built = await input.build();
        } catch (error) {
          // The claim stays: the same key and body rebuild on retry.
          throw new CallerCallbackError(error);
        }
        let admission;
        try {
          admission = input.canaryAdmission(built);
        } catch (error) {
          throw new CallerCallbackError(error);
        }
        const inserted = await withV2Transaction(
          pool,
          unavailable,
          async (client: PoolClient) => {
            await lockV2Owner(client, input.ownerUserId, unavailable);
            const raced = await client.query<Row>({
              text: `select ${intentColumns} from public.launch2_intents where idempotency_record_id = $1`,
              values: [claim.recordId],
            });
            if (raced.rows[0] !== undefined) {
              return { created: false, row: raced.rows[0] };
            }
            if (admission !== null) {
              await admitCanaryExposure(
                client,
                input.ownerUserId,
                admission,
                (error) => new CallerCallbackError(error),
              );
            }
            const result = await client.query<Row>({
              text: `
                insert into public.launch2_intents (
                  intent_id, owner_user_id, idempotency_record_id, instance_id,
                  wallet_id, wallet_address, kind, chain_id, contract_address,
                  amount_in, expected_out, min_out, tax_usd1, refund_usd1,
                  deadline, snapshot_block_number, snapshot_block_hash,
                  calldata, unsigned_transaction, approval, policy,
                  payload_digest, expires_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric,
                  $11::numeric, $12::numeric, $13::numeric, $14::numeric,
                  $15::timestamptz, $16::numeric, $17, $18::jsonb, $19::jsonb,
                  $20::jsonb, $21::jsonb, $22, $23::timestamptz)
                returning ${intentColumns}
              `,
              values: [
                built.intentId,
                input.ownerUserId,
                claim.recordId,
                built.instanceId,
                built.walletId,
                built.walletAddress,
                built.kind,
                built.chainId,
                built.contractAddress,
                built.amountIn,
                built.expectedOut,
                built.minOut,
                built.taxUsd1,
                built.refundUsd1,
                built.deadline,
                built.snapshotBlockNumber,
                built.snapshotBlockHash,
                JSON.stringify(built.calldata),
                JSON.stringify(built.unsignedTransaction),
                built.approval === null ? null : JSON.stringify(built.approval),
                JSON.stringify(built.policy),
                built.payloadDigest,
                built.expiresAt,
              ],
            });
            return { created: true, row: result.rows[0] as Row };
          },
        );
        return Object.freeze({
          created: inserted.created,
          intent: mapIntent(inserted.row),
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}
