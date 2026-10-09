import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create function public.loop_alias_text_is_safe(value text)
    returns boolean
    language sql
    immutable
    strict
    parallel safe
    as $function$
      select not exists (
        select 1
        from (
          select ascii(code_point_text) as code_point
          from regexp_split_to_table(value, '') as scalars(code_point_text)
        ) as decoded
        where code_point between 0 and 31
          or code_point between 127 and 159
          or code_point = 173
          or code_point between 1536 and 1541
          or code_point = 1564
          or code_point = 1757
          or code_point = 1807
          or code_point between 2192 and 2193
          or code_point = 2274
          or code_point = 6158
          or code_point between 8203 and 8207
          or code_point between 8232 and 8238
          or code_point between 8288 and 8292
          or code_point between 8294 and 8303
          or code_point = 65279
          or code_point between 65529 and 65531
          or code_point = 69821
          or code_point = 69837
          or code_point between 78896 and 78911
          or code_point between 113824 and 113827
          or code_point between 119155 and 119162
          or code_point = 917505
          or code_point between 917536 and 917631
      );
    $function$;

    create function public.loop_alias_search_key_unicode17_v1(value text)
    returns text
    language sql
    immutable
    strict
    parallel safe
    as $function$
      select regexp_replace(
        lower(
          normalize(
            translate(
              btrim(value),
              chr(42993)
                || chr(117974) || chr(117975) || chr(117976)
                || chr(117977) || chr(117978) || chr(117979)
                || chr(117980) || chr(117981) || chr(117982)
                || chr(117983) || chr(117984) || chr(117985)
                || chr(117986) || chr(117987) || chr(117988)
                || chr(117989) || chr(117990) || chr(117991)
                || chr(117992) || chr(117993) || chr(117994)
                || chr(117995) || chr(117996) || chr(117997)
                || chr(117998) || chr(117999) || chr(118000)
                || chr(118001) || chr(118002) || chr(118003)
                || chr(118004) || chr(118005) || chr(118006)
                || chr(118007) || chr(118008) || chr(118009),
              'SABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            ),
            NFKC
          )
        ),
        '[[:space:]]+',
        ' ',
        'g'
      );
    $function$;

    do $profile_alias_guard$
    begin
      if exists (
        select 1
        from public.user_profiles
        where alias is not null
          and not public.loop_alias_text_is_safe(alias)
      ) then
        raise exception
          'cannot apply 000012_alias_discovery_and_group_personas while a profile alias contains a control, formatting, surrogate, line-separator, or paragraph-separator code point; clear or replace the alias first'
          using errcode = '55000';
      end if;
    end;
    $profile_alias_guard$;

    alter table public.user_profiles
      drop constraint user_profiles_alias_check;
    alter table public.user_profiles
      add constraint user_profiles_alias_check
      check (
        alias is null
        or (
          char_length(alias) between 1 and 40
          and alias = btrim(alias)
          and public.loop_alias_text_is_safe(alias)
        )
      );

    alter table public.user_profiles
      add column public_profile_id uuid not null default gen_random_uuid(),
      add column alias_search_key text generated always as (
        case
          when alias is null then null
          else public.loop_alias_search_key_unicode17_v1(alias)
        end
      ) stored,
      add column alias_search_version text not null
        default 'unicode17_nfkc_lower_ws_v1',
      add constraint user_profiles_public_profile_id_unique
        unique (public_profile_id),
      add constraint user_profiles_alias_search_version_check
        check (alias_search_version = 'unicode17_nfkc_lower_ws_v1');

    create index user_profiles_alias_search_prefix_idx
      on public.user_profiles (
        alias_search_key collate "C",
        public_profile_id
      )
      where alias_search_key is not null;

    comment on column public.user_profiles.public_profile_id is
      'Stable opaque public directory identifier. It is not an owner, Privy, Stream, or wallet identifier.';
    comment on column public.user_profiles.alias_search_key is
      'Stored unicode17_nfkc_lower_ws_v1 lookup key derived from the untrusted display alias.';

    create table public.communication_groups (
      group_id uuid primary key default gen_random_uuid(),
      stream_channel_type text not null default 'messaging',
      stream_channel_id text not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint communication_groups_stream_channel_unique
        unique (stream_channel_type, stream_channel_id),
      constraint communication_groups_stream_channel_type_check
        check (stream_channel_type = 'messaging'),
      constraint communication_groups_stream_channel_id_check
        check (
          stream_channel_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
        )
    );

    comment on table public.communication_groups is
      'Immutable opaque LOOP group mapping for one fixed Stream messaging channel. Provider identifiers never become LOOP authorization subjects.';

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

    create table public.group_alias_reservations (
      group_alias_id uuid primary key default gen_random_uuid(),
      group_id uuid not null
        references public.communication_groups(group_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      alias text not null,
      alias_search_key text generated always as (
        public.loop_alias_search_key_unicode17_v1(alias)
      ) stored,
      alias_search_version text not null
        default 'unicode17_nfkc_lower_ws_v1',
      projection_state text not null default 'pending',
      confirmed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint group_alias_reservations_group_owner_unique
        unique (group_id, owner_user_id),
      constraint group_alias_reservations_group_search_key_unique
        unique (group_id, alias_search_key),
      constraint group_alias_reservations_alias_check
        check (
          char_length(alias) between 1 and 40
          and alias = btrim(alias)
          and public.loop_alias_text_is_safe(alias)
        ),
      constraint group_alias_reservations_search_key_check
        check (char_length(alias_search_key) >= 1),
      constraint group_alias_reservations_search_version_check
        check (alias_search_version = 'unicode17_nfkc_lower_ws_v1'),
      constraint group_alias_reservations_projection_state_check
        check (projection_state in ('pending', 'confirmed')),
      constraint group_alias_reservations_projection_pairing_check
        check (
          (projection_state = 'pending' and confirmed_at is null)
          or (projection_state = 'confirmed' and confirmed_at is not null)
        ),
      constraint group_alias_reservations_timestamp_check
        check (
          updated_at >= created_at
          and (
            confirmed_at is null
            or (
              confirmed_at >= created_at
              and confirmed_at <= updated_at
            )
          )
        )
    );

    comment on table public.group_alias_reservations is
      'Permanent one-owner-per-group aliases. Leaving and rejoining never releases or changes an alias; projection state records only the bounded Stream member-data projection.';

    create index group_alias_reservations_search_prefix_idx
      on public.group_alias_reservations (
        group_id,
        alias_search_key collate "C",
        group_alias_id
      )
      where projection_state = 'confirmed';

    create function public.guard_group_alias_reservation_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'INSERT' then
        if new.projection_state <> 'pending'
          or new.confirmed_at is not null
        then
          raise exception 'group alias projection must start pending'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if tg_op = 'DELETE' then
        raise exception 'group_alias_reservations cannot be deleted'
          using errcode = '55000';
      end if;

      if new.group_alias_id is distinct from old.group_alias_id
        or new.group_id is distinct from old.group_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.alias is distinct from old.alias
        or new.alias_search_key is distinct from old.alias_search_key
        or new.alias_search_version is distinct from old.alias_search_version
        or new.created_at is distinct from old.created_at
      then
        raise exception 'group alias identity and alias are immutable'
          using errcode = '55000';
      end if;

      if new.updated_at < old.updated_at then
        raise exception 'group alias timestamps cannot move backward'
          using errcode = '55000';
      end if;

      if old.projection_state = 'pending' then
        if new.projection_state = 'pending' then
          if new.confirmed_at is not null then
            raise exception 'pending group alias cannot have confirmed_at'
              using errcode = '55000';
          end if;
        elsif new.projection_state = 'confirmed' then
          if new.confirmed_at is null
            or new.confirmed_at < old.updated_at
            or new.updated_at < new.confirmed_at
          then
            raise exception 'group alias confirmation timestamps are invalid'
              using errcode = '55000';
          end if;
        else
          raise exception 'group alias projection transition is invalid'
            using errcode = '55000';
        end if;
      elsif old.projection_state = 'confirmed' then
        if new.projection_state <> 'confirmed'
          or new.confirmed_at is distinct from old.confirmed_at
        then
          raise exception 'confirmed group alias projection is irreversible'
            using errcode = '55000';
        end if;
      else
        raise exception 'group alias projection state is invalid'
          using errcode = '55000';
      end if;

      return new;
    end;
    $function$;

    create trigger group_alias_reservations_guard
      after insert or update or delete on public.group_alias_reservations
      for each row execute function public.guard_group_alias_reservation_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.group_alias_reservations,
      public.communication_groups,
      public.user_profiles
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.user_profiles)
        or exists (select 1 from public.communication_groups)
        or exists (select 1 from public.group_alias_reservations)
      then
        raise exception
          'cannot roll back 000012_alias_discovery_and_group_personas while public profiles, groups, or aliases exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger group_alias_reservations_guard
      on public.group_alias_reservations;
    drop function public.guard_group_alias_reservation_mutation();
    drop index public.group_alias_reservations_search_prefix_idx;
    drop table public.group_alias_reservations;

    drop trigger communication_groups_immutable
      on public.communication_groups;
    drop function public.reject_communication_group_mutation();
    drop table public.communication_groups;

    drop index public.user_profiles_alias_search_prefix_idx;
    alter table public.user_profiles
      drop constraint user_profiles_alias_search_version_check,
      drop constraint user_profiles_public_profile_id_unique,
      drop column alias_search_version,
      drop column alias_search_key,
      drop column public_profile_id;

    alter table public.user_profiles
      drop constraint user_profiles_alias_check;
    alter table public.user_profiles
      add constraint user_profiles_alias_check
      check (
        alias is null
        or (
          char_length(alias) between 1 and 40
          and alias = btrim(alias)
          and alias !~ '[[:cntrl:]]'
        )
      );

    drop function if exists public.loop_alias_search_key_unicode17_v1(text);
    drop function if exists public.loop_alias_text_is_safe(text);
  `);
}
