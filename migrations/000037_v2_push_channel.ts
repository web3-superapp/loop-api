import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0067: the push channel.
 *
 * - `device_push_tokens` binds one FCM registration token to one device
 *   session. The token is the only value here that could address a user's
 *   handset, so it is never projected by an API response and never logged;
 *   `token_sha256` is the reference every log line and audit row uses. At
 *   most one active row per session and at most one active row per token
 *   exist, which is what makes re-registration and device hand-over
 *   deterministic instead of producing duplicate sends.
 * - `device_push_token_commands` is the durable idempotency record of the
 *   register and unregister writes, mirroring `device_session_commands`: a
 *   replayed `Idempotency-Key` returns the first outcome, and the same key
 *   with a different request digest is a conflict.
 * - `push_deliveries` is the append-only attempt log. `(push_token_id,
 *   event_key)` is unique, so one event reaches one device exactly once, and
 *   the row doubles as the hourly per-device budget counter. It stores the
 *   event type and an opaque event key only: no payload, no message text, no
 *   address and no amount.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.device_push_tokens (
      push_token_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      session_id uuid not null
        references public.device_sessions(session_id) on delete restrict,
      device_id uuid not null,
      platform text not null,
      provider text not null default 'fcm',
      token text not null,
      token_sha256 text not null,
      app_version text not null,
      status text not null default 'active',
      revoke_reason text,
      registered_at timestamptz not null default clock_timestamp(),
      last_observed_at timestamptz not null default clock_timestamp(),
      last_delivery_at timestamptz,
      revoked_at timestamptz,
      constraint device_push_tokens_platform_check
        check (platform in ('android', 'ios')),
      constraint device_push_tokens_provider_check
        check (provider = 'fcm'),
      constraint device_push_tokens_token_check
        check (char_length(token) between 32 and 4096),
      constraint device_push_tokens_token_sha256_check
        check (token_sha256 ~ '^[0-9a-f]{64}$'),
      constraint device_push_tokens_app_version_check
        check (char_length(app_version) between 5 and 64),
      constraint device_push_tokens_status_check
        check (status in ('active', 'revoked')),
      constraint device_push_tokens_revoke_reason_check
        check (revoke_reason is null or revoke_reason in (
          'client_unregister',
          'session_revoked',
          'provider_unregistered',
          'replaced_by_session'
        )),
      constraint device_push_tokens_state_check
        check (
          (status = 'active' and revoked_at is null and revoke_reason is null)
          or (status = 'revoked' and revoked_at is not null and revoke_reason is not null)
        ),
      constraint device_push_tokens_timestamp_check
        check (
          last_observed_at >= registered_at
          and (revoked_at is null or revoked_at >= registered_at)
        )
    );

    create unique index device_push_tokens_active_session_key
      on public.device_push_tokens (session_id)
      where status = 'active';
    create unique index device_push_tokens_active_token_key
      on public.device_push_tokens (token_sha256)
      where status = 'active';
    create index device_push_tokens_active_owner_idx
      on public.device_push_tokens (owner_user_id)
      where status = 'active';

    comment on table public.device_push_tokens is
      'FCM registration tokens bound to a device session. One active row per session and per token; revoking or logging out of the session retires the row. The token column is never projected by an API response and never logged: token_sha256 is the safe reference.';

    create table public.device_push_token_commands (
      command_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      session_id uuid not null,
      command_kind text not null,
      idempotency_key uuid not null,
      request_digest_version text not null,
      request_sha256 text not null,
      request_id uuid not null,
      result_status text not null,
      result_push_token_id uuid
        references public.device_push_tokens(push_token_id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      constraint device_push_token_commands_key_unique
        unique (command_kind, idempotency_key),
      constraint device_push_token_commands_kind_check
        check (command_kind in ('push_token_register', 'push_token_unregister')),
      constraint device_push_token_commands_digest_version_check
        check (
          (command_kind = 'push_token_register'
            and request_digest_version = 'device_push_token_register_v1')
          or (command_kind = 'push_token_unregister'
            and request_digest_version = 'device_push_token_unregister_v1')
        ),
      constraint device_push_token_commands_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint device_push_token_commands_result_check
        check (result_status in ('registered', 'unregistered', 'not_registered')),
      constraint device_push_token_commands_result_token_check
        check (
          (result_status = 'registered' and result_push_token_id is not null)
          or (result_status <> 'registered')
        )
    );

    comment on table public.device_push_token_commands is
      'Durable owner-bound UUID-idempotent push-token register and unregister outcomes. Holds the request digest only, never the registration token itself.';

    create table public.push_deliveries (
      delivery_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      push_token_id uuid not null
        references public.device_push_tokens(push_token_id) on delete restrict,
      event_type text not null,
      event_key text not null,
      mandatory boolean not null,
      status text not null default 'pending',
      reason_code text,
      provider_message_ref text,
      created_at timestamptz not null default clock_timestamp(),
      completed_at timestamptz,
      constraint push_deliveries_event_unique
        unique (push_token_id, event_key),
      constraint push_deliveries_event_type_check
        check (event_type in (
          'price_alert_triggered',
          'security_event',
          'community_voice_room_started'
        )),
      constraint push_deliveries_event_key_check
        check (char_length(event_key) between 1 and 200),
      constraint push_deliveries_status_check
        check (status in ('pending', 'sent', 'invalid_token', 'failed')),
      constraint push_deliveries_reason_code_check
        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      constraint push_deliveries_provider_ref_check
        check (
          provider_message_ref is null
          or char_length(provider_message_ref) between 1 and 200
        ),
      constraint push_deliveries_completed_check
        check (
          (status = 'pending' and completed_at is null)
          or (status <> 'pending' and completed_at is not null)
        )
    );

    create index push_deliveries_budget_idx
      on public.push_deliveries (push_token_id, mandatory, created_at desc);

    comment on table public.push_deliveries is
      'Append-only push attempt log. One row per (device token, event key) enforces at-most-once delivery and is the hourly per-device budget counter. No payload, message text, address or amount is stored.';

    create or replace function public.guard_push_delivery_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'push_deliveries are append-only';
      end if;
      if new.delivery_id is distinct from old.delivery_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.push_token_id is distinct from old.push_token_id
        or new.event_type is distinct from old.event_type
        or new.event_key is distinct from old.event_key
        or new.mandatory is distinct from old.mandatory
        or new.created_at is distinct from old.created_at
      then
        raise exception 'push_deliveries identity is immutable';
      end if;
      if old.status <> 'pending' then
        raise exception 'a resolved push delivery is immutable';
      end if;
      return new;
    end
    $$;

    create trigger push_deliveries_guard
      before update or delete on public.push_deliveries
      for each row execute function public.guard_push_delivery_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.push_deliveries)
        or exists (select 1 from public.device_push_tokens)
      then
        raise exception
          'refusing destructive rollback of push channel data';
      end if;
    end
    $$;

    drop trigger push_deliveries_guard on public.push_deliveries;
    drop function public.guard_push_delivery_mutation();
    drop table public.push_deliveries;
    drop table public.device_push_token_commands;
    drop table public.device_push_tokens;
  `);
}
