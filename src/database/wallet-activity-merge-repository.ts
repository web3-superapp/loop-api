import type { Pool } from "pg";

import {
  walletLaunch2ActivityKinds,
  type WalletActivityMergeRepository,
  type WalletActivitySortKey,
  type WalletLaunch2ActivityKind,
  type WalletLaunch2ActivityRecord,
  type WalletTimedTransferRecord,
} from "../features/wallet/wallet-activity-launch2.js";

/**
 * Decision 0167 (S251): the two reads of the merged wallet activity list.
 * Both order by the same key as `compareSortKeys` (descending) and take the
 * rows strictly after the cursor with a row comparison on that key.
 */

type Row = Record<string, unknown>;

export class WalletActivityMergeUnavailableError extends Error {
  readonly code = "wallet_activity_merge_unavailable";

  constructor() {
    super("The wallet activity merge repository is unavailable");
    this.name = "WalletActivityMergeUnavailableError";
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new WalletActivityMergeUnavailableError();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new WalletActivityMergeUnavailableError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new WalletActivityMergeUnavailableError();
  }
  return parsed;
}

function iso(row: Row, key: string): string {
  const value = row[key];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WalletActivityMergeUnavailableError();
  }
  return value.toISOString();
}

function kindOf(value: unknown): WalletLaunch2ActivityKind {
  if (
    typeof value !== "string" ||
    !(walletLaunch2ActivityKinds as readonly string[]).includes(value)
  ) {
    throw new WalletActivityMergeUnavailableError();
  }
  return value as WalletLaunch2ActivityKind;
}

/** `at` in microseconds since the epoch (exact: `extract` is numeric). */
export const micros = (column: string): string =>
  `(extract(epoch from ${column}) * 1000000)::bigint::text`;

/** The cursor timestamp rebuilt from microseconds without float rounding. */
export const cursorAt = (param: string): string =>
  `(timestamptz 'epoch' + ${param}::bigint * interval '1 microsecond')`;

/**
 * `(at, block, log, source, hash) < cursor`, the strict "older than" of the
 * descending key. `$cursor` params are null on the first page.
 */
export function afterCursor(input: {
  readonly at: string;
  readonly block: string;
  readonly log: string;
  readonly source: "erc20" | "launch2";
  readonly hash: string;
  readonly first: number;
}): string {
  const p = (offset: number): string => `$${input.first + offset}`;
  return `(${p(0)}::text is null or (
      ${input.at}, ${input.block}::numeric, ${input.log},
      '${input.source}'::text collate "C", ${input.hash} collate "C")
    < (${cursorAt(p(0))}, ${p(1)}::numeric, ${p(2)}::int,
      ${p(3)}::text collate "C", ${p(4)}::text collate "C"))`;
}

export function cursorValues(
  before: WalletActivitySortKey | undefined,
): readonly (string | number | null)[] {
  return before === undefined
    ? [null, null, null, null, null]
    : [
        before.atMicros,
        before.blockNumber,
        before.logIndex,
        before.source,
        before.transactionHash,
      ];
}

/**
 * One branch per fact table, each limited to the newest `$7` after the
 * cursor; the outer query keeps the newest `$7` overall. `$1` chain, `$2`
 * address, `$3..$6`… see `afterCursor` (first = 3), `$8` the limit + 1.
 */
function launch2Sql(): string {
  const cursor = (at: string, alias: string): string =>
    afterCursor({
      at,
      block: `${alias}.block_number`,
      log: `${alias}.log_index`,
      source: "launch2",
      hash: `${alias}.transaction_hash`,
      first: 3,
    });
  const order = (at: string, alias: string): string =>
    `order by ${at} desc, ${alias}.block_number desc, ${alias}.log_index desc,
      ${alias}.transaction_hash collate "C" desc
    limit $8`;
  return `
  with feed as (
    (select case t.side when 'buy' then 'launch2_curve_buy'
          else 'launch2_curve_sell' end as kind,
        t.instance_id, t.meme_amount as amount_meme,
        case t.side when 'buy' then t.usd1_gross else t.usd1_net end
          as amount_usd1,
        t.tax_usd1, t.traded_at as at, t.transaction_hash,
        t.block_number, t.log_index
      from public.launch2_trades t
      join public.launch2_instances i on i.instance_id = t.instance_id
      where i.chain_id = $1 and t.chain_id = $1 and not t.removed
        and t.trader_address = $2
        and ${cursor("t.traded_at", "t")}
      ${order("t.traded_at", "t")})
    union all
    (select case s.side when 'buy' then 'launch2_pool_buy'
          else 'launch2_pool_sell' end,
        s.instance_id,
        case when s.side = 'buy' then coalesce(s.router_amount_out,
            case when s.tax_token = 'meme'
              then greatest(s.meme_amount - s.tax_amount, 0)
              else s.meme_amount end)
          else coalesce(s.router_amount_in, s.meme_amount) end,
        case when s.side = 'buy' then coalesce(s.router_amount_in, s.usd1_amount)
          else coalesce(s.router_amount_out,
            case when s.tax_token = 'usd1'
              then greatest(s.usd1_amount - s.tax_amount, 0)
              else s.usd1_amount end) end,
        case when s.tax_token = 'usd1' then s.tax_amount else null end,
        s.swapped_at, s.transaction_hash, s.block_number, s.log_index
      from public.launch2_pool_swaps s
      join public.launch2_instances i on i.instance_id = s.instance_id
      where i.chain_id = $1 and s.chain_id = $1 and not s.removed
        and s.caller_address is distinct from i.buyback_adapter_address
        and s.caller_address is distinct from i.buyback_executor_address
        and not exists (
          select 1 from public.launch2_buybacks b
          where b.chain_id = s.chain_id
            and b.instance_id = s.instance_id
            and b.transaction_hash = s.transaction_hash
            and not b.removed)
        and (s.wallet_address = $2 or s.recipient_address = $2
          or (s.side = 'buy' and exists (
            select 1 from public.launch2_dynamic_credit_entries c
            where c.instance_id = s.instance_id
              and c.chain_id = s.chain_id
              and c.transaction_hash = s.transaction_hash
              and c.direction = 'in'
              and c.attribution <> 'moved'
              and c.address = $2)))
        and ${cursor("s.swapped_at", "s")}
      ${order("s.swapped_at", "s")})
    union all
    (select 'launch2_nft_mint', m.instance_id, null, m.amount_usd1, null,
        m.minted_at, m.transaction_hash, m.block_number, m.log_index
      from public.launch2_nft_mints m
      join public.launch2_instances i on i.instance_id = m.instance_id
      where i.chain_id = $1 and m.chain_id = $1 and not m.removed
        and m.payer_address = $2
        and ${cursor("m.minted_at", "m")}
      ${order("m.minted_at", "m")})
    union all
    (select 'launch2_reward_claim', c.instance_id, null, c.amount_usd1, null,
        c.claimed_at, c.transaction_hash, c.block_number, c.log_index
      from public.launch2_dynamic_claims c
      join public.launch2_instances i on i.instance_id = c.instance_id
      where i.chain_id = $1 and c.chain_id = $1 and not c.removed
        and c.buyer_address = $2
        and ${cursor("c.claimed_at", "c")}
      ${order("c.claimed_at", "c")})
    union all
    (select 'launch2_buyback', b.instance_id, b.meme_delivered, b.usd1_spent,
        null, b.executed_at, b.transaction_hash, b.block_number, b.log_index
      from public.launch2_buybacks b
      join public.launch2_instances i on i.instance_id = b.instance_id
      where i.chain_id = $1 and b.chain_id = $1 and not b.removed
        and b.outcome = 'executed'
        and i.buyback_recipient = $2
        and ${cursor("b.executed_at", "b")}
      ${order("b.executed_at", "b")})
  )
  select f.kind, i.chain_id, f.instance_id::text as instance_id, i.ticker,
    i.name, i.logo_url, f.amount_meme::text as amount_meme,
    f.amount_usd1::text as amount_usd1, f.tax_usd1::text as tax_usd1,
    f.at, ${micros("f.at")} as at_micros, f.transaction_hash,
    f.block_number::text as block_number, f.log_index
  from feed f
  join public.launch2_instances i on i.instance_id = f.instance_id
  order by f.at desc, f.block_number desc, f.log_index desc,
    f.transaction_hash collate "C" desc
  limit $8
  `;
}

const launch2ActivitySql = launch2Sql();

const transfersByTimeSql = `
  select transaction_hash, log_index, block_number::text as block_number,
    block_hash, asset_id, from_address, to_address,
    raw_value::text as raw_value, removed, observed_at,
    ${micros("observed_at")} as at_micros
  from public.indexed_transfers
  where chain_id = $1
    and asset_id = any($2::text[])
    and (from_address = $9 or to_address = $9)
    and ${afterCursor({
      at: "observed_at",
      block: "block_number",
      log: "log_index",
      source: "erc20",
      hash: "transaction_hash",
      first: 3,
    })}
  order by observed_at desc, block_number desc, log_index desc,
    transaction_hash collate "C" desc
  limit $8
`;

function mapTransfer(row: Row): WalletTimedTransferRecord {
  const removed = row["removed"];
  if (typeof removed !== "boolean") {
    throw new WalletActivityMergeUnavailableError();
  }
  return Object.freeze({
    transactionHash: text(row, "transaction_hash"),
    logIndex: integer(row, "log_index"),
    blockNumber: text(row, "block_number"),
    blockHash: text(row, "block_hash"),
    assetId: text(row, "asset_id"),
    fromAddress: text(row, "from_address"),
    toAddress: text(row, "to_address"),
    rawValue: text(row, "raw_value"),
    removed,
    observedAt: iso(row, "observed_at"),
    atMicros: text(row, "at_micros"),
  });
}

function mapLaunch2(row: Row): WalletLaunch2ActivityRecord {
  return Object.freeze({
    kind: kindOf(row["kind"]),
    chainId: text(row, "chain_id"),
    instanceId: text(row, "instance_id"),
    ticker: text(row, "ticker"),
    name: text(row, "name"),
    logoUrl: nullableText(row, "logo_url"),
    amountMeme: nullableText(row, "amount_meme"),
    amountUsd1: nullableText(row, "amount_usd1"),
    taxUsd1: nullableText(row, "tax_usd1"),
    transactionHash: text(row, "transaction_hash"),
    logIndex: integer(row, "log_index"),
    blockNumber: text(row, "block_number"),
    occurredAt: iso(row, "at"),
    atMicros: text(row, "at_micros"),
  });
}

export function createPostgresWalletActivityMergeRepository(
  pool: Pool,
): WalletActivityMergeRepository {
  return Object.freeze<WalletActivityMergeRepository>({
    async getLaunch2Checkpoint(chainId) {
      const result = await pool.query<Row>({
        text: `
          select last_block_number::text as last_block_number
          from public.indexer_checkpoints
          where lane = 'launch2_event' and chain_id = $1
          limit 1
        `,
        values: [chainId],
      });
      const row = result.rows[0];
      return row === undefined ? null : text(row, "last_block_number");
    },

    async listTransfersByTime(input) {
      if (input.assetIds.length === 0) {
        return Object.freeze({ items: Object.freeze([]), hasMore: false });
      }
      const result = await pool.query<Row>({
        text: transfersByTimeSql,
        values: [
          input.chainId,
          [...input.assetIds],
          ...cursorValues(input.before),
          input.limit + 1,
          input.address,
        ],
      });
      const rows = result.rows.map(mapTransfer);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit)),
        hasMore: rows.length > input.limit,
      });
    },

    async listLaunch2Activity(input) {
      const result = await pool.query<Row>({
        text: launch2ActivitySql,
        values: [
          input.chainId,
          input.address,
          ...cursorValues(input.before),
          input.limit + 1,
        ],
      });
      const rows = result.rows.map(mapLaunch2);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit)),
        hasMore: rows.length > input.limit,
      });
    },
  });
}
