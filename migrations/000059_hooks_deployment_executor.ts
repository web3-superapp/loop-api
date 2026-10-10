import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0112 (S132): the Hooks deployment executor.
 *
 * - `hooks_launch_deployment_tasks` gains the executor state machine
 *   `awaiting_executor → claimed → broadcast → confirmed → verified →
 *   activated`, with `failed` (retryable flag + attempt count) and `reorged`
 *   (back to `claimed`, the same signed transaction is re-sent). The guard
 *   trigger now allows exactly these transitions, keeps the S125 columns
 *   immutable, and lets a transaction hash change only on
 *   `claimed → broadcast` (the hash is persisted before the transaction is
 *   sent). Every in-flight state carries a lease (`claimed_by`,
 *   `lease_expires_at`).
 * - `hooks_launch_deployment_events`: append-only, one row per status change
 *   or executor step (tx hash, block, confirmations, error code, safe
 *   details). It doubles as the executor audit trail.
 * - `hooks_launch_executor_nonces`: executor-account nonce reservations; at
 *   most one `pending` reservation per (chain, executor, nonce). A
 *   reservation only moves `pending → released`.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_deployment_tasks
      drop constraint hooks_launch_deployment_tasks_status_check,
      add constraint hooks_launch_deployment_tasks_status_check check (status in (
        'awaiting_executor','claimed','broadcast','confirmed','verified',
        'activated','failed','reorged','cancelled')),
      add column claimed_by text check (claimed_by ~ '^[A-Za-z0-9._:-]{1,128}$'),
      add column claimed_at timestamptz,
      add column lease_expires_at timestamptz,
      add column attempt_count integer not null default 0 check (attempt_count >= 0),
      add column executor_address text check (executor_address ~ '^0x[0-9a-f]{40}$'),
      add column tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
      add column tx_nonce bigint check (tx_nonce >= 0),
      add column raw_tx text check (raw_tx ~ '^0x[0-9a-f]+$' and length(raw_tx) <= 131072),
      add column block_number bigint check (block_number >= 0),
      add column block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
      add column confirmations integer check (confirmations >= 0),
      add column launch_id text check (launch_id ~ '^0x[0-9a-f]{64}$'),
      add column deployed_addresses jsonb check (jsonb_typeof(deployed_addresses) = 'object'),
      add column verification jsonb check (jsonb_typeof(verification) = 'object'),
      add column activation_tx_hash text check (activation_tx_hash ~ '^0x[0-9a-f]{64}$'),
      add column activation_tx_nonce bigint check (activation_tx_nonce >= 0),
      add column activation_raw_tx text check (activation_raw_tx ~ '^0x[0-9a-f]+$' and length(activation_raw_tx) <= 131072),
      add column activation_block_number bigint check (activation_block_number >= 0),
      add column activation_block_hash text check (activation_block_hash ~ '^0x[0-9a-f]{64}$'),
      add column activation_attempt_count integer not null default 0 check (activation_attempt_count >= 0),
      add column activated_at timestamptz,
      add column failure_code text check (failure_code ~ '^[A-Z0-9_]{1,64}$'),
      add column failure_retryable boolean,
      add column updated_at timestamptz not null default clock_timestamp(),
      add constraint hooks_deployment_lease_shape check (
        status not in ('claimed','broadcast','confirmed','verified')
        or (claimed_by is not null and claimed_at is not null and lease_expires_at is not null)),
      add constraint hooks_deployment_tx_shape check (
        status not in ('broadcast','confirmed','verified','activated')
        or (tx_hash is not null and raw_tx is not null and tx_nonce is not null and executor_address is not null)),
      add constraint hooks_deployment_block_shape check (
        status not in ('confirmed','verified','activated')
        or (block_number is not null and block_hash is not null and confirmations is not null)),
      add constraint hooks_deployment_verified_shape check (
        status not in ('verified','activated')
        or (launch_id is not null and deployed_addresses is not null and verification is not null)),
      add constraint hooks_deployment_activation_shape check (
        (activation_tx_hash is null) = (activation_raw_tx is null)
        and (activation_tx_hash is null) = (activation_tx_nonce is null)
        and (status <> 'activated' or (activation_tx_hash is not null
          and activation_block_hash is not null and activated_at is not null))),
      add constraint hooks_deployment_failure_shape check (
        (status = 'failed') = (failure_code is not null)
        and (failure_code is null) = (failure_retryable is null));

    drop index public.hooks_deployment_active_version;
    drop index public.hooks_deployment_active_nonce;
    create unique index hooks_deployment_active_version
      on public.hooks_launch_deployment_tasks(project_id, config_version)
      where status in ('awaiting_executor','claimed','broadcast','confirmed','verified','reorged','activated')
        or (status = 'failed' and failure_retryable);
    create unique index hooks_deployment_active_nonce
      on public.hooks_launch_deployment_tasks(chain_id, factory_address, project_owner, owner_nonce)
      where status in ('awaiting_executor','claimed','broadcast','confirmed','verified','reorged','activated')
        or (status = 'failed' and failure_retryable);
    create unique index hooks_deployment_tx_hash
      on public.hooks_launch_deployment_tasks(tx_hash) where tx_hash is not null;
    create index hooks_deployment_executor_queue
      on public.hooks_launch_deployment_tasks(status, lease_expires_at, created_at)
      where status in ('awaiting_executor','claimed','broadcast','confirmed','verified','reorged','failed');

    create or replace function public.guard_hooks_deployment_task() returns trigger language plpgsql as $$
    declare
      mutable text[] := array['status','claimed_by','claimed_at','lease_expires_at',
        'attempt_count','executor_address','tx_hash','tx_nonce','raw_tx','block_number',
        'block_hash','confirmations','launch_id','deployed_addresses','verification',
        'activation_tx_hash','activation_tx_nonce','activation_raw_tx',
        'activation_block_number','activation_block_hash','activation_attempt_count',
        'activated_at','failure_code','failure_retryable','updated_at'];
      transition text;
    begin
      if TG_OP = 'DELETE' then
        raise exception 'deployment tasks retain audit history';
      end if;
      if (to_jsonb(NEW) - mutable) is distinct from (to_jsonb(OLD) - mutable) then
        raise exception 'invalid deployment task mutation';
      end if;
      transition := OLD.status || '>' || NEW.status;
      if OLD.status = NEW.status then
        if OLD.status not in ('claimed','broadcast','confirmed','verified') then
          raise exception 'invalid deployment task mutation';
        end if;
      elsif transition not in (
        'awaiting_executor>claimed','awaiting_executor>cancelled',
        'claimed>broadcast','claimed>failed',
        'broadcast>confirmed','broadcast>reorged','broadcast>failed',
        'confirmed>verified','confirmed>reorged','confirmed>failed',
        'verified>activated','verified>reorged','verified>failed',
        'reorged>claimed','failed>claimed') then
        raise exception 'invalid deployment task mutation: transition % not allowed', transition;
      end if;
      if transition = 'failed>claimed' and OLD.failure_retryable is not true then
        raise exception 'deployment task failure is not retryable';
      end if;
      if NEW.tx_hash is distinct from OLD.tx_hash
        and transition <> 'claimed>broadcast' then
        raise exception 'deployment transaction hash changes only when broadcast';
      end if;
      if NEW.activation_tx_hash is distinct from OLD.activation_tx_hash
        and not (transition = 'verified>verified'
          or (transition = 'reorged>claimed' and NEW.activation_tx_hash is null)) then
        raise exception 'activation transaction hash changes only while verified (or is cleared after a reorg)';
      end if;
      if NEW.attempt_count < OLD.attempt_count
        or NEW.activation_attempt_count < OLD.activation_attempt_count then
        raise exception 'deployment attempt counters only grow';
      end if;
      NEW.updated_at := clock_timestamp();
      return NEW;
    end;
    $$;

    create table public.hooks_launch_deployment_events (
      event_id bigint generated always as identity primary key,
      job_id uuid not null references public.hooks_launch_deployment_tasks(job_id),
      from_status text check (from_status ~ '^[a-z_]{1,32}$'),
      to_status text not null check (to_status ~ '^[a-z_]{1,32}$'),
      kind text not null check (kind ~ '^[a-z_]{1,40}$'),
      tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
      block_number bigint check (block_number >= 0),
      block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
      confirmations integer check (confirmations >= 0),
      error_code text check (error_code ~ '^[A-Z0-9_]{1,64}$'),
      details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
      actor text check (actor ~ '^[A-Za-z0-9._:-]{1,128}$'),
      created_at timestamptz not null default clock_timestamp()
    );
    create index hooks_deployment_events_job on public.hooks_launch_deployment_events(job_id, event_id);
    create trigger hooks_deployment_event_immutable before update or delete
      on public.hooks_launch_deployment_events
      for each row execute function public.reject_hooks_review_mutation();

    create table public.hooks_launch_executor_nonces (
      reservation_id bigint generated always as identity primary key,
      chain_id integer not null check (chain_id = 97),
      executor_address text not null check (executor_address ~ '^0x[0-9a-f]{40}$'),
      nonce bigint not null check (nonce >= 0),
      job_id uuid not null references public.hooks_launch_deployment_tasks(job_id),
      purpose text not null check (purpose in ('deploy','activate')),
      tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
      state text not null default 'pending' check (state in ('pending','released')),
      created_at timestamptz not null default clock_timestamp(),
      released_at timestamptz,
      check ((state = 'released') = (released_at is not null))
    );
    create unique index hooks_executor_nonce_pending
      on public.hooks_launch_executor_nonces(chain_id, executor_address, nonce)
      where state = 'pending';
    create function public.guard_hooks_executor_nonce() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'DELETE' then
        raise exception 'executor nonce reservations retain audit history';
      end if;
      if (to_jsonb(NEW) - array['state','released_at']) is distinct from (to_jsonb(OLD) - array['state','released_at'])
        or OLD.state <> 'pending' or NEW.state <> 'released' then
        raise exception 'invalid executor nonce reservation mutation';
      end if;
      return NEW;
    end;
    $$;
    create trigger hooks_executor_nonce_guard before update or delete
      on public.hooks_launch_executor_nonces
      for each row execute function public.guard_hooks_executor_nonce();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from public.hooks_launch_deployment_events)
        or exists(select 1 from public.hooks_launch_executor_nonces)
        or exists(select 1 from public.hooks_launch_deployment_tasks
          where status not in ('awaiting_executor','cancelled')) then
        raise exception 'refusing to remove Hooks executor evidence';
      end if;
    end $$;
    drop table public.hooks_launch_executor_nonces;
    drop function public.guard_hooks_executor_nonce();
    drop table public.hooks_launch_deployment_events;
    drop index public.hooks_deployment_executor_queue;
    drop index public.hooks_deployment_tx_hash;
    drop index public.hooks_deployment_active_version;
    drop index public.hooks_deployment_active_nonce;
    create unique index hooks_deployment_active_version on public.hooks_launch_deployment_tasks(project_id,config_version) where status='awaiting_executor';
    create unique index hooks_deployment_active_nonce on public.hooks_launch_deployment_tasks(chain_id,factory_address,project_owner,owner_nonce) where status='awaiting_executor';
    alter table public.hooks_launch_deployment_tasks
      drop constraint hooks_deployment_lease_shape,
      drop constraint hooks_deployment_tx_shape,
      drop constraint hooks_deployment_block_shape,
      drop constraint hooks_deployment_verified_shape,
      drop constraint hooks_deployment_activation_shape,
      drop constraint hooks_deployment_failure_shape,
      drop column claimed_by, drop column claimed_at, drop column lease_expires_at,
      drop column attempt_count, drop column executor_address, drop column tx_hash,
      drop column tx_nonce, drop column raw_tx, drop column block_number,
      drop column block_hash, drop column confirmations, drop column launch_id,
      drop column deployed_addresses, drop column verification,
      drop column activation_tx_hash, drop column activation_tx_nonce,
      drop column activation_raw_tx, drop column activation_block_number,
      drop column activation_block_hash, drop column activation_attempt_count,
      drop column activated_at, drop column failure_code,
      drop column failure_retryable, drop column updated_at,
      drop constraint hooks_launch_deployment_tasks_status_check,
      add constraint hooks_launch_deployment_tasks_status_check check (status in ('awaiting_executor','cancelled'));
    create or replace function public.guard_hooks_deployment_task() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then raise exception 'deployment tasks retain audit history'; end if;
      if (to_jsonb(NEW)-'status') is distinct from (to_jsonb(OLD)-'status')
        or OLD.status != 'awaiting_executor' or NEW.status != 'cancelled' then
        raise exception 'invalid deployment task mutation';
      end if;
      return NEW;
    end;
    $$;
  `);
}
