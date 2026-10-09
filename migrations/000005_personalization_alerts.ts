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
        'price_alert_create_v1'
      ));

    create table public.user_profiles (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      alias text,
      avatar_ref text,
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint user_profiles_alias_check
        check (
          alias is null
          or (
            char_length(alias) between 1 and 40
            and alias = btrim(alias)
            and alias !~ '[[:cntrl:]]'
          )
        ),
      constraint user_profiles_avatar_ref_check
        check (
          avatar_ref is null
          or avatar_ref ~ '^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$'
        ),
      constraint user_profiles_record_version_check
        check (record_version > 0),
      constraint user_profiles_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.user_profiles is
      'Owner-bound mutable LOOP presentation data. Alias and avatar reference are untrusted display fields, never identity or authorization.';

    create table public.privacy_preferences (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      discoverable boolean not null default false,
      copy_trade_visibility text not null default 'private',
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint privacy_preferences_visibility_check
        check (copy_trade_visibility in ('private', 'followers', 'public')),
      constraint privacy_preferences_record_version_check
        check (record_version > 0),
      constraint privacy_preferences_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.privacy_preferences is
      'Fail-closed owner presentation preferences. Copy-trade visibility is not trading authorization and does not create a relationship graph.';

    create table public.watchlist_versions (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      record_version integer not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint watchlist_versions_record_version_check
        check (record_version >= 0),
      constraint watchlist_versions_timestamp_check
        check (updated_at >= created_at)
    );

    create table public.watchlist_groups (
      owner_user_id uuid not null,
      group_key text not null,
      name text not null,
      position integer not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (owner_user_id, group_key),
      constraint watchlist_groups_owner_fk
        foreign key (owner_user_id)
        references public.watchlist_versions(owner_user_id)
        on delete cascade,
      constraint watchlist_groups_position_unique
        unique (owner_user_id, position),
      constraint watchlist_groups_key_check
        check (group_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
      constraint watchlist_groups_name_check
        check (
          char_length(name) between 1 and 40
          and name = btrim(name)
          and name !~ '[[:cntrl:]]'
        ),
      constraint watchlist_groups_position_check
        check (position between 0 and 19),
      constraint watchlist_groups_timestamp_check
        check (updated_at >= created_at)
    );

    create table public.watchlist_items (
      owner_user_id uuid not null,
      group_key text not null,
      asset_key text not null,
      position integer not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (owner_user_id, group_key, asset_key),
      constraint watchlist_items_group_fk
        foreign key (owner_user_id, group_key)
        references public.watchlist_groups(owner_user_id, group_key)
        on delete cascade,
      constraint watchlist_items_position_unique
        unique (owner_user_id, group_key, position),
      constraint watchlist_items_asset_key_check
        check (asset_key ~ '^[A-Z0-9][A-Z0-9:_-]{0,63}$'),
      constraint watchlist_items_position_check
        check (position between 0 and 99),
      constraint watchlist_items_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.watchlist_versions is
      'Owner-level optimistic version used to atomically reconcile the complete grouped Watchlist snapshot.';
    comment on table public.watchlist_groups is
      'Owner-local ordered Watchlist group presentation. Group keys are not authorization identifiers.';
    comment on table public.watchlist_items is
      'Ordered opaque asset references only; rows are not proof that a market exists or is tradable.';

    create table public.price_alert_definitions (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      create_idempotency_record_id uuid not null unique,
      create_request_sha256 text not null,
      asset_key text not null,
      condition text not null,
      threshold_decimal text not null,
      expires_at timestamptz,
      state text not null default 'inactive',
      deleted_at timestamptz,
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint price_alert_definitions_id_owner_unique
        unique (id, owner_user_id),
      constraint price_alert_definitions_idempotency_fk
        foreign key (
          create_idempotency_record_id,
          owner_user_id,
          create_request_sha256
        )
        references public.idempotency_records (
          id,
          owner_user_id,
          request_sha256
        )
        on delete restrict,
      constraint price_alert_definitions_request_sha256_check
        check (create_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint price_alert_definitions_asset_key_check
        check (asset_key ~ '^[A-Z0-9][A-Z0-9:_-]{0,63}$'),
      constraint price_alert_definitions_condition_check
        check (condition in ('above', 'at_or_above', 'below', 'at_or_below')),
      constraint price_alert_definitions_threshold_check
        check (
          length(threshold_decimal) <= 96
          and threshold_decimal ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
        ),
      constraint price_alert_definitions_state_check
        check (state = 'inactive'),
      constraint price_alert_definitions_record_version_check
        check (record_version > 0),
      constraint price_alert_definitions_expiry_check
        check (expires_at is null or expires_at > created_at),
      constraint price_alert_definitions_deletion_check
        check (deleted_at is null or deleted_at >= created_at),
      constraint price_alert_definitions_timestamp_check
        check (updated_at >= created_at)
    );

    create index price_alert_definitions_owner_created_idx
      on public.price_alert_definitions (owner_user_id, created_at desc, id)
      where deleted_at is null;

    create table public.notification_preference_versions (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      record_version integer not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint notification_preference_versions_record_version_check
        check (record_version >= 0),
      constraint notification_preference_versions_timestamp_check
        check (updated_at >= created_at)
    );

    create table public.notification_preferences (
      owner_user_id uuid not null,
      event_type text not null,
      enabled boolean not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (owner_user_id, event_type),
      constraint notification_preferences_owner_fk
        foreign key (owner_user_id)
        references public.notification_preference_versions(owner_user_id)
        on delete cascade,
      constraint notification_preferences_event_type_check
        check (event_type in (
          'price_alert_triggered',
          'provider_activity_projected',
          'security_notice',
          'support_update'
        )),
      constraint notification_preferences_timestamp_check
        check (updated_at >= created_at)
    );

    create table public.price_alert_events (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null,
      alert_id uuid not null,
      asset_key text not null,
      condition text not null,
      threshold_decimal text not null,
      value_decimal text not null,
      source text not null,
      source_fact_ref text not null,
      observed_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint price_alert_events_alert_owner_fk
        foreign key (alert_id, owner_user_id)
        references public.price_alert_definitions(id, owner_user_id)
        on delete restrict,
      constraint price_alert_events_asset_key_check
        check (asset_key ~ '^[A-Z0-9][A-Z0-9:_-]{0,63}$'),
      constraint price_alert_events_condition_check
        check (condition in ('above', 'at_or_above', 'below', 'at_or_below')),
      constraint price_alert_events_threshold_check
        check (
          length(threshold_decimal) <= 96
          and threshold_decimal ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
        ),
      constraint price_alert_events_value_check
        check (
          length(value_decimal) <= 96
          and value_decimal ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
        ),
      constraint price_alert_events_source_check
        check (source ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint price_alert_events_source_fact_ref_check
        check (
          char_length(source_fact_ref) between 1 and 128
          and source_fact_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
      constraint price_alert_events_observation_check
        check (observed_at <= created_at)
    );

    create index price_alert_events_owner_created_idx
      on public.price_alert_events (owner_user_id, created_at desc, id desc);

    comment on table public.price_alert_definitions is
      'Owner-bound inactive price-alert definitions. Rows do not imply a running evaluator, market-data authority, or delivery path.';
    comment on table public.notification_preferences is
      'Owner delivery intent only. Enabled rows do not imply Firebase, APNs, FCM, inbox, or provider availability.';
    comment on table public.price_alert_events is
      'Append-only sanitized authoritative trigger history for a future internal evaluator. No public writer exists.';

    create function public.reject_price_alert_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'price_alert_events is append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger price_alert_events_append_only
      before update or delete on public.price_alert_events
      for each row execute function public.reject_price_alert_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.idempotency_records,
      public.user_profiles,
      public.privacy_preferences,
      public.watchlist_versions,
      public.watchlist_groups,
      public.watchlist_items,
      public.price_alert_definitions,
      public.notification_preference_versions,
      public.notification_preferences,
      public.price_alert_events
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.user_profiles)
        or exists (select 1 from public.privacy_preferences)
        or exists (select 1 from public.watchlist_versions)
        or exists (select 1 from public.price_alert_definitions)
        or exists (select 1 from public.notification_preference_versions)
        or exists (select 1 from public.price_alert_events)
        or exists (
          select 1 from public.idempotency_records
          where digest_version = 'price_alert_create_v1'
             or scope = 'price_alert_create'
        )
      then
        raise exception
          'cannot roll back 000005_personalization_alerts while personalization or alert records exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop table public.price_alert_events;
    drop function public.reject_price_alert_event_mutation();
    drop table public.notification_preferences;
    drop table public.notification_preference_versions;
    drop table public.price_alert_definitions;
    drop table public.watchlist_items;
    drop table public.watchlist_groups;
    drop table public.watchlist_versions;
    drop table public.privacy_preferences;
    drop table public.user_profiles;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1'
      ));
  `);
}
