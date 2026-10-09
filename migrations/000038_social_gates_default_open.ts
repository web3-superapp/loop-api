import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0070: the social gates default to open.
 *
 * Migration 000013 created `social_privacy_preferences` with every gate
 * defaulting to `disabled` and documented a missing row as "every social
 * capability is disabled". Rows are only ever written by an explicit privacy
 * replacement, so every account that never touched the retired social-privacy
 * page (all but one Development account) could neither receive a message
 * request nor open a direct channel: the whole private-chat path was
 * unreachable by construction, not by choice.
 *
 * The 2026-09-23 ruling flips the default: a missing row now means friend
 * requests `enabled`, group invites `friends`, and direct messages `friends`.
 * The column defaults move so a row created without explicit values carries
 * the same meaning as no row at all. Existing rows are not rewritten: an
 * explicit `disabled` is a choice the owner made and stays in force.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.social_privacy_preferences
      alter column friend_requests set default 'enabled',
      alter column group_invites set default 'friends',
      alter column direct_messages set default 'friends';

    comment on table public.social_privacy_preferences is
      'Versioned social gates. A missing row means the open defaults (friend requests enabled, group invites and direct messages for friends); an explicit disabled value is respected as written.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.social_privacy_preferences
      alter column friend_requests set default 'disabled',
      alter column group_invites set default 'disabled',
      alter column direct_messages set default 'disabled';

    comment on table public.social_privacy_preferences is
      'Fail-closed versioned social permissions. Missing rows mean every social capability is disabled.';
  `);
}
