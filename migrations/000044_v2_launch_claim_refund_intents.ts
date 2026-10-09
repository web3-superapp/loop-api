import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0087: Launch `claim()` and `claimRefund()` Intents beside the
 * purchase Intent, and the per-log settlement records the history lists.
 *
 * - `launch_intents.direction` (000023, `'buy'` only) is the Intent kind:
 *   `buy`, `claim`, `claim_refund`. A claim or refund Intent names no round
 *   and pays no USD1: `round_id` / `round_index` are null and
 *   `pay_amount_raw` is 0; a buy keeps a round and a positive amount (every
 *   existing row is a buy, so the new checks hold for them).
 * - `launch_settlement_records`: one row per `Claimed` / `Refunded` log of a
 *   registered sale whose wallet argument resolves to exactly one LOOP
 *   account, projected by the `launch_event` lane like `purchase_records`
 *   (opaque ID, reorged rows kept with `confirmation_state = 'reorged'`).
 *   The transaction hash and log index are the event's identity, never a
 *   key of an account.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch_intents
      drop constraint launch_intents_direction_check,
      drop constraint launch_intents_amounts_check,
      alter column round_id drop not null,
      add constraint launch_intents_direction_check
        check (direction in ('buy', 'claim', 'claim_refund')),
      add constraint launch_intents_amounts_check
        check (
          pay_amount_raw >= 0 and expected_receive_raw >= 0 and wallet_cumulative_raw >= 0
          and (direction <> 'buy' or pay_amount_raw > 0)
          and (direction = 'buy' or pay_amount_raw = 0)
        ),
      add constraint launch_intents_kind_round_check
        check (
          (direction = 'buy' and round_id is not null)
          or (direction <> 'buy' and round_id is null and round_index is null)
        );

    comment on column public.launch_intents.direction is
      'Decision 0087: the Intent kind. buy = buy() (06 §4.1, a round and a positive USD1 amount); claim = claim(saleId); claim_refund = claimRefund(saleId). claim and claim_refund name no round and pay nothing.';

    create table public.launch_settlement_records (
      settlement_record_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      kind text not null,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      amount_raw numeric(78, 0) not null,
      cumulative_raw numeric(78, 0) not null,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      confirmation_state text not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      created_at timestamptz not null default clock_timestamp(),
      constraint launch_settlement_records_log_unique unique (transaction_hash, log_index),
      constraint launch_settlement_records_kind_check
        check (kind in ('claimed', 'refunded')),
      constraint launch_settlement_records_amount_check
        check (amount_raw >= 0 and cumulative_raw >= 0),
      constraint launch_settlement_records_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_settlement_records_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_settlement_records_log_check
        check (log_index >= 0 and block_number >= 0),
      constraint launch_settlement_records_confirmation_check
        check (confirmation_state in ('pending', 'confirmed', 'reorged')),
      constraint launch_settlement_records_removed_check
        check (removed = (confirmation_state = 'reorged'))
    );

    create index launch_settlement_records_owner_idx
      on public.launch_settlement_records (launch_id, owner_user_id, block_number desc, log_index desc);

    comment on table public.launch_settlement_records is
      'Decision 0087: one row per Claimed (project token) or Refunded (USD1) log of a registered sale, attributed to the single LOOP wallet its wallet argument resolves to. Projected from launch_indexed_events by the launch_event lane; amounts are base units; a reorged log keeps its row as reorged.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.launch_settlement_records)
        or exists (select 1 from public.launch_intents where direction <> 'buy')
      then
        raise exception 'claim or refund facts exist; refusing to roll back 000044';
      end if;
    end
    $$;

    drop table public.launch_settlement_records;
    alter table public.launch_intents
      drop constraint launch_intents_kind_round_check,
      drop constraint launch_intents_amounts_check,
      drop constraint launch_intents_direction_check,
      alter column round_id set not null,
      add constraint launch_intents_direction_check check (direction = 'buy'),
      add constraint launch_intents_amounts_check
        check (pay_amount_raw > 0 and expected_receive_raw >= 0 and wallet_cumulative_raw >= 0);
    comment on column public.launch_intents.direction is null;
  `);
}
