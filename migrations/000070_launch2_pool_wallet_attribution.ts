import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0126 (S150): per-wallet official-pool trades.
 *
 * 1. `launch2_events` admits `RouterSwap`: the `OfficialPoolRouter`
 *    `Swap(poolId, payer, recipient, zeroForOne, amountIn, amountOut)` log
 *    (renamed on decode — its topic0 is not the PoolManager `Swap`'s).
 * 2. `launch2_pool_swaps` gains an opaque `pool_trade_id` (existing rows get
 *    one; a re-scan upsert keeps it) and the router attribution of the
 *    PoolManager swap: `wallet_address` (the router's payer = the trader),
 *    `recipient_address`, the router's exact `amountIn` / net `amountOut` and
 *    its log index. All five are null for a swap no router event paired
 *    (the buyback executor, other routers) — never guessed.
 * 3. `launch2_instances.pool_router_target_block` / `_complete_at`: the
 *    one-time re-scan from the graduation block that attributes swaps the
 *    lane indexed before it read router logs (the two dev swaps).
 *
 * Additive; no row is rewritten beyond the column defaults.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
        'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
        'BuybackResumed', 'Swap', 'RouterSwap'));

    alter table public.launch2_pool_swaps
      add column pool_trade_id uuid not null default gen_random_uuid(),
      add column wallet_address text
        check (wallet_address ~ '^0x[0-9a-f]{40}$'),
      add column recipient_address text
        check (recipient_address ~ '^0x[0-9a-f]{40}$'),
      add column router_amount_in numeric(78, 0)
        check (router_amount_in > 0),
      add column router_amount_out numeric(78, 0)
        check (router_amount_out > 0),
      add column router_log_index integer
        check (router_log_index > log_index),
      add constraint launch2_pool_swaps_trade_id_key unique (pool_trade_id),
      add constraint launch2_pool_swaps_attribution_shape check (
        (wallet_address is null) = (recipient_address is null)
        and (wallet_address is null) = (router_amount_in is null)
        and (wallet_address is null) = (router_amount_out is null)
        and (wallet_address is null) = (router_log_index is null));
    create index launch2_pool_swaps_wallet_idx
      on public.launch2_pool_swaps
        (instance_id, wallet_address, block_number desc, log_index desc)
      where not removed and wallet_address is not null;

    alter table public.launch2_instances
      add column pool_router_target_block numeric(78, 0)
        constraint launch2_instances_pool_router_target_block_check
          check (pool_router_target_block >= 0),
      add column pool_router_complete_at timestamptz,
      add constraint launch2_instances_pool_router_shape check (
        pool_router_complete_at is null or pool_router_target_block is not null);

    comment on column public.launch2_pool_swaps.wallet_address is
      'Decision 0126: OfficialPoolRouter Swap payer paired with this PoolManager swap (null = not routed through the router).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_events where event_name = 'RouterSwap')
        or exists (select 1 from public.launch2_pool_swaps where wallet_address is not null)
      then raise exception 'refusing to remove official-pool wallet attribution evidence'; end if;
    end $$;
    alter table public.launch2_instances
      drop constraint launch2_instances_pool_router_shape,
      drop column pool_router_complete_at,
      drop column pool_router_target_block;
    drop index public.launch2_pool_swaps_wallet_idx;
    alter table public.launch2_pool_swaps
      drop constraint launch2_pool_swaps_attribution_shape,
      drop constraint launch2_pool_swaps_trade_id_key,
      drop column router_log_index,
      drop column router_amount_out,
      drop column router_amount_in,
      drop column recipient_address,
      drop column wallet_address,
      drop column pool_trade_id;
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
        'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
        'BuybackResumed', 'Swap'));
  `);
}
