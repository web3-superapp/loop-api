import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0116 (S138): hourly two-track Mining settlement.
 *
 * - `mining_parameter_versions`: reviewer-approved parameters (five referral
 *   ratios, two daily budgets, release window, admitted asset weights,
 *   community coefficients) with an effective instant; approved rows are
 *   immutable.
 * - `mining_epochs`: one row per UTC hour; `settled` exactly once
 *   (unique hour and idempotency key), `failed` retryable.
 * - `mining_epoch_rewards`: per user × epoch, both tracks' self / referral /
 *   total power, the five-level breakdown, and the rewards.
 * - `mining_reward_ledger_events` (append-only) + `mining_reward_balances`
 *   (projection): settled total, claimed total, unclaimed (generated).
 * - `mining_claims`: EIP-712 vouchers and their on-chain outcome.
 * - `idempotency_records.digest_version` admits the two claim commands.
 *
 * The legacy `mining_reward_ledger` (000023) is left as it is.
 */

const digestVersionsBefore = [
  "sha256_v1",
  "perp_intent_request_v1",
  "perp_agent_authorization_issue_v1",
  "price_alert_create_v1",
  "spot_intent_request_v1",
  "spot_agent_authorization_issue_v1",
  "social_command_v1",
  "chat_channel_command_v1",
  "community_command_v1",
  "social_graph_command_v1",
  "communication_command_v1",
  "price_alert_create_v2",
  "launch_command_v1",
  "referral_command_v1",
  "support_ticket_create_v1",
  "community_ai_ask_v1",
  "community_ai_report_v1",
  "launch_intent_v1",
  "meme_token_create_v1",
  "meme_intent_v1",
  "launch2_intent_v1",
] as const;

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const raw = (column: string): string =>
  `${column} numeric(78, 0) not null default 0 check (${column} >= 0)`;
const decimal = (column: string): string =>
  `${column} text not null default '0' check (${column} ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,18})?$')`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list([
        ...digestVersionsBefore,
        "mining_claim_prepare_v1",
        "mining_claim_report_v1",
      ])}));

    create table public.mining_parameter_versions (
      version_id uuid primary key,
      config_version text not null unique
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      status text not null default 'pending_approval'
        check (status in ('pending_approval', 'approved', 'withdrawn')),
      document jsonb not null check (jsonb_typeof(document) = 'object'),
      effective_from timestamptz not null,
      draft_author_actor text not null check (char_length(draft_author_actor) between 1 and 128),
      draft_author_account_id uuid,
      approved_by text,
      approved_by_account_id uuid,
      approved_at timestamptz,
      requested_audit_id uuid,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint mining_parameter_versions_approval_shape check (
        (status = 'approved') = (approved_at is not null and approved_by is not null)),
      constraint mining_parameter_versions_timestamp_check check (updated_at >= created_at)
    );
    create unique index mining_parameter_versions_effective_idx
      on public.mining_parameter_versions (effective_from)
      where status = 'approved';

    create function public.reject_approved_mining_parameter_mutation()
    returns trigger language plpgsql as $$
    begin
      if old.status = 'approved' then
        raise exception 'approved mining parameter versions are immutable'
          using errcode = '55000';
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $$;
    create trigger mining_parameter_versions_immutable
      before update or delete on public.mining_parameter_versions
      for each row execute function public.reject_approved_mining_parameter_mutation();

    create table public.mining_epochs (
      epoch_id uuid primary key,
      hour_start timestamptz not null unique,
      hour_end timestamptz not null,
      idempotency_key text not null unique
        check (idempotency_key ~ '^mining_hourly:[0-9T:.Z-]{20,32}$'),
      status text not null default 'pending'
        check (status in ('pending', 'settling', 'settled', 'failed')),
      trigger text not null default 'scheduled'
        check (trigger in ('scheduled', 'test_trigger')),
      version_id uuid references public.mining_parameter_versions(version_id) on delete restrict,
      ${raw("budget_nft_raw")},
      ${raw("budget_asset_raw")},
      ${decimal("denominator_nft_power")},
      ${decimal("denominator_asset_power")},
      ${raw("allocated_nft_raw")},
      ${raw("allocated_asset_raw")},
      ${raw("unallocated_nft_raw")},
      ${raw("unallocated_asset_raw")},
      user_count integer not null default 0 check (user_count >= 0),
      input_digest text check (input_digest ~ '^[0-9a-f]{64}$'),
      input_summary jsonb not null default '{}'::jsonb
        check (jsonb_typeof(input_summary) = 'object'),
      failure_reason_code text check (failure_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      settled_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint mining_epochs_hour_shape check (
        hour_end = hour_start + interval '1 hour'
        and extract(epoch from hour_start)::bigint % 3600 = 0),
      constraint mining_epochs_settled_shape check (
        (status = 'settled') = (settled_at is not null)
        and (status <> 'settled' or (input_digest is not null and version_id is not null))),
      constraint mining_epochs_budget_shape check (
        allocated_nft_raw + unallocated_nft_raw = budget_nft_raw
        and allocated_asset_raw + unallocated_asset_raw = budget_asset_raw
        or status <> 'settled'),
      constraint mining_epochs_timestamp_check check (updated_at >= created_at)
    );
    create index mining_epochs_recent_idx
      on public.mining_epochs (hour_start desc) where status = 'settled';

    create function public.reject_settled_mining_epoch_mutation()
    returns trigger language plpgsql as $$
    begin
      if old.status = 'settled' then
        raise exception 'settled mining epochs are immutable'
          using errcode = '55000';
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $$;
    create trigger mining_epochs_settled_immutable
      before update or delete on public.mining_epochs
      for each row execute function public.reject_settled_mining_epoch_mutation();

    create table public.mining_epoch_rewards (
      epoch_id uuid not null references public.mining_epochs(epoch_id) on delete restrict,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      ${decimal("nft_self_power")},
      ${decimal("asset_self_power")},
      ${decimal("nft_referral_power")},
      ${decimal("asset_referral_power")},
      ${decimal("nft_total_power")},
      ${decimal("asset_total_power")},
      referral_levels jsonb not null
        check (jsonb_typeof(referral_levels) = 'array' and jsonb_array_length(referral_levels) = 5),
      nft_holdings jsonb not null default '[]'::jsonb check (jsonb_typeof(nft_holdings) = 'array'),
      asset_holdings jsonb not null default '[]'::jsonb check (jsonb_typeof(asset_holdings) = 'array'),
      ${raw("nft_reward_raw")},
      ${raw("asset_reward_raw")},
      ${raw("total_reward_raw")},
      primary key (epoch_id, owner_user_id),
      constraint mining_epoch_rewards_total_check
        check (total_reward_raw = nft_reward_raw + asset_reward_raw)
    );
    create index mining_epoch_rewards_owner_idx
      on public.mining_epoch_rewards (owner_user_id, epoch_id);

    create table public.mining_claims (
      claim_id uuid primary key,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      idempotency_record_id uuid not null unique
        references public.idempotency_records(id) on delete restrict,
      wallet_id uuid not null,
      wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
      chain_id text not null references public.chains(chain_id) on delete restrict,
      contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
      ${raw("cumulative_amount_raw")},
      ${raw("expected_delta_raw")},
      nonce numeric(78, 0) not null check (nonce >= 0),
      deadline timestamptz not null,
      signature text not null check (signature ~ '^0x[0-9a-f]{130}$'),
      signer_address text not null check (signer_address ~ '^0x[0-9a-f]{40}$'),
      prepared_block_number numeric(78, 0) not null check (prepared_block_number >= 0),
      unsigned_transaction jsonb not null check (jsonb_typeof(unsigned_transaction) = 'object'),
      status text not null default 'claimable' check (status in (
        'claimable', 'submitting', 'confirming', 'succeeded', 'failed', 'expired')),
      transaction_hash text unique check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      block_number numeric(78, 0) check (block_number >= 0),
      confirmed_delta_raw numeric(78, 0) check (confirmed_delta_raw > 0),
      failure_reason_code text check (failure_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint mining_claims_submitted_shape check (
        status in ('claimable', 'expired', 'failed') or transaction_hash is not null),
      constraint mining_claims_succeeded_shape check (
        (status = 'succeeded') = (confirmed_delta_raw is not null)),
      constraint mining_claims_timestamp_check check (updated_at >= created_at)
    );
    create index mining_claims_owner_idx
      on public.mining_claims (owner_user_id, created_at desc, claim_id desc);
    create index mining_claims_open_idx
      on public.mining_claims (status, updated_at)
      where status in ('claimable', 'submitting', 'confirming');

    create table public.mining_reward_ledger_events (
      event_id uuid primary key,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      kind text not null check (kind in ('settled', 'claimed')),
      amount_raw numeric(78, 0) not null check (amount_raw > 0),
      epoch_id uuid references public.mining_epochs(epoch_id) on delete restrict,
      claim_id uuid references public.mining_claims(claim_id) on delete restrict,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint mining_reward_ledger_events_shape check (
        (kind = 'settled' and epoch_id is not null and claim_id is null)
        or (kind = 'claimed' and claim_id is not null and epoch_id is null))
    );
    create unique index mining_reward_ledger_events_settled_idx
      on public.mining_reward_ledger_events (epoch_id, owner_user_id)
      where kind = 'settled';
    create unique index mining_reward_ledger_events_claimed_idx
      on public.mining_reward_ledger_events (claim_id)
      where kind = 'claimed';
    create index mining_reward_ledger_events_owner_idx
      on public.mining_reward_ledger_events (owner_user_id, occurred_at desc);

    create function public.reject_mining_ledger_event_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'mining_reward_ledger_events are append-only'
        using errcode = '55000';
    end;
    $$;
    create trigger mining_reward_ledger_events_append_only
      before update or delete on public.mining_reward_ledger_events
      for each row execute function public.reject_mining_ledger_event_mutation();

    create table public.mining_reward_balances (
      owner_user_id uuid primary key references public.loop_users(id) on delete restrict,
      ${raw("settled_total_raw")},
      ${raw("claimed_total_raw")},
      unclaimed_raw numeric(78, 0) generated always as (settled_total_raw - claimed_total_raw) stored,
      updated_at timestamptz not null default clock_timestamp(),
      constraint mining_reward_balances_claimed_check check (claimed_total_raw <= settled_total_raw)
    );

    comment on table public.mining_parameter_versions is
      'Decision 0116: reviewer-approved hourly settlement parameters; approved rows are immutable.';
    comment on table public.mining_epochs is
      'Decision 0116: one UTC hour [hour_start, hour_end); settled exactly once, then immutable.';
    comment on table public.mining_epoch_rewards is
      'Decision 0116: per user and hour, both tracks (self / five-level referral / total power, rewards).';
    comment on table public.mining_reward_ledger_events is
      'Decision 0116: append-only settled / claimed events; the only writer of mining_reward_balances.';
    comment on table public.mining_reward_balances is
      'Decision 0116: projection of the ledger events: settled, claimed (confirmed on chain), unclaimed.';
    comment on table public.mining_claims is
      'Decision 0116: EIP-712 claim vouchers (device signs and sends) and their on-chain outcome.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.mining_epochs)
        or exists (select 1 from public.mining_claims)
        or exists (select 1 from public.mining_parameter_versions where status = 'approved')
      then raise exception 'refusing to remove mining settlement evidence'; end if;
    end $$;
    drop table public.mining_reward_balances;
    drop trigger mining_reward_ledger_events_append_only on public.mining_reward_ledger_events;
    drop function public.reject_mining_ledger_event_mutation();
    drop table public.mining_reward_ledger_events;
    drop table public.mining_claims;
    drop table public.mining_epoch_rewards;
    drop trigger mining_epochs_settled_immutable on public.mining_epochs;
    drop function public.reject_settled_mining_epoch_mutation();
    drop table public.mining_epochs;
    drop trigger mining_parameter_versions_immutable on public.mining_parameter_versions;
    drop function public.reject_approved_mining_parameter_mutation();
    drop table public.mining_parameter_versions;
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list(digestVersionsBefore)}));
  `);
}
