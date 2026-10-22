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
  launch2CurvePriceNumerator,
  launch2CurveVirtualMeme,
  launch2PriceAt,
  launch2ReserveAt,
} from "../features/launch2/launch2-curve-math.js";
import {
  launch2PoolPriceE18,
  launch2PoolSwapFacts,
} from "../features/launch2/launch2-pool.js";
import { createLaunch2CandleStore } from "./launch2-candles-repository.js";
import {
  Launch2IdempotencyConflictError,
  Launch2RepositoryUnavailableError,
  launch2ActivityKinds,
  type CreateLaunch2IntentRecord,
  type Launch2ActivityKind,
  type Launch2ActivityRecord,
  type Launch2BuybackRecord,
  type Launch2DynamicClaimReportRecord,
  type Launch2DynamicCreditAttribution,
  type Launch2DynamicCreditEntryRecord,
  type Launch2DynamicRewardRecord,
  type Launch2DynamicRoundBuyerRecord,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2LaneEvent,
  type Launch2LaneInstance,
  type Launch2OverviewInstanceFacts,
  type Launch2PoolTradeRecord,
  type Launch2PoolTradeStats,
  type Launch2PositionRecord,
  type Launch2PublicCandleRecord,
  type Launch2PublicMemeFacts,
  type Launch2PublicPoolTradeRecord,
  type Launch2Repository,
  type Launch2TradeRecord,
} from "../features/launch2/launch2-ports.js";
import type { Launch2ProjectProfile } from "../features/launch2/launch2-project-profile.js";
import {
  launch2FactoryGenerations,
  type Launch2FactoryGeneration,
} from "../features/launch2/launch2-generation.js";
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

/**
 * Decision 0152 (loop-contracts Decision 0015): the curve's per-address
 * purchase cap the executor read back and verified (S209: the Factory's
 * `maxCumulativeBuy()`), kept in the task's
 * `verification.curveMaxCumulativeBuy`. Tasks verified before S209 lack
 * the key; that code only passed curves whose cap was exactly the
 * 5,000,000 MEME constant, so that is their fact.
 */
const curvePurchaseCapColumn = `
  coalesce(
    (select (t.verification ->> 'curveMaxCumulativeBuy')::numeric
       from public.hooks_launch_deployment_tasks t
       where t.job_id = launch2_instances.job_id
         and t.verification ->> 'curveMaxCumulativeBuy' ~ '^[1-9][0-9]{0,27}$'),
    5000000000000000000000000
  )::text as curve_purchase_cap`;

/**
 * Decision 0119: the NFT sale end is the deployed `ProjectNFT.saleEnd()`
 * the S132 executor read back and verified (= start + the Factory's
 * `nftSaleDuration()`), kept in the task's `verification.nftSaleEnd`.
 * Tasks verified before S141 lack the key; that code only passed an NFT
 * whose period was exactly 604,800 s, so start + 604,800 is their fact.
 */
const nftSaleEndColumn = `
  coalesce(
    (select (t.verification ->> 'nftSaleEnd')::numeric
       from public.hooks_launch_deployment_tasks t
       where t.job_id = launch2_instances.job_id
         and t.verification ->> 'nftSaleEnd' ~ '^[1-9][0-9]{0,19}$'),
    extract(epoch from launch2_instances.nft_sale_start)::numeric(20, 0)
      + 604800
  )::text as nft_sale_end_seconds`;

/**
 * Decision 0127: a pool swap that is not a buyback — its PoolManager caller
 * is neither the instance's buyback adapter (the contract that swaps for
 * the executor) nor the executor itself. Decision 0158: nor a swap in a
 * transaction that recorded one of the instance's buybacks — a LoopDynamic
 * buyback reaches the PoolManager through the shared LoopRouter, so its
 * caller is the router, like every user swap (S221: 2 buybacks counted as
 * user trades). `swap` is the `launch2_pool_swaps` alias; the instance is
 * `i`.
 */
const userSwap = (swap: string): string => `${swap}.caller_address
    is distinct from i.buyback_adapter_address
  and ${swap}.caller_address is distinct from i.buyback_executor_address
  and not exists (
    select 1 from public.launch2_buybacks b
    where b.chain_id = ${swap}.chain_id
      and b.instance_id = ${swap}.instance_id
      and b.transaction_hash = ${swap}.transaction_hash
      and not b.removed)`;

const instanceColumns = `
  instance_id::text, job_id::text, project_id::text, config_version,
  owner_user_id::text, chain_id, factory_address, factory_generation,
  launch_id, config_hash,
  project_owner, name, ticker, logo_url, nft_image_url, nft_image_cid,
  meme_address,
  hook_address, nft_address, curve_address, gate_address, escrow_address,
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
  official_pool_id, opened_without_holders_at,
  opened_without_holders_block::text, opened_without_holders_tx,
  buyback_paused, buyback_count::text, buyback_usd1::text,
  buyback_meme::text, last_buyback_at, projected_at, registered_at,
  pool_trade_count::text, pool_buy_count::text, pool_sell_count::text,
  pool_buy_volume_usd1::text, pool_sell_volume_usd1::text,
  pool_tax_usd1::text, pool_tax_meme::text, pool_last_price_e18::text,
  pool_last_trade_at,
  pool_user_trade_count::text, pool_user_buy_volume_usd1::text,
  pool_user_sell_volume_usd1::text,
  (select coalesce(sum(s.usd1_amount), 0)::text
    from public.launch2_pool_swaps s
    where s.instance_id = launch2_instances.instance_id and not s.removed
      and s.swapped_at > clock_timestamp() - interval '24 hours')
    as pool_volume_24h_usd1,
  coalesce(activated_at, registered_at) as sort_at,
  meme_transfers_target_block::text,
  meme_transfers_coverage_failures,
  pool_router_target_block::text,
  pool_hook_kind, dynamic_hook_address, dynamic_pool_id,
  dynamic_hook_bound_block::text, listing,
  (select jsonb_build_object(
      'status', p.status, 'txHash', p.tx_hash,
      'cutoffBlock', p.cutoff_block::text, 'memberCount', p.member_count)
    from public.launch2_snapshot_publications p
    where p.instance_id = launch2_instances.instance_id
      and p.action = 'publish_snapshot'
    order by p.attempt desc limit 1) as snapshot_publication,
  (select jsonb_build_object(
      'status', k.status, 'reasonCode', k.reason_code,
      'lastAttemptAt', coalesce(k.last_rejected_at, k.created_at),
      'nextEligibleAt', k.next_eligible_at,
      'aligned', k.buyback_id is not null)
    from public.launch2_buyback_attempts k
    where k.instance_id = launch2_instances.instance_id
    order by k.attempt desc limit 1) as buyback_keeper,
  (select jsonb_build_object('cutoffBlock', c.cutoff_block::text,
      'closedAt', c.created_at)
    from public.launch2_snapshot_closures c
    where c.instance_id = launch2_instances.instance_id) as snapshot_closure,
  (select jsonb_build_object('description', v.config -> 'description',
      'links', v.config -> 'links')
    from public.hooks_launch_project_config_versions v
    where v.project_id = launch2_instances.project_id
      and v.config_version = launch2_instances.config_version)
    as project_profile,
  ${nftSaleEndColumn},
  ${curvePurchaseCapColumn}
`;

/**
 * Decision 0138: the joined config's description / links, read leniently
 * (a malformed value degrades to null / [] rather than failing the read).
 */
function projectProfileOf(value: unknown): Launch2ProjectProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const description = record["description"];
  const links = record["links"];
  return Object.freeze({
    description: typeof description === "string" ? description : null,
    links: Object.freeze(
      Array.isArray(links)
        ? links.filter((link): link is string => typeof link === "string")
        : [],
    ),
  });
}

/** Decision 0121: the newest buyback keeper attempt, if any. */
function keeperOf(value: unknown): Launch2InstanceRecord["buybackKeeper"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (
    status !== "rejected" &&
    status !== "pending" &&
    status !== "broadcast" &&
    status !== "confirmed" &&
    status !== "failed"
  ) {
    throw new Launch2RepositoryUnavailableError();
  }
  const at = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" ? new Date(value).toISOString() : null;
  };
  const lastAttemptAt = at("lastAttemptAt");
  if (lastAttemptAt === null) throw new Launch2RepositoryUnavailableError();
  return Object.freeze({
    status,
    reasonCode:
      typeof record["reasonCode"] === "string" ? record["reasonCode"] : null,
    lastAttemptAt,
    nextEligibleAt: at("nextEligibleAt"),
    aligned: record["aligned"] === true,
  });
}

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

/** Decision 0120: the no-holder closure, if the publisher recorded one. */
function closureOf(value: unknown): Launch2InstanceRecord["noHoldersClosure"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const cutoffBlock = record["cutoffBlock"];
  const closedAt = record["closedAt"];
  if (
    typeof cutoffBlock !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(cutoffBlock) ||
    typeof closedAt !== "string" ||
    !Number.isFinite(Date.parse(closedAt))
  ) {
    throw new Launch2RepositoryUnavailableError();
  }
  return Object.freeze({
    cutoffBlock,
    closedAt: new Date(closedAt).toISOString(),
  });
}

function saleEndOf(row: Row): string {
  const seconds = row["nft_sale_end_seconds"];
  const start = Date.parse(iso(row, "nft_sale_start"));
  if (typeof seconds !== "string" || !/^[1-9][0-9]{0,11}$/.test(seconds)) {
    throw new Launch2RepositoryUnavailableError();
  }
  const end = Number(seconds) * 1000;
  if (!Number.isFinite(start) || end <= start) {
    throw new Launch2RepositoryUnavailableError();
  }
  return new Date(end).toISOString();
}

function generationOf(value: unknown): Launch2FactoryGeneration {
  if (
    typeof value !== "string" ||
    !(launch2FactoryGenerations as readonly string[]).includes(value)
  ) {
    throw new Launch2RepositoryUnavailableError();
  }
  return value as Launch2FactoryGeneration;
}

function mapInstance(row: Row): Launch2InstanceRecord {
  const snapshotRoot = nullableText(row, "snapshot_root");
  const openedAt = nullableIso(row, "opened_without_holders_at");
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
    generation: generationOf(row["factory_generation"]),
    launchId: text(row, "launch_id"),
    configHash: text(row, "config_hash"),
    projectOwner: text(row, "project_owner"),
    name: text(row, "name"),
    ticker: text(row, "ticker"),
    logoUrl: nullableText(row, "logo_url"),
    nftImageUrl: nullableText(row, "nft_image_url"),
    nftImageCid: nullableText(row, "nft_image_cid"),
    listing: row["listing"] === "hidden" ? "hidden" : "visible",
    projectProfile: projectProfileOf(row["project_profile"]),
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
    nftSaleEnd: saleEndOf(row),
    curvePurchaseCap: text(row, "curve_purchase_cap"),
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
    noHoldersClosure: closureOf(row["snapshot_closure"]),
    openedWithoutHolders:
      openedAt === null
        ? null
        : Object.freeze({
            openedAt,
            blockNumber: text(row, "opened_without_holders_block"),
            transactionHash: text(row, "opened_without_holders_tx"),
          }),
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
    pool: Object.freeze({
      tradeCount: text(row, "pool_trade_count"),
      buyCount: text(row, "pool_buy_count"),
      sellCount: text(row, "pool_sell_count"),
      buyVolumeUsd1: text(row, "pool_buy_volume_usd1"),
      sellVolumeUsd1: text(row, "pool_sell_volume_usd1"),
      volume24hUsd1: text(row, "pool_volume_24h_usd1"),
      taxUsd1: text(row, "pool_tax_usd1"),
      taxMeme: text(row, "pool_tax_meme"),
      lastPriceE18: nullableText(row, "pool_last_price_e18"),
      lastTradeAt: nullableIso(row, "pool_last_trade_at"),
      userTradeCount: text(row, "pool_user_trade_count"),
      userBuyVolumeUsd1: text(row, "pool_user_buy_volume_usd1"),
      userSellVolumeUsd1: text(row, "pool_user_sell_volume_usd1"),
    }),
    // Decision 0131: the registry row's hook kind and the bound Hook.
    poolHookKind:
      row["pool_hook_kind"] === "loopDynamic" ? "loopDynamic" : "officialTax",
    dynamicPool:
      nullableText(row, "dynamic_hook_address") === null
        ? null
        : Object.freeze({
            hook: text(row, "dynamic_hook_address"),
            poolId: text(row, "dynamic_pool_id"),
            boundBlock: text(row, "dynamic_hook_bound_block"),
          }),
    buybackKeeper: keeperOf(row["buyback_keeper"]),
    registeredAt: iso(row, "registered_at"),
    projectedAt: iso(row, "projected_at"),
  });
}

function secondsToTimestamp(seconds: string): string {
  return new Date(Number(BigInt(seconds)) * 1000).toISOString();
}

/**
 * Decision 0126: the router attribution the lane paired with a PoolManager
 * swap (all five or none; anything malformed is left unattributed).
 * Decision 0132: `attributionSource = transactionSender` — a LoopDynamic
 * swap attributed to its transaction's `from` (direct LoopRouter call): the
 * same four values without a router log index. The sixth value is the
 * stored `attribution_source`.
 */
function attributionValues(
  a: Readonly<Record<string, string>>,
  logIndex: number,
): (string | number | null)[] {
  const payer = a["routerPayer"];
  const recipient = a["routerRecipient"];
  const amountIn = a["routerAmountIn"];
  const amountOut = a["routerAmountOut"];
  const routerLog = a["routerLogIndex"];
  const address = /^0x[0-9a-f]{40}$/u;
  const positive = /^[1-9][0-9]{0,77}$/u;
  if (a["attributionSource"] === "transactionSender") {
    if (
      payer === undefined ||
      recipient === undefined ||
      amountIn === undefined ||
      amountOut === undefined ||
      routerLog !== undefined ||
      !address.test(payer) ||
      !address.test(recipient) ||
      !positive.test(amountIn) ||
      !positive.test(amountOut)
    ) {
      return [null, null, null, null, null, null];
    }
    return [payer, recipient, amountIn, amountOut, null, "transaction_sender"];
  }
  if (
    payer === undefined ||
    recipient === undefined ||
    amountIn === undefined ||
    amountOut === undefined ||
    routerLog === undefined ||
    !address.test(payer) ||
    !address.test(recipient) ||
    !positive.test(amountIn) ||
    !positive.test(amountOut) ||
    !/^[0-9]{1,9}$/u.test(routerLog) ||
    Number(routerLog) <= logIndex
  ) {
    return [null, null, null, null, null, null];
  }
  return [
    payer,
    recipient,
    amountIn,
    amountOut,
    Number(routerLog),
    "router_swap",
  ];
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
  } else if (event.eventName === "Swap") {
    // Decision 0124: the lane adds memeIsCurrency0 from the hook's
    // currency0(); a log that is not one-in-one-out stays raw only.
    const facts = launch2PoolSwapFacts({
      amount0: BigInt(a["amount0"] ?? "0"),
      amount1: BigInt(a["amount1"] ?? "0"),
      memeIsCurrency0: a["memeIsCurrency0"] === "true",
    });
    if (
      facts !== null &&
      (a["memeIsCurrency0"] === "true" || a["memeIsCurrency0"] === "false")
    ) {
      const sqrtPrice = BigInt(a["sqrtPriceX96"] ?? "0");
      const dynamic = a["poolHookKind"] === "loopDynamic";
      // Decision 0131: a LoopDynamic pool's fee is the Hook's own log
      // (BuyFeeCharged / SellFeeCharged of the same swap, paired by the
      // lane); unpaired = no fee (an exempt buyback).
      const dynamicFee =
        dynamic && /^(0|[1-9][0-9]{0,77})$/u.test(a["dynamicFee"] ?? "")
          ? BigInt(a["dynamicFee"] as string)
          : 0n;
      // Decision 0152 (loop-contracts Decision 0015): an S209 Hook took the
      // buy fee from the USD1 input before the pool swapped — the Swap log
      // shows the pool input, the buyer paid input + fee, and the fee is
      // USD1; the MEME output is untaxed.
      const usd1BuyFee =
        dynamic && facts.side === "buy" && a["dynamicFeeToken"] === "usd1";
      await client.query({
        text: `
          insert into public.launch2_pool_swaps (
            chain_id, transaction_hash, log_index, block_number, block_hash,
            instance_id, pool_id, caller_address, side, usd1_amount,
            meme_amount, tax_amount, tax_token, sqrt_price_x96, price_e18,
            swapped_at, wallet_address, recipient_address, router_amount_in,
            router_amount_out, router_log_index, attribution_source
          )
          values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10::numeric,
            $11::numeric, $12::numeric, $13, $14::numeric, $15::numeric,
            $16::timestamptz, $17, $18, $19::numeric, $20::numeric, $21::integer,
            $22)
          on conflict (chain_id, transaction_hash, log_index) do update set
            block_number = excluded.block_number,
            block_hash = excluded.block_hash,
            removed = false,
            observed_at = clock_timestamp(),
            -- Decision 0126: a re-scan fills a missing attribution; one
            -- already paired is kept (same transaction, same router log).
            wallet_address = coalesce(public.launch2_pool_swaps.wallet_address, excluded.wallet_address),
            recipient_address = coalesce(public.launch2_pool_swaps.recipient_address, excluded.recipient_address),
            router_amount_in = coalesce(public.launch2_pool_swaps.router_amount_in, excluded.router_amount_in),
            router_amount_out = coalesce(public.launch2_pool_swaps.router_amount_out, excluded.router_amount_out),
            router_log_index = coalesce(public.launch2_pool_swaps.router_log_index, excluded.router_log_index),
            -- Decision 0132: the source travels with the first attribution.
            attribution_source = case
              when public.launch2_pool_swaps.wallet_address is null
                then excluded.attribution_source
              else public.launch2_pool_swaps.attribution_source end
        `,
        values: [
          ...base,
          a["id"],
          a["sender"],
          facts.side,
          (usd1BuyFee
            ? facts.usd1Amount + dynamicFee
            : facts.usd1Amount
          ).toString(10),
          facts.memeAmount.toString(10),
          (dynamic ? dynamicFee : facts.taxAmount).toString(10),
          usd1BuyFee ? "usd1" : facts.taxToken,
          sqrtPrice.toString(10),
          launch2PoolPriceE18(
            sqrtPrice,
            a["memeIsCurrency0"] === "true",
          ).toString(10),
          at,
          ...attributionValues(a, event.logIndex),
        ],
      });
    }
  } else if (event.eventName === "LoopHookBound") {
    // Decision 0131: the graduation adapter bound the instance's Hook.
    await client.query({
      text: `
        insert into public.launch2_dynamic_hook_bindings (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, hook_address, pool_id, bound_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9::timestamptz)
        ${upsertTail}
      `,
      values: [...base, a["hook"], a["poolId"], at],
    });
  } else if (event.eventName === "SellFeeCharged") {
    await client.query({
      text: `
        insert into public.launch2_dynamic_fees (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, hook_address, side, fee_token, round_id,
          buyer_address, gross_amount, base_fee, extra_fee, drop_wad,
          charged_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, 'sell', 'usd1',
          $8::numeric, null, $9::numeric, $10::numeric, $11::numeric,
          $12::numeric, $13::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        event.contractAddress,
        a["round"],
        a["grossQuote"],
        a["baseFee"],
        a["extraFee"],
        a["dropWad"],
        at,
      ],
    });
  } else if (event.eventName === "BuyFeeCharged") {
    // Decision 0152 (loop-contracts Decision 0015): an S209 Hook's
    // `BuyFeeCharged(round, buyer, grossQuote, fee)` — 2 % of the USD1 the
    // buyer paid, kept in the Hook's `baseFeesAccrued` (round 0 = no round
    // armed, buyer 0 = an unattributed tier-3 buy). A pre-S209 Hook's
    // `BuyFeeCharged(buyer, grossMeme, fee)` — loop-contracts S165: 2 % of
    // the MEME output to the fee vault — keeps its MEME row.
    const usd1 = a["grossQuote"] !== undefined;
    await client.query({
      text: `
        insert into public.launch2_dynamic_fees (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, hook_address, side, fee_token, round_id,
          buyer_address, gross_amount, base_fee, extra_fee, drop_wad,
          charged_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, 'buy', $8, $9::numeric,
          $10, $11::numeric, $12::numeric, 0, 0, $13::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        event.contractAddress,
        usd1 ? "usd1" : "meme",
        usd1 ? a["round"] : null,
        a["buyer"],
        usd1 ? a["grossQuote"] : a["grossMeme"],
        a["fee"],
        at,
      ],
    });
  } else if (event.eventName === "CandleClosed") {
    await client.query({
      text: `
        insert into public.launch2_dynamic_candles (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, hook_address, candle_id, open_sqrt_price_x96,
          close_sqrt_price_x96, closed_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, $8::numeric,
          $9::numeric, $10::numeric, $11::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        event.contractAddress,
        a["candle"],
        a["openSqrtPriceX96"],
        a["closeSqrtPriceX96"],
        at,
      ],
    });
  } else if (event.eventName === "RewardClaimed") {
    await client.query({
      text: `
        insert into public.launch2_dynamic_claims (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          instance_id, hook_address, round_id, buyer_address, amount_usd1,
          claimed_at
        )
        values ($1, $2, $3, $4::numeric, $5, $6, $7, $8::numeric, $9,
          $10::numeric, $11::timestamptz)
        ${upsertTail}
      `,
      values: [
        ...base,
        event.contractAddress,
        a["round"],
        a["buyer"],
        a["amount"],
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
        // Decision 0122: a v3 BuybackCompleted has no protection fields.
        a["minMemeOut"] ?? null,
        a["referencePrice"] ?? null,
        a["spotPrice"] ?? null,
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
            'tx', transaction_hash)
          from public.launch2_events
          where instance_id = $1 and not removed
            and event_name = 'PublicRoundOpenedWithoutHolders'
          order by block_number, log_index limit 1) as opened,
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
        (select jsonb_build_object('count', count(*)::text,
            'buys', count(*) filter (where side = 'buy')::text,
            'sells', count(*) filter (where side = 'sell')::text,
            'buyUsd1', coalesce(sum(usd1_amount) filter (where side = 'buy'), 0)::text,
            'sellUsd1', coalesce(sum(usd1_amount) filter (where side = 'sell'), 0)::text,
            'taxUsd1', coalesce(sum(tax_amount) filter (where tax_token = 'usd1'), 0)::text,
            'taxMeme', coalesce(sum(tax_amount) filter (where tax_token = 'meme'), 0)::text,
            'lastPrice', (select p.price_e18::text from public.launch2_pool_swaps p
              where p.instance_id = $1 and not p.removed
              order by p.block_number desc, p.log_index desc limit 1),
            'lastAt', max(swapped_at),
            -- Decision 0127: market trades only — swaps the instance's own
            -- buyback adapter / executor sent to the PoolManager are
            -- buybacks (ledger: launch2_buybacks), not outside trading.
            'userCount', count(*) filter (where ${userSwap("ps")})::text,
            'userBuyUsd1', coalesce(sum(ps.usd1_amount) filter (where ps.side = 'buy' and ${userSwap("ps")}), 0)::text,
            'userSellUsd1', coalesce(sum(ps.usd1_amount) filter (where ps.side = 'sell' and ${userSwap("ps")}), 0)::text)
          from public.launch2_pool_swaps ps
          where ps.instance_id = $1 and not ps.removed) as pool_swaps,
        i.meme_address, i.nft_address, i.curve_address, i.hook_address,
        i.project_owner, i.activation_block_number::text as activation_block,
        i.snapshot_root, i.factory_generation
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
  // Decision 0122: the zero-holder opening (v3 registries only; the
  // contract makes it exclusive with a published snapshot).
  const openedFact = row["opened"] as {
    payload: Record<string, string>;
    block: string;
    tx: string;
  } | null;
  const opened =
    openedFact !== null &&
    snapshot === null &&
    row["factory_generation"] !== "v2"
      ? openedFact
      : null;
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
  const poolSwaps = row["pool_swaps"] as {
    count: string;
    buys: string;
    sells: string;
    buyUsd1: string;
    sellUsd1: string;
    taxUsd1: string;
    taxMeme: string;
    lastPrice: string | null;
    lastAt: string | null;
    userCount: string;
    userBuyUsd1: string;
    userSellUsd1: string;
  };
  // Decision 0124: swaps count only while the graduation is indexed (a
  // rewound graduation leaves its pool facts out of the projection).
  const poolCounted = graduated !== null && poolSwaps.count !== "0";
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
        opened_without_holders_at = $29::timestamptz,
        opened_without_holders_block = $30::numeric,
        opened_without_holders_tx = $31,
        pool_trade_count = $32::numeric,
        pool_buy_count = $33::numeric,
        pool_sell_count = $34::numeric,
        pool_buy_volume_usd1 = $35::numeric,
        pool_sell_volume_usd1 = $36::numeric,
        pool_tax_usd1 = $37::numeric,
        pool_tax_meme = $38::numeric,
        pool_last_price_e18 = $39::numeric,
        pool_last_trade_at = $40::timestamptz,
        pool_user_trade_count = $41::numeric,
        pool_user_buy_volume_usd1 = $42::numeric,
        pool_user_sell_volume_usd1 = $43::numeric,
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
      opened === null
        ? null
        : secondsToTimestamp(opened.payload["openedAt"] ?? "0"),
      opened === null ? null : (opened.payload["openedBlock"] ?? opened.block),
      opened?.tx ?? null,
      poolCounted ? poolSwaps.count : "0",
      poolCounted ? poolSwaps.buys : "0",
      poolCounted ? poolSwaps.sells : "0",
      poolCounted ? poolSwaps.buyUsd1 : "0",
      poolCounted ? poolSwaps.sellUsd1 : "0",
      poolCounted ? poolSwaps.taxUsd1 : "0",
      poolCounted ? poolSwaps.taxMeme : "0",
      poolCounted ? poolSwaps.lastPrice : null,
      poolCounted ? poolSwaps.lastAt : null,
      poolCounted ? poolSwaps.userCount : "0",
      poolCounted ? poolSwaps.userBuyUsd1 : "0",
      poolCounted ? poolSwaps.userSellUsd1 : "0",
    ],
  });
  await reprojectPositions(client, instanceId);
  await reprojectDynamic(client, instanceId);
}

const creditAttributions: readonly Launch2DynamicCreditAttribution[] = [
  "loopRouter",
  "registryRouter",
  "delivery",
  "moved",
  "unknown",
];

function creditAttribution(value: unknown): Launch2DynamicCreditAttribution {
  return creditAttributions.find((known) => known === value) ?? "unknown";
}

/** Decision 0146: the jsonb entry list of `listDynamicRewards`. */
function creditEntries(
  value: unknown,
): readonly Launch2DynamicCreditEntryRecord[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    (value as Record<string, unknown>[]).map(
      (entry): Launch2DynamicCreditEntryRecord =>
        Object.freeze({
          direction: entry["direction"] === "out" ? "out" : "in",
          attribution: creditAttribution(entry["attribution"]),
          counterparty:
            typeof entry["counterparty"] === "string"
              ? entry["counterparty"]
              : null,
          amountUsd1: String(entry["amount"]),
          transactionHash: String(entry["tx"]),
          logIndex: Number(entry["logIndex"]),
          blockNumber: String(entry["block"]),
          creditedAt: new Date(String(entry["at"])).toISOString(),
        }),
    ),
  );
}

/**
 * Decision 0131: rebuilds a LoopDynamic instance's Hook binding, reward
 * rounds and buy weights from its non-removed facts (a reorg that removed
 * any of them is undone here). OfficialTax instances are left untouched.
 */
async function reprojectDynamic(
  client: DatabaseClient,
  instanceId: string,
): Promise<void> {
  const kind = await client.query<{ pool_hook_kind: string }>({
    text: `select pool_hook_kind from public.launch2_instances where instance_id = $1`,
    values: [instanceId],
  });
  if (kind.rows[0]?.pool_hook_kind !== "loopDynamic") return;
  await client.query({
    text: `
      update public.launch2_instances i
      set dynamic_hook_address = b.hook_address,
          dynamic_pool_id = b.pool_id,
          dynamic_hook_bound_block = b.block_number
      from (select 1) as one
      left join lateral (
        select hook_address, pool_id, block_number
        from public.launch2_dynamic_hook_bindings
        where instance_id = $1 and not removed
        order by block_number, log_index limit 1
      ) b on true
      where i.instance_id = $1
    `,
    values: [instanceId],
  });
  await client.query({
    text: `delete from public.launch2_dynamic_rounds where instance_id = $1`,
    values: [instanceId],
  });
  await client.query({
    text: `delete from public.launch2_dynamic_buy_weights where instance_id = $1`,
    values: [instanceId],
  });
  await client.query({
    text: `delete from public.launch2_dynamic_credit_entries where instance_id = $1`,
    values: [instanceId],
  });
  // Decision 0146: the weight entries — BuyCredited (in; the lane's
  // attribution, absent on rows indexed before S201 = unknown) and
  // CreditMoved (moved: out of from, into to).
  await client.query({
    text: `
      with hook as (
        select dynamic_hook_address as address from public.launch2_instances
        where instance_id = $1 and dynamic_hook_address is not null
      ),
      logs as (
        select e.* from public.launch2_events e, hook
        where e.instance_id = $1 and not e.removed
          and e.contract_address = hook.address
          and e.event_name in ('BuyCredited', 'CreditMoved')
      )
      insert into public.launch2_dynamic_credit_entries (
        instance_id, round_id, address, direction, attribution,
        counterparty_address, amount_usd1, hook_address, chain_id,
        transaction_hash, log_index, block_number, credited_at
      )
      select $1, (payload ->> 'round')::numeric, payload ->> 'buyer', 'in',
        case when payload ->> 'attribution'
            in ('loopRouter', 'registryRouter', 'delivery')
          then payload ->> 'attribution' else 'unknown' end,
        null, (payload ->> 'quoteSpent')::numeric, contract_address,
        chain_id, transaction_hash, log_index, block_number, event_at
      from logs where event_name = 'BuyCredited'
      union all
      select $1, (payload ->> 'round')::numeric, payload ->> 'to', 'in',
        'moved', payload ->> 'from', (payload ->> 'quoteSpent')::numeric,
        contract_address, chain_id, transaction_hash, log_index,
        block_number, event_at
      from logs where event_name = 'CreditMoved'
      union all
      select $1, (payload ->> 'round')::numeric, payload ->> 'from', 'out',
        'moved', payload ->> 'to', (payload ->> 'quoteSpent')::numeric,
        contract_address, chain_id, transaction_hash, log_index,
        block_number, event_at
      from logs where event_name = 'CreditMoved'
    `,
    values: [instanceId],
  });
  // Decision 0146: weight = Σ BuyCredited + Σ CreditMoved in − Σ out, the
  // chain's buyWeight(round, address); an address whose weight was moved on
  // entirely has none left (no row).
  await client.query({
    text: `
      insert into public.launch2_dynamic_buy_weights (
        instance_id, round_id, buyer_address, weight_usd1, credit_count,
        last_credited_at, credited_usd1, moved_in_usd1, moved_out_usd1
      )
      select $1, round_id, address,
        credited + moved_in - moved_out, credits, last_at,
        credited, moved_in, moved_out
      from (
        select round_id, address,
          coalesce(sum(amount_usd1) filter (
            where direction = 'in' and attribution <> 'moved'), 0) as credited,
          coalesce(sum(amount_usd1) filter (
            where direction = 'in' and attribution = 'moved'), 0) as moved_in,
          coalesce(sum(amount_usd1) filter (where direction = 'out'), 0) as moved_out,
          (count(*) filter (where direction = 'in'))::integer as credits,
          max(credited_at) filter (where direction = 'in') as last_at
        from public.launch2_dynamic_credit_entries
        where instance_id = $1
        group by round_id, address
      ) merged
      where credited + moved_in - moved_out > 0
    `,
    values: [instanceId],
  });
  await client.query({
    text: `
      with hook as (
        select dynamic_hook_address as address from public.launch2_instances
        where instance_id = $1 and dynamic_hook_address is not null
      ),
      activated as (
        select distinct on ((e.payload ->> 'round')::numeric)
          (e.payload ->> 'round')::numeric as round_id,
          (e.payload ->> 'startCandle')::numeric as start_candle,
          (e.payload ->> 'carriedQuote')::numeric as carried_in,
          e.event_at, e.block_number, e.transaction_hash
        from public.launch2_events e, hook
        where e.instance_id = $1 and not e.removed
          and e.event_name = 'RoundActivated' and e.contract_address = hook.address
        order by (e.payload ->> 'round')::numeric, e.block_number, e.log_index
      )
      insert into public.launch2_dynamic_rounds (
        instance_id, round_id, hook_address, start_candle, end_candle,
        carried_in_usd1, extra_fees_usd1, total_buy_weight_usd1,
        allocation_usd1, next_carry_usd1, claimed_usd1, buyer_count, closed,
        activated_at, activated_block, activated_transaction_hash,
        closed_at, closed_block, closed_transaction_hash
      )
      select $1, a.round_id, hook.address, a.start_candle,
        (c.payload ->> 'endCandle')::numeric, a.carried_in,
        coalesce((select sum(f.extra_fee) from public.launch2_dynamic_fees f
          where f.instance_id = $1 and not f.removed and f.side = 'sell'
            and f.hook_address = hook.address and f.round_id = a.round_id), 0),
        coalesce((select sum((w.payload ->> 'quoteSpent')::numeric)
          from public.launch2_events w
          where w.instance_id = $1 and not w.removed
            and w.event_name = 'BuyCredited' and w.contract_address = hook.address
            and (w.payload ->> 'round')::numeric = a.round_id), 0),
        (c.payload ->> 'rewardAllocation')::numeric,
        (c.payload ->> 'nextCarry')::numeric,
        coalesce((select sum(k.amount_usd1) from public.launch2_dynamic_claims k
          where k.instance_id = $1 and not k.removed
            and k.hook_address = hook.address and k.round_id = a.round_id), 0),
        (select count(*)::integer from public.launch2_dynamic_buy_weights w
          where w.instance_id = $1 and w.round_id = a.round_id),
        c.payload is not null,
        a.event_at, a.block_number, a.transaction_hash,
        c.event_at, c.block_number, c.transaction_hash
      from activated a
      cross join hook
      left join lateral (
        select e.payload, e.event_at, e.block_number, e.transaction_hash
        from public.launch2_events e
        where e.instance_id = $1 and not e.removed
          and e.event_name = 'RoundClosed' and e.contract_address = hook.address
          and (e.payload ->> 'round')::numeric = a.round_id
        order by e.block_number, e.log_index limit 1
      ) c on true
    `,
    values: [instanceId],
  });
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
      pool_holders as (
        -- Decision 0126: wallets whose pool swaps the router attributed.
        select wallet_address as holder, max(swapped_at) as last
        from public.launch2_pool_swaps
        where instance_id = $1 and not removed and wallet_address is not null
        group by wallet_address
      ),
      holders as (
        select holder from held union select holder from mints
        union select holder from trades union select holder from pool_holders
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
        greatest(held.last, m.last, t.last, ph.last)
      from holders h
      left join held on held.holder = h.holder
      left join mints m on m.holder = h.holder
      left join trades t on t.holder = h.holder
      left join pool_holders ph on ph.holder = h.holder
      where h.holder ~ '^0x[0-9a-f]{40}$'
    `,
    values: [instanceId, zeroAddress],
  });
}

/**
 * Decision 0139: the launchpad activity feed. Each branch reads one typed
 * fact table of the chain's listed instances (same visibility as
 * `listInstances`), keeps its own newest `$2`, and the union keeps the
 * newest `$2` overall. Ties order by block, log index, kind, hash.
 *
 * - curve_buy / curve_sell: `launch2_trades` (CurveBought / CurveSold;
 *   buy = USD1 paid incl. tax = `usd1_gross`, sell = USD1 received =
 *   `usd1_net`), and the official pool's user swaps `launch2_pool_swaps`
 *   (Decision 0127 user filter, and no `BuybackCompleted` in the same
 *   transaction; buy = USD1 in, sell = USD1 out − a USD1 fee; actor =
 *   the Decision 0126 / 0132 attributed wallet, null when anonymous);
 * - nft_mint: `launch2_nft_mints` (payer, `amount_usd1`);
 * - graduated: `launch2_instances.graduated_at` (lane projection of
 *   `Graduated`; actor / amount null);
 * - buyback: `launch2_buybacks` with outcome `executed` (`usd1_spent`;
 *   actor null);
 * - round_activated: `launch2_dynamic_rounds` (projection of the non-removed
 *   `RoundActivated`; actor / amount null);
 * - reward_claimed: `launch2_dynamic_claims` (RewardClaimed; buyer, USD1).
 */
const activitySql = `
  with visible as (
    select instance_id, ticker, name, logo_url, graduated_at,
      graduation_block, graduation_transaction_hash,
      buyback_adapter_address, buyback_executor_address
    from public.launch2_instances
    where chain_id = $1 and (activated_at is not null or hold_reason is not null)
      and listing = 'visible'
  ),
  feed as (
    (select case t.side when 'buy' then 'curve_buy' else 'curve_sell' end as kind,
        t.instance_id, t.trader_address as actor,
        case t.side when 'buy' then t.usd1_gross else t.usd1_net end as amount,
        t.traded_at as at, t.transaction_hash, t.block_number, t.log_index
      from public.launch2_trades t
      join visible i on i.instance_id = t.instance_id
      where not t.removed
      order by t.traded_at desc, t.block_number desc, t.log_index desc
      limit $2)
    union all
    (select case s.side when 'buy' then 'curve_buy' else 'curve_sell' end,
        s.instance_id, s.wallet_address,
        case when s.side = 'buy' then s.usd1_amount
          when s.tax_token = 'usd1' then greatest(s.usd1_amount - s.tax_amount, 0)
          else s.usd1_amount end,
        s.swapped_at, s.transaction_hash, s.block_number, s.log_index
      from public.launch2_pool_swaps s
      join visible i on i.instance_id = s.instance_id
      where not s.removed and ${userSwap("s")}
      order by s.swapped_at desc, s.block_number desc, s.log_index desc
      limit $2)
    union all
    (select 'nft_mint', m.instance_id, m.payer_address, m.amount_usd1,
        m.minted_at, m.transaction_hash, m.block_number, m.log_index
      from public.launch2_nft_mints m
      join visible i on i.instance_id = m.instance_id
      where not m.removed
      order by m.minted_at desc, m.block_number desc, m.log_index desc
      limit $2)
    union all
    (select 'graduated', i.instance_id, null, null, i.graduated_at,
        i.graduation_transaction_hash, i.graduation_block, null
      from visible i
      where i.graduated_at is not null
      order by i.graduated_at desc
      limit $2)
    union all
    (select 'buyback', b.instance_id, null, b.usd1_spent, b.executed_at,
        b.transaction_hash, b.block_number, b.log_index
      from public.launch2_buybacks b
      join visible i on i.instance_id = b.instance_id
      where not b.removed and b.outcome = 'executed'
      order by b.executed_at desc, b.block_number desc, b.log_index desc
      limit $2)
    union all
    (select 'round_activated', r.instance_id, null, null, r.activated_at,
        r.activated_transaction_hash, r.activated_block, null
      from public.launch2_dynamic_rounds r
      join visible i on i.instance_id = r.instance_id
      order by r.activated_at desc, r.activated_block desc
      limit $2)
    union all
    (select 'reward_claimed', c.instance_id, c.buyer_address, c.amount_usd1,
        c.claimed_at, c.transaction_hash, c.block_number, c.log_index
      from public.launch2_dynamic_claims c
      join visible i on i.instance_id = c.instance_id
      where not c.removed
      order by c.claimed_at desc, c.block_number desc, c.log_index desc
      limit $2)
  )
  select f.kind, f.instance_id::text, v.ticker, v.name, v.logo_url, f.actor,
    f.amount::text as amount, f.at, f.transaction_hash,
    f.block_number::text as block_number, f.log_index
  from feed f
  join visible v on v.instance_id = f.instance_id
  order by f.at desc, f.block_number desc nulls last,
    f.log_index desc nulls last, f.kind, f.transaction_hash
  limit $2
`;

function activityKindOf(value: unknown): Launch2ActivityKind {
  if (
    typeof value !== "string" ||
    !(launch2ActivityKinds as readonly string[]).includes(value)
  ) {
    throw new Launch2RepositoryUnavailableError();
  }
  return value as Launch2ActivityKind;
}

function mapActivity(row: Row): Launch2ActivityRecord {
  const logIndex = row["log_index"];
  return Object.freeze({
    kind: activityKindOf(row["kind"]),
    instanceId: text(row, "instance_id"),
    ticker: text(row, "ticker"),
    name: text(row, "name"),
    logoUrl: nullableText(row, "logo_url"),
    actor: nullableText(row, "actor"),
    amountUsd1: nullableText(row, "amount"),
    at: iso(row, "at"),
    transactionHash: nullableText(row, "transaction_hash"),
    blockNumber: nullableText(row, "block_number"),
    logIndex:
      logIndex === null || logIndex === undefined ? null : Number(logIndex),
  });
}

/** Decision 0139: the stage inputs `mapInstance` reads, nothing else. */
const overviewFactsSql = `
  select instance_id::text, nft_sale_start, hold_reason,
    snapshot_published_at, graduated_at, opened_without_holders_at,
    nft_minted_count::text, buyback_usd1::text,
    (select jsonb_build_object('cutoffBlock', c.cutoff_block::text,
        'closedAt', c.created_at)
      from public.launch2_snapshot_closures c
      where c.instance_id = launch2_instances.instance_id) as snapshot_closure,
    ${nftSaleEndColumn}
  from public.launch2_instances
  where chain_id = $1 and (activated_at is not null or hold_reason is not null)
    and listing = 'visible'
`;

function mapOverviewFacts(row: Row): Launch2OverviewInstanceFacts {
  const publishedAt = nullableIso(row, "snapshot_published_at");
  const graduatedAt = nullableIso(row, "graduated_at");
  const openedAt = nullableIso(row, "opened_without_holders_at");
  return Object.freeze({
    instanceId: text(row, "instance_id"),
    nftSaleStart: iso(row, "nft_sale_start"),
    nftSaleEnd: saleEndOf(row),
    holdReason: holdOf(row["hold_reason"]),
    snapshot: publishedAt === null ? null : Object.freeze({ publishedAt }),
    graduation: graduatedAt === null ? null : Object.freeze({ graduatedAt }),
    noHoldersClosure: closureOf(row["snapshot_closure"]),
    openedWithoutHolders:
      openedAt === null ? null : Object.freeze({ openedAt }),
    nftMintedCount: text(row, "nft_minted_count"),
    buybackUsd1: text(row, "buyback_usd1"),
  });
}

function mapLaneInstance(row: Row): Launch2LaneInstance {
  const instance = mapInstance(row);
  return Object.freeze({
    instanceId: instance.instanceId,
    launchId: instance.launchId,
    generation: instance.generation,
    addresses: instance.addresses,
    deployBlockNumber: instance.deployBlockNumber,
    nftSaleStart: instance.nftSaleStart,
    nftSaleEnd: instance.nftSaleEnd,
    holdReason: instance.holdReason,
    graduated: instance.graduation !== null,
    officialPoolId: instance.graduation?.poolId ?? null,
    snapshotPublishedAt: instance.snapshot?.publishedAt ?? null,
    closedNoHolders: instance.noHoldersClosure !== null,
    openedWithoutHoldersAt: instance.openedWithoutHolders?.openedAt ?? null,
    activatedAt: instance.activatedAt,
    stage: instance.stage,
    nextChangeAt: instance.nextChangeAt,
    // Decision 0125: null until the one MEME transfer re-scan started.
    memeTransfersTargetBlock: nullableText(row, "meme_transfers_target_block"),
    // Decision 0132: consecutive failed coverage checks (3 = stalled).
    memeTransfersCoverageFailures: Number(
      row["meme_transfers_coverage_failures"] ?? 0,
    ),
    // Decision 0126: the router-attribution re-scan.
    graduationBlockNumber: instance.graduation?.blockNumber ?? null,
    poolRouterTargetBlock: nullableText(row, "pool_router_target_block"),
    // Decision 0131: the LoopDynamic Hook the lane indexed (graduation).
    dynamicHook: nullableText(row, "dynamic_hook_address"),
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

/**
 * Decision 0147: the public MEME page's indexed facts, one row per listed
 * instance (see `Launch2PublicMemeFacts`). Every sum skips reorged
 * (`removed`) facts. The community is the non-rejected one whose
 * `bound_asset_key` is `<chainId>:<meme>` (Decision 0125 binds it).
 */
const publicMemeFactsSql = `
  select i.instance_id::text,
    (select jsonb_build_object(
        'communityId', c.community_id::text, 'name', c.name,
        'description', c.description, 'memberCount', c.member_count,
        'verified', c.verification_status = 'verified')
      from public.communities c
      where c.bound_asset_key = i.chain_id || ':' || lower(i.meme_address)
        and c.verification_status <> 'rejected'
      order by c.created_at, c.community_id
      limit 1) as community,
    t.curve_tax_usd1, t.curve_sold_at_since,
    p.pool_tax_meme, p.pool_tax_usd1,
    (select jsonb_build_object(
        'roundId', r.round_id::text, 'closedAt', r.closed_at,
        'allocationUsd1', r.allocation_usd1::text,
        'buyerCount', r.buyer_count)
      from public.launch2_dynamic_rounds r
      where r.instance_id = i.instance_id and r.closed
      order by r.round_id desc
      limit 1) as last_closed_round,
    coalesce(
      (select s.price_e18 from public.launch2_pool_swaps s
        where s.instance_id = i.instance_id and not s.removed
          and s.swapped_at <= $2::timestamptz
        order by s.block_number desc, s.log_index desc limit 1),
      (select s.price_e18 from public.launch2_pool_swaps s
        where s.instance_id = i.instance_id and not s.removed
          and s.swapped_at > $2::timestamptz
        order by s.block_number asc, s.log_index asc limit 1)
    )::text as pool_reference_price_e18
  from public.launch2_instances i
  cross join lateral (
    select coalesce(sum(tr.tax_usd1), 0)::text as curve_tax_usd1,
      coalesce(sum(case when tr.side = 'buy' then tr.meme_amount
          else -tr.meme_amount end)
        filter (where tr.traded_at <= $2::timestamptz), 0)::text
        as curve_sold_at_since
    from public.launch2_trades tr
    where tr.instance_id = i.instance_id and not tr.removed
  ) t
  cross join lateral (
    select
      coalesce(sum(s.tax_amount) filter (where s.tax_token = 'meme'), 0)::text
        as pool_tax_meme,
      coalesce(sum(s.tax_amount) filter (where s.tax_token = 'usd1'), 0)::text
        as pool_tax_usd1
    from public.launch2_pool_swaps s
    where s.instance_id = i.instance_id and not s.removed
  ) p
  where i.instance_id = any($1::uuid[])
`;

function mapPublicMemeFacts(row: Row): Launch2PublicMemeFacts {
  const community = row["community"] as Record<string, unknown> | null;
  const round = row["last_closed_round"] as Record<string, unknown> | null;
  const curveSold = text(row, "curve_sold_at_since");
  if (curveSold.startsWith("-")) throw new Launch2RepositoryUnavailableError();
  return Object.freeze({
    instanceId: text(row, "instance_id"),
    community:
      community === null
        ? null
        : Object.freeze({
            communityId: String(community["communityId"]),
            name: String(community["name"]),
            description:
              typeof community["description"] === "string" &&
              community["description"].length > 0
                ? community["description"]
                : null,
            memberCount: Number(community["memberCount"]),
            verified: community["verified"] === true,
          }),
    curveTaxUsd1: text(row, "curve_tax_usd1"),
    poolTaxMeme: text(row, "pool_tax_meme"),
    poolTaxUsd1: text(row, "pool_tax_usd1"),
    lastClosedRound:
      round === null
        ? null
        : Object.freeze({
            roundId: String(round["roundId"]),
            closedAt: new Date(String(round["closedAt"])).toISOString(),
            allocationUsd1: String(round["allocationUsd1"]),
            buyerCount: Number(round["buyerCount"]),
          }),
    poolReferencePriceE18: nullableText(row, "pool_reference_price_e18"),
    curveSoldAtSince: curveSold,
  });
}

/** `2^192`: `price = sqrtP² / 2^192` (currency1 per currency0). */
const q192Sql = "6277101735386680763835789423207666416102355444464034512896";

/**
 * Decision 0147: 5-minute curve candles. Each trade is priced at the
 * curve's marginal price after it, `div(N, (Tv − s)²)` (= `launch2PriceAt`)
 * with `s` the running sold supply (Σ buy − sell MEME in log order);
 * volume = USD1 gross (tax included). The newest `$2` buckets, oldest first.
 */
const publicCurveCandlesSql = `
  with t as (
    select traded_at, block_number, log_index, usd1_gross,
      sum(case when side = 'buy' then meme_amount else -meme_amount end)
        over (order by block_number, log_index
          rows between unbounded preceding and current row) as sold
    from public.launch2_trades
    where instance_id = $1 and not removed
  ),
  priced as (
    select to_timestamp(floor(extract(epoch from traded_at) / 300) * 300)
        as open_time,
      block_number, log_index, usd1_gross,
      div($3::numeric, ($4::numeric - sold) * ($4::numeric - sold)) as price
    from t
    where sold >= 0 and sold < $4::numeric
  ),
  recent as (
    select distinct open_time from priced order by open_time desc limit $2
  )
  select b.open_time,
    (array_agg(b.price order by b.block_number, b.log_index))[1]::text as open_e18,
    max(b.price)::text as high_e18,
    min(b.price)::text as low_e18,
    (array_agg(b.price order by b.block_number desc, b.log_index desc))[1]::text as close_e18,
    sum(b.usd1_gross)::text as volume_usd1
  from priced b
  join recent r on r.open_time = b.open_time
  group by b.open_time
  order by b.open_time asc
`;

/**
 * Decision 0147: 5-minute official-pool candles from the indexed
 * PoolManager swaps (`price_e18` after each swap, USD1 per MEME; volume =
 * the swap's USD1 leg). Buyback swaps are market swaps here too.
 */
const publicPoolCandlesSql = `
  with b as (
    select to_timestamp(floor(extract(epoch from swapped_at) / 300) * 300)
        as open_time,
      block_number, log_index, price_e18, usd1_amount
    from public.launch2_pool_swaps
    where instance_id = $1 and not removed
  ),
  recent as (
    select distinct open_time from b order by open_time desc limit $2
  )
  select b.open_time,
    (array_agg(b.price_e18 order by b.block_number, b.log_index))[1]::text as open_e18,
    max(b.price_e18)::text as high_e18,
    min(b.price_e18)::text as low_e18,
    (array_agg(b.price_e18 order by b.block_number desc, b.log_index desc))[1]::text as close_e18,
    sum(b.usd1_amount)::text as volume_usd1
  from b
  join recent r on r.open_time = b.open_time
  group by b.open_time
  order by b.open_time asc
`;

/**
 * Decision 0147: a LoopDynamic Hook's own 5-minute candles
 * (`CandleClosed`: open / close sqrt prices, the prices the round rules
 * compare), priced with the pool orientation the lane stored on the
 * instance's indexed `Swap` (`memeIsCurrency0`). High / low widen to the
 * bucket's swap prices; volume = the bucket's swap USD1 (0 for a candle a
 * poke closed). No orientation (no indexed swap) = no rows.
 */
const publicDynamicCandlesSql = `
  with orient as (
    select (payload ->> 'memeIsCurrency0') = 'true' as meme0
    from public.launch2_events
    where instance_id = $1 and event_name = 'Swap' and not removed
      and payload ->> 'memeIsCurrency0' in ('true', 'false')
    order by block_number desc, log_index desc
    limit 1
  ),
  c as (
    select distinct on (candle_id) candle_id,
      open_sqrt_price_x96 as o, close_sqrt_price_x96 as cl
    from public.launch2_dynamic_candles
    where instance_id = $1 and not removed
    order by candle_id desc, block_number desc, log_index desc
  ),
  recent as (
    select * from c where o > 0 and cl > 0 order by candle_id desc limit $2
  ),
  priced as (
    select r.candle_id,
      case when x.meme0 then div(r.o * r.o * 1000000000000000000, ${q192Sql})
        else div(${q192Sql} * 1000000000000000000, r.o * r.o) end as open_p,
      case when x.meme0 then div(r.cl * r.cl * 1000000000000000000, ${q192Sql})
        else div(${q192Sql} * 1000000000000000000, r.cl * r.cl) end as close_p
    from recent r cross join orient x
  )
  select to_timestamp(p.candle_id * 300) as open_time,
    p.open_p::text as open_e18,
    greatest(p.open_p, p.close_p, sw.high)::text as high_e18,
    least(p.open_p, p.close_p, sw.low)::text as low_e18,
    p.close_p::text as close_e18,
    sw.volume::text as volume_usd1
  from priced p
  cross join lateral (
    select max(s.price_e18) as high, min(s.price_e18) as low,
      coalesce(sum(s.usd1_amount), 0) as volume
    from public.launch2_pool_swaps s
    where s.instance_id = $1 and not s.removed
      and s.swapped_at >= to_timestamp(p.candle_id * 300)
      and s.swapped_at < to_timestamp((p.candle_id + 1) * 300)
  ) sw
  order by p.candle_id asc
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

  // Decision 0171: the App candles route (src/database/launch2-candles-repository.ts).
  const candles = createLaunch2CandleStore(query);

  return Object.freeze<Launch2Repository>({
    readCandleBounds: (input) => candles.readCandleBounds(input),
    readCandleWindow: (input) => candles.readCandleWindow(input),

    async registerActivatedInstances(input) {
      const rows = await query<{ instance_id: string }>(
        `
          insert into public.launch2_instances (
            instance_id, job_id, project_id, config_version, owner_user_id,
            chain_id, factory_address, factory_generation, launch_id,
            config_hash, project_owner,
            name, ticker, logo_url, nft_image_url, nft_image_cid,
            meme_address, hook_address,
            nft_address,
            curve_address, gate_address, escrow_address, snapshots_address,
            graduation_adapter_address, buyback_adapter_address,
            price_recorder_address, buyback_executor_address,
            buyback_recipient, nft_sale_start, deploy_block_number,
            activation_block_number, price_e18
          )
          select gen_random_uuid(), t.job_id, t.project_id, t.config_version,
            t.owner_user_id, $1, t.factory_address, f.generation, t.launch_id,
            v.config_hash,
            t.project_owner, v.config ->> 'name', v.config ->> 'ticker',
            nullif(v.config ->> 'logoAssetUrl', ''),
            -- Decision 0173: the optional project NFT picture and its CID
            -- (guarded so a malformed value never fails the whole batch).
            case when char_length(v.config ->> 'nftImageAssetUrl')
                between 1 and 2048
              then v.config ->> 'nftImageAssetUrl' end,
            case when v.config ->> 'nftImageCid'
                ~ '^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$'
              then v.config ->> 'nftImageCid' end,
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
          join unnest($2::text[], $4::text[]) as f(address, generation)
            on f.address = t.factory_address
          where t.status = 'activated'
            and t.chain_id = $5::integer
            and not exists (
              select 1 from public.launch2_instances i where i.job_id = t.job_id)
          on conflict do nothing
          returning instance_id::text
        `,
        [
          input.chainId,
          input.factories.map((factory) => factory.address.toLowerCase()),
          launch2PriceAt(0n).toString(10),
          input.factories.map((factory) => factory.generation),
          // Decision 0150: the task table's integer chain id of the slot.
          input.chainId === "eip155:56" ? 56 : 97,
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

    async listMemeCoverageChecks(input) {
      const rows = await query<Row>(
        `
          select i.instance_id::text as instance_id,
            i.meme_transfers_coverage_failures as failures,
            exists (
              select 1 from public.launch2_meme_transfers t
              where t.instance_id = i.instance_id and not t.removed
                and t.from_address = $4
                and t.block_number = i.deploy_block_number
            ) as deploy_mint_present,
            (
              select count(*) from (
                select flow.address
                from (
                  select t.to_address as address, t.amount as delta
                  from public.launch2_meme_transfers t
                  where t.instance_id = i.instance_id and not t.removed
                  union all
                  select t.from_address, -t.amount
                  from public.launch2_meme_transfers t
                  where t.instance_id = i.instance_id and not t.removed
                ) flow
                where flow.address <> $4
                group by flow.address
                having sum(flow.delta) < 0
              ) negative
            )::int as negative_count
          from public.launch2_instances i
          where i.chain_id = $1 and i.meme_transfers_complete_at is null
            and i.meme_transfers_target_block is not null
            and i.meme_transfers_target_block <= $2::numeric
            and i.meme_transfers_coverage_failures < $3
          order by i.instance_id
        `,
        [
          input.chainId,
          input.throughBlockNumber,
          input.maxAttempts,
          zeroAddress,
        ],
      );
      return rows.map((row) =>
        Object.freeze({
          instanceId: text(row, "instance_id"),
          deployMintPresent: row["deploy_mint_present"] === true,
          negativeBalanceCount: Number(row["negative_count"]),
          failedAttempts: Number(row["failures"]),
        }),
      );
    },

    async memeLedgerBalances(input) {
      const addresses = input.addresses.map((address) => address.toLowerCase());
      const rows = await query<Row>(
        `
          select flow.address, sum(flow.delta)::text as balance
          from (
            select t.to_address as address, t.amount as delta
            from public.launch2_meme_transfers t
            where t.chain_id = $1 and t.instance_id = $2::uuid
              and not t.removed and t.block_number < $3::numeric
              and t.to_address = any($4::text[])
            union all
            select t.from_address, -t.amount
            from public.launch2_meme_transfers t
            where t.chain_id = $1 and t.instance_id = $2::uuid
              and not t.removed and t.block_number < $3::numeric
              and t.from_address = any($4::text[])
          ) flow
          group by flow.address
        `,
        [input.chainId, input.instanceId, input.beforeBlockNumber, addresses],
      );
      const supply = await query<Row>(
        `
          select (
            coalesce(sum(case when t.from_address = $4 then t.amount end), 0)
            - coalesce(sum(case when t.to_address = $4 then t.amount end), 0)
          )::text as supply
          from public.launch2_meme_transfers t
          where t.chain_id = $1 and t.instance_id = $2::uuid
            and not t.removed and t.block_number < $3::numeric
        `,
        [input.chainId, input.instanceId, input.beforeBlockNumber, zeroAddress],
      );
      const balances: Record<string, string> = {};
      for (const address of addresses) balances[address] = "0";
      for (const row of rows) {
        balances[text(row, "address")] = text(row, "balance");
      }
      return Object.freeze({
        balances: Object.freeze(balances),
        supply: supply[0] === undefined ? "0" : text(supply[0], "supply"),
      });
    },

    async recordMemeCoverage(input) {
      for (const verdict of input.verdicts) {
        // Decision 0132: unreadable state at the segment end — nothing.
        if (verdict.kind === "pending") continue;
        if (verdict.kind === "complete") {
          await query(
            `update public.launch2_instances
             set meme_transfers_complete_at = clock_timestamp(),
               meme_transfers_coverage_failures = 0
             where chain_id = $1 and instance_id = $2::uuid
               and meme_transfers_complete_at is null
               and meme_transfers_target_block is not null`,
            [input.chainId, verdict.instanceId],
          );
        } else {
          // retry: clear the target so the lane re-scans from the deploy
          // block; stalled: keep it (no re-scan) until an operator resets.
          await query(
            `update public.launch2_instances
             set meme_transfers_coverage_failures = $3::integer,
               meme_transfers_target_block = case when $4::boolean
                 then null else meme_transfers_target_block end
             where chain_id = $1 and instance_id = $2::uuid
               and meme_transfers_complete_at is null`,
            [
              input.chainId,
              verdict.instanceId,
              verdict.failedAttempts,
              verdict.kind === "retry",
            ],
          );
        }
      }
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
              "launch2_meme_transfers",
              "launch2_pool_swaps",
              // Decision 0131: LoopDynamic facts (projections rebuilt).
              "launch2_dynamic_hook_bindings",
              "launch2_dynamic_fees",
              "launch2_dynamic_candles",
              "launch2_dynamic_claims",
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
          // Decision 0125: MEME ERC-20 transfers (raw facts, no projection).
          for (const transfer of input.memeTransfers ?? []) {
            await client.query({
              text: `
                insert into public.launch2_meme_transfers (
                  chain_id, transaction_hash, log_index, block_number,
                  block_hash, instance_id, from_address, to_address, amount,
                  transferred_at
                )
                values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9::numeric,
                  $10::timestamptz)
                on conflict (chain_id, transaction_hash, log_index) do update set
                  block_number = excluded.block_number,
                  block_hash = excluded.block_hash,
                  instance_id = excluded.instance_id,
                  from_address = excluded.from_address,
                  to_address = excluded.to_address,
                  amount = excluded.amount,
                  transferred_at = excluded.transferred_at,
                  removed = false,
                  observed_at = clock_timestamp()
              `,
              values: [
                input.chainId,
                transfer.transactionHash,
                transfer.logIndex,
                transfer.blockNumber,
                transfer.blockHash,
                transfer.instanceId,
                transfer.from,
                transfer.to,
                transfer.amount,
                secondsToTimestamp(transfer.at),
              ],
            });
          }
          if (input.memeTransferCoverage !== undefined) {
            await client.query({
              text: `
                update public.launch2_instances
                set meme_transfers_target_block = $3::numeric
                where chain_id = $1 and instance_id = any($2::uuid[])
                  and meme_transfers_target_block is null
              `,
              values: [
                input.chainId,
                input.memeTransferCoverage.instanceIds,
                input.memeTransferCoverage.targetBlockNumber,
              ],
            });
          }
          // Decision 0132: per-instance degradation of a segment the lane
          // could not vouch for (after the target above, same transaction).
          for (const degraded of input.memeCoverageDegraded ?? []) {
            await client.query({
              text: `
                update public.launch2_instances
                set meme_transfers_complete_at = null,
                  meme_transfers_coverage_failures = case
                    when $3 = 'unverified' then meme_transfers_coverage_failures
                    else $4::integer end,
                  meme_transfers_target_block = case
                    when $3 = 'retry' then null
                    else meme_transfers_target_block end
                where chain_id = $1 and instance_id = $2::uuid
              `,
              values: [
                input.chainId,
                degraded.instanceId,
                degraded.kind,
                degraded.failedAttempts,
              ],
            });
          }
          if (input.poolRouterCoverage !== undefined) {
            await client.query({
              text: `
                update public.launch2_instances
                set pool_router_target_block = $3::numeric
                where chain_id = $1 and instance_id = any($2::uuid[])
                  and pool_router_target_block is null
              `,
              values: [
                input.chainId,
                input.poolRouterCoverage.instanceIds,
                input.poolRouterCoverage.targetBlockNumber,
              ],
            });
          }
          await client.query({
            text: `
              update public.launch2_instances
              set pool_router_complete_at = clock_timestamp()
              where chain_id = $1 and pool_router_complete_at is null
                and pool_router_target_block is not null
                and pool_router_target_block <= $2::numeric
            `,
            values: [input.chainId, input.checkpoint.lastBlockNumber],
          });
          // Decision 0129 §2: the MEME transfer coverage is no longer
          // marked complete by the checkpoint position alone; the lane
          // checks the indexed facts (listMemeCoverageChecks) and records
          // the verdict (recordMemeCoverage).
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
            and listing = 'visible'
            and ($2::text is null or stage = $2)
            and ($6::text is null or stage <> $6)
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
          input.notStage ?? null,
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

    async getInstances(instanceIds) {
      if (instanceIds.length === 0) return [];
      const rows = await query<Row>(
        `select ${instanceColumns} from public.launch2_instances where instance_id = any($1::uuid[])`,
        [[...new Set(instanceIds)]],
      );
      return rows.map(mapInstance);
    },

    async getInstanceByLaunchId(launchId) {
      const rows = await query<Row>(
        `select ${instanceColumns} from public.launch2_instances where launch_id = $1`,
        [launchId.toLowerCase()],
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
          minMemeOut: nullableText(row, "min_meme_out"),
          referencePriceE18: nullableText(row, "reference_price_e18"),
          spotPriceE18: nullableText(row, "spot_price_e18"),
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

    async listActivity(input) {
      const rows = await query<Row>(activitySql, [input.chainId, input.limit]);
      return rows.map(mapActivity);
    },

    async listOverviewFacts(input) {
      const rows = await query<Row>(overviewFactsSql, [input.chainId]);
      return rows.map(mapOverviewFacts);
    },

    async listPoolTrades(input) {
      const rows = await query<Row>(
        `
          select pool_trade_id::text, side, router_amount_in::text,
            router_amount_out::text, usd1_amount::text, meme_amount::text,
            tax_amount::text, tax_token, price_e18::text, recipient_address,
            swapped_at, transaction_hash, log_index, block_number::text
          from public.launch2_pool_swaps
          where instance_id = $1 and wallet_address = $2 and not removed
          order by block_number desc, log_index desc
          limit $3
        `,
        [input.instanceId, input.walletAddress.toLowerCase(), input.limit],
      );
      return rows.map((row): Launch2PoolTradeRecord =>
        Object.freeze({
          poolTradeId: text(row, "pool_trade_id"),
          side: text(row, "side") === "sell" ? "sell" : "buy",
          amountIn: text(row, "router_amount_in"),
          amountOut: text(row, "router_amount_out"),
          usd1Amount: text(row, "usd1_amount"),
          memeAmount: text(row, "meme_amount"),
          taxAmount: text(row, "tax_amount"),
          taxToken: text(row, "tax_token") === "usd1" ? "usd1" : "meme",
          priceE18: text(row, "price_e18"),
          recipientAddress: text(row, "recipient_address"),
          tradedAt: iso(row, "swapped_at"),
          transactionHash: text(row, "transaction_hash"),
          logIndex: Number(row["log_index"]),
          blockNumber: text(row, "block_number"),
        }),
      );
    },

    async listRecentPoolTrades(input) {
      // Decision 0174: user swaps only (the activity feed's rule), every
      // wallet; the (instance, block desc, log desc) index serves it.
      const rows = await query<Row>(
        `
          select s.side, s.meme_amount::text,
            (case when s.side = 'buy' then s.usd1_amount
              when s.tax_token = 'usd1'
                then greatest(s.usd1_amount - s.tax_amount, 0)
              else s.usd1_amount end)::text as usd1_amount,
            s.price_e18::text, s.wallet_address, s.swapped_at,
            s.transaction_hash, s.log_index, s.block_number::text
          from public.launch2_pool_swaps s
          join public.launch2_instances i on i.instance_id = s.instance_id
          where s.instance_id = $1 and not s.removed and ${userSwap("s")}
          order by s.block_number desc, s.log_index desc
          limit $2
        `,
        [input.instanceId, input.limit],
      );
      return rows.map((row): Launch2PublicPoolTradeRecord =>
        Object.freeze({
          side: text(row, "side") === "sell" ? "sell" : "buy",
          memeAmount: text(row, "meme_amount"),
          usd1Amount: text(row, "usd1_amount"),
          priceE18: text(row, "price_e18"),
          walletAddress: nullableText(row, "wallet_address"),
          tradedAt: iso(row, "swapped_at"),
          transactionHash: text(row, "transaction_hash"),
          logIndex: Number(row["log_index"]),
          blockNumber: text(row, "block_number"),
        }),
      );
    },

    async poolTradeStats(input) {
      if (input.walletAddresses.length === 0) return [];
      const rows = await query<Row>(
        `
          select instance_id::text, wallet_address, count(*)::text as n,
            max(swapped_at) as last
          from public.launch2_pool_swaps
          where wallet_address = any($1::text[]) and not removed
            and ($2::uuid is null or instance_id = $2::uuid)
          group by instance_id, wallet_address
        `,
        [
          input.walletAddresses.map((address) => address.toLowerCase()),
          input.instanceId,
        ],
      );
      return rows.map((row): Launch2PoolTradeStats =>
        Object.freeze({
          instanceId: text(row, "instance_id"),
          walletAddress: text(row, "wallet_address"),
          count: text(row, "n"),
          lastAt: nullableIso(row, "last"),
        }),
      );
    },

    // --- Decision 0131: LoopDynamic reads ---
    async dynamicRoundSummary(instanceId) {
      const rows = await query<Row>(
        `
          select
            (select count(*)::int from public.launch2_dynamic_rounds
              where instance_id = $1) as round_count,
            (select count(*)::int from public.launch2_dynamic_rounds
              where instance_id = $1 and closed) as closed_count,
            (select coalesce(sum(allocation_usd1), 0)::text
              from public.launch2_dynamic_rounds where instance_id = $1) as allocated,
            (select coalesce(sum(claimed_usd1), 0)::text
              from public.launch2_dynamic_rounds where instance_id = $1) as claimed,
            (select coalesce(sum(extra_fee), 0)::text
              from public.launch2_dynamic_fees
              where instance_id = $1 and not removed and side = 'sell') as extra_fees,
            (select coalesce(sum(base_fee), 0)::text
              from public.launch2_dynamic_fees
              where instance_id = $1 and not removed and side = 'sell') as base_sell,
            (select coalesce(sum(base_fee), 0)::text
              from public.launch2_dynamic_fees
              where instance_id = $1 and not removed and side = 'buy'
                and fee_token = 'meme') as buy_fees,
            -- Decision 0152: S209 Hooks charge the buy fee in USD1.
            (select coalesce(sum(base_fee), 0)::text
              from public.launch2_dynamic_fees
              where instance_id = $1 and not removed and side = 'buy'
                and fee_token = 'usd1') as buy_fees_usd1,
            (select jsonb_build_object('roundId', round_id::text,
                'closed', closed, 'activatedAt', activated_at,
                'closedAt', closed_at)
              from public.launch2_dynamic_rounds where instance_id = $1
              order by round_id desc limit 1) as last_round
        `,
        [instanceId],
      );
      const row = rows[0];
      if (row === undefined) throw new Launch2RepositoryUnavailableError();
      const last = row["last_round"] as Record<string, unknown> | null;
      return Object.freeze({
        roundCount: Number(row["round_count"]),
        closedRoundCount: Number(row["closed_count"]),
        allocatedUsd1: text(row, "allocated"),
        claimedUsd1: text(row, "claimed"),
        extraFeesUsd1: text(row, "extra_fees"),
        baseSellFeesUsd1: text(row, "base_sell"),
        buyFeesMeme: text(row, "buy_fees"),
        buyFeesUsd1: text(row, "buy_fees_usd1"),
        lastRound:
          last === null
            ? null
            : Object.freeze({
                roundId: String(last["roundId"]),
                closed: last["closed"] === true,
                activatedAt: new Date(
                  String(last["activatedAt"]),
                ).toISOString(),
                closedAt:
                  typeof last["closedAt"] === "string"
                    ? new Date(last["closedAt"]).toISOString()
                    : null,
              }),
      });
    },

    // --- Decision 0147: the public MEME page read surface ---
    async getPublicMemeFacts(input) {
      if (input.instanceIds.length === 0) return [];
      const rows = await query<Row>(publicMemeFactsSql, [
        [...input.instanceIds],
        input.since,
      ]);
      return rows.map(mapPublicMemeFacts);
    },

    async listPublicCandles(input) {
      const sql =
        input.source.kind === "curve"
          ? publicCurveCandlesSql
          : input.source.kind === "pool"
            ? publicPoolCandlesSql
            : publicDynamicCandlesSql;
      const values =
        input.source.kind === "curve"
          ? [
              input.instanceId,
              input.limit,
              launch2CurvePriceNumerator.toString(10),
              launch2CurveVirtualMeme.toString(10),
            ]
          : [input.instanceId, input.limit];
      const rows = await query<Row>(sql, values);
      return rows.map((row): Launch2PublicCandleRecord =>
        Object.freeze({
          openTime: iso(row, "open_time"),
          openE18: text(row, "open_e18"),
          highE18: text(row, "high_e18"),
          lowE18: text(row, "low_e18"),
          closeE18: text(row, "close_e18"),
          volumeUsd1: nullableText(row, "volume_usd1"),
        }),
      );
    },

    async listDynamicRewards(input) {
      const rows = await query<Row>(
        `
          select r.round_id::text, r.hook_address, r.closed,
            r.start_candle::text, r.end_candle::text,
            r.carried_in_usd1::text, r.extra_fees_usd1::text,
            r.total_buy_weight_usd1::text, r.allocation_usd1::text,
            w.weight_usd1::text, w.credited_usd1::text,
            w.moved_in_usd1::text, w.moved_out_usd1::text, x.entries,
            k.amount_usd1::text as claimed_amount,
            k.transaction_hash as claim_tx, k.claimed_at,
            r.activated_at, r.closed_at
          from public.launch2_dynamic_buy_weights w
          join public.launch2_dynamic_rounds r
            on r.instance_id = w.instance_id and r.round_id = w.round_id
          left join lateral (
            select amount_usd1, transaction_hash, claimed_at
            from public.launch2_dynamic_claims c
            where c.instance_id = w.instance_id and not c.removed
              and c.round_id = w.round_id and c.buyer_address = w.buyer_address
            order by c.block_number, c.log_index limit 1
          ) k on true
          left join lateral (
            select coalesce(jsonb_agg(jsonb_build_object(
                'direction', d.direction, 'attribution', d.attribution,
                'counterparty', d.counterparty_address,
                'amount', d.amount_usd1::text,
                'tx', d.transaction_hash, 'logIndex', d.log_index,
                'block', d.block_number::text, 'at', d.credited_at)
              order by d.block_number desc, d.log_index desc, d.direction), '[]'::jsonb)
              as entries
            from (
              select * from public.launch2_dynamic_credit_entries e
              where e.instance_id = w.instance_id and e.round_id = w.round_id
                and e.address = w.buyer_address
              order by e.block_number desc, e.log_index desc, e.direction
              limit 20
            ) d
          ) x on true
          where w.instance_id = $1 and w.buyer_address = $2
          order by r.round_id desc
          limit $3
        `,
        [input.instanceId, input.walletAddress.toLowerCase(), input.limit],
      );
      return rows.map((row): Launch2DynamicRewardRecord =>
        Object.freeze({
          roundId: text(row, "round_id"),
          hook: text(row, "hook_address"),
          closed: row["closed"] === true,
          startCandle: text(row, "start_candle"),
          endCandle: nullableText(row, "end_candle"),
          carriedInUsd1: text(row, "carried_in_usd1"),
          extraFeesUsd1: text(row, "extra_fees_usd1"),
          totalBuyWeightUsd1: text(row, "total_buy_weight_usd1"),
          allocationUsd1: nullableText(row, "allocation_usd1"),
          weightUsd1: text(row, "weight_usd1"),
          creditedUsd1: text(row, "credited_usd1"),
          movedInUsd1: text(row, "moved_in_usd1"),
          movedOutUsd1: text(row, "moved_out_usd1"),
          entries: creditEntries(row["entries"]),
          claimedAmountUsd1: nullableText(row, "claimed_amount"),
          claimTransactionHash: nullableText(row, "claim_tx"),
          claimedAt: nullableIso(row, "claimed_at"),
          activatedAt: iso(row, "activated_at"),
          closedAt: nullableIso(row, "closed_at"),
        }),
      );
    },

    async listDynamicRoundBuyers(input) {
      const rows = await query<Row>(
        `
          select w.buyer_address, w.weight_usd1::text, w.credited_usd1::text,
            w.moved_in_usd1::text, w.moved_out_usd1::text, w.credit_count,
            w.last_credited_at,
            (select coalesce(jsonb_agg(distinct e.attribution), '[]'::jsonb)
              from public.launch2_dynamic_credit_entries e
              where e.instance_id = w.instance_id and e.round_id = w.round_id
                and e.address = w.buyer_address and e.direction = 'in')
              as attributions,
            count(*) over () as buyer_count
          from public.launch2_dynamic_buy_weights w
          where w.instance_id = $1 and w.round_id = $2::numeric
          order by w.weight_usd1 desc, w.buyer_address
          limit $3
        `,
        [input.instanceId, input.roundId, input.limit],
      );
      const buyerCount =
        rows[0] === undefined ? 0 : Number(rows[0]["buyer_count"]);
      return Object.freeze({
        buyerCount,
        buyers: rows.map((row): Launch2DynamicRoundBuyerRecord =>
          Object.freeze({
            address: text(row, "buyer_address"),
            weightUsd1: text(row, "weight_usd1"),
            creditedUsd1: text(row, "credited_usd1"),
            movedInUsd1: text(row, "moved_in_usd1"),
            movedOutUsd1: text(row, "moved_out_usd1"),
            creditCount: Number(row["credit_count"]),
            attributions: Object.freeze(
              (Array.isArray(row["attributions"])
                ? (row["attributions"] as unknown[])
                : []
              )
                .map((value) => creditAttribution(value))
                .sort(),
            ),
            lastCreditedAt: iso(row, "last_credited_at"),
          }),
        ),
      });
    },

    async getDynamicBuyWeight(input) {
      const rows = await query<Row>(
        `select weight_usd1::text from public.launch2_dynamic_buy_weights
         where instance_id = $1 and round_id = $2::numeric and buyer_address = $3`,
        [input.instanceId, input.roundId, input.address.toLowerCase()],
      );
      return rows[0] === undefined ? "0" : text(rows[0], "weight_usd1");
    },

    async getDynamicClaimIntent(input) {
      const rows = await query<Row>(
        `select ${intentColumns} from public.launch2_intents
         where intent_id = $1 and owner_user_id = $2 and kind = 'dynamic_claim'`,
        [input.intentId, input.ownerUserId],
      );
      return rows[0] === undefined ? null : mapIntent(rows[0]);
    },

    async recordDynamicClaimReport(input) {
      const mapReport = (row: Row): Launch2DynamicClaimReportRecord =>
        Object.freeze({
          intentId: text(row, "intent_id"),
          instanceId: text(row, "instance_id"),
          walletId: text(row, "wallet_id"),
          walletAddress: text(row, "wallet_address"),
          roundId: text(row, "round_id"),
          transactionHash: text(row, "transaction_hash"),
          reportedAt: iso(row, "reported_at"),
        });
      const columns = `intent_id::text, instance_id::text, wallet_id::text,
        wallet_address, round_id::text, transaction_hash, reported_at`;
      const inserted = await query<Row>(
        `insert into public.launch2_dynamic_claim_reports (
           intent_id, owner_user_id, instance_id, wallet_id, wallet_address,
           round_id, transaction_hash
         ) values ($1, $2, $3, $4, $5, $6::numeric, $7)
         on conflict (intent_id) do nothing
         returning ${columns}`,
        [
          input.intentId,
          input.ownerUserId,
          input.instanceId,
          input.walletId,
          input.walletAddress.toLowerCase(),
          input.roundId,
          input.transactionHash.toLowerCase(),
        ],
      );
      if (inserted[0] !== undefined) {
        return { outcome: "created", report: mapReport(inserted[0]) };
      }
      const existing = await query<Row>(
        `select ${columns} from public.launch2_dynamic_claim_reports
         where intent_id = $1`,
        [input.intentId],
      );
      if (existing[0] === undefined)
        throw new Launch2RepositoryUnavailableError();
      const report = mapReport(existing[0]);
      return {
        outcome:
          report.transactionHash === input.transactionHash.toLowerCase()
            ? "same"
            : "conflict",
        report,
      };
    },

    async findDynamicClaim(input) {
      const rows = await query<Row>(
        `select amount_usd1::text, block_number::text, claimed_at
         from public.launch2_dynamic_claims
         where instance_id = $1 and transaction_hash = $2
           and round_id = $3::numeric and buyer_address = $4 and not removed
         order by log_index limit 1`,
        [
          input.instanceId,
          input.transactionHash.toLowerCase(),
          input.roundId,
          input.buyer.toLowerCase(),
        ],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : Object.freeze({
            amountUsd1: text(row, "amount_usd1"),
            blockNumber: text(row, "block_number"),
            claimedAt: iso(row, "claimed_at"),
          });
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
