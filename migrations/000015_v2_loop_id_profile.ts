import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create function public.loop_generate_loop_id()
    returns text
    language plpgsql
    volatile
    as $function$
    declare
      alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      raw bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      value bigint := 0;
      encoded text := '';
      index integer;
    begin
      for index in 0..4 loop
        value := value * 256 + get_byte(raw, index);
      end loop;
      for index in 1..8 loop
        encoded := substr(alphabet, (value % 32)::integer + 1, 1) || encoded;
        value := value / 32;
      end loop;
      return 'LOOP-' || encoded;
    end;
    $function$;

    comment on function public.loop_generate_loop_id() is
      'Random LOOP-XXXXXXXX Crockford Base32 identifier from 40 cryptographically random bits. Runtime account creation allocates in the API with unique-violation retry; this default only protects direct inserts.';

    alter table public.loop_users
      add column loop_id text;

    do $backfill$
    declare
      user_row record;
      candidate text;
    begin
      for user_row in
        select id
        from public.loop_users
        where loop_id is null
        order by created_at, id
      loop
        loop
          candidate := public.loop_generate_loop_id();
          exit when not exists (
            select 1 from public.loop_users where loop_id = candidate
          );
        end loop;
        update public.loop_users
        set loop_id = candidate
        where id = user_row.id;
      end loop;
    end;
    $backfill$;

    alter table public.loop_users
      alter column loop_id set not null,
      alter column loop_id set default public.loop_generate_loop_id(),
      add constraint loop_users_loop_id_unique unique (loop_id),
      add constraint loop_users_loop_id_check
        check (loop_id ~ '^LOOP-[0-9A-HJKMNP-TV-Z]{8}$');

    comment on column public.loop_users.loop_id is
      'Immutable, random, globally unique public LOOP ID (LOOP- plus 8 Crockford Base32 characters). Presentation identity only; never an authorization key.';

    create function public.guard_loop_user_loop_id_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.loop_id is distinct from old.loop_id then
        raise exception 'loop_id is immutable' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger loop_users_loop_id_immutable
      before update on public.loop_users
      for each row execute function public.guard_loop_user_loop_id_mutation();

    create function public.loop_text_array_is_unique(value text[])
    returns boolean
    language sql
    immutable
    strict
    parallel safe
    as $function$
      select array_position(value, null) is null
        and coalesce(cardinality(value), 0) = (
          select count(distinct element)
          from unnest(value) as elements(element)
        );
    $function$;

    alter table public.user_profiles
      add column profile_status text not null default 'pending',
      add column activated_at timestamptz,
      add column bio text,
      add column interests text[] not null default '{}'::text[],
      add constraint user_profiles_profile_status_check
        check (profile_status in ('pending', 'active')),
      add constraint user_profiles_activation_check
        check (
          (profile_status = 'pending' and activated_at is null)
          or (
            profile_status = 'active'
            and activated_at is not null
            and activated_at >= created_at
          )
        ),
      add constraint user_profiles_bio_check
        check (
          bio is null
          or (
            char_length(bio) between 1 and 160
            and bio = btrim(bio)
            and public.loop_alias_text_is_safe(bio)
          )
        ),
      add constraint user_profiles_interests_check
        check (
          cardinality(interests) <= 6
          and interests <@ array['MEME', 'DEFI', 'AI', 'GAMEFI', 'NFT', 'RWA']::text[]
          and public.loop_text_array_is_unique(interests)
        );

    comment on column public.user_profiles.profile_status is
      'V2 LOOP ID activation state. pending until POST /v2/profile/loop-id succeeds; active is irreversible.';
    comment on column public.user_profiles.bio is
      'Untrusted V2 display biography, 1-160 code points, same character safety as alias.';
    comment on column public.user_profiles.interests is
      'Deduplicated V2 interest track enum values, at most six.';

    create function public.guard_user_profile_activation_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if old.profile_status = 'active'
        and (
          new.profile_status is distinct from 'active'
          or new.activated_at is distinct from old.activated_at
        )
      then
        raise exception 'profile activation is irreversible'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger user_profiles_activation_guard
      before update on public.user_profiles
      for each row execute function public.guard_user_profile_activation_mutation();

    create table public.privacy_preferences_v2 (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      discoverable boolean not null default false,
      anonymous_mode boolean not null default false,
      total_assets_visibility text not null default 'self',
      mining_power_visibility text not null default 'self',
      communities_visibility text not null default 'self',
      trade_history_visibility text not null default 'self',
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint privacy_preferences_v2_total_assets_check
        check (total_assets_visibility in ('self', 'everyone')),
      constraint privacy_preferences_v2_mining_power_check
        check (mining_power_visibility in ('self', 'everyone')),
      constraint privacy_preferences_v2_communities_check
        check (communities_visibility in ('self', 'everyone')),
      constraint privacy_preferences_v2_trade_history_check
        check (trade_history_visibility in ('self', 'everyone')),
      constraint privacy_preferences_v2_record_version_check
        check (record_version > 0),
      constraint privacy_preferences_v2_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.privacy_preferences_v2 is
      'Fail-closed V2 owner presentation preferences. Independent from the frozen V1 privacy_preferences; no copy-trade field exists.';

    create table public.profile_activation_commands (
      command_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      command_kind text not null default 'activate',
      idempotency_key uuid not null,
      request_digest_version text not null default 'profile_activation_v1',
      request_sha256 text not null,
      contract_version text not null default '2.0',
      request_id uuid not null,
      result_status text not null,
      result_record_version integer not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint profile_activation_commands_kind_key_unique
        unique (command_kind, idempotency_key),
      constraint profile_activation_commands_kind_check
        check (command_kind = 'activate'),
      constraint profile_activation_commands_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint profile_activation_commands_digest_version_check
        check (request_digest_version = 'profile_activation_v1'),
      constraint profile_activation_commands_contract_version_check
        check (contract_version = '2.0'),
      constraint profile_activation_commands_result_status_check
        check (result_status in ('activated', 'already_active')),
      constraint profile_activation_commands_result_version_check
        check (result_record_version > 0)
    );

    comment on table public.profile_activation_commands is
      'Durable owner/route/digest-bound UUID idempotency records for POST /v2/profile/loop-id. Replays return the current profile; a different digest under the same key conflicts.';

    create index profile_activation_commands_owner_created_idx
      on public.profile_activation_commands (owner_user_id, created_at desc, command_id);

    create function public.reject_profile_activation_command_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'profile_activation_commands are permanent'
        using errcode = '55000';
    end;
    $function$;

    create trigger profile_activation_commands_immutable
      before update or delete on public.profile_activation_commands
      for each row execute function public.reject_profile_activation_command_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.profile_activation_commands,
      public.privacy_preferences_v2,
      public.user_profiles,
      public.loop_users
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.profile_activation_commands)
        or exists (select 1 from public.privacy_preferences_v2)
        or exists (
          select 1 from public.user_profiles
          where profile_status <> 'pending'
             or bio is not null
             or cardinality(interests) > 0
        )
      then
        raise exception
          'refusing destructive rollback of v2 LOOP ID profile data'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger profile_activation_commands_immutable
      on public.profile_activation_commands;
    drop function public.reject_profile_activation_command_mutation();
    drop table public.profile_activation_commands;
    drop table public.privacy_preferences_v2;

    drop trigger user_profiles_activation_guard on public.user_profiles;
    drop function public.guard_user_profile_activation_mutation();
    alter table public.user_profiles
      drop constraint user_profiles_interests_check,
      drop constraint user_profiles_bio_check,
      drop constraint user_profiles_activation_check,
      drop constraint user_profiles_profile_status_check,
      drop column interests,
      drop column bio,
      drop column activated_at,
      drop column profile_status;
    drop function public.loop_text_array_is_unique(text[]);

    drop trigger loop_users_loop_id_immutable on public.loop_users;
    drop function public.guard_loop_user_loop_id_mutation();
    alter table public.loop_users
      drop constraint loop_users_loop_id_check,
      drop constraint loop_users_loop_id_unique,
      drop column loop_id;
    drop function public.loop_generate_loop_id();
  `);
}
