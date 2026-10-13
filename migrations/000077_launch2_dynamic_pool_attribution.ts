import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0132 (S170): wallet attribution of LoopDynamic pool swaps.
 *
 * LoopRouter emits no event; the user's wallet calls it directly, so the
 * swap transaction's `from` is the trader (coordinator ruling 2026-10-13).
 * The lane attributes a LoopDynamic PoolManager `Swap` to `tx.from` only
 * when the transaction's `to` is the Hook's `trustedRouter()` (the shared
 * LoopRouter), the swap's `sender` is that router, and it is the only such
 * swap of the transaction. Anything else (the buyback through its adapter,
 * other routers, contract wallets) stays anonymous — counted in the pool
 * statistics, attributed to no wallet.
 *
 * 1. `launch2_pool_swaps.attribution_source`: `router_swap` (Decision 0126:
 *    the OfficialPoolRouter `Swap` log, `router_log_index` set) or
 *    `transaction_sender` (this decision: no router log, so
 *    `router_log_index` stays null). Existing attributed rows are
 *    `router_swap` (the only source before this migration).
 * 2. The all-or-none attribution shape becomes per source.
 *
 * Additive; existing rows only gain the source of the attribution they
 * already carry.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_pool_swaps
      add column attribution_source text
        constraint launch2_pool_swaps_attribution_source_check
          check (attribution_source in ('router_swap', 'transaction_sender'));
    update public.launch2_pool_swaps
      set attribution_source = 'router_swap'
      where wallet_address is not null;
    alter table public.launch2_pool_swaps
      drop constraint launch2_pool_swaps_attribution_shape;
    alter table public.launch2_pool_swaps
      add constraint launch2_pool_swaps_attribution_shape check (
        (attribution_source is null
          and wallet_address is null and recipient_address is null
          and router_amount_in is null and router_amount_out is null
          and router_log_index is null)
        or (attribution_source = 'router_swap'
          and wallet_address is not null and recipient_address is not null
          and router_amount_in is not null and router_amount_out is not null
          and router_log_index is not null)
        or (attribution_source = 'transaction_sender'
          and wallet_address is not null and recipient_address is not null
          and router_amount_in is not null and router_amount_out is not null
          and router_log_index is null));

    comment on column public.launch2_pool_swaps.attribution_source is
      'Decision 0132: router_swap = OfficialPoolRouter Swap payer (Decision 0126); transaction_sender = tx.from of a direct LoopRouter call on a LoopDynamic pool; null = anonymous.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_pool_swaps
        where attribution_source = 'transaction_sender')
      then raise exception 'refusing to remove LoopDynamic pool wallet attribution evidence'; end if;
    end $$;
    alter table public.launch2_pool_swaps
      drop constraint launch2_pool_swaps_attribution_shape;
    alter table public.launch2_pool_swaps
      add constraint launch2_pool_swaps_attribution_shape check (
        (wallet_address is null) = (recipient_address is null)
        and (wallet_address is null) = (router_amount_in is null)
        and (wallet_address is null) = (router_amount_out is null)
        and (wallet_address is null) = (router_log_index is null));
    alter table public.launch2_pool_swaps
      drop column attribution_source;
  `);
}
