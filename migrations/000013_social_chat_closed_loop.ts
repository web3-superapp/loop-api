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
        'chat_channel_command_v1'
      )),
      add constraint idempotency_records_operation_binding_unique
      unique (
        id,
        owner_user_id,
        request_sha256,
        scope,
        idempotency_key,
        digest_version
      );

    create sequence public.profile_code_sequence
      as bigint
      minvalue 1
      maxvalue 1125899906842623
      start with 1
      increment by 1
      no cycle;

    create function public.loop_profile_code_from_sequence(value bigint)
    returns text
    language plpgsql
    immutable
    strict
    parallel safe
    as $function$
    declare
      alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      remaining bigint := value;
      encoded text := '';
      digit integer;
      position integer;
    begin
      if value < 0 or value >= 1125899906842624 then
        raise exception 'profile code sequence value is outside the 10-character Crockford Base32 range'
          using errcode = '22003';
      end if;

      for position in 1..10 loop
        digit := (remaining % 32)::integer;
        encoded := substr(alphabet, digit + 1, 1) || encoded;
        remaining := remaining / 32;
      end loop;
      return encoded;
    end;
    $function$;

    alter table public.user_profiles
      add column profile_code text;

    update public.user_profiles
    set profile_code = public.loop_profile_code_from_sequence(
      nextval('public.profile_code_sequence')
    )
    where profile_code is null;

    alter table public.user_profiles
      alter column profile_code set default
        public.loop_profile_code_from_sequence(
          nextval('public.profile_code_sequence')
        ),
      alter column profile_code set not null,
      add constraint user_profiles_profile_code_unique unique (profile_code),
      add constraint user_profiles_profile_code_check
        check (profile_code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$');

    alter sequence public.profile_code_sequence
      owned by public.user_profiles.profile_code;

    comment on column public.user_profiles.profile_code is
      'Immutable globally unique presentation-only Crockford Base32 code. It is not an authorization identifier.';

    create function public.guard_user_profile_code_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.profile_code is distinct from old.profile_code then
        raise exception 'profile_code is immutable' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger user_profiles_profile_code_immutable
      before update on public.user_profiles
      for each row execute function public.guard_user_profile_code_mutation();

    create table public.social_privacy_preferences (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      friend_requests text not null default 'disabled',
      group_invites text not null default 'disabled',
      direct_messages text not null default 'disabled',
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint social_privacy_friend_requests_check
        check (friend_requests in ('enabled', 'disabled')),
      constraint social_privacy_group_invites_check
        check (group_invites in ('friends', 'disabled')),
      constraint social_privacy_direct_messages_check
        check (direct_messages in ('friends', 'disabled')),
      constraint social_privacy_record_version_check
        check (record_version > 0),
      constraint social_privacy_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.social_privacy_preferences is
      'Fail-closed versioned social permissions. Missing rows mean every social capability is disabled.';

    create table public.friend_requests (
      friend_request_id uuid primary key default gen_random_uuid(),
      requester_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      recipient_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      pair_user_id_low uuid generated always as (
        least(requester_user_id, recipient_user_id)
      ) stored,
      pair_user_id_high uuid generated always as (
        greatest(requester_user_id, recipient_user_id)
      ) stored,
      status text not null default 'pending',
      expires_at timestamptz not null,
      decided_at timestamptz,
      rejection_cooldown_until timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint friend_requests_requester_recipient_check
        check (requester_user_id <> recipient_user_id),
      constraint friend_requests_status_check
        check (status in ('pending', 'accepted', 'rejected', 'expired')),
      constraint friend_requests_lifecycle_check
        check (
          expires_at > created_at
          and updated_at >= created_at
          and (
            (
              status = 'pending'
              and decided_at is null
              and rejection_cooldown_until is null
            )
            or (
              status = 'accepted'
              and decided_at is not null
              and decided_at >= created_at
              and rejection_cooldown_until is null
            )
            or (
              status = 'rejected'
              and decided_at is not null
              and decided_at >= created_at
              and rejection_cooldown_until is not null
              and rejection_cooldown_until > decided_at
            )
            or (
              status = 'expired'
              and decided_at is not null
              and decided_at >= created_at
              and rejection_cooldown_until is null
            )
          )
        )
    );

    create unique index friend_requests_one_pending_pair_idx
      on public.friend_requests (pair_user_id_low, pair_user_id_high)
      where status = 'pending';
    create index friend_requests_recipient_pending_idx
      on public.friend_requests (
        recipient_user_id,
        status,
        created_at desc,
        friend_request_id desc
      );
    create index friend_requests_requester_pending_idx
      on public.friend_requests (
        requester_user_id,
        status,
        created_at desc,
        friend_request_id desc
      );
    create index friend_requests_pair_cooldown_idx
      on public.friend_requests (
        pair_user_id_low,
        pair_user_id_high,
        rejection_cooldown_until desc
      )
      where status = 'rejected';

    create function public.guard_friend_request_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'friend_requests cannot be deleted' using errcode = '55000';
      end if;
      if new.friend_request_id is distinct from old.friend_request_id
        or new.requester_user_id is distinct from old.requester_user_id
        or new.recipient_user_id is distinct from old.recipient_user_id
        or new.expires_at is distinct from old.expires_at
        or new.created_at is distinct from old.created_at
      then
        raise exception 'friend request identity is immutable' using errcode = '55000';
      end if;
      if old.status <> 'pending'
        or new.status not in ('accepted', 'rejected', 'expired')
        or new.updated_at < old.updated_at
      then
        raise exception 'friend request transition is invalid' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger friend_requests_transition_guard
      before update or delete on public.friend_requests
      for each row execute function public.guard_friend_request_transition();

    create table public.friendships (
      friendship_id uuid primary key default gen_random_uuid(),
      user_id_low uuid not null
        references public.loop_users(id) on delete restrict,
      user_id_high uuid not null
        references public.loop_users(id) on delete restrict,
      accepted_friend_request_id uuid not null unique
        references public.friend_requests(friend_request_id) on delete restrict,
      accepted_at timestamptz not null default clock_timestamp(),
      constraint friendships_pair_unique unique (user_id_low, user_id_high),
      constraint friendships_pair_order_check check (user_id_low < user_id_high)
    );

    create index friendships_low_accepted_idx
      on public.friendships (user_id_low, accepted_at desc, friendship_id desc);
    create index friendships_high_accepted_idx
      on public.friendships (user_id_high, accepted_at desc, friendship_id desc);

    create function public.validate_friendship_source()
    returns trigger
    language plpgsql
    as $function$
    begin
      if not exists (
        select 1
        from public.friend_requests as request
        where request.friend_request_id = new.accepted_friend_request_id
          and request.status = 'accepted'
          and request.pair_user_id_low = new.user_id_low
          and request.pair_user_id_high = new.user_id_high
          and request.decided_at is not null
          and new.accepted_at >= request.decided_at
      ) then
        raise exception 'friendship source request is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger friendships_source_guard
      before insert on public.friendships
      for each row execute function public.validate_friendship_source();

    create function public.reject_friendship_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'friendships are immutable until a deletion decision exists'
        using errcode = '55000';
    end;
    $function$;

    create trigger friendships_immutable
      before update or delete on public.friendships
      for each row execute function public.reject_friendship_mutation();

    create table public.social_operations (
      operation_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      idempotency_record_id uuid not null unique,
      idempotency_scope text not null default 'social_command',
      digest_version text not null default 'social_command_v1',
      request_sha256 text not null,
      operation_kind text not null,
      status text not null,
      result_json jsonb,
      error_code text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint social_operations_id_owner_unique
        unique (operation_id, owner_user_id),
      constraint social_operations_idempotency_fk
        foreign key (
          idempotency_record_id,
          owner_user_id,
          request_sha256,
          idempotency_scope,
          operation_id,
          digest_version
        ) references public.idempotency_records (
          id,
          owner_user_id,
          request_sha256,
          scope,
          idempotency_key,
          digest_version
        ) on delete restrict,
      constraint social_operations_scope_check
        check (idempotency_scope = 'social_command'),
      constraint social_operations_digest_version_check
        check (digest_version = 'social_command_v1'),
      constraint social_operations_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint social_operations_kind_check
        check (operation_kind in (
          'friend_request_send',
          'friend_request_decide'
        )),
      constraint social_operations_status_check
        check (status in ('succeeded', 'failed')),
      constraint social_operations_outcome_check
        check (
          (
            status = 'succeeded'
            and result_json is not null
            and jsonb_typeof(result_json) = 'object'
            and error_code is null
          )
          or (
            status = 'failed'
            and result_json is null
            and error_code is not null
            and error_code ~ '^[a-z][a-z0-9_]{0,63}$'
          )
        ),
      constraint social_operations_timestamp_check
        check (updated_at >= created_at)
    );

    create index social_operations_owner_created_idx
      on public.social_operations (owner_user_id, created_at desc, operation_id);

    create table public.social_operation_events (
      event_id uuid primary key default gen_random_uuid(),
      operation_id uuid not null,
      owner_user_id uuid not null,
      request_id uuid not null,
      event_type text not null default 'completed',
      status text not null,
      reason_code text,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint social_operation_events_operation_fk
        foreign key (operation_id, owner_user_id)
        references public.social_operations(operation_id, owner_user_id)
        on delete restrict,
      constraint social_operation_events_one_event_unique
        unique (operation_id),
      constraint social_operation_events_type_check
        check (event_type = 'completed'),
      constraint social_operation_events_status_check
        check (status in ('succeeded', 'failed')),
      constraint social_operation_events_reason_check
        check (
          (status = 'succeeded' and reason_code is null)
          or (
            status = 'failed'
            and reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
          )
        )
    );

    create function public.reject_social_audit_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'social operation and audit records are append-only'
        using errcode = '55000';
    end;
    $function$;

    create function public.validate_social_operation_event()
    returns trigger
    language plpgsql
    as $function$
    begin
      if not exists (
        select 1
        from public.social_operations as operation
        where operation.operation_id = new.operation_id
          and operation.owner_user_id = new.owner_user_id
          and operation.status = new.status
          and operation.error_code is not distinct from new.reason_code
      ) then
        raise exception 'social operation event does not match its operation'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger social_operations_append_only
      before update or delete on public.social_operations
      for each row execute function public.reject_social_audit_mutation();
    create trigger social_operation_events_append_only
      before update or delete on public.social_operation_events
      for each row execute function public.reject_social_audit_mutation();
    create trigger social_operation_events_match_operation
      before insert on public.social_operation_events
      for each row execute function public.validate_social_operation_event();

    create table public.chat_operations (
      operation_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      idempotency_record_id uuid not null unique,
      idempotency_scope text not null default 'chat_channel_command',
      digest_version text not null default 'chat_channel_command_v1',
      request_sha256 text not null,
      operation_kind text not null,
      state text not null default 'pending',
      fixed_stream_channel_id text not null,
      attempt_count integer not null default 0,
      transport_attempt_id uuid unique,
      attempt_committed_at timestamptz,
      attempt_deadline_at timestamptz,
      result_json jsonb,
      error_code text,
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint chat_operations_id_owner_unique
        unique (operation_id, owner_user_id),
      constraint chat_operations_idempotency_fk
        foreign key (
          idempotency_record_id,
          owner_user_id,
          request_sha256,
          idempotency_scope,
          operation_id,
          digest_version
        ) references public.idempotency_records (
          id,
          owner_user_id,
          request_sha256,
          scope,
          idempotency_key,
          digest_version
        ) on delete restrict,
      constraint chat_operations_scope_check
        check (idempotency_scope = 'chat_channel_command'),
      constraint chat_operations_digest_version_check
        check (digest_version = 'chat_channel_command_v1'),
      constraint chat_operations_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint chat_operations_kind_check
        check (operation_kind in ('group_create', 'direct_get_or_create')),
      constraint chat_operations_state_check
        check (state in (
          'pending',
          'submitting',
          'reconciling',
          'succeeded',
          'failed',
          'operator_required'
        )),
      constraint chat_operations_channel_check
        check (
          fixed_stream_channel_id
            ~ '^loop_(group|direct)_[0-9a-f]{32}$'
        ),
      constraint chat_operations_attempt_count_check
        check (attempt_count between 0 and 1),
      constraint chat_operations_attempt_lifecycle_check
        check (
          (
            attempt_count = 0
            and state in ('pending', 'succeeded', 'failed')
            and transport_attempt_id is null
            and attempt_committed_at is null
            and attempt_deadline_at is null
          )
          or (
            attempt_count = 1
            and state in (
              'submitting',
              'reconciling',
              'succeeded',
              'failed',
              'operator_required'
            )
            and transport_attempt_id is not null
            and attempt_committed_at is not null
            and attempt_deadline_at is not null
            and attempt_deadline_at > attempt_committed_at
          )
        ),
      constraint chat_operations_outcome_check
        check (
          (
            state in ('pending', 'submitting', 'reconciling')
            and result_json is null
            and error_code is null
          )
          or (
            state = 'succeeded'
            and result_json is not null
            and jsonb_typeof(result_json) = 'object'
            and error_code is null
          )
          or (
            state in ('failed', 'operator_required')
            and result_json is null
            and error_code is not null
            and error_code ~ '^[a-z][a-z0-9_]{0,63}$'
          )
        ),
      constraint chat_operations_record_version_check
        check (record_version >= 0),
      constraint chat_operations_timestamp_check
        check (updated_at >= created_at)
    );

    create index chat_operations_owner_created_idx
      on public.chat_operations (owner_user_id, created_at desc, operation_id);
    create index chat_operations_reconcile_idx
      on public.chat_operations (updated_at, operation_id)
      where state in ('submitting', 'reconciling');

    create function public.guard_chat_operation_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'chat_operations cannot be deleted' using errcode = '55000';
      end if;
      if new.operation_id is distinct from old.operation_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.idempotency_record_id is distinct from old.idempotency_record_id
        or new.idempotency_scope is distinct from old.idempotency_scope
        or new.digest_version is distinct from old.digest_version
        or new.request_sha256 is distinct from old.request_sha256
        or new.operation_kind is distinct from old.operation_kind
        or new.fixed_stream_channel_id is distinct from old.fixed_stream_channel_id
        or new.created_at is distinct from old.created_at
      then
        raise exception 'chat operation identity is immutable' using errcode = '55000';
      end if;
      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
      then
        raise exception 'chat operation version is invalid' using errcode = '55000';
      end if;
      if not (
        (
          old.state = 'pending'
          and new.state in ('submitting', 'succeeded', 'failed')
        )
        or (
          old.state = 'submitting'
          and new.state in (
            'reconciling', 'succeeded', 'failed', 'operator_required'
          )
        )
        or (
          old.state = 'reconciling'
          and new.state in ('succeeded', 'failed', 'operator_required')
        )
      ) then
        raise exception 'chat operation transition is invalid' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger chat_operations_transition_guard
      before update or delete on public.chat_operations
      for each row execute function public.guard_chat_operation_transition();

    create table public.chat_operation_events (
      event_id uuid primary key default gen_random_uuid(),
      operation_id uuid not null,
      owner_user_id uuid not null,
      request_id uuid not null,
      from_state text,
      to_state text not null,
      operation_version bigint not null,
      transport_attempt_id uuid,
      reason_code text,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint chat_operation_events_operation_fk
        foreign key (operation_id, owner_user_id)
        references public.chat_operations(operation_id, owner_user_id)
        on delete restrict,
      constraint chat_operation_events_version_unique
        unique (operation_id, operation_version),
      constraint chat_operation_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'pending', 'submitting', 'reconciling',
            'succeeded', 'failed', 'operator_required'
          )
        ),
      constraint chat_operation_events_to_state_check
        check (to_state in (
          'pending', 'submitting', 'reconciling',
          'succeeded', 'failed', 'operator_required'
        )),
      constraint chat_operation_events_initial_check
        check (
          (operation_version = 0 and from_state is null)
          or (operation_version > 0 and from_state is not null)
        ),
      constraint chat_operation_events_reason_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        )
    );

    create function public.validate_chat_operation_event()
    returns trigger
    language plpgsql
    as $function$
    begin
      if not exists (
        select 1
        from public.chat_operations as operation
        where operation.operation_id = new.operation_id
          and operation.owner_user_id = new.owner_user_id
          and operation.state = new.to_state
          and operation.record_version = new.operation_version
          and operation.transport_attempt_id
            is not distinct from new.transport_attempt_id
          and operation.error_code is not distinct from new.reason_code
      ) then
        raise exception 'chat operation event does not match its operation'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger chat_operation_events_append_only
      before update or delete on public.chat_operation_events
      for each row execute function public.reject_social_audit_mutation();
    create trigger chat_operation_events_match_operation
      before insert on public.chat_operation_events
      for each row execute function public.validate_chat_operation_event();

    drop trigger communication_groups_immutable
      on public.communication_groups;
    drop function public.reject_communication_group_mutation();

    alter table public.communication_groups
      add column channel_kind text not null default 'legacy_group',
      add column name text,
      add column create_operation_id uuid unique
        references public.chat_operations(operation_id) on delete restrict,
      add column channel_state text not null default 'active',
      add column updated_at timestamptz not null default clock_timestamp(),
      add constraint communication_groups_kind_check
        check (channel_kind in ('legacy_group', 'group')),
      add constraint communication_groups_state_check
        check (
          channel_state in (
            'pending', 'active', 'cancelled', 'operator_required'
          )
        ),
      add constraint communication_groups_metadata_check
        check (
          (
            channel_kind = 'legacy_group'
            and name is null
            and create_operation_id is null
            and channel_state = 'active'
          )
          or (
            channel_kind = 'group'
            and name is not null
            and char_length(name) between 1 and 60
            and name = btrim(name)
            and public.loop_alias_text_is_safe(name)
            and create_operation_id is not null
          )
        ),
      add constraint communication_groups_timestamp_check
        check (updated_at >= created_at);

    create function public.validate_communication_group_insert()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.channel_kind = 'legacy_group' then
        return new;
      end if;
      if new.channel_state <> 'pending'
        or not exists (
          select 1
          from public.chat_operations as operation
          where operation.operation_id = new.create_operation_id
            and operation.operation_kind = 'group_create'
            and operation.fixed_stream_channel_id = new.stream_channel_id
            and operation.state = 'pending'
        )
      then
        raise exception 'communication group create operation is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger communication_groups_insert_guard
      before insert on public.communication_groups
      for each row execute function public.validate_communication_group_insert();

    create function public.guard_communication_group_mutation()
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

    create trigger communication_groups_guard
      before update or delete on public.communication_groups
      for each row execute function public.guard_communication_group_mutation();

    create table public.communication_group_members (
      group_id uuid not null
        references public.communication_groups(group_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      member_role text not null,
      created_at timestamptz not null default clock_timestamp(),
      primary key (group_id, owner_user_id),
      constraint communication_group_members_role_check
        check (member_role in ('creator', 'member'))
    );

    create unique index communication_group_one_creator_idx
      on public.communication_group_members (group_id)
      where member_role = 'creator';

    create function public.validate_communication_group_member_insert()
    returns trigger
    language plpgsql
    as $function$
    begin
      if not exists (
        select 1
        from public.communication_groups as group_record
        where group_record.group_id = new.group_id
          and group_record.channel_kind = 'group'
      ) then
        raise exception 'communication group member target is invalid'
          using errcode = '55000';
      end if;
      if new.member_role = 'creator'
        and not exists (
          select 1
          from public.communication_groups as group_record
          join public.chat_operations as operation
            on operation.operation_id = group_record.create_operation_id
          where group_record.group_id = new.group_id
            and operation.owner_user_id = new.owner_user_id
        )
      then
        raise exception 'communication group creator is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger communication_group_members_insert_guard
      before insert on public.communication_group_members
      for each row execute function public.validate_communication_group_member_insert();

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

    create table public.direct_channels (
      direct_channel_id uuid primary key default gen_random_uuid(),
      user_id_low uuid not null
        references public.loop_users(id) on delete restrict,
      user_id_high uuid not null
        references public.loop_users(id) on delete restrict,
      stream_channel_type text not null default 'messaging',
      stream_channel_id text not null,
      create_operation_id uuid not null unique
        references public.chat_operations(operation_id) on delete restrict,
      channel_state text not null default 'pending',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint direct_channels_pair_order_check check (user_id_low < user_id_high),
      constraint direct_channels_stream_channel_unique
        unique (stream_channel_type, stream_channel_id),
      constraint direct_channels_stream_type_check
        check (stream_channel_type = 'messaging'),
      constraint direct_channels_stream_id_check
        check (stream_channel_id ~ '^loop_direct_[0-9a-f]{32}$'),
      constraint direct_channels_state_check
        check (
          channel_state in (
            'pending', 'active', 'cancelled', 'operator_required'
          )
        ),
      constraint direct_channels_timestamp_check
        check (updated_at >= created_at)
    );

    create unique index direct_channels_live_pair_unique
      on public.direct_channels (user_id_low, user_id_high)
      where channel_state in ('pending', 'active', 'operator_required');

    create function public.validate_direct_channel_insert()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.channel_state <> 'pending'
        or not exists (
          select 1
          from public.chat_operations as operation
          where operation.operation_id = new.create_operation_id
            and operation.operation_kind = 'direct_get_or_create'
            and operation.fixed_stream_channel_id = new.stream_channel_id
            and operation.owner_user_id in (new.user_id_low, new.user_id_high)
            and operation.state = 'pending'
        )
      then
        raise exception 'direct channel create operation is invalid'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger direct_channels_insert_guard
      before insert on public.direct_channels
      for each row execute function public.validate_direct_channel_insert();

    create function public.guard_direct_channel_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'direct_channels cannot be deleted' using errcode = '55000';
      end if;
      if new.direct_channel_id is distinct from old.direct_channel_id
        or new.user_id_low is distinct from old.user_id_low
        or new.user_id_high is distinct from old.user_id_high
        or new.stream_channel_type is distinct from old.stream_channel_type
        or new.stream_channel_id is distinct from old.stream_channel_id
        or new.create_operation_id is distinct from old.create_operation_id
        or new.created_at is distinct from old.created_at
        or new.updated_at < old.updated_at
      then
        raise exception 'direct channel identity is immutable' using errcode = '55000';
      end if;
      if old.channel_state <> 'pending'
        or new.channel_state not in (
          'active', 'cancelled', 'operator_required'
        )
      then
        raise exception 'direct channel transition is invalid' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger direct_channels_guard
      before update or delete on public.direct_channels
      for each row execute function public.guard_direct_channel_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.direct_channels,
      public.communication_group_members,
      public.communication_groups,
      public.chat_operation_events,
      public.chat_operations,
      public.social_operation_events,
      public.social_operations,
      public.friendships,
      public.friend_requests,
      public.social_privacy_preferences,
      public.user_profiles,
      public.idempotency_records
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.direct_channels)
        or exists (select 1 from public.communication_group_members)
        or exists (
          select 1 from public.communication_groups
          where channel_kind <> 'legacy_group'
            or name is not null
            or create_operation_id is not null
            or channel_state <> 'active'
        )
        or exists (select 1 from public.chat_operation_events)
        or exists (select 1 from public.chat_operations)
        or exists (select 1 from public.social_operation_events)
        or exists (select 1 from public.social_operations)
        or exists (select 1 from public.friendships)
        or exists (select 1 from public.friend_requests)
        or exists (select 1 from public.social_privacy_preferences)
        or exists (select 1 from public.user_profiles)
      then
        raise exception
          'cannot roll back 000013_social_chat_closed_loop after a profile code or social/chat record exists'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger direct_channels_guard on public.direct_channels;
    drop trigger direct_channels_insert_guard on public.direct_channels;
    drop function public.guard_direct_channel_mutation();
    drop function public.validate_direct_channel_insert();
    drop table public.direct_channels;

    drop trigger communication_group_members_immutable
      on public.communication_group_members;
    drop trigger communication_group_members_insert_guard
      on public.communication_group_members;
    drop function public.reject_communication_group_member_mutation();
    drop function public.validate_communication_group_member_insert();
    drop index public.communication_group_one_creator_idx;
    drop table public.communication_group_members;

    drop trigger communication_groups_guard on public.communication_groups;
    drop trigger communication_groups_insert_guard
      on public.communication_groups;
    drop function public.guard_communication_group_mutation();
    drop function public.validate_communication_group_insert();
    alter table public.communication_groups
      drop constraint communication_groups_timestamp_check,
      drop constraint communication_groups_metadata_check,
      drop constraint communication_groups_state_check,
      drop constraint communication_groups_kind_check,
      drop column updated_at,
      drop column channel_state,
      drop column create_operation_id,
      drop column name,
      drop column channel_kind;

    create function public.reject_communication_group_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'communication_groups mappings are immutable'
        using errcode = '55000';
    end;
    $function$;
    create trigger communication_groups_immutable
      before update or delete on public.communication_groups
      for each row execute function public.reject_communication_group_mutation();

    drop trigger chat_operation_events_append_only
      on public.chat_operation_events;
    drop trigger chat_operation_events_match_operation
      on public.chat_operation_events;
    drop function public.validate_chat_operation_event();
    drop table public.chat_operation_events;
    drop trigger chat_operations_transition_guard on public.chat_operations;
    drop function public.guard_chat_operation_transition();
    drop table public.chat_operations;

    drop trigger social_operation_events_append_only
      on public.social_operation_events;
    drop trigger social_operation_events_match_operation
      on public.social_operation_events;
    drop trigger social_operations_append_only on public.social_operations;
    drop table public.social_operation_events;
    drop table public.social_operations;
    drop function public.reject_social_audit_mutation();
    drop function public.validate_social_operation_event();

    drop trigger friendships_immutable on public.friendships;
    drop trigger friendships_source_guard on public.friendships;
    drop function public.reject_friendship_mutation();
    drop function public.validate_friendship_source();
    drop table public.friendships;

    drop trigger friend_requests_transition_guard on public.friend_requests;
    drop function public.guard_friend_request_transition();
    drop table public.friend_requests;
    drop table public.social_privacy_preferences;

    drop trigger user_profiles_profile_code_immutable on public.user_profiles;
    drop function public.guard_user_profile_code_mutation();
    alter table public.user_profiles
      drop constraint user_profiles_profile_code_check,
      drop constraint user_profiles_profile_code_unique,
      drop column profile_code;
    drop function public.loop_profile_code_from_sequence(bigint);

    alter table public.idempotency_records
      drop constraint idempotency_records_operation_binding_unique,
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1'
      ));
  `);
}
