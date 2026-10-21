import { launch2Template } from "../features/launch2/launch2-contract.js";
import type {
  Launch2CandleBoundsRecord,
  Launch2CandleBucketRecord,
  Launch2CandleStore,
  Launch2CandleWindowRecord,
} from "../features/launch2/launch2-candles.js";
import {
  launch2CurvePriceNumerator,
  launch2CurveVirtualMeme,
} from "../features/launch2/launch2-curve-math.js";

/**
 * Decision 0171: the candles route's SQL over the `launch2_event` lane's
 * facts. One price series per instance, in chain order (block, log index):
 *
 * - curve trades (`launch2_trades`, not removed): the marginal price after
 *   the trade, `div(N, (Tv − s)²)` = `launch2PriceAt(s)`, with `s` the
 *   running sold supply Σ buy − sell MEME (a `CurveBought` row carries no
 *   `sold_after`; on a `CurveSold` row the running sum equals it). A
 *   running supply outside `[0, curveSaleSupply]` (never on a consistent
 *   lane) is left out, as `launch2PriceAt` would throw. Volume legs:
 *   `meme_amount`, `usd1_net` (buy: USD1 into the reserve after the 10 %
 *   tax; sell: USD1 paid to the seller after the tax).
 * - official-pool swaps (`launch2_pool_swaps`, not removed, `price_e18 > 0`;
 *   OfficialTax and LoopDynamic pools alike, buyback swaps included as on
 *   the detail's `pool_last_price_e18`): `price_e18` after the swap. Volume
 *   legs: `meme_amount`, `usd1_amount` (the swap's USD1 leg, the hook's
 *   output tax not deducted).
 *
 * Buckets are `floor(epoch / step) × step` (UTC-aligned); the instance's
 * trade indexes (`instance_id, block_number desc, log_index desc` where not
 * removed) serve the per-instance scans. No table, no migration.
 */

type Query = <T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[],
) => Promise<T[]>;

const factsSql = `
  with curve as (
    select traded_at as at, block_number, log_index, meme_amount,
      usd1_net as usd1,
      sum(case when side = 'buy' then meme_amount else -meme_amount end)
        over (order by block_number, log_index
          rows between unbounded preceding and current row) as sold
    from public.launch2_trades
    where instance_id = $1 and not removed
  ),
  facts as (
    select at, block_number, log_index, meme_amount, usd1, false as pool,
      div($2::numeric, ($3::numeric - sold) * ($3::numeric - sold)) as price
    from curve
    where sold >= 0 and sold <= $4::numeric
    union all
    select swapped_at, block_number, log_index, meme_amount, usd1_amount,
      true, price_e18
    from public.launch2_pool_swaps
    where instance_id = $1 and not removed and price_e18 > 0
  )`;

const boundsSql = `
  ${factsSql},
  newest as (
    select price, at from facts
    order by block_number desc, log_index desc
    limit 1
  )
  select
    (select floor(extract(epoch from min(at)))::bigint::text from facts)
      as first_at,
    (select price::text from newest) as latest_price,
    (select floor(extract(epoch from at))::bigint::text from newest)
      as latest_at
`;

const windowSql = `
  ${factsSql},
  prior as (
    select price, pool from facts
    where at < to_timestamp($5::bigint)
    order by block_number desc, log_index desc
    limit 1
  ),
  w as (
    select (floor(extract(epoch from at) / $6::bigint) * $6::bigint)::bigint
        as t,
      block_number, log_index, price, meme_amount, usd1, pool
    from facts
    where at >= to_timestamp($5::bigint) and at < to_timestamp($7::bigint)
  ),
  agg as (
    select t,
      max(price) as high,
      min(price) as low,
      (array_agg(price order by block_number desc, log_index desc))[1]
        as close,
      sum(meme_amount) as volume_meme,
      sum(usd1) as volume_usd1,
      count(*) as n,
      bool_or(not pool) as has_curve,
      bool_or(pool) as has_pool
    from w
    group by t
  )
  select
    (select price::text from prior) as prior_close,
    (select pool from prior) as prior_pool,
    coalesce((
      select jsonb_agg(jsonb_build_object(
          't', t::text, 'high', high::text, 'low', low::text,
          'close', close::text, 'volumeMeme', volume_meme::text,
          'volumeUsd1', volume_usd1::text, 'n', n,
          'hasCurve', has_curve, 'hasPool', has_pool)
        order by t)
      from agg
    ), '[]'::jsonb) as buckets
`;

function curveValues(instanceId: string): readonly unknown[] {
  return [
    instanceId,
    launch2CurvePriceNumerator.toString(10),
    launch2CurveVirtualMeme.toString(10),
    launch2Template.curveSaleSupply.toString(10),
  ];
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function bucketOf(value: Record<string, unknown>): Launch2CandleBucketRecord {
  return Object.freeze({
    t: Number(value["t"]),
    highE18: String(value["high"]),
    lowE18: String(value["low"]),
    closeE18: String(value["close"]),
    volumeMeme: String(value["volumeMeme"]),
    volumeUsd1: String(value["volumeUsd1"]),
    count: Number(value["n"]),
    hasCurve: value["hasCurve"] === true,
    hasPool: value["hasPool"] === true,
  });
}

export function createLaunch2CandleStore(query: Query): Launch2CandleStore {
  return Object.freeze<Launch2CandleStore>({
    async readCandleBounds(input): Promise<Launch2CandleBoundsRecord> {
      const rows = await query<Record<string, unknown>>(
        boundsSql,
        curveValues(input.instanceId),
      );
      const row = rows[0] ?? {};
      const firstAt = nullableNumber(row["first_at"]);
      const latestPrice = row["latest_price"];
      const latestAt = nullableNumber(row["latest_at"]);
      return Object.freeze({
        firstAt,
        latest:
          typeof latestPrice === "string" && latestAt !== null
            ? Object.freeze({ priceE18: latestPrice, at: latestAt })
            : null,
      });
    },

    async readCandleWindow(input): Promise<Launch2CandleWindowRecord> {
      const rows = await query<Record<string, unknown>>(windowSql, [
        ...curveValues(input.instanceId),
        String(input.fromSeconds),
        String(input.stepSeconds),
        String(input.toSeconds),
      ]);
      const row = rows[0] ?? {};
      const prior = row["prior_close"];
      const buckets = Array.isArray(row["buckets"])
        ? (row["buckets"] as Record<string, unknown>[]).map(bucketOf)
        : [];
      return Object.freeze({
        priorCloseE18: typeof prior === "string" ? prior : null,
        priorPool:
          typeof row["prior_pool"] === "boolean" ? row["prior_pool"] : null,
        buckets,
      });
    },
  });
}
