import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in ('sha256_v1', 'perp_intent_request_v1'));
    update public.idempotency_records
      set digest_version = 'perp_intent_request_v1'
      where scope = 'perp_intent_prepare';

    alter table public.provider_operations
      add constraint provider_operations_perp_intent_identity_unique
      unique (
        id,
        owner_user_id,
        domain,
        operation_kind,
        request_sha256
      );

    create table public.perp_intents (
      id uuid primary key,
      owner_user_id uuid not null,
      domain text not null default 'hyperliquid',
      operation_kind text not null default 'perp_intent',
      request_sha256 text not null,
      request_digest_version text not null default 'perp_intent_request_v1',
      action text not null,
      network text not null default 'testnet',
      market text not null default 'core_perps',
      dex text not null default '',
      account_address text not null,
      account_kind text not null,
      binding_version bigint not null,
      canonical_action jsonb not null,
      public_review jsonb not null,
      review_sha256 text not null,
      facts_observed_at timestamptz not null,
      expires_at timestamptz not null,
      state text not null default 'prepared',
      result_observed_at timestamptz,
      result_reason_code text,
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint perp_intents_id_owner_unique
        unique (id, owner_user_id),
      constraint perp_intents_provider_operation_fk
        foreign key (
          id,
          owner_user_id,
          domain,
          operation_kind,
          request_sha256
        )
        references public.provider_operations (
          id,
          owner_user_id,
          domain,
          operation_kind,
          request_sha256
        )
        on delete restrict,
      constraint perp_intents_domain_check
        check (domain = 'hyperliquid'),
      constraint perp_intents_operation_kind_check
        check (operation_kind = 'perp_intent'),
      constraint perp_intents_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint perp_intents_request_digest_version_check
        check (request_digest_version = 'perp_intent_request_v1'),
      constraint perp_intents_action_check
        check (action in (
          'order',
          'cancel',
          'modify',
          'batch_modify',
          'update_leverage',
          'update_isolated_margin'
        )),
      constraint perp_intents_network_check
        check (network = 'testnet'),
      constraint perp_intents_market_check
        check (market = 'core_perps'),
      constraint perp_intents_dex_check
        check (dex = ''),
      constraint perp_intents_account_address_check
        check (
          account_address ~ '^0x[0-9a-f]{40}$'
          and account_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint perp_intents_account_kind_check
        check (account_kind in ('master', 'subaccount')),
      constraint perp_intents_binding_version_check
        check (binding_version > 0),
      constraint perp_intents_canonical_action_check
        check (jsonb_typeof(canonical_action) = 'object'),
      constraint perp_intents_public_review_check
        check (jsonb_typeof(public_review) = 'object'),
      constraint perp_intents_review_sha256_check
        check (review_sha256 ~ '^[0-9a-f]{64}$'),
      constraint perp_intents_review_window_check
        check (facts_observed_at < expires_at),
      constraint perp_intents_state_check
        check (state in (
          'prepared',
          'submitting',
          'accepted',
          'partial',
          'filled',
          'cancelled',
          'rejected',
          'unknown',
          'reconciling',
          'expired'
        )),
      constraint perp_intents_result_reason_code_check
        check (
          result_reason_code is null
          or result_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint perp_intents_record_version_check
        check (record_version >= 0)
    );

    comment on table public.perp_intents is
      'Durable Testnet Core perpetual intent review and lifecycle projection. Account authority remains internal and no signing material or raw provider response is stored.';

    create index perp_intents_owner_created_idx
      on public.perp_intents (owner_user_id, created_at desc, id);
    create index perp_intents_expiry_idx
      on public.perp_intents (expires_at, id)
      where state = 'prepared';

    create table public.perp_intent_items (
      intent_id uuid not null,
      owner_user_id uuid not null,
      item_index smallint not null,
      coin text not null,
      target_kind text,
      target_order_id text,
      target_client_order_id text,
      generated_client_order_id text,
      result_state text,
      result_order_id text,
      result_client_order_id text,
      filled_size text,
      average_fill_price text,
      reason_code text,
      observed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (intent_id, item_index),
      constraint perp_intent_items_intent_owner_fk
        foreign key (intent_id, owner_user_id)
        references public.perp_intents (id, owner_user_id)
        on delete restrict,
      constraint perp_intent_items_index_check
        check (item_index between 0 and 38),
      constraint perp_intent_items_coin_check
        check (coin in ('BTC', 'ETH', 'SOL')),
      constraint perp_intent_items_target_check
        check (
          (
            target_kind is null
            and target_order_id is null
            and target_client_order_id is null
          )
          or
          (
            target_kind = 'order_id'
            and target_order_id ~ '^(0|[1-9][0-9]{0,19})$'
            and target_client_order_id is null
          )
          or
          (
            target_kind = 'client_order_id'
            and target_order_id is null
            and target_client_order_id ~ '^0x[0-9a-f]{32}$'
          )
        ),
      constraint perp_intent_items_target_order_id_uint64_check
        check (
          target_order_id is null
          or length(target_order_id) < 20
          or target_order_id <= '18446744073709551615'
        ),
      constraint perp_intent_items_generated_client_order_id_check
        check (
          generated_client_order_id is null
          or generated_client_order_id ~ '^0x[0-9a-f]{32}$'
        ),
      constraint perp_intent_items_result_state_check
        check (
          result_state is null
          or result_state in (
            'accepted',
            'partial',
            'filled',
            'cancelled',
            'rejected',
            'unknown'
          )
        ),
      constraint perp_intent_items_result_order_id_check
        check (
          result_order_id is null
          or (
            result_order_id ~ '^(0|[1-9][0-9]{0,19})$'
            and (
              length(result_order_id) < 20
              or result_order_id <= '18446744073709551615'
            )
          )
        ),
      constraint perp_intent_items_result_client_order_id_check
        check (
          result_client_order_id is null
          or result_client_order_id ~ '^0x[0-9a-f]{32}$'
        ),
      constraint perp_intent_items_filled_size_check
        check (
          filled_size is null
          or (
            length(filled_size) <= 128
            and filled_size ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
          )
        ),
      constraint perp_intent_items_average_fill_price_check
        check (
          average_fill_price is null
          or (
            length(average_fill_price) <= 128
            and average_fill_price ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
          )
        ),
      constraint perp_intent_items_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint perp_intent_items_result_presence_check
        check (
          (
            result_state is null
            and result_order_id is null
            and result_client_order_id is null
            and filled_size is null
            and average_fill_price is null
            and reason_code is null
            and observed_at is null
          )
          or
          (
            result_state is not null
            and observed_at is not null
          )
        )
    );

    comment on table public.perp_intent_items is
      'Immutable intent item identity plus sanitized authoritative lifecycle facts; it stores neither formatted provider actions nor signing material.';

    create unique index perp_intent_items_generated_cloid_unique
      on public.perp_intent_items (generated_client_order_id)
      where generated_client_order_id is not null;

    create table public.perp_intent_events (
      id uuid primary key default gen_random_uuid(),
      intent_id uuid not null,
      owner_user_id uuid not null,
      request_id uuid not null,
      actor_type text not null,
      event_type text not null,
      from_state text,
      to_state text not null,
      outcome text not null,
      reason_code text,
      intent_version bigint not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint perp_intent_events_intent_owner_fk
        foreign key (intent_id, owner_user_id)
        references public.perp_intents (id, owner_user_id)
        on delete restrict,
      constraint perp_intent_events_intent_version_unique
        unique (intent_id, intent_version),
      constraint perp_intent_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint perp_intent_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint perp_intent_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'prepared',
            'submitting',
            'accepted',
            'partial',
            'filled',
            'cancelled',
            'rejected',
            'unknown',
            'reconciling',
            'expired'
          )
        ),
      constraint perp_intent_events_to_state_check
        check (to_state in (
          'prepared',
          'submitting',
          'accepted',
          'partial',
          'filled',
          'cancelled',
          'rejected',
          'unknown',
          'reconciling',
          'expired'
        )),
      constraint perp_intent_events_initial_transition_check
        check (
          (intent_version = 0 and from_state is null)
          or (intent_version > 0 and from_state is not null)
        ),
      constraint perp_intent_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint perp_intent_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint perp_intent_events_version_check
        check (intent_version >= 0)
    );

    comment on table public.perp_intent_events is
      'Append-only sanitized Perp intent lifecycle events without provider payloads, signatures, nonces, or secret-bearing metadata.';

    create index perp_intent_events_intent_created_idx
      on public.perp_intent_events (intent_id, occurred_at, id);
    create index perp_intent_events_owner_created_idx
      on public.perp_intent_events (owner_user_id, occurred_at desc, id);

    create function public.validate_perp_intent_item_set()
    returns trigger
    language plpgsql
    as $function$
    declare
      checked_intent_id uuid;
      checked_action text;
      item_count bigint;
      target_count bigint;
      generated_count bigint;
      valid_item_set boolean;
    begin
      if tg_argv[0] = 'intent' then
        checked_intent_id := new.id;
      elsif tg_op = 'DELETE' then
        checked_intent_id := old.intent_id;
      else
        checked_intent_id := new.intent_id;
      end if;

      select intent.action
      into checked_action
      from public.perp_intents as intent
      where intent.id = checked_intent_id;

      if not found then
        return null;
      end if;

      select
        count(*),
        count(*) filter (where item.target_kind is not null),
        count(*) filter (where item.generated_client_order_id is not null)
      into item_count, target_count, generated_count
      from public.perp_intent_items as item
      where item.intent_id = checked_intent_id;

      valid_item_set := case checked_action
        when 'order' then
          item_count = 1 and target_count = 0 and generated_count = 1
        when 'cancel' then
          item_count = 1 and target_count = 1 and generated_count = 0
        when 'modify' then
          item_count = 1 and target_count = 1 and generated_count = 1
        when 'batch_modify' then
          item_count between 1 and 39
          and target_count = item_count
          and generated_count = item_count
        when 'update_leverage' then
          item_count = 1 and target_count = 0 and generated_count = 0
        when 'update_isolated_margin' then
          item_count = 1 and target_count = 0 and generated_count = 0
        else false
      end;

      if not valid_item_set then
        raise exception 'perp intent item set does not match its action'
          using errcode = '23514';
      end if;

      return null;
    end;
    $function$;

    create constraint trigger perp_intents_item_set_complete
      after insert or update on public.perp_intents
      deferrable initially deferred
      for each row execute function public.validate_perp_intent_item_set('intent');

    create constraint trigger perp_intent_items_set_complete
      after insert or update or delete on public.perp_intent_items
      deferrable initially deferred
      for each row execute function public.validate_perp_intent_item_set('item');

    create function public.reject_perp_intent_immutable_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.domain is distinct from old.domain
        or new.operation_kind is distinct from old.operation_kind
        or new.request_sha256 is distinct from old.request_sha256
        or new.request_digest_version is distinct from old.request_digest_version
        or new.action is distinct from old.action
        or new.network is distinct from old.network
        or new.market is distinct from old.market
        or new.dex is distinct from old.dex
        or new.account_address is distinct from old.account_address
        or new.account_kind is distinct from old.account_kind
        or new.binding_version is distinct from old.binding_version
        or new.canonical_action is distinct from old.canonical_action
        or new.public_review is distinct from old.public_review
        or new.review_sha256 is distinct from old.review_sha256
        or new.facts_observed_at is distinct from old.facts_observed_at
        or new.expires_at is distinct from old.expires_at
        or new.created_at is distinct from old.created_at
      then
        raise exception 'perp_intents immutable review fields cannot change'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger perp_intents_immutable_fields
      before update on public.perp_intents
      for each row execute function public.reject_perp_intent_immutable_mutation();

    create function public.reject_perp_intent_item_identity_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'perp_intent_items cannot be deleted'
          using errcode = '55000';
      elsif new.intent_id is distinct from old.intent_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.item_index is distinct from old.item_index
        or new.coin is distinct from old.coin
        or new.target_kind is distinct from old.target_kind
        or new.target_order_id is distinct from old.target_order_id
        or new.target_client_order_id is distinct from old.target_client_order_id
        or new.generated_client_order_id is distinct from old.generated_client_order_id
        or new.created_at is distinct from old.created_at
      then
        raise exception 'perp_intent_items immutable identity fields cannot change'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger perp_intent_items_immutable_fields
      before update or delete on public.perp_intent_items
      for each row execute function public.reject_perp_intent_item_identity_mutation();

    create function public.reject_perp_intent_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'perp_intent_events is append-only' using errcode = '55000';
    end;
    $function$;

    create trigger perp_intent_events_append_only
      before update or delete on public.perp_intent_events
      for each row execute function public.reject_perp_intent_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (
        select 1
        from public.provider_operations
        where domain = 'hyperliquid'
          and operation_kind = 'perp_intent'
      ) then
        raise exception
          'cannot roll back 000003_perp_intents while prepared operations exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop table public.perp_intent_events;
    drop function public.reject_perp_intent_event_mutation();
    drop table public.perp_intent_items;
    drop function public.reject_perp_intent_item_identity_mutation();
    drop table public.perp_intents;
    drop function public.reject_perp_intent_immutable_mutation();
    drop function public.validate_perp_intent_item_set();
    alter table public.provider_operations
      drop constraint provider_operations_perp_intent_identity_unique;
    update public.idempotency_records
      set digest_version = 'sha256_v1'
      where scope = 'perp_intent_prepare';
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version = 'sha256_v1');
  `);
}
