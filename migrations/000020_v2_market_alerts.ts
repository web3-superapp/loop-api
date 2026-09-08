import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0034: V2 market facts, the pool-event indexer lane columns, V2
 * price alerts keyed by canonical asset ID, context notifications, and the
 * ten-category V2 notification preferences.
 *
 * Every market number is stored as a canonical decimal string or a
 * `numeric(78, 0)` integer; nothing here is a JavaScript number. Provider raw
 * responses are never stored: only the normalised projection and the SHA-256
 * digest of the raw body.
 */
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
        'communication_command_v1',
        'price_alert_create_v2'
      ));

    create table public.market_fact_cache (
      subject_key text not null,
      fact_kind text not null,
      source text not null,
      value jsonb not null,
      raw_digest text not null,
      fetched_at timestamptz not null,
      ttl_seconds integer not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (subject_key, fact_kind, source),
      constraint market_fact_cache_subject_check
        check (subject_key ~ '^[a-z][a-z0-9]*:[A-Za-z0-9:._-]{1,160}$'),
      constraint market_fact_cache_kind_check
        check (fact_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint market_fact_cache_source_check
        check (source ~ '^[a-z][a-z0-9_]{0,31}$'),
      constraint market_fact_cache_value_check
        check (jsonb_typeof(value) = 'object'),
      constraint market_fact_cache_digest_check
        check (raw_digest ~ '^[0-9a-f]{64}$'),
      constraint market_fact_cache_ttl_check
        check (ttl_seconds between 1 and 86400),
      constraint market_fact_cache_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.market_fact_cache is
      'Normalised market Provider facts with their fetch time, TTL, and the SHA-256 digest of the raw response. A row is evidence of what a Provider said at fetched_at, never a LOOP opinion; expired rows are served only as quality=stale.';

    alter table public.indexed_pool_events
      add column block_timestamp timestamptz,
      add column amount0 numeric(78, 0),
      add column amount1 numeric(78, 0),
      add column sqrt_price_x96 numeric(78, 0);

    alter table public.indexed_pool_events
      add constraint indexed_pool_events_swap_fields_check
      check (
        event_kind <> 'swap'
        or (
          amount0 is not null
          and amount1 is not null
          and sqrt_price_x96 is not null
          and sqrt_price_x96 >= 0
        )
      );

    create index indexed_pool_events_swap_time_idx
      on public.indexed_pool_events (pool_id, block_timestamp, block_number, log_index)
      where event_kind = 'swap' and not removed;

    comment on column public.indexed_pool_events.block_timestamp is
      'Timestamp of the block that carried the log, taken from the RPC log or block header. Candles derived from swaps bucket on this column.';

    alter table public.price_alert_definitions
      alter column asset_key drop not null;
    alter table public.price_alert_definitions
      add column asset_id text,
      add column triggered_at timestamptz,
      add column last_evaluated_at timestamptz;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_state_check;
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_state_check
      check (state in ('inactive', 'active', 'triggered'));
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_asset_identity_check
      check ((asset_key is not null) <> (asset_id is not null));
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_asset_id_check
      check (
        asset_id is null
        or asset_id ~ '^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$'
      );
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_namespace_state_check
      check (
        (asset_id is null and state = 'inactive')
        or (asset_id is not null and state in ('active', 'triggered'))
      );
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_triggered_check
      check ((state = 'triggered') = (triggered_at is not null));

    create index price_alert_definitions_evaluable_idx
      on public.price_alert_definitions (asset_id, id)
      where deleted_at is null and state = 'active';

    comment on column public.price_alert_definitions.asset_id is
      'Canonical lowercase CAIP asset ID written only by V2. Legacy V1 rows keep asset_key and stay inactive; exactly one of the two columns is set per row.';

    alter table public.price_alert_events
      alter column asset_key drop not null;
    alter table public.price_alert_events
      add column asset_id text;
    alter table public.price_alert_events
      add constraint price_alert_events_asset_identity_check
      check ((asset_key is not null) <> (asset_id is not null));
    alter table public.price_alert_events
      add constraint price_alert_events_asset_id_check
      check (
        asset_id is null
        or asset_id ~ '^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$'
      );

    create table public.notifications (
      notification_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      type text not null,
      entity_ref text not null,
      context_route text not null,
      context_params jsonb not null default '{}'::jsonb,
      payload jsonb not null,
      dedupe_key text not null,
      source text,
      observed_at timestamptz,
      read_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      constraint notifications_owner_dedupe_unique
        unique (owner_user_id, dedupe_key),
      constraint notifications_type_check
        check (type in (
          'mining.settlement',
          'mining.weight',
          'launch.round',
          'launch.graduation',
          'trade.result',
          'trade.priceAlert',
          'community.mention',
          'community.announcement',
          'community.all',
          'security.event'
        )),
      constraint notifications_entity_ref_check
        check (entity_ref ~ '^[a-z][A-Za-z0-9]{0,31}:[A-Za-z0-9._:-]{1,160}$'),
      constraint notifications_context_route_check
        check (context_route ~ '^[a-z][a-z0-9-]{0,63}$'),
      constraint notifications_context_params_check
        check (jsonb_typeof(context_params) = 'object'),
      constraint notifications_payload_check
        check (jsonb_typeof(payload) = 'object'),
      constraint notifications_dedupe_key_check
        check (dedupe_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
      constraint notifications_source_check
        check (source is null or source ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint notifications_read_check
        check (read_at is null or read_at >= created_at)
    );

    create index notifications_owner_created_idx
      on public.notifications (owner_user_id, created_at desc, notification_id desc);
    create index notifications_owner_unread_idx
      on public.notifications (owner_user_id)
      where read_at is null;

    comment on table public.notifications is
      'Owner-bound context notifications. Each row names the entity and the client route it belongs to; dedupe_key collapses repeats inside the evaluator window. No push delivery exists: rows are read through the feed only.';

    create table public.notification_preference_v2_versions (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      record_version integer not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint notification_preference_v2_versions_record_version_check
        check (record_version >= 0),
      constraint notification_preference_v2_versions_timestamp_check
        check (updated_at >= created_at)
    );

    create table public.notification_preferences_v2 (
      owner_user_id uuid not null,
      category text not null,
      enabled boolean not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (owner_user_id, category),
      constraint notification_preferences_v2_owner_fk
        foreign key (owner_user_id)
        references public.notification_preference_v2_versions(owner_user_id)
        on delete cascade,
      constraint notification_preferences_v2_category_check
        check (category in (
          'mining.settlement',
          'mining.weight',
          'launch.round',
          'launch.graduation',
          'trade.result',
          'trade.priceAlert',
          'community.mention',
          'community.announcement',
          'community.all'
        )),
      constraint notification_preferences_v2_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.notification_preferences_v2 is
      'V2 ten-category notification intent. security.event is never stored: it is always enabled and a write that tries to disable it is rejected. Enabled rows are intent only; no push Provider exists.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.notification_preferences_v2;
    drop table public.notification_preference_v2_versions;
    drop table public.notifications;

    delete from public.price_alert_events where asset_id is not null;
    alter table public.price_alert_events
      drop constraint price_alert_events_asset_id_check;
    alter table public.price_alert_events
      drop constraint price_alert_events_asset_identity_check;
    alter table public.price_alert_events drop column asset_id;
    alter table public.price_alert_events
      alter column asset_key set not null;

    delete from public.price_alert_definitions where asset_id is not null;
    drop index public.price_alert_definitions_evaluable_idx;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_triggered_check;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_namespace_state_check;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_asset_id_check;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_asset_identity_check;
    alter table public.price_alert_definitions
      drop constraint price_alert_definitions_state_check;
    alter table public.price_alert_definitions
      add constraint price_alert_definitions_state_check
      check (state = 'inactive');
    alter table public.price_alert_definitions
      drop column asset_id,
      drop column triggered_at,
      drop column last_evaluated_at;
    alter table public.price_alert_definitions
      alter column asset_key set not null;

    drop index public.indexed_pool_events_swap_time_idx;
    alter table public.indexed_pool_events
      drop constraint indexed_pool_events_swap_fields_check;
    alter table public.indexed_pool_events
      drop column block_timestamp,
      drop column amount0,
      drop column amount1,
      drop column sqrt_price_x96;

    drop table public.market_fact_cache;

    delete from public.idempotency_records
      where digest_version = 'price_alert_create_v2';
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
  `);
}
