import type { MigrationBuilder } from "node-pg-migrate";

/**
 * `POST /v2/message-requests` (Decision 0031 revision, 2026-09-08) writes one
 * `social_graph_events` row per accepted send, so the audit event vocabulary
 * gains `message_request_sent`. The V1 `friend_requests` storage, its state
 * machine, and every V1 route stay exactly as they are.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.social_graph_events
      drop constraint social_graph_events_type_check;
    alter table public.social_graph_events
      add constraint social_graph_events_type_check
      check (event_type in (
        'followed',
        'unfollowed',
        'blocked',
        'unblocked',
        'message_request_sent',
        'message_request_accepted',
        'message_request_ignored',
        'message_request_reported'
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table public.social_graph_events in access exclusive mode;

    do $guard$
    begin
      if exists (
        select 1 from public.social_graph_events
        where event_type = 'message_request_sent'
      )
      then
        raise exception
          'refusing rollback while V2 message request sends are recorded'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    alter table public.social_graph_events
      drop constraint social_graph_events_type_check;
    alter table public.social_graph_events
      add constraint social_graph_events_type_check
      check (event_type in (
        'followed',
        'unfollowed',
        'blocked',
        'unblocked',
        'message_request_accepted',
        'message_request_ignored',
        'message_request_reported'
      ));
  `);
}
