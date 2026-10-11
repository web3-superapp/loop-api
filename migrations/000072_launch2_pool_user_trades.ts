import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0127 (S151): market trades of the official pool apart from
 * buybacks.
 *
 * `launch2_instances.pool_*` count every PoolManager swap of the official
 * pool, including the swaps the instance's own buyback adapter sends for
 * the keeper. Three projection columns count only the other callers
 * (`caller_address` neither `buyback_adapter_address` nor
 * `buyback_executor_address`): `pool_user_trade_count`,
 * `pool_user_buy_volume_usd1`, `pool_user_sell_volume_usd1`. The existing
 * columns keep their meaning.
 *
 * Backfill recomputes the three columns from the non-removed facts of
 * graduated instances (the same rule as the projection); no fact row and
 * no other column is changed.
 */

const amount = (column: string): string =>
  `add column ${column} numeric(78, 0) not null default 0 check (${column} >= 0)`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      add column pool_user_trade_count bigint not null default 0
        check (pool_user_trade_count >= 0),
      ${amount("pool_user_buy_volume_usd1")},
      ${amount("pool_user_sell_volume_usd1")};

    update public.launch2_instances i set
      pool_user_trade_count = facts.trades,
      pool_user_buy_volume_usd1 = facts.buy_usd1,
      pool_user_sell_volume_usd1 = facts.sell_usd1
    from (
      select s.instance_id,
        count(*) as trades,
        coalesce(sum(s.usd1_amount) filter (where s.side = 'buy'), 0) as buy_usd1,
        coalesce(sum(s.usd1_amount) filter (where s.side = 'sell'), 0) as sell_usd1
      from public.launch2_pool_swaps s
      inner join public.launch2_instances owner_instance
        on owner_instance.instance_id = s.instance_id
      where not s.removed
        and s.caller_address is distinct from owner_instance.buyback_adapter_address
        and s.caller_address is distinct from owner_instance.buyback_executor_address
      group by s.instance_id
    ) facts
    where i.instance_id = facts.instance_id
      and i.graduated_at is not null
      and i.pool_trade_count > 0;

    alter table public.launch2_instances
      add constraint launch2_instances_pool_user_shape check (
        pool_user_trade_count <= pool_trade_count
        and pool_user_buy_volume_usd1 <= pool_buy_volume_usd1
        and pool_user_sell_volume_usd1 <= pool_sell_volume_usd1);

    comment on column public.launch2_instances.pool_user_trade_count is
      'Decision 0127: official-pool swaps whose PoolManager caller is not the instance''s buyback adapter / executor.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      drop constraint launch2_instances_pool_user_shape,
      drop column pool_user_sell_volume_usd1,
      drop column pool_user_buy_volume_usd1,
      drop column pool_user_trade_count;
  `);
}
