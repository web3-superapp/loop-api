import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0035: unified wallet intents (send / approve / revoke / swap), their
 * append-only event history, indexed ERC-20 `Approval` logs from the transfer
 * lane, and allowance read observations.
 *
 * An intent row is immutable evidence of what the user was shown: the
 * canonical payload and the public review are generated from one source and
 * the review digest is computed over the canonical payload. State changes are
 * the only mutation; the payload columns are frozen by trigger. Amounts are
 * `numeric(78, 0)` or canonical strings inside jsonb; nothing is a JavaScript
 * number.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.wallet_intents (
      intent_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      provider_operation_id uuid
        references public.provider_operations(id) on delete restrict,
      kind text not null,
      state text not null default 'prepared',
      chain_id text not null references public.chains(chain_id) on delete restrict,
      canonical_payload jsonb not null,
      public_review jsonb not null,
      review_sha256 text not null,
      policy_config_version text not null,
      facts_observed_at timestamptz not null,
      expires_at timestamptz not null,
      simulation_status text not null,
      transaction_hash text,
      provider_action_id text,
      reason_code text,
      receipt jsonb,
      reconcile_after timestamptz,
      reconcile_attempt_count integer not null default 0,
      record_version bigint not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint wallet_intents_kind_check
        check (kind in ('send', 'approve', 'revoke', 'swap')),
      constraint wallet_intents_state_check
        check (state in (
          'prepared', 'awaiting_signature', 'submitted', 'confirmed',
          'reverted', 'failed', 'unknown', 'cancelled', 'expired'
        )),
      constraint wallet_intents_simulation_check
        check (simulation_status in ('passed', 'reverted', 'unavailable')),
      constraint wallet_intents_review_sha256_check
        check (review_sha256 ~ '^[0-9a-f]{64}$'),
      constraint wallet_intents_policy_version_check
        check (policy_config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint wallet_intents_payload_check
        check (jsonb_typeof(canonical_payload) = 'object'),
      constraint wallet_intents_review_check
        check (jsonb_typeof(public_review) = 'object'),
      constraint wallet_intents_receipt_check
        check (receipt is null or jsonb_typeof(receipt) = 'object'),
      constraint wallet_intents_transaction_hash_check
        check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint wallet_intents_provider_action_id_check
        check (
          provider_action_id is null
          or provider_action_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
        ),
      constraint wallet_intents_reason_code_check
        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
      constraint wallet_intents_expiry_check
        check (expires_at > facts_observed_at),
      constraint wallet_intents_attempts_check
        check (reconcile_attempt_count >= 0),
      constraint wallet_intents_version_check check (record_version >= 1),
      constraint wallet_intents_timestamp_check check (updated_at >= created_at)
    );

    create index wallet_intents_owner_idx
      on public.wallet_intents (owner_user_id, created_at desc, intent_id desc);
    create index wallet_intents_wallet_open_idx
      on public.wallet_intents (wallet_id)
      where state in ('prepared', 'awaiting_signature');
    create index wallet_intents_reconcile_idx
      on public.wallet_intents (reconcile_after)
      where state in ('submitted', 'unknown');
    create unique index wallet_intents_operation_idx
      on public.wallet_intents (provider_operation_id)
      where provider_operation_id is not null;

    comment on table public.wallet_intents is
      'Unified send/approve/revoke/swap intents. canonical_payload and public_review are generated from one source and frozen; review_sha256 is the digest the client re-checks before signing. Only state, hash, receipt, reason, and reconciliation columns ever change.';

    create or replace function public.reject_wallet_intent_payload_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.canonical_payload is distinct from old.canonical_payload
        or new.public_review is distinct from old.public_review
        or new.review_sha256 is distinct from old.review_sha256
        or new.kind is distinct from old.kind
        or new.owner_user_id is distinct from old.owner_user_id
        or new.wallet_id is distinct from old.wallet_id
        or new.chain_id is distinct from old.chain_id
        or new.facts_observed_at is distinct from old.facts_observed_at
        or new.expires_at is distinct from old.expires_at
        or new.simulation_status is distinct from old.simulation_status
        or new.policy_config_version is distinct from old.policy_config_version
      then
        raise exception 'wallet_intents payload columns are immutable'
          using errcode = 'restrict_violation';
      end if;
      return new;
    end;
    $$;

    create trigger wallet_intents_payload_immutable
      before update on public.wallet_intents
      for each row execute function public.reject_wallet_intent_payload_mutation();

    create table public.wallet_intent_events (
      event_id bigserial primary key,
      intent_id uuid not null
        references public.wallet_intents(intent_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      from_state text,
      to_state text not null,
      reason_code text,
      request_id uuid,
      actor_type text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default clock_timestamp(),
      constraint wallet_intent_events_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint wallet_intent_events_actor_check
        check (actor_type in ('api', 'worker')),
      constraint wallet_intent_events_reason_check
        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
      constraint wallet_intent_events_details_check
        check (jsonb_typeof(details) = 'object')
    );

    create index wallet_intent_events_intent_idx
      on public.wallet_intent_events (intent_id, event_id);

    comment on table public.wallet_intent_events is
      'Append-only intent state history. Details never carry calldata, signatures, or Provider bodies.';

    create or replace function public.reject_wallet_intent_event_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'wallet_intent_events is append-only'
        using errcode = 'restrict_violation';
    end;
    $$;

    create trigger wallet_intent_events_append_only
      before update or delete on public.wallet_intent_events
      for each row execute function public.reject_wallet_intent_event_mutation();

    create table public.indexed_approvals (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      owner_address text not null,
      spender_address text not null,
      raw_value numeric(78, 0) not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint indexed_approvals_transaction_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_approvals_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_approvals_log_index_check check (log_index >= 0),
      constraint indexed_approvals_block_check check (block_number >= 0),
      constraint indexed_approvals_owner_check
        check (owner_address ~ '^0x[0-9a-f]{40}$'),
      constraint indexed_approvals_spender_check
        check (spender_address ~ '^0x[0-9a-f]{40}$'),
      constraint indexed_approvals_value_check check (raw_value >= 0)
    );

    create index indexed_approvals_owner_idx
      on public.indexed_approvals (chain_id, owner_address, block_number desc, log_index desc);
    create index indexed_approvals_block_idx
      on public.indexed_approvals (chain_id, block_number);

    comment on table public.indexed_approvals is
      'ERC-20 Approval logs for Asset Registry assets, written by the erc20_transfer lane in the same segment transaction as Transfer logs. A reorged-out log keeps its row with removed = true.';

    create table public.approval_observations (
      observation_id uuid primary key default gen_random_uuid(),
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      spender_address text not null,
      raw_value numeric(78, 0) not null,
      block_number bigint not null,
      block_hash text not null,
      observed_at timestamptz not null default clock_timestamp(),
      constraint approval_observations_spender_check
        check (spender_address ~ '^0x[0-9a-f]{40}$'),
      constraint approval_observations_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint approval_observations_block_check check (block_number >= 0),
      constraint approval_observations_value_check check (raw_value >= 0)
    );

    create index approval_observations_wallet_idx
      on public.approval_observations (wallet_id, asset_id, spender_address, observed_at desc);

    comment on table public.approval_observations is
      'allowance() values actually read over RPC at a block. Audit trail only; never replayed as a current allowance when the chain is unreadable.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.approval_observations;
    drop table public.indexed_approvals;
    drop trigger wallet_intent_events_append_only on public.wallet_intent_events;
    drop function public.reject_wallet_intent_event_mutation();
    drop table public.wallet_intent_events;
    drop trigger wallet_intents_payload_immutable on public.wallet_intents;
    drop function public.reject_wallet_intent_payload_mutation();
    drop table public.wallet_intents;
  `);
}
