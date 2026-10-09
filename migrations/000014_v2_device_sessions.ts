import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.device_sessions (
      session_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      bootstrap_idempotency_key uuid not null unique,
      bootstrap_digest_version text not null default 'device_session_bootstrap_v1',
      bootstrap_request_sha256 text not null,
      device_id uuid not null,
      client_platform text not null,
      client_version text not null,
      contract_version text not null default '2.0',
      auth_strength text not null default 'provider_authenticated',
      policy_version text not null default 'session_policy_v1',
      status text not null default 'active',
      created_at timestamptz not null default clock_timestamp(),
      last_seen_at timestamptz not null default clock_timestamp(),
      revoked_at timestamptz,
      constraint device_sessions_id_owner_unique
        unique (session_id, owner_user_id),
      constraint device_sessions_request_sha256_check
        check (bootstrap_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint device_sessions_bootstrap_digest_version_check
        check (bootstrap_digest_version = 'device_session_bootstrap_v1'),
      constraint device_sessions_client_platform_check
        check (client_platform in ('android', 'ios')),
      constraint device_sessions_client_version_check
        check (
          char_length(client_version) between 5 and 64
          and client_version ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'
          and client_version !~ '[^0-9A-Za-z.+-]'
        ),
      constraint device_sessions_auth_strength_check
        check (auth_strength = 'provider_authenticated'),
      constraint device_sessions_contract_version_check
        check (contract_version = '2.0'),
      constraint device_sessions_policy_version_check
        check (policy_version = 'session_policy_v1'),
      constraint device_sessions_status_check
        check (status in ('active', 'revoked')),
      constraint device_sessions_revocation_state_check
        check (
          (status = 'active' and revoked_at is null)
          or (status = 'revoked' and revoked_at is not null)
        ),
      constraint device_sessions_time_order_check
        check (
          last_seen_at >= created_at
          and (revoked_at is null or revoked_at >= created_at)
        )
    );

    comment on table public.device_sessions is
      'Non-authoritative LOOP device/session audit projections. A current Privy access token remains mandatory for every protected request.';

    create index device_sessions_owner_status_created_idx
      on public.device_sessions (owner_user_id, status, created_at desc, session_id);
    create index device_sessions_owner_device_idx
      on public.device_sessions (owner_user_id, device_id, created_at desc);

    create function public.guard_device_session_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.session_id is distinct from old.session_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.bootstrap_idempotency_key is distinct from old.bootstrap_idempotency_key
        or new.bootstrap_digest_version is distinct from old.bootstrap_digest_version
        or new.bootstrap_request_sha256 is distinct from old.bootstrap_request_sha256
        or new.device_id is distinct from old.device_id
        or new.client_platform is distinct from old.client_platform
        or new.client_version is distinct from old.client_version
        or new.contract_version is distinct from old.contract_version
        or new.auth_strength is distinct from old.auth_strength
        or new.policy_version is distinct from old.policy_version
        or new.created_at is distinct from old.created_at
        or new.last_seen_at < old.last_seen_at
        or (
          old.status = 'active'
          and not (
            (new.status = 'active' and new.revoked_at is null)
            or (new.status = 'revoked' and new.revoked_at is not null)
          )
        )
        or (
          old.status = 'revoked'
          and (
            new.status is distinct from old.status
            or new.revoked_at is distinct from old.revoked_at
          )
        )
      then
        raise exception 'immutable device-session fields cannot be changed'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger device_sessions_guard_mutation
      before update on public.device_sessions
      for each row execute function public.guard_device_session_mutation();

    create table public.device_session_commands (
      command_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      requested_session_id uuid not null,
      resolved_session_id uuid,
      command_kind text not null,
      idempotency_key uuid not null,
      request_digest_version text not null default 'device_session_logout_v1',
      request_sha256 text not null,
      request_id uuid not null,
      result_status text not null,
      result_revoked_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      last_seen_at timestamptz not null default clock_timestamp(),
      constraint device_session_commands_resolved_session_owner_fk
        foreign key (resolved_session_id, owner_user_id)
        references public.device_sessions(session_id, owner_user_id)
        on delete restrict,
      constraint device_session_commands_kind_key_unique
        unique (command_kind, idempotency_key),
      constraint device_session_commands_kind_check
        check (command_kind = 'logout'),
      constraint device_session_commands_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint device_session_commands_digest_version_check
        check (request_digest_version = 'device_session_logout_v1'),
      constraint device_session_commands_result_status_check
        check (result_status in ('not_found', 'revoked')),
      constraint device_session_commands_result_check
        check (
          (
            result_status = 'not_found'
            and resolved_session_id is null
            and result_revoked_at is null
          )
          or (
            result_status = 'revoked'
            and resolved_session_id is not null
            and resolved_session_id = requested_session_id
            and result_revoked_at is not null
          )
        ),
      constraint device_session_commands_time_order_check
        check (last_seen_at >= created_at)
    );

    comment on table public.device_session_commands is
      'Durable owner-bound UUID-idempotent logout outcomes, including non-enumerating not-found results, without provider tokens or device secrets.';

    create index device_session_commands_owner_created_idx
      on public.device_session_commands (owner_user_id, created_at desc, command_id);
    create index device_session_commands_resolved_owner_idx
      on public.device_session_commands (resolved_session_id, owner_user_id)
      where resolved_session_id is not null;

    create function public.guard_device_session_command_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'device_session_commands are permanent'
          using errcode = '55000';
      end if;

      if new.command_id is distinct from old.command_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.requested_session_id is distinct from old.requested_session_id
        or new.resolved_session_id is distinct from old.resolved_session_id
        or new.command_kind is distinct from old.command_kind
        or new.idempotency_key is distinct from old.idempotency_key
        or new.request_digest_version is distinct from old.request_digest_version
        or new.request_sha256 is distinct from old.request_sha256
        or new.request_id is distinct from old.request_id
        or new.result_status is distinct from old.result_status
        or new.result_revoked_at is distinct from old.result_revoked_at
        or new.created_at is distinct from old.created_at
        or new.last_seen_at < old.last_seen_at
      then
        raise exception 'immutable device-session command fields cannot be changed'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger device_session_commands_guard_mutation
      before update or delete on public.device_session_commands
      for each row execute function public.guard_device_session_command_mutation();

    create table public.device_session_events (
      event_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null,
      session_id uuid not null,
      event_version smallint not null,
      event_type text not null,
      request_id uuid not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint device_session_events_session_owner_fk
        foreign key (session_id, owner_user_id)
        references public.device_sessions(session_id, owner_user_id)
        on delete restrict,
      constraint device_session_events_version_unique
        unique (session_id, event_version),
      constraint device_session_events_version_check
        check (event_version in (0, 1)),
      constraint device_session_events_type_check
        check (event_type in ('session_created', 'session_revoked')),
      constraint device_session_events_type_version_check
        check (
          (event_version = 0 and event_type = 'session_created')
          or (event_version = 1 and event_type = 'session_revoked')
        )
    );

    comment on table public.device_session_events is
      'Append-only session creation and revocation audit events.';

    create function public.reject_device_session_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'device_session_events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger device_session_events_immutable
      before update or delete on public.device_session_events
      for each row execute function public.reject_device_session_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.device_session_commands,
      public.device_sessions,
      public.device_session_events
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.device_session_events)
        or exists (select 1 from public.device_session_commands)
        or exists (select 1 from public.device_sessions)
      then
        raise exception 'refusing destructive rollback of v2 device sessions'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger device_session_events_immutable
      on public.device_session_events;
    drop function public.reject_device_session_event_mutation();
    drop trigger device_session_commands_guard_mutation
      on public.device_session_commands;
    drop function public.guard_device_session_command_mutation();
    drop trigger device_sessions_guard_mutation
      on public.device_sessions;
    drop function public.guard_device_session_mutation();
    drop table public.device_session_events;
    drop table public.device_session_commands;
    drop table public.device_sessions;
  `);
}
