import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0035 review follow-up: durable Privy Swap quotes consumed exactly
 * once by a prepare, and the `payload_verified` flag on wallet intents that
 * records whether the broadcast transaction was compared with the reviewed
 * payload before the receipt could finalise it.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.swap_quotes (
      quote_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      snapshot jsonb not null,
      expires_at timestamptz not null,
      consumed_by_intent_id uuid,
      created_at timestamptz not null default clock_timestamp(),
      constraint swap_quotes_snapshot_check
        check (jsonb_typeof(snapshot) = 'object'),
      constraint swap_quotes_expiry_check check (expires_at > created_at)
    );

    create index swap_quotes_owner_idx
      on public.swap_quotes (owner_user_id, created_at desc);
    create index swap_quotes_expiry_idx
      on public.swap_quotes (expires_at);

    comment on table public.swap_quotes is
      'Privy Swap quote snapshots bound to the caller and wallet. A quote is consumed by exactly one prepare (consumed_by_intent_id, set before the intent row exists so a concurrent prepare cannot spend it twice) and is never reused after expires_at.';

    alter table public.wallet_intents
      add column payload_verified boolean not null default false;

    comment on column public.wallet_intents.payload_verified is
      'True once eth_getTransactionByHash for the reported hash was compared with the reviewed payload and matched. A receipt never finalises an intent before this is true.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.wallet_intents drop column payload_verified;
    drop table public.swap_quotes;
  `);
}
