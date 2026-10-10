import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0121 (S143): the MEME v2 buyback keeper.
 *
 * `launch2_buyback_attempts`: one row per keeper decision on a graduated
 * instance. A `BuybackExecutor.execute()` simulation the contract refuses
 * is a `rejected` row (no transaction); consecutive refusals with the same
 * reason update that row (`rejection_count`, `last_rejected_at`,
 * `next_eligible_at`) instead of adding rows. A simulation that passes is a
 * `pending` row written before anything is signed; the keeper's signed
 * transaction (hash, nonce, raw bytes) is written on it before the bytes
 * are sent. Status machine:
 *
 *   rejected (terminal; same-reason refresh only)
 *   pending → broadcast → confirmed (receipt success, confirmations deep)
 *   pending | broadcast → failed (terminal)
 *   confirmed → broadcast (the receipt left the canonical chain, while the
 *   ledger has not yet aligned)
 *
 * `buyback_id` = the `launch2_buybacks` row the `launch2_event` lane wrote
 * from this transaction's `BuybackCompleted` (set once, while confirmed).
 * The ledger itself is never written by the keeper. At most one
 * `pending | broadcast | confirmed-unaligned` row per instance. Rows are
 * never deleted.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.launch2_buyback_attempts (
      attempt_id uuid primary key,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      attempt integer not null check (attempt >= 1),
      status text not null check (status in (
        'rejected', 'pending', 'broadcast', 'confirmed', 'failed')),
      keeper_address text not null check (keeper_address ~ '^0x[0-9a-f]{40}$'),
      executor_address text not null check (executor_address ~ '^0x[0-9a-f]{40}$'),
      simulation text not null check (simulation in ('passed', 'reverted')),
      order_usd1 numeric(78, 0) check (order_usd1 > 0),
      simulated_gas bigint check (simulated_gas > 0),
      reason_code text check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      reason_detail text check (reason_detail ~ '^[A-Za-z0-9_]{1,64}$'),
      rejection_count integer check (rejection_count >= 1),
      last_rejected_at timestamptz,
      next_eligible_at timestamptz,
      tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
      tx_nonce bigint check (tx_nonce >= 0),
      raw_tx text check (raw_tx ~ '^0x[0-9a-f]+$' and length(raw_tx) <= 131072),
      block_number bigint check (block_number >= 0),
      block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
      confirmations integer check (confirmations >= 0),
      buyback_id uuid,
      created_at timestamptz not null default clock_timestamp(),
      broadcast_at timestamptz,
      confirmed_at timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch2_buyback_attempt_simulation_shape check (
        (status = 'rejected') = (simulation = 'reverted')),
      constraint launch2_buyback_attempt_rejected_shape check (
        (status = 'rejected') = (rejection_count is not null)
        and (status = 'rejected') = (last_rejected_at is not null)),
      constraint launch2_buyback_attempt_reason_shape check (
        (status in ('rejected', 'failed')) = (reason_code is not null)
        and (reason_detail is null or reason_code is not null)),
      constraint launch2_buyback_attempt_tx_shape check (
        (tx_hash is null) = (raw_tx is null) and (tx_hash is null) = (tx_nonce is null)
        and (status not in ('broadcast', 'confirmed') or tx_hash is not null)
        and (status <> 'rejected' or tx_hash is null)),
      constraint launch2_buyback_attempt_confirmed_shape check (
        status <> 'confirmed'
        or (block_number is not null and block_hash is not null and confirmations is not null
          and confirmed_at is not null)),
      constraint launch2_buyback_attempt_ledger_shape check (
        buyback_id is null or status = 'confirmed')
    );
    create unique index launch2_buyback_attempt_active
      on public.launch2_buyback_attempts (instance_id)
      where status in ('pending', 'broadcast') or (status = 'confirmed' and buyback_id is null);
    create unique index launch2_buyback_attempt_number
      on public.launch2_buyback_attempts (instance_id, attempt);
    create index launch2_buyback_attempt_recent
      on public.launch2_buyback_attempts (instance_id, attempt desc);
    create unique index launch2_buyback_attempt_tx
      on public.launch2_buyback_attempts (tx_hash) where tx_hash is not null;
    create index launch2_buyback_attempt_nonce
      on public.launch2_buyback_attempts (keeper_address, tx_nonce)
      where status in ('pending', 'broadcast') and tx_nonce is not null;

    create function public.guard_launch2_buyback_attempt()
    returns trigger language plpgsql as $$
    declare
      mutable text[] := array['status', 'reason_code', 'reason_detail',
        'rejection_count', 'last_rejected_at', 'next_eligible_at', 'tx_hash',
        'tx_nonce', 'raw_tx', 'block_number', 'block_hash', 'confirmations',
        'buyback_id', 'broadcast_at', 'confirmed_at', 'updated_at'];
      transition text;
    begin
      if TG_OP = 'DELETE' then
        raise exception 'buyback attempts retain audit history';
      end if;
      if (to_jsonb(NEW) - mutable) is distinct from (to_jsonb(OLD) - mutable) then
        raise exception 'invalid buyback attempt mutation';
      end if;
      transition := OLD.status || '>' || NEW.status;
      if transition not in (
        'rejected>rejected', 'pending>pending', 'pending>broadcast',
        'pending>failed', 'broadcast>broadcast', 'broadcast>confirmed',
        'broadcast>failed', 'confirmed>confirmed', 'confirmed>broadcast') then
        raise exception 'invalid buyback attempt mutation: transition % not allowed', transition;
      end if;
      if OLD.status = 'rejected' and (
        NEW.reason_code is distinct from OLD.reason_code
        or NEW.reason_detail is distinct from OLD.reason_detail
        or NEW.rejection_count <= OLD.rejection_count) then
        raise exception 'a rejected buyback attempt only counts the same refusal again';
      end if;
      if NEW.tx_hash is distinct from OLD.tx_hash
        and not (OLD.status = 'pending' and NEW.status = 'pending' and OLD.tx_hash is null) then
        raise exception 'buyback attempt transaction is set once, while pending';
      end if;
      if NEW.buyback_id is distinct from OLD.buyback_id
        and not (transition = 'confirmed>confirmed' and OLD.buyback_id is null) then
        raise exception 'buyback attempt ledger alignment is set once, while confirmed';
      end if;
      if transition = 'confirmed>broadcast' and OLD.buyback_id is not null then
        raise exception 'an aligned buyback attempt is final';
      end if;
      if transition = 'confirmed>confirmed' and (
        NEW.block_number is distinct from OLD.block_number
        or NEW.block_hash is distinct from OLD.block_hash) then
        raise exception 'invalid buyback attempt mutation';
      end if;
      NEW.updated_at := clock_timestamp();
      return NEW;
    end;
    $$;
    create trigger launch2_buyback_attempt_guard
      before update or delete on public.launch2_buyback_attempts
      for each row execute function public.guard_launch2_buyback_attempt();

    comment on table public.launch2_buyback_attempts is
      'Decision 0121: buyback keeper attempts (simulation verdict; passing attempts written before signing, transaction before broadcast; ledger stays the launch2_event lane''s).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_buyback_attempts)
      then raise exception 'refusing to remove buyback keeper evidence'; end if;
    end $$;
    drop table public.launch2_buyback_attempts;
    drop function public.guard_launch2_buyback_attempt();
  `);
}
