import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0158 (S226): a LoopDynamic buyback reaches the PoolManager
 * through the shared LoopRouter, so the Decision 0127 caller rule (adapter /
 * executor) counted it as a user trade (S221: tradeCount = userTradeCount =
 * 13 with 2 buybacks). The projection now also excludes a swap whose
 * transaction recorded one of the instance's buybacks
 * (`launch2_buybacks`, same chain / instance / transaction, not removed).
 *
 * Backfill recomputes `pool_user_trade_count`,
 * `pool_user_buy_volume_usd1` and `pool_user_sell_volume_usd1` of every
 * graduated instance from the non-removed facts with the new rule (an
 * instance without user swaps goes to 0). No fact row and no other column
 * is changed. `down` recomputes them with the Decision 0127 rule.
 */

function recompute(excludeBuybackTransactions: boolean): string {
  const buybackTx = excludeBuybackTransactions
    ? `
        and not exists (
          select 1 from public.launch2_buybacks b
          where b.chain_id = s.chain_id
            and b.instance_id = s.instance_id
            and b.transaction_hash = s.transaction_hash
            and not b.removed)`
    : "";
  return `
    update public.launch2_instances i set
      pool_user_trade_count = coalesce(facts.trades, 0),
      pool_user_buy_volume_usd1 = coalesce(facts.buy_usd1, 0),
      pool_user_sell_volume_usd1 = coalesce(facts.sell_usd1, 0)
    from public.launch2_instances target
    left join (
      select s.instance_id,
        count(*) as trades,
        coalesce(sum(s.usd1_amount) filter (where s.side = 'buy'), 0) as buy_usd1,
        coalesce(sum(s.usd1_amount) filter (where s.side = 'sell'), 0) as sell_usd1
      from public.launch2_pool_swaps s
      inner join public.launch2_instances owner_instance
        on owner_instance.instance_id = s.instance_id
      where not s.removed
        and s.caller_address is distinct from owner_instance.buyback_adapter_address
        and s.caller_address is distinct from owner_instance.buyback_executor_address${buybackTx}
      group by s.instance_id
    ) facts on facts.instance_id = target.instance_id
    where i.instance_id = target.instance_id
      and target.graduated_at is not null;
  `;
}

export function up(pgm: MigrationBuilder): void {
  pgm.sql(recompute(true));
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(recompute(false));
}
