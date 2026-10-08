import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0098 (S109b): small-group rename and voice-room titles.
 *
 * 1. `communication_groups.name` may change on an `active` friend group, and
 *    only together with `name_version = name_version + 1` (a new column,
 *    default 1). Every other column of the mapping stays immutable and the
 *    Decision 0025 `pending -> terminal` transition is unchanged.
 * 2. `communication_group_events`: append-only audit of `group_renamed`
 *    (old name, new name, the version it produced, the idempotency record).
 *    `chat_group_membership_events` is not reused: it has no name columns
 *    and its rows mean "membership changed".
 * 3. `voice_rooms.title`: an optional room title, 1-40 code points, trimmed.
 * 4. `voice_room_events` gains `speaker_stepped_down` (a speaker's own
 *    `DELETE /v2/voice-rooms/{id}/speakers/me`).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.communication_groups
      add column name_version integer not null default 1,
      add constraint communication_groups_name_version_check
        check (name_version >= 1);

    comment on column public.communication_groups.name_version is
      'Decision 0098: 1 at creation; each rename of an active friend group adds exactly 1.';

    create or replace function public.guard_communication_group_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'communication_groups mappings cannot be deleted'
          using errcode = '55000';
      end if;
      if new.group_id is distinct from old.group_id
        or new.stream_channel_type is distinct from old.stream_channel_type
        or new.stream_channel_id is distinct from old.stream_channel_id
        or new.channel_kind is distinct from old.channel_kind
        or new.create_operation_id is distinct from old.create_operation_id
        or new.created_at is distinct from old.created_at
        or new.updated_at < old.updated_at
      then
        raise exception 'communication group identity is immutable'
          using errcode = '55000';
      end if;
      -- Decision 0098: a rename changes the name and bumps the version by
      -- exactly one, on an active friend group, and changes nothing else.
      if new.name is distinct from old.name
        or new.name_version is distinct from old.name_version
      then
        if old.channel_kind <> 'group'
          or old.channel_state <> 'active'
          or new.channel_state is distinct from old.channel_state
          or new.name is null
          or new.name is not distinct from old.name
          or new.name_version <> old.name_version + 1
        then
          raise exception 'communication group rename is invalid'
            using errcode = '55000';
        end if;
        return new;
      end if;
      if old.channel_kind <> 'group'
        or old.channel_state <> 'pending'
        or new.channel_state not in (
          'active', 'cancelled', 'operator_required'
        )
      then
        raise exception 'communication group transition is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create table public.communication_group_events (
      event_id uuid primary key default gen_random_uuid(),
      group_id uuid not null
        references public.communication_groups(group_id) on delete restrict,
      event_type text not null,
      actor_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      old_name text not null,
      new_name text not null,
      name_version integer not null,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      created_at timestamptz not null default clock_timestamp(),
      constraint communication_group_events_idempotency_unique
        unique (idempotency_record_id),
      constraint communication_group_events_type_check
        check (event_type in ('group_renamed')),
      constraint communication_group_events_rename_check
        check (old_name <> new_name and name_version >= 2)
    );

    comment on table public.communication_group_events is
      'Decision 0098: append-only audit of friend-group profile changes (group_renamed). A same-key replay finds its row through idempotency_record_id.';

    create index communication_group_events_group_idx
      on public.communication_group_events (group_id, created_at desc, event_id);

    create trigger communication_group_events_append_only
      before update or delete on public.communication_group_events
      for each row execute function public.reject_community_audit_mutation();

    -- Decision 0098: a speaker's own step-down is audited on its own type.
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
          'speaker_stepped_down',
          'muted_all',
          'room_ended'
        ));

    alter table public.voice_rooms
      add column title text,
      add constraint voice_rooms_title_check
        check (
          title is null
          or (char_length(title) between 1 and 40 and title = btrim(title))
        );

    comment on column public.voice_rooms.title is
      'Decision 0098: optional host-provided room title, 1-40 code points; null shows the community name.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.communication_group_events,
      public.communication_groups,
      public.voice_rooms,
      public.voice_room_events
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.communication_group_events)
        or exists (select 1 from public.communication_groups where name_version <> 1)
        or exists (select 1 from public.voice_rooms where title is not null)
        or exists (
          select 1 from public.voice_room_events
          where event_type = 'speaker_stepped_down'
        )
      then
        raise exception
          'refusing rollback while group renames, voice-room titles, or step-downs are recorded'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    alter table public.voice_rooms
      drop constraint voice_rooms_title_check,
      drop column title;

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

    drop trigger communication_group_events_append_only
      on public.communication_group_events;
    drop table public.communication_group_events;

    create or replace function public.guard_communication_group_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'communication_groups mappings cannot be deleted'
          using errcode = '55000';
      end if;
      if new.group_id is distinct from old.group_id
        or new.stream_channel_type is distinct from old.stream_channel_type
        or new.stream_channel_id is distinct from old.stream_channel_id
        or new.channel_kind is distinct from old.channel_kind
        or new.name is distinct from old.name
        or new.create_operation_id is distinct from old.create_operation_id
        or new.created_at is distinct from old.created_at
        or new.updated_at < old.updated_at
      then
        raise exception 'communication group identity is immutable'
          using errcode = '55000';
      end if;
      if old.channel_kind <> 'group'
        or old.channel_state <> 'pending'
        or new.channel_state not in (
          'active', 'cancelled', 'operator_required'
        )
      then
        raise exception 'communication group transition is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    alter table public.communication_groups
      drop constraint communication_groups_name_version_check,
      drop column name_version;
  `);
}
