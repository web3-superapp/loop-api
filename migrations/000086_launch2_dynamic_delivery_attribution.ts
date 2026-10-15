import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0146 (S201-api): LoopDynamic delivery-based reward attribution
 * (loop-contracts S200, Decision 0014). Any router's buy is weighted and
 * credited to the address that receives the MEME; a same-transaction
 * forward moves the weight on (`CreditMoved`).
 *
 * 1. `launch2_events` admits the Hook's `CreditMoved(round, from, to,
 *    quoteSpent)`.
 * 2. `launch2_dynamic_credit_entries` (projection, rebuilt per touched
 *    instance from the non-removed `BuyCredited` / `CreditMoved` logs like
 *    the other LoopDynamic projections): one `in` row per `BuyCredited`
 *    (its `attribution` the lane derived from the same transaction's logs:
 *    loopRouter / registryRouter / delivery, else unknown) and per
 *    `CreditMoved` receiver (`moved`), one `out` row per `CreditMoved`
 *    sender (`moved`).
 * 3. `launch2_dynamic_buy_weights` keeps the merged weight
 *    (`weight_usd1 = credited_usd1 + moved_in_usd1 − moved_out_usd1`, the
 *    chain's `buyWeight(round, address)`); the existing rows are all
 *    `BuyCredited` (pre-S200 Hooks emit no `CreditMoved`), so they backfill
 *    `credited_usd1 = weight_usd1`.
 *
 * `down` refuses while a `CreditMoved` is indexed.
 */

const eventNames = `
  'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
  'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
  'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
  'BuybackResumed', 'Swap', 'RouterSwap',
  'LoopHookBound', 'SellFeeCharged', 'CandleClosed', 'EmptyCandlesSkipped',
  'RoundActivated', 'RoundClosed', 'BuyCredited', 'BuyNotCredited',
  'BuyFeeCharged', 'RewardClaimed'`;

const amount = (column: string): string =>
  `${column} numeric(78, 0) not null default 0 check (${column} >= 0)`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames},
        'CreditMoved'));

    create table public.launch2_dynamic_credit_entries (
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      round_id numeric(78, 0) not null check (round_id > 0),
      address text not null check (address ~ '^0x[0-9a-f]{40}$'),
      direction text not null check (direction in ('in', 'out')),
      attribution text not null check (attribution in (
        'loopRouter', 'registryRouter', 'delivery', 'moved', 'unknown')),
      counterparty_address text check (counterparty_address ~ '^0x[0-9a-f]{40}$'),
      amount_usd1 numeric(78, 0) not null check (amount_usd1 >= 0),
      hook_address text not null check (hook_address ~ '^0x[0-9a-f]{40}$'),
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      log_index integer not null check (log_index >= 0),
      block_number bigint not null check (block_number >= 0),
      credited_at timestamptz not null,
      primary key (instance_id, chain_id, transaction_hash, log_index, direction),
      constraint launch2_dynamic_credit_entries_shape check (
        (attribution = 'moved') = (counterparty_address is not null)
        and (direction = 'in' or attribution = 'moved'))
    );
    create index launch2_dynamic_credit_entries_address_idx
      on public.launch2_dynamic_credit_entries (instance_id, address, round_id, block_number desc, log_index desc);
    create index launch2_dynamic_credit_entries_round_idx
      on public.launch2_dynamic_credit_entries (instance_id, round_id);

    alter table public.launch2_dynamic_buy_weights
      add column ${amount("credited_usd1")},
      add column ${amount("moved_in_usd1")},
      add column ${amount("moved_out_usd1")};
    update public.launch2_dynamic_buy_weights set credited_usd1 = weight_usd1;
    alter table public.launch2_dynamic_buy_weights
      add constraint launch2_dynamic_buy_weights_merge check (
        weight_usd1 = credited_usd1 + moved_in_usd1 - moved_out_usd1);

    comment on table public.launch2_dynamic_credit_entries is
      'Decision 0146: LoopDynamic weight entries projected from BuyCredited (in, lane-derived attribution) and CreditMoved (moved: out of from, into to).';
    comment on table public.launch2_dynamic_buy_weights is
      'Decision 0131 / 0146: LoopDynamic per-round buy weight per address = sum BuyCredited + sum CreditMoved in - sum CreditMoved out.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_events where event_name = 'CreditMoved')
      then raise exception 'refusing to remove LoopDynamic CreditMoved evidence'; end if;
    end $$;
    alter table public.launch2_dynamic_buy_weights
      drop constraint launch2_dynamic_buy_weights_merge,
      drop column moved_out_usd1,
      drop column moved_in_usd1,
      drop column credited_usd1;
    comment on table public.launch2_dynamic_buy_weights is
      'Decision 0131: LoopDynamic per-round buy weight per buyer projected from BuyCredited.';
    drop table public.launch2_dynamic_credit_entries;
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames}));
  `);
}
