import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0037: D20 security, settings, and support.
 *
 * - `device_session_commands` gains the `revoke` command kind so a remote
 *   revocation of another session is durable and idempotent under its own
 *   digest version, next to the existing `logout` command.
 * - `account_settings` is the compare-and-swap account-level settings slot.
 *   Every value is fixed in this step (`USD`, `zh-CN`) and enforced by check
 *   constraints; the row exists so a later mutable setting inherits the CAS
 *   version instead of inventing a second one.
 * - `support_tickets` and the append-only `support_ticket_events` hold user
 *   tickets. Status only moves through the Dev operator script; the API can
 *   create and list. No attachment column exists: attachments are unavailable.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.device_session_commands
      drop constraint device_session_commands_kind_check;
    alter table public.device_session_commands
      add constraint device_session_commands_kind_check
      check (command_kind in ('logout', 'revoke'));
    alter table public.device_session_commands
      drop constraint device_session_commands_digest_version_check;
    alter table public.device_session_commands
      add constraint device_session_commands_digest_version_check
      check (
        (command_kind = 'logout' and request_digest_version = 'device_session_logout_v1')
        or (command_kind = 'revoke' and request_digest_version = 'device_session_revoke_v1')
      );

    comment on table public.device_session_commands is
      'Durable owner-bound UUID-idempotent logout and remote-revoke outcomes, including non-enumerating not-found results, without provider tokens or device secrets.';

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1',
        'community_command_v1',
        'social_graph_command_v1',
        'communication_command_v1',
        'price_alert_create_v2',
        'launch_command_v1',
        'referral_command_v1',
        'support_ticket_create_v1'
      ));

    create table public.account_settings (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      display_currency text not null default 'USD',
      language text not null default 'zh-CN',
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint account_settings_display_currency_check
        check (display_currency = 'USD'),
      constraint account_settings_language_check
        check (language = 'zh-CN'),
      constraint account_settings_record_version_check
        check (record_version > 0),
      constraint account_settings_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.account_settings is
      'Account-level V2 settings behind an expectedVersion compare-and-swap. displayCurrency and language are fixed product constants in this step; reduceMotion and theme stay on the device.';

    create table public.support_tickets (
      ticket_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      category text not null,
      body text not null,
      status text not null default 'open',
      create_idempotency_record_id uuid not null
        references public.idempotency_records(id) on delete restrict,
      create_request_sha256 text not null,
      contract_version text not null default '2.0',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      last_event_at timestamptz not null default clock_timestamp(),
      constraint support_tickets_owner_unique
        unique (ticket_id, owner_user_id),
      constraint support_tickets_create_record_unique
        unique (create_idempotency_record_id),
      constraint support_tickets_category_check
        check (category in (
          'account', 'security', 'wallet', 'trade', 'launch', 'mining',
          'community', 'other'
        )),
      constraint support_tickets_body_check
        check (
          char_length(body) between 1 and 2000
          and body = btrim(body)
          and public.loop_alias_text_is_safe(body)
        ),
      constraint support_tickets_status_check
        check (status in ('open', 'answered', 'closed')),
      constraint support_tickets_create_sha256_check
        check (create_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint support_tickets_contract_version_check
        check (contract_version = '2.0'),
      constraint support_tickets_timestamp_check
        check (updated_at >= created_at and last_event_at >= created_at)
    );

    comment on table public.support_tickets is
      'User support tickets. The API creates and lists them; status advances only through the operator script (scripts/support-answer.ts) which appends a support_ticket_events row. No attachment is stored.';

    create index support_tickets_owner_created_idx
      on public.support_tickets (owner_user_id, created_at desc, ticket_id desc);

    create function public.guard_support_ticket_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'support_tickets are permanent'
          using errcode = '55000';
      end if;
      if new.ticket_id is distinct from old.ticket_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.category is distinct from old.category
        or new.body is distinct from old.body
        or new.create_idempotency_record_id is distinct from old.create_idempotency_record_id
        or new.create_request_sha256 is distinct from old.create_request_sha256
        or new.contract_version is distinct from old.contract_version
        or new.created_at is distinct from old.created_at
        or new.updated_at < old.updated_at
        or new.last_event_at < old.last_event_at
        or (old.status = 'closed' and new.status is distinct from 'closed')
        or (old.status = 'answered' and new.status = 'open')
      then
        raise exception 'immutable support ticket fields cannot be changed'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger support_tickets_guard_mutation
      before update or delete on public.support_tickets
      for each row execute function public.guard_support_ticket_mutation();

    create table public.support_ticket_events (
      event_id uuid primary key default gen_random_uuid(),
      ticket_id uuid not null,
      owner_user_id uuid not null,
      event_version integer not null,
      event_type text not null,
      actor text not null,
      note text,
      request_id uuid not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint support_ticket_events_ticket_owner_fk
        foreign key (ticket_id, owner_user_id)
        references public.support_tickets(ticket_id, owner_user_id)
        on delete restrict,
      constraint support_ticket_events_version_unique
        unique (ticket_id, event_version),
      constraint support_ticket_events_version_check
        check (event_version >= 0),
      constraint support_ticket_events_type_check
        check (event_type in ('created', 'answered', 'closed')),
      constraint support_ticket_events_actor_check
        check (actor in ('user', 'operator')),
      constraint support_ticket_events_type_actor_check
        check (
          (event_type = 'created' and actor = 'user' and event_version = 0)
          or (event_type in ('answered', 'closed') and actor = 'operator' and event_version > 0)
        ),
      constraint support_ticket_events_note_check
        check (
          note is null
          or (
            char_length(note) between 1 and 2000
            and note = btrim(note)
            and public.loop_alias_text_is_safe(note)
          )
        )
    );

    comment on table public.support_ticket_events is
      'Append-only support ticket lifecycle. Version 0 is the user creation; later versions are operator answers/closures written by the Dev script with an optional sanitized note.';

    create function public.reject_support_ticket_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'support_ticket_events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger support_ticket_events_immutable
      before update or delete on public.support_ticket_events
      for each row execute function public.reject_support_ticket_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.account_settings,
      public.support_tickets,
      public.support_ticket_events,
      public.device_session_commands
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.support_ticket_events)
        or exists (select 1 from public.support_tickets)
        or exists (select 1 from public.account_settings)
        or exists (
          select 1 from public.device_session_commands
          where command_kind = 'revoke'
        )
        or exists (
          select 1 from public.idempotency_records
          where digest_version = 'support_ticket_create_v1'
        )
      then
        raise exception 'refusing destructive rollback of v2 security, settings, and support data'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger support_ticket_events_immutable
      on public.support_ticket_events;
    drop function public.reject_support_ticket_event_mutation();
    drop table public.support_ticket_events;
    drop trigger support_tickets_guard_mutation on public.support_tickets;
    drop function public.guard_support_ticket_mutation();
    drop table public.support_tickets;
    drop table public.account_settings;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1',
        'community_command_v1',
        'social_graph_command_v1',
        'communication_command_v1',
        'price_alert_create_v2',
        'launch_command_v1',
        'referral_command_v1'
      ));

    alter table public.device_session_commands
      drop constraint device_session_commands_digest_version_check;
    alter table public.device_session_commands
      add constraint device_session_commands_digest_version_check
      check (request_digest_version = 'device_session_logout_v1');
    alter table public.device_session_commands
      drop constraint device_session_commands_kind_check;
    alter table public.device_session_commands
      add constraint device_session_commands_kind_check
      check (command_kind = 'logout');

    comment on table public.device_session_commands is
      'Durable owner-bound UUID-idempotent logout outcomes, including non-enumerating not-found results, without provider tokens or device secrets.';
  `);
}
