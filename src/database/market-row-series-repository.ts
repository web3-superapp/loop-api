import type { Pool } from "pg";

import { launch2Template } from "../features/launch2/launch2-contract.js";
import {
  launch2CurvePriceNumerator,
  launch2CurveVirtualMeme,
} from "../features/launch2/launch2-curve-math.js";
import type {
  MarketRowHourlyRecord,
  MarketRowSeriesStore,
} from "../features/market/market-row-sparkline24h.js";

/**
 * Decision 0186: hourly closes of many launchpad assets in one SQL read,
 * for the market list rows' `sparkline24h`.
 *
 * - launch2 (asset `chain_id:meme_address` of `launch2_instances`): the
 *   Decision 0171 candles series — curve trades priced
 *   `div(N, (Tv − sold)²)` with the running sold supply (per instance, in
 *   chain order) and official-pool swaps at `price_e18`, removed facts left
 *   out.
 * - MEME v1 (`meme_tokens.asset_id`, the oldest token row per asset as the
 *   category list picks it): `meme_trades.price_after_e18`, not removed.
 *
 * Per asset: the first fact's time, the price after the last fact before
 * the window, and the close (price after the last fact) of every UTC hour
 * of the window that holds facts. Only the window's facts are read row by
 * row; the prior close and the first fact are index lookups (`limit 1`),
 * and the launch2 curve's sold supply before the window is one aggregate
 * per instance. No table, no migration.
 */

const hourlySql = `
  with l2 as (
    select i.instance_id, i.chain_id || ':' || i.meme_address as asset_id
    from public.launch2_instances as i
    where i.chain_id || ':' || i.meme_address = any($1::text[])
  ),
  v1 as (
    select distinct on (m.asset_id) m.meme_token_id, m.asset_id
    from public.meme_tokens as m
    where m.asset_id = any($1::text[])
      and m.asset_id not in (select asset_id from l2)
    order by m.asset_id, m.created_at asc
  ),
  -- launch2 curve before the window: the sold supply and the last position
  -- (one aggregate per instance, no sort).
  curve_before as (
    select l2.asset_id, l2.instance_id,
      coalesce(sum(case when t.side = 'buy' then t.meme_amount
        else -t.meme_amount end), 0) as sold,
      max(array[t.block_number, t.log_index::bigint])
        filter (where t.instance_id is not null) as pos
    from l2
    left join public.launch2_trades as t
      on t.instance_id = l2.instance_id and not t.removed
        and t.traded_at < to_timestamp($5::bigint)
    group by l2.asset_id, l2.instance_id
  ),
  curve_window as (
    select b.asset_id, t.traded_at as at, t.block_number, t.log_index,
      b.sold + sum(case when t.side = 'buy' then t.meme_amount
        else -t.meme_amount end)
        over (partition by t.instance_id order by t.block_number, t.log_index
          rows between unbounded preceding and current row) as sold
    from curve_before as b
    join public.launch2_trades as t on t.instance_id = b.instance_id
    where not t.removed
      and t.traded_at >= to_timestamp($5::bigint)
      and t.traded_at < to_timestamp($6::bigint)
  ),
  window_facts as (
    select asset_id, at, block_number, log_index,
      div($2::numeric, ($3::numeric - sold) * ($3::numeric - sold)) as price
    from curve_window
    where sold >= 0 and sold <= $4::numeric
    union all
    select l2.asset_id, s.swapped_at, s.block_number, s.log_index, s.price_e18
    from l2
    join public.launch2_pool_swaps as s on s.instance_id = l2.instance_id
    where not s.removed and s.price_e18 > 0
      and s.swapped_at >= to_timestamp($5::bigint)
      and s.swapped_at < to_timestamp($6::bigint)
    union all
    select v1.asset_id, tr.traded_at, tr.block_number, tr.log_index,
      tr.price_after_e18
    from v1
    join public.meme_trades as tr on tr.meme_token_id = v1.meme_token_id
    where not tr.removed and tr.price_after_e18 > 0
      and tr.traded_at >= to_timestamp($5::bigint)
      and tr.traded_at < to_timestamp($6::bigint)
  ),
  -- The last fact before the window and the first fact ever, per leg
  -- (index lookups), then the latest / earliest per asset.
  before_facts as (
    select b.asset_id, b.pos[1] as block_number, b.pos[2] as log_index,
      div($2::numeric, ($3::numeric - b.sold) * ($3::numeric - b.sold))
        as price
    from curve_before as b
    where b.pos is not null and b.sold >= 0 and b.sold <= $4::numeric
    union all
    select l2.asset_id, p.block_number, p.log_index, p.price_e18
    from l2
    cross join lateral (
      select s.block_number, s.log_index, s.price_e18
      from public.launch2_pool_swaps as s
      where s.instance_id = l2.instance_id and not s.removed
        and s.price_e18 > 0 and s.swapped_at < to_timestamp($5::bigint)
      order by s.block_number desc, s.log_index desc
      limit 1
    ) as p
    union all
    select v1.asset_id, p.block_number, p.log_index, p.price_after_e18
    from v1
    cross join lateral (
      select tr.block_number, tr.log_index, tr.price_after_e18
      from public.meme_trades as tr
      where tr.meme_token_id = v1.meme_token_id and not tr.removed
        and tr.price_after_e18 > 0 and tr.traded_at < to_timestamp($5::bigint)
      order by tr.traded_at desc, tr.block_number desc, tr.log_index desc
      limit 1
    ) as p
  ),
  prior as (
    select distinct on (asset_id) asset_id, price
    from before_facts
    order by asset_id, block_number desc, log_index desc
  ),
  first_facts as (
    select l2.asset_id, f.at
    from l2
    cross join lateral (
      select t.traded_at as at from public.launch2_trades as t
      where t.instance_id = l2.instance_id and not t.removed
      order by t.block_number asc, t.log_index asc
      limit 1
    ) as f
    union all
    select l2.asset_id, f.at
    from l2
    cross join lateral (
      select s.swapped_at as at from public.launch2_pool_swaps as s
      where s.instance_id = l2.instance_id and not s.removed
        and s.price_e18 > 0
      order by s.block_number asc, s.log_index asc
      limit 1
    ) as f
    union all
    select v1.asset_id, f.at
    from v1
    cross join lateral (
      select tr.traded_at as at from public.meme_trades as tr
      where tr.meme_token_id = v1.meme_token_id and not tr.removed
        and tr.price_after_e18 > 0
      order by tr.traded_at asc, tr.block_number asc, tr.log_index asc
      limit 1
    ) as f
  ),
  firsts as (
    select asset_id, floor(extract(epoch from min(at)))::bigint as first_at
    from first_facts
    group by asset_id
  ),
  agg as (
    select asset_id,
      (floor(extract(epoch from at) / 3600) * 3600)::bigint as t,
      (array_agg(price order by block_number desc, log_index desc))[1] as close
    from window_facts
    group by asset_id, 2
  )
  select f.asset_id, f.first_at::text as first_at,
    p.price::text as prior_close,
    coalesce((
      select jsonb_agg(jsonb_build_object('t', a.t::text, 'close', a.close::text)
        order by a.t)
      from agg as a where a.asset_id = f.asset_id
    ), '[]'::jsonb) as buckets
  from firsts as f
  left join prior as p on p.asset_id = f.asset_id
`;

export function createPostgresMarketRowSeriesStore(
  pool: Pool,
): MarketRowSeriesStore {
  return Object.freeze<MarketRowSeriesStore>({
    async readHourlyCloses(input) {
      const result = new Map<string, MarketRowHourlyRecord>();
      if (input.assetIds.length === 0) return result;
      const { rows } = await pool.query<Record<string, unknown>>({
        text: hourlySql,
        values: [
          [...input.assetIds],
          launch2CurvePriceNumerator.toString(10),
          launch2CurveVirtualMeme.toString(10),
          launch2Template.curveSaleSupply.toString(10),
          String(input.fromSeconds),
          String(input.toSeconds),
        ],
      });
      for (const row of rows) {
        const assetId = row["asset_id"];
        const firstAt = Number(row["first_at"]);
        if (typeof assetId !== "string" || !Number.isSafeInteger(firstAt)) {
          continue;
        }
        const prior = row["prior_close"];
        const buckets = Array.isArray(row["buckets"])
          ? (row["buckets"] as Record<string, unknown>[]).map((bucket) =>
              Object.freeze({
                t: Number(bucket["t"]),
                closeE18: String(bucket["close"]),
              }),
            )
          : [];
        result.set(
          assetId,
          Object.freeze({
            firstAt,
            priorCloseE18: typeof prior === "string" ? prior : null,
            buckets: Object.freeze(buckets),
          }),
        );
      }
      return result;
    },
  });
}
