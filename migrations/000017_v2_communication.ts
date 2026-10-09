import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
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
        'communication_command_v1'
      ));

    create table public.community_channels (
      community_id uuid primary key
        references public.communities(community_id) on delete restrict,
      stream_channel_id text not null,
      channel_type text not null default 'messaging',
      state text not null default 'created',
      member_cap integer not null,
      created_by_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      provisioned_at timestamptz,
      last_error_code text,
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint community_channels_stream_channel_id_unique
        unique (stream_channel_id),
      constraint community_channels_stream_channel_id_check
        check (stream_channel_id ~ '^loop_community_[0-9a-f]{32}$'),
      constraint community_channels_channel_type_check
        check (channel_type = 'messaging'),
      constraint community_channels_state_check
        check (state in ('created', 'capacityPending', 'failed')),
      constraint community_channels_member_cap_check
        check (member_cap between 1 and 200000),
      constraint community_channels_error_code_check
        check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint community_channels_record_version_check
        check (record_version > 0),
      constraint community_channels_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_channels is
      'Official community Stream messaging channel (Decision 0032). The explicit channel ID is allocated when the community is verified; the Stream write itself happens only after commit, through community_channel_sync_jobs.';

    create table public.community_channel_members (
      community_id uuid not null
        references public.community_channels(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      stream_user_id text not null,
      state text not null default 'pending',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (community_id, owner_user_id),
      constraint community_channel_members_state_check
        check (state in ('synced', 'pending', 'removed', 'capacityPending')),
      constraint community_channel_members_stream_user_id_check
        check (stream_user_id ~ '^loop_[0-9a-f]{32}$'),
      constraint community_channel_members_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_channel_members is
      'LOOP projection of official-channel membership. synced is the only state that proves Stream accepted the member; capacityPending means the LOOP membership stands but the channel is at its member cap.';

    create index community_channel_members_synced_idx
      on public.community_channel_members (community_id)
      where state = 'synced';

    create table public.community_channel_sync_jobs (
      community_id uuid not null
        references public.community_channels(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      kind text not null,
      state text not null default 'pending',
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default clock_timestamp(),
      last_error_code text,
      lease_worker_id uuid,
      lease_expires_at timestamptz,
      request_id uuid,
      enqueued_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (community_id, owner_user_id),
      constraint community_channel_sync_jobs_kind_check
        check (kind in ('add', 'remove')),
      constraint community_channel_sync_jobs_state_check
        check (state in ('pending', 'reconciling', 'succeeded', 'failed')),
      constraint community_channel_sync_jobs_attempts_check
        check (attempts between 0 and 1000),
      constraint community_channel_sync_jobs_error_code_check
        check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint community_channel_sync_jobs_lease_pairing_check
        check (
          (lease_worker_id is null and lease_expires_at is null)
          or (lease_worker_id is not null and lease_expires_at is not null)
        ),
      constraint community_channel_sync_jobs_timestamp_check
        check (updated_at >= enqueued_at)
    );

    comment on table public.community_channel_sync_jobs is
      'Transactional outbox for official-channel membership (Decision 0032). One row per (community, account) holds the latest intended Stream write; the standalone community-channel-sync worker lane leases it and attempts each provider call exactly once.';

    create index community_channel_sync_jobs_due_idx
      on public.community_channel_sync_jobs (
        next_attempt_at asc,
        community_id asc,
        owner_user_id asc
      )
      where state in ('pending', 'reconciling');

    create table public.voice_rooms (
      voice_room_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      call_type text not null default 'audio_room',
      call_id text not null,
      state text not null default 'live',
      provision_state text not null default 'pending',
      backstage boolean not null default true,
      created_by_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      hand_raise_sequence bigint not null default 0,
      last_error_code text,
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      ended_at timestamptz,
      constraint voice_rooms_call_id_unique unique (call_id),
      constraint voice_rooms_call_id_check
        check (call_id ~ '^loop_voice_[0-9a-f]{32}$'),
      constraint voice_rooms_call_type_check check (call_type = 'audio_room'),
      constraint voice_rooms_state_check check (state in ('live', 'ended')),
      constraint voice_rooms_provision_state_check
        check (provision_state in ('pending', 'provisioned', 'reconciling', 'failed')),
      constraint voice_rooms_ended_pairing_check
        check ((state = 'ended') = (ended_at is not null)),
      constraint voice_rooms_hand_raise_sequence_check
        check (hand_raise_sequence >= 0),
      constraint voice_rooms_error_code_check
        check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint voice_rooms_record_version_check check (record_version > 0),
      constraint voice_rooms_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.voice_rooms is
      'Backend-prepared Stream Video audio_room (Decision 0032). PostgreSQL owns the room lifecycle, host identity, and the hand-raise queue; Stream owns participants, media state, and permissions.';

    create unique index voice_rooms_one_live_per_community_idx
      on public.voice_rooms (community_id)
      where state = 'live';
    create index voice_rooms_community_recent_idx
      on public.voice_rooms (community_id, created_at desc, voice_room_id desc);

    create table public.voice_room_members (
      voice_room_id uuid not null
        references public.voice_rooms(voice_room_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      role text not null default 'listener',
      state text not null default 'joined',
      joined_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (voice_room_id, owner_user_id),
      constraint voice_room_members_role_check
        check (role in ('host', 'speaker', 'listener')),
      constraint voice_room_members_state_check
        check (state in ('joined', 'left', 'removed')),
      constraint voice_room_members_host_state_check
        check (role <> 'host' or state = 'joined'),
      constraint voice_room_members_timestamp_check
        check (updated_at >= joined_at)
    );

    comment on table public.voice_room_members is
      'Voice-room role projection. Only the host may invite or remove speakers, mute everyone, or end the room; the live participant list stays a Stream fact.';

    create unique index voice_room_members_one_host_idx
      on public.voice_room_members (voice_room_id)
      where role = 'host';
    create index voice_room_members_listing_idx
      on public.voice_room_members (voice_room_id, role, joined_at asc)
      where state = 'joined';

    create table public.voice_room_hand_raises (
      hand_raise_id uuid primary key default gen_random_uuid(),
      voice_room_id uuid not null
        references public.voice_rooms(voice_room_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      sequence bigint not null,
      state text not null default 'pending',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint voice_room_hand_raises_sequence_unique
        unique (voice_room_id, sequence),
      constraint voice_room_hand_raises_sequence_check check (sequence > 0),
      constraint voice_room_hand_raises_state_check
        check (state in ('pending', 'invited', 'cancelled')),
      constraint voice_room_hand_raises_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.voice_room_hand_raises is
      'PostgreSQL hand-raise queue. The sequence is allocated under the voice_rooms row lock so concurrent raises keep a total order; at most one pending raise exists per (room, account).';

    create unique index voice_room_hand_raises_pending_idx
      on public.voice_room_hand_raises (voice_room_id, owner_user_id)
      where state = 'pending';
    create index voice_room_hand_raises_queue_idx
      on public.voice_room_hand_raises (voice_room_id, sequence asc)
      where state = 'pending';

    create table public.voice_room_events (
      event_id uuid primary key default gen_random_uuid(),
      voice_room_id uuid not null
        references public.voice_rooms(voice_room_id) on delete restrict,
      actor_user_id uuid
        references public.loop_users(id) on delete restrict,
      target_user_id uuid
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      from_role text,
      to_role text,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint voice_room_events_idempotency_unique
        unique (idempotency_record_id),
      constraint voice_room_events_type_check
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
        )),
      constraint voice_room_events_role_check
        check (
          (from_role is null or from_role in ('host', 'speaker', 'listener'))
          and (to_role is null or to_role in ('host', 'speaker', 'listener'))
        ),
      constraint voice_room_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table public.voice_room_events is
      'Append-only voice-room audit (Decision 0032). idempotency_record_id binds each durable command replay to its first committed result.';

    create index voice_room_events_room_idx
      on public.voice_room_events (voice_room_id, occurred_at desc, event_id);

    create trigger voice_room_events_append_only
      before update or delete on public.voice_room_events
      for each row execute function public.reject_community_audit_mutation();

    -- Decision 0025 froze communication_group_members until member management
    -- was approved. Decision 0032 approves exactly one transition: a non
    -- creator member may leave its own small group. Role changes and creator
    -- removal stay rejected, so group-info member management is still closed.
    drop trigger communication_group_members_immutable
      on public.communication_group_members;
    drop function public.reject_communication_group_member_mutation();

    create function public.guard_communication_group_member_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'UPDATE' then
        raise exception 'communication_group_members rows are immutable'
          using errcode = '55000';
      end if;
      if old.member_role <> 'member' then
        raise exception 'only a non-creator group member may leave'
          using errcode = '55000';
      end if;
      return old;
    end;
    $function$;

    create trigger communication_group_members_guard
      before update or delete on public.communication_group_members
      for each row execute function public.guard_communication_group_member_mutation();

    create table public.chat_group_membership_events (
      event_id uuid primary key default gen_random_uuid(),
      group_id uuid not null
        references public.communication_groups(group_id) on delete restrict,
      actor_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint chat_group_membership_events_idempotency_unique
        unique (idempotency_record_id),
      constraint chat_group_membership_events_type_check
        check (event_type in ('member_left')),
      constraint chat_group_membership_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table public.chat_group_membership_events is
      'Append-only audit for the V2 group-leave command (Decision 0032). The Stream removal is idempotent, so a replay finds this row and repeats only the provider call.';

    create index chat_group_membership_events_group_idx
      on public.chat_group_membership_events (group_id, occurred_at desc, event_id);

    create trigger chat_group_membership_events_append_only
      before update or delete on public.chat_group_membership_events
      for each row execute function public.reject_community_audit_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.chat_group_membership_events,
      public.voice_room_events,
      public.voice_room_hand_raises,
      public.voice_room_members,
      public.voice_rooms,
      public.community_channel_sync_jobs,
      public.community_channel_members,
      public.community_channels,
      public.idempotency_records
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.chat_group_membership_events)
        or exists (select 1 from public.voice_room_events)
        or exists (select 1 from public.voice_room_hand_raises)
        or exists (select 1 from public.voice_room_members)
        or exists (select 1 from public.voice_rooms)
        or exists (select 1 from public.community_channel_sync_jobs)
        or exists (select 1 from public.community_channel_members)
        or exists (select 1 from public.community_channels)
        or exists (
          select 1 from public.idempotency_records
          where digest_version = 'communication_command_v1'
        )
      then
        raise exception
          'refusing destructive rollback of v2 communication data'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger chat_group_membership_events_append_only
      on public.chat_group_membership_events;
    drop table public.chat_group_membership_events;

    drop trigger communication_group_members_guard
      on public.communication_group_members;
    drop function public.guard_communication_group_member_mutation();

    create function public.reject_communication_group_member_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'communication_group_members are immutable until member management is approved'
        using errcode = '55000';
    end;
    $function$;

    create trigger communication_group_members_immutable
      before update or delete on public.communication_group_members
      for each row execute function public.reject_communication_group_member_mutation();

    drop trigger voice_room_events_append_only on public.voice_room_events;
    drop table public.voice_room_events;
    drop table public.voice_room_hand_raises;
    drop table public.voice_room_members;
    drop table public.voice_rooms;
    drop table public.community_channel_sync_jobs;
    drop table public.community_channel_members;
    drop table public.community_channels;

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
        'social_graph_command_v1'
      ));
  `);
}
