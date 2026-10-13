import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0131 (S166): the optional LoopDynamic official-pool Hook kind
 * (loop-contracts S164, Decision 0009). Default off; nothing here changes
 * an OfficialTax instance.
 *
 * 1. `launch2_events` admits the LoopDynamic logs: `LoopHookBound` (the
 *    instance's graduation adapter binds the per-project Hook it deployed
 *    in the graduation transaction) and the Hook's `SellFeeCharged`,
 *    `CandleClosed`, `EmptyCandlesSkipped`, `RoundActivated`,
 *    `RoundClosed`, `BuyCredited`, `BuyNotCredited`, `BuyFeeCharged`,
 *    `RewardClaimed`.
 * 2. `launch2_instances.pool_hook_kind` is derived from the registry row: a
 *    LoopDynamic Factory deploys no Hook at `deployLaunch`
 *    (`LaunchDeployed.hook = 0`), so a zero `hook_address` is LoopDynamic.
 *    `dynamic_hook_address` / `dynamic_pool_id` / `dynamic_hook_bound_block`
 *    are the lane's projection of the non-removed `LoopHookBound`.
 * 3. Typed facts (same key and reorg discipline as the other launch2
 *    facts: `(chain_id, transaction_hash, log_index)`, `removed`):
 *    `launch2_dynamic_hook_bindings`, `launch2_dynamic_fees` (direction:
 *    sell = `SellFeeCharged`, USD1 gross / base / dynamic extra / drop
 *    rate; buy = `BuyFeeCharged`, MEME gross / 2 % fee, loop-contracts
 *    S165), `launch2_dynamic_candles` (only
 *    `CandleClosed`), `launch2_dynamic_claims`.
 * 4. Projections rebuilt per touched instance from the non-removed facts:
 *    `launch2_dynamic_rounds` and `launch2_dynamic_buy_weights`.
 * 5. `launch2_intents.kind` admits `dynamic_claim` (`claim(roundId)` on the
 *    Hook, for the device signing exit); `launch2_dynamic_claim_reports`
 *    keeps the transaction hash the device reported for such an intent
 *    (append-only; the indexed `RewardClaimed` stays the truth).
 */

const eventNames = `
  'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
  'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
  'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
  'BuybackResumed', 'Swap', 'RouterSwap'`;

const dynamicEventNames = `
  'LoopHookBound', 'SellFeeCharged', 'CandleClosed', 'EmptyCandlesSkipped',
  'RoundActivated', 'RoundClosed', 'BuyCredited', 'BuyNotCredited',
  'BuyFeeCharged', 'RewardClaimed'`;

const zeroAddress = "0x0000000000000000000000000000000000000000";

const factColumns = `
  chain_id text not null references public.chains(chain_id) on delete restrict,
  transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
  removed boolean not null default false,
  observed_at timestamptz not null default clock_timestamp(),
  hook_address text not null check (hook_address ~ '^0x[0-9a-f]{40}$'),`;

const amount = (column: string): string =>
  `${column} numeric(78, 0) not null check (${column} >= 0)`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames},
        ${dynamicEventNames}));

    alter table public.launch2_instances
      add column pool_hook_kind text generated always as (
        case when hook_address = '${zeroAddress}'
          then 'loopDynamic' else 'officialTax' end) stored,
      add column dynamic_hook_address text
        check (dynamic_hook_address ~ '^0x[0-9a-f]{40}$'),
      add column dynamic_pool_id text
        check (dynamic_pool_id ~ '^0x[0-9a-f]{64}$'),
      add column dynamic_hook_bound_block bigint
        check (dynamic_hook_bound_block >= 0),
      add constraint launch2_instances_dynamic_hook_shape check (
        (dynamic_hook_address is null) = (dynamic_pool_id is null)
        and (dynamic_hook_address is null) = (dynamic_hook_bound_block is null)
        and (dynamic_hook_address is null or hook_address = '${zeroAddress}'));

    create table public.launch2_dynamic_hook_bindings (
      ${factColumns}
      pool_id text not null check (pool_id ~ '^0x[0-9a-f]{64}$'),
      bound_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_dynamic_hook_bindings_instance_idx
      on public.launch2_dynamic_hook_bindings (instance_id, block_number desc, log_index desc)
      where not removed;

    create table public.launch2_dynamic_fees (
      ${factColumns}
      side text not null check (side in ('buy', 'sell')),
      fee_token text not null check (fee_token in ('usd1', 'meme')),
      round_id numeric(78, 0) check (round_id >= 0),
      buyer_address text check (buyer_address ~ '^0x[0-9a-f]{40}$'),
      ${amount("gross_amount")},
      ${amount("base_fee")},
      ${amount("extra_fee")},
      drop_wad numeric(78, 0) not null check (drop_wad >= 0 and drop_wad <= 1000000000000000000),
      charged_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index),
      constraint launch2_dynamic_fees_split check (base_fee + extra_fee <= gross_amount),
      constraint launch2_dynamic_fees_side_shape check (
        (side = 'buy') = (fee_token = 'meme')
        and (side = 'buy') = (round_id is null)
        and (side = 'buy') = (buyer_address is not null)
        and (side = 'sell' or (extra_fee = 0 and drop_wad = 0)))
    );
    create index launch2_dynamic_fees_instance_idx
      on public.launch2_dynamic_fees (instance_id, side, round_id)
      where not removed;

    create table public.launch2_dynamic_candles (
      ${factColumns}
      candle_id numeric(78, 0) not null check (candle_id >= 0),
      open_sqrt_price_x96 numeric(78, 0) not null check (open_sqrt_price_x96 >= 0),
      close_sqrt_price_x96 numeric(78, 0) not null check (close_sqrt_price_x96 >= 0),
      closed_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_dynamic_candles_instance_idx
      on public.launch2_dynamic_candles (instance_id, candle_id desc)
      where not removed;

    create table public.launch2_dynamic_claims (
      ${factColumns}
      round_id numeric(78, 0) not null check (round_id > 0),
      buyer_address text not null check (buyer_address ~ '^0x[0-9a-f]{40}$'),
      ${amount("amount_usd1")},
      claimed_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_dynamic_claims_buyer_idx
      on public.launch2_dynamic_claims (instance_id, buyer_address, round_id)
      where not removed;

    create table public.launch2_dynamic_rounds (
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      round_id numeric(78, 0) not null check (round_id > 0),
      hook_address text not null check (hook_address ~ '^0x[0-9a-f]{40}$'),
      start_candle numeric(78, 0) not null check (start_candle >= 0),
      end_candle numeric(78, 0) check (end_candle >= 0),
      ${amount("carried_in_usd1")},
      ${amount("extra_fees_usd1")},
      ${amount("total_buy_weight_usd1")},
      allocation_usd1 numeric(78, 0) check (allocation_usd1 >= 0),
      next_carry_usd1 numeric(78, 0) check (next_carry_usd1 >= 0),
      ${amount("claimed_usd1")},
      buyer_count integer not null check (buyer_count >= 0),
      closed boolean not null,
      activated_at timestamptz not null,
      activated_block bigint not null check (activated_block >= 0),
      activated_transaction_hash text not null check (activated_transaction_hash ~ '^0x[0-9a-f]{64}$'),
      closed_at timestamptz,
      closed_block bigint check (closed_block >= 0),
      closed_transaction_hash text check (closed_transaction_hash ~ '^0x[0-9a-f]{64}$'),
      projected_at timestamptz not null default clock_timestamp(),
      primary key (instance_id, round_id),
      constraint launch2_dynamic_rounds_closed_shape check (
        closed = (end_candle is not null)
        and closed = (allocation_usd1 is not null)
        and closed = (next_carry_usd1 is not null)
        and closed = (closed_at is not null)
        and closed = (closed_block is not null)
        and closed = (closed_transaction_hash is not null))
    );

    create table public.launch2_dynamic_buy_weights (
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      round_id numeric(78, 0) not null check (round_id > 0),
      buyer_address text not null check (buyer_address ~ '^0x[0-9a-f]{40}$'),
      weight_usd1 numeric(78, 0) not null check (weight_usd1 > 0),
      credit_count integer not null check (credit_count > 0),
      last_credited_at timestamptz not null,
      primary key (instance_id, round_id, buyer_address)
    );
    create index launch2_dynamic_buy_weights_buyer_idx
      on public.launch2_dynamic_buy_weights (instance_id, buyer_address, round_id);

    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell', 'dynamic_claim'));

    create table public.launch2_dynamic_claim_reports (
      intent_id uuid primary key references public.launch2_intents(intent_id) on delete restrict,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      wallet_id uuid not null,
      wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
      round_id numeric(78, 0) not null check (round_id > 0),
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      reported_at timestamptz not null default clock_timestamp()
    );
    create index launch2_dynamic_claim_reports_tx_idx
      on public.launch2_dynamic_claim_reports (transaction_hash);
    create function public.reject_launch2_dynamic_claim_report_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'launch2 dynamic claim reports are append-only';
    end;
    $$;
    create trigger launch2_dynamic_claim_reports_immutable
      before update or delete on public.launch2_dynamic_claim_reports
      for each row execute function public.reject_launch2_dynamic_claim_report_mutation();

    comment on table public.launch2_dynamic_hook_bindings is
      'Decision 0131: LoopHookBound logs of LoopDynamic instances (graduation adapter binds the per-project Hook).';
    comment on table public.launch2_dynamic_fees is
      'Decision 0131: LoopDynamic Hook fee logs: SellFeeCharged (USD1 gross / base / dynamic extra, drop rate) and BuyFeeCharged (MEME gross / 2 percent buy fee).';
    comment on table public.launch2_dynamic_candles is
      'Decision 0131: LoopDynamic Hook CandleClosed logs (5-minute candles closed by a swap or poke).';
    comment on table public.launch2_dynamic_claims is
      'Decision 0131: LoopDynamic Hook RewardClaimed logs.';
    comment on table public.launch2_dynamic_rounds is
      'Decision 0131: LoopDynamic reward rounds projected from the non-removed Hook logs.';
    comment on table public.launch2_dynamic_buy_weights is
      'Decision 0131: LoopDynamic per-round buy weight per buyer projected from BuyCredited.';
    comment on table public.launch2_dynamic_claim_reports is
      'Decision 0131: transaction hashes the device reported for dynamic_claim intents (append-only).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_dynamic_hook_bindings)
        or exists (select 1 from public.launch2_dynamic_fees)
        or exists (select 1 from public.launch2_dynamic_candles)
        or exists (select 1 from public.launch2_dynamic_claims)
        or exists (select 1 from public.launch2_dynamic_claim_reports)
        or exists (select 1 from public.launch2_intents where kind = 'dynamic_claim')
        or exists (select 1 from public.launch2_events where event_name in (${dynamicEventNames}))
      then raise exception 'refusing to remove LoopDynamic evidence'; end if;
    end $$;
    drop table public.launch2_dynamic_claim_reports;
    drop function public.reject_launch2_dynamic_claim_report_mutation();
    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell'));
    drop table public.launch2_dynamic_buy_weights;
    drop table public.launch2_dynamic_rounds;
    drop table public.launch2_dynamic_claims;
    drop table public.launch2_dynamic_candles;
    drop table public.launch2_dynamic_fees;
    drop table public.launch2_dynamic_hook_bindings;
    alter table public.launch2_instances
      drop constraint launch2_instances_dynamic_hook_shape,
      drop column dynamic_hook_bound_block,
      drop column dynamic_pool_id,
      drop column dynamic_hook_address,
      drop column pool_hook_kind;
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames}));
  `);
}
