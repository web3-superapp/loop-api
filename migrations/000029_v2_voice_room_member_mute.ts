import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0052 §2: the voice-room roster carries the host's LOOP-side mute
 * intent per speaker.
 *
 * `voice_room_members.muted_at` is the host's last mute of that speaker
 * (per-member mute or mute-all). It is LOOP intent, never Stream media
 * state: Stream stays authoritative for whether a microphone is open. Only a
 * speaker can be muted, so every role transition (invite, remove, leave)
 * clears it, and the check constraint makes a muted listener or host
 * unrepresentable. The audit gains the per-member `speaker_muted` event.
 *
 * Existing rows were never muted through LOOP (no per-member mute existed),
 * so a null `muted_at` is a true statement about them, not a backfill guess.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.voice_room_members
      add column muted_at timestamptz,
      add constraint voice_room_members_muted_role_check
        check (muted_at is null or role = 'speaker'),
      add constraint voice_room_members_muted_timestamp_check
        check (muted_at is null or muted_at >= joined_at);

    comment on column public.voice_room_members.muted_at is
      'Decision 0052: the host''s last LOOP-side mute of this speaker (per-member mute or mute-all). Intent only; Stream owns the live microphone state. Cleared by every role transition.';

    alter table public.voice_room_events
      drop constraint voice_room_events_type_check,
      add constraint voice_room_events_type_check
        check (event_type in (
          'room_created',
          'member_joined',
          'member_left',
          'hand_raised',
          'hand_raise_cancelled',
          'speaker_invited',
          'speaker_removed',
          'speaker_muted',
          'muted_all',
          'room_ended'
        ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.voice_room_events where event_type = 'speaker_muted'
      ) then
        raise exception
          'refusing to drop the per-member mute while a speaker_muted audit row exists';
      end if;
    end
    $$;

    alter table public.voice_room_events
      drop constraint voice_room_events_type_check,
      add constraint voice_room_events_type_check
        check (event_type in (
          'room_created',
          'member_joined',
          'member_left',
          'hand_raised',
          'hand_raise_cancelled',
          'speaker_invited',
          'speaker_removed',
          'muted_all',
          'room_ended'
        ));

    alter table public.voice_room_members
      drop constraint voice_room_members_muted_timestamp_check,
      drop constraint voice_room_members_muted_role_check,
      drop column muted_at;
  `);
}
