import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0053 §1: a muted speaker may clear the host's mute intent itself,
 * and the host may clear it too. Both paths write the `speaker_unmuted`
 * audit event (`reason_code` says who cleared it), so the event type check
 * gains exactly that value. No column changes: `muted_at` already allows null
 * and every role transition clears it (migration 000029).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
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
          'speaker_unmuted',
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
        select 1 from public.voice_room_events where event_type = 'speaker_unmuted'
      ) then
        raise exception
          'refusing to narrow the audit event types while a speaker_unmuted row exists';
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
          'speaker_muted',
          'muted_all',
          'room_ended'
        ));
  `);
}
