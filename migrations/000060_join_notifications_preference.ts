import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0115 (S135): the join-time notification preference.
 *
 * - `community_memberships.notifications` records what the joiner asked for
 *   (`default` or `muted`). Existing rows and every join that sends no
 *   preference read `default`.
 * - `community_memberships.notifications_applied_at` is set by the
 *   `community-channel-sync` lane once Stream confirmed the server-side
 *   channel mute that followed the member add. It is only ever set for a
 *   `muted` row, so a later re-add (a role change) never mutes a member who
 *   unmuted themselves in the app. A leave deletes the row, so a re-join
 *   starts over.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.community_memberships
      add column notifications text not null default 'default',
      add column notifications_applied_at timestamptz null,
      add constraint community_memberships_notifications_check
        check (notifications in ('default', 'muted')),
      add constraint community_memberships_notifications_applied_check
        check (notifications_applied_at is null or notifications = 'muted');

    comment on column public.community_memberships.notifications is
      'Decision 0115: the notification preference sent with POST /v2/communities/{id}/join (default | muted).';
    comment on column public.community_memberships.notifications_applied_at is
      'Decision 0115: when the channel sync lane confirmed the server-side Stream channel mute; null until then and for default rows.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.community_memberships
      drop constraint community_memberships_notifications_applied_check,
      drop constraint community_memberships_notifications_check,
      drop column notifications_applied_at,
      drop column notifications;
  `);
}
