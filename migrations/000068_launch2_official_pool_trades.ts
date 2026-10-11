import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0124 (S146): official-pool (Uniswap v4) trading of graduated
 * MEME v2 instances.
 *
 * 1. `launch2_events` admits `Swap`: the PoolManager `Swap` log of an
 *    instance's `officialPoolId` (the `launch2_event` lane asks the node for
 *    the PoolManager address filtered by those pool ids only).
 * 2. `launch2_pool_swaps`: typed facts of those logs — side (buy = USD1 in),
 *    the USD1 and MEME amounts (output gross of the 2 % hook tax), the tax
 *    (output token, 2 % of the gross), the price after the swap, and the
 *    contract that called the PoolManager (the in-App router, the buyback
 *    adapter or any other caller). Same fact key and reorg discipline as
 *    the other launch2 facts.
 * 3. `launch2_instances.pool_*`: the projection the instance detail shows
 *    (counts, volumes, taxes, last price and time), recomputed from the
 *    non-removed facts.
 * 4. `launch2_intents.kind` admits `pool_buy` / `pool_sell` (router calls
 *    prepared for the device signing exit).
 */

const amount = (column: string): string =>
  `add column ${column} numeric(78, 0) not null default 0 check (${column} >= 0)`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
        'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
        'BuybackResumed', 'Swap'));

    create table public.launch2_pool_swaps (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      log_index integer not null check (log_index >= 0),
      block_number bigint not null check (block_number >= 0),
      block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      pool_id text not null check (pool_id ~ '^0x[0-9a-f]{64}$'),
      caller_address text not null check (caller_address ~ '^0x[0-9a-f]{40}$'),
      side text not null check (side in ('buy', 'sell')),
      usd1_amount numeric(78, 0) not null check (usd1_amount > 0),
      meme_amount numeric(78, 0) not null check (meme_amount > 0),
      tax_amount numeric(78, 0) not null check (tax_amount >= 0),
      tax_token text not null check (tax_token in ('usd1', 'meme')),
      sqrt_price_x96 numeric(78, 0) not null check (sqrt_price_x96 >= 0),
      price_e18 numeric(78, 0) not null check (price_e18 >= 0),
      swapped_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index),
      constraint launch2_pool_swaps_tax_side check (
        (side = 'buy') = (tax_token = 'meme'))
    );
    create index launch2_pool_swaps_instance_idx
      on public.launch2_pool_swaps (instance_id, block_number desc, log_index desc)
      where not removed;
    create index launch2_pool_swaps_recent_idx
      on public.launch2_pool_swaps (instance_id, swapped_at)
      where not removed;

    alter table public.launch2_instances
      add column pool_trade_count bigint not null default 0 check (pool_trade_count >= 0),
      add column pool_buy_count bigint not null default 0 check (pool_buy_count >= 0),
      add column pool_sell_count bigint not null default 0 check (pool_sell_count >= 0),
      ${amount("pool_buy_volume_usd1")},
      ${amount("pool_sell_volume_usd1")},
      ${amount("pool_tax_usd1")},
      ${amount("pool_tax_meme")},
      add column pool_last_price_e18 numeric(78, 0) check (pool_last_price_e18 >= 0),
      add column pool_last_trade_at timestamptz,
      add constraint launch2_instances_pool_shape check (
        (pool_trade_count = 0) = (pool_last_trade_at is null)
        and (pool_last_trade_at is null) = (pool_last_price_e18 is null)
        and pool_trade_count = pool_buy_count + pool_sell_count
        and (pool_trade_count = 0 or official_pool_id is not null));

    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell'));

    comment on table public.launch2_pool_swaps is
      'Decision 0124: PoolManager Swap logs of each graduated instance''s official pool (launch2_event lane).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_pool_swaps)
        or exists (select 1 from public.launch2_events where event_name = 'Swap')
        or exists (select 1 from public.launch2_intents where kind in ('pool_buy', 'pool_sell'))
      then raise exception 'refusing to remove official-pool trade evidence'; end if;
    end $$;
    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell'));
    alter table public.launch2_instances
      drop constraint launch2_instances_pool_shape,
      drop column pool_last_trade_at,
      drop column pool_last_price_e18,
      drop column pool_tax_meme,
      drop column pool_tax_usd1,
      drop column pool_sell_volume_usd1,
      drop column pool_buy_volume_usd1,
      drop column pool_sell_count,
      drop column pool_buy_count,
      drop column pool_trade_count;
    drop table public.launch2_pool_swaps;
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
        'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
        'BuybackResumed'));
  `);
}
