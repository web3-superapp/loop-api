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
        'spot_agent_authorization_issue_v1'
      ));
    create table public.spot_agent_identities (
      id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      network text not null default 'testnet',
      binding_version bigint not null,
      agent_address text not null,
      agent_name text not null,
      signer_ref text not null,
      lifecycle_state text not null default 'reserved',
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint spot_agent_identities_id_owner_unique
        unique (id, owner_user_id),
      constraint spot_agent_identities_binding_unique
        unique (
          id,
          owner_user_id,
          binding_version,
          agent_address,
          agent_name
        ),
      constraint spot_agent_identities_id_owner_epoch_unique
        unique (id, owner_user_id, binding_version),
      constraint spot_agent_identities_owner_epoch_unique
        unique (owner_user_id, network, binding_version),
      constraint spot_agent_identities_address_unique
        unique (agent_address),
      constraint spot_agent_identities_signer_ref_unique
        unique (signer_ref),
      constraint spot_agent_identities_network_check
        check (network = 'testnet'),
      constraint spot_agent_identities_binding_version_check
        check (binding_version > 0),
      constraint spot_agent_identities_address_check
        check (
          agent_address ~ '^0x[0-9a-f]{40}$'
          and agent_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint spot_agent_identities_name_check
        check (
          char_length(agent_name) between 1 and 64
          and agent_name = btrim(agent_name)
          and agent_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
        ),
      constraint spot_agent_identities_signer_ref_check
        check (
          char_length(signer_ref) between 1 and 255
          and signer_ref = btrim(signer_ref)
          and signer_ref !~ '[[:cntrl:]]'
        ),
      constraint spot_agent_identities_lifecycle_state_check
        check (lifecycle_state in (
          'reserved',
          'authorization_pending',
          'active',
          'revoked',
          'retired',
          'operator_hold'
        )),
      constraint spot_agent_identities_record_version_check
        check (record_version >= 0),
      constraint spot_agent_identities_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.spot_agent_identities is
      'Owner-, Testnet-, and wallet-epoch-bound Spot Agent identities. signer_ref is an opaque internal remote-custody reference; no private key, token, signature, nonce, or raw provider payload is stored.';

    create index spot_agent_identities_owner_created_idx
      on public.spot_agent_identities (owner_user_id, created_at desc, id);

    create table public.spot_agent_identity_events (
      id uuid primary key default gen_random_uuid(),
      agent_identity_id uuid not null,
      owner_user_id uuid not null,
      request_id uuid not null,
      actor_type text not null,
      event_type text not null,
      from_state text,
      to_state text not null,
      outcome text not null,
      reason_code text,
      identity_version bigint not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint spot_agent_identity_events_owner_fk
        foreign key (agent_identity_id, owner_user_id)
        references public.spot_agent_identities (id, owner_user_id)
        on delete restrict,
      constraint spot_agent_identity_events_version_unique
        unique (agent_identity_id, identity_version),
      constraint spot_agent_identity_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint spot_agent_identity_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_agent_identity_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'reserved',
            'authorization_pending',
            'active',
            'revoked',
            'retired',
            'operator_hold'
          )
        ),
      constraint spot_agent_identity_events_to_state_check
        check (to_state in (
          'reserved',
          'authorization_pending',
          'active',
          'revoked',
          'retired',
          'operator_hold'
        )),
      constraint spot_agent_identity_events_initial_transition_check
        check (
          (identity_version = 0 and from_state is null)
          or (identity_version > 0 and from_state is not null)
        ),
      constraint spot_agent_identity_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_agent_identity_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint spot_agent_identity_events_version_check
        check (identity_version >= 0)
    );

    comment on table public.spot_agent_identity_events is
      'Append-only sanitized Spot Agent identity lifecycle history without signer references or authority-bearing material.';

    create index spot_agent_identity_events_owner_created_idx
      on public.spot_agent_identity_events (
        owner_user_id,
        occurred_at desc,
        id
      );

    create table public.spot_intents (
      id uuid primary key,
      owner_user_id uuid not null,
      domain text not null default 'hyperliquid',
      operation_kind text not null default 'spot_intent',
      request_sha256 text not null,
      request_digest_version text not null default 'spot_intent_request_v1',
      network text not null default 'testnet',
      market_id uuid not null,
      provider_coin text not null,
      base_token_index integer not null,
      base_token_id text not null,
      quote_token_index integer not null,
      quote_token_id text not null,
      spot_pair_index integer not null,
      exchange_order_asset integer not null,
      metadata_version text not null,
      metadata_sha256 text not null,
      policy_version text not null,
      side text not null,
      amount_mode text not null,
      amount_value text not null,
      computed_base_size text not null,
      reference_price text not null,
      worst_ioc_limit_price text not null,
      maximum_spend_or_minimum_receive text not null,
      fee_rate text not null,
      fee_estimate text not null,
      account_address text not null,
      account_kind text not null default 'master',
      binding_version bigint not null,
      agent_identity_id uuid not null,
      client_order_id text not null,
      canonical_action jsonb not null,
      public_review jsonb not null,
      review_sha256 text not null,
      facts_observed_at timestamptz not null,
      reference_source_time timestamptz not null,
      expires_at timestamptz not null,
      state text not null default 'prepared',
      provider_order_id text,
      filled_base_size text,
      filled_quote_amount text,
      average_fill_price text,
      result_fee_amount text,
      result_fee_token_index integer,
      result_fee_token_id text,
      result_fee_asset_display_identity text,
      result_observed_at timestamptz,
      result_reason_code text,
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint spot_intents_id_owner_unique
        unique (id, owner_user_id),
      constraint spot_intents_provider_operation_fk
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
      constraint spot_intents_agent_identity_fk
        foreign key (
          agent_identity_id,
          owner_user_id,
          binding_version
        )
        references public.spot_agent_identities (
          id,
          owner_user_id,
          binding_version
        )
        on delete restrict,
      constraint spot_intents_domain_check
        check (domain = 'hyperliquid'),
      constraint spot_intents_operation_kind_check
        check (operation_kind = 'spot_intent'),
      constraint spot_intents_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_intents_request_digest_version_check
        check (request_digest_version = 'spot_intent_request_v1'),
      constraint spot_intents_network_check
        check (network = 'testnet'),
      constraint spot_intents_provider_coin_check
        check (
          char_length(provider_coin) between 2 and 64
          and provider_coin ~ '^([A-Z0-9][A-Z0-9._-]{0,30}/[A-Z0-9][A-Z0-9._-]{0,30}|@(0|[1-9][0-9]{0,9}))$'
        ),
      constraint spot_intents_token_index_check
        check (
          base_token_index >= 0
          and quote_token_index >= 0
          and base_token_index <> quote_token_index
        ),
      constraint spot_intents_token_id_check
        check (
          base_token_id ~ '^0x[0-9a-f]{32}$'
          and quote_token_id ~ '^0x[0-9a-f]{32}$'
          and base_token_id <> quote_token_id
        ),
      constraint spot_intents_pair_index_check
        check (spot_pair_index >= 0),
      constraint spot_intents_exchange_order_asset_check
        check (exchange_order_asset = 10000 + spot_pair_index),
      constraint spot_intents_metadata_version_check
        check (
          char_length(metadata_version) between 1 and 128
          and metadata_version ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
        ),
      constraint spot_intents_metadata_sha256_check
        check (metadata_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_intents_policy_version_check
        check (policy_version ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_intents_side_check
        check (side in ('buy', 'sell')),
      constraint spot_intents_amount_mode_check
        check (amount_mode in ('quote', 'base')),
      constraint spot_intents_natural_amount_pairing_check
        check (
          (side = 'buy' and amount_mode = 'quote')
          or (side = 'sell' and amount_mode = 'base')
        ),
      constraint spot_intents_amount_value_check
        check (
          length(amount_value) <= 128
          and amount_value ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
        ),
      constraint spot_intents_computed_base_size_check
        check (
          length(computed_base_size) <= 128
          and computed_base_size ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
        ),
      constraint spot_intents_reference_price_check
        check (
          length(reference_price) <= 128
          and reference_price ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
        ),
      constraint spot_intents_worst_ioc_limit_price_check
        check (
          length(worst_ioc_limit_price) <= 128
          and worst_ioc_limit_price ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
        ),
      constraint spot_intents_reviewed_bound_check
        check (
          length(maximum_spend_or_minimum_receive) <= 128
          and maximum_spend_or_minimum_receive ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
        ),
      constraint spot_intents_fee_rate_check
        check (
          length(fee_rate) <= 128
          and fee_rate ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
        ),
      constraint spot_intents_fee_estimate_check
        check (
          length(fee_estimate) <= 128
          and fee_estimate ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
        ),
      constraint spot_intents_account_address_check
        check (
          account_address ~ '^0x[0-9a-f]{40}$'
          and account_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint spot_intents_account_kind_check
        check (account_kind = 'master'),
      constraint spot_intents_binding_version_check
        check (binding_version > 0),
      constraint spot_intents_client_order_id_check
        check (client_order_id ~ '^0x[0-9a-f]{32}$'),
      constraint spot_intents_client_order_id_unique
        unique (client_order_id),
      constraint spot_intents_canonical_action_check
        check (jsonb_typeof(canonical_action) = 'object'),
      constraint spot_intents_public_review_check
        check (jsonb_typeof(public_review) = 'object'),
      constraint spot_intents_review_sha256_check
        check (review_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_intents_review_window_check
        check (
          reference_source_time <= facts_observed_at
          and facts_observed_at <= created_at
          and created_at < expires_at
        ),
      constraint spot_intents_state_check
        check (state in (
          'prepared',
          'submitting',
          'accepted',
          'partially_filled',
          'filled',
          'not_filled',
          'rejected',
          'unknown',
          'reconciling',
          'operator_required',
          'expired'
        )),
      constraint spot_intents_provider_order_id_check
        check (
          provider_order_id is null
          or (
            provider_order_id ~ '^(0|[1-9][0-9]{0,19})$'
            and (
              length(provider_order_id) < 20
              or provider_order_id <= '18446744073709551615'
            )
          )
        ),
      constraint spot_intents_filled_base_size_check
        check (
          filled_base_size is null
          or (
            length(filled_base_size) <= 128
            and filled_base_size ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
          )
        ),
      constraint spot_intents_filled_quote_amount_check
        check (
          filled_quote_amount is null
          or (
            length(filled_quote_amount) <= 128
            and filled_quote_amount ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
          )
        ),
      constraint spot_intents_average_fill_price_check
        check (
          average_fill_price is null
          or (
            length(average_fill_price) <= 128
            and average_fill_price ~ '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
          )
        ),
      constraint spot_intents_result_fee_amount_check
        check (
          result_fee_amount is null
          or (
            length(result_fee_amount) <= 128
            and result_fee_amount ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
          )
        ),
      constraint spot_intents_result_fee_identity_check
        check (
          (
            result_fee_amount is null
            and result_fee_token_index is null
            and result_fee_token_id is null
            and result_fee_asset_display_identity is null
          )
          or (
            result_fee_amount is not null
            and result_fee_token_index is not null
            and result_fee_token_id is not null
            and result_fee_asset_display_identity is not null
            and result_fee_asset_display_identity ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
            and (
              (
                result_fee_token_index = base_token_index
                and result_fee_token_id = base_token_id
              )
              or (
                result_fee_token_index = quote_token_index
                and result_fee_token_id = quote_token_id
              )
            )
          )
        ),
      constraint spot_intents_result_reason_code_check
        check (
          result_reason_code is null
          or result_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint spot_intents_result_presence_check
        check (
          (
            state in ('prepared', 'submitting')
            and provider_order_id is null
            and filled_base_size is null
            and filled_quote_amount is null
            and average_fill_price is null
            and result_fee_amount is null
            and result_fee_token_index is null
            and result_fee_token_id is null
            and result_fee_asset_display_identity is null
            and result_observed_at is null
            and result_reason_code is null
          )
          or (
            state not in ('prepared', 'submitting')
            and result_observed_at is not null
          )
        ),
      constraint spot_intents_fill_presence_check
        check (
          (
            state in ('partially_filled', 'filled')
            and filled_base_size is not null
            and filled_quote_amount is not null
            and average_fill_price is not null
            and result_fee_amount is not null
            and result_fee_token_index is not null
            and result_fee_token_id is not null
            and result_fee_asset_display_identity is not null
          )
          or (
            state not in ('partially_filled', 'filled')
            and filled_base_size is null
            and filled_quote_amount is null
            and average_fill_price is null
            and result_fee_amount is null
            and result_fee_token_index is null
            and result_fee_token_id is null
            and result_fee_asset_display_identity is null
          )
        ),
      constraint spot_intents_record_version_check
        check (record_version >= 0),
      constraint spot_intents_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.spot_intents is
      'Durable one-order Testnet Spot review and authoritative lifecycle projection. Internal provider identifiers are never client authority; no key, signature, nonce, token, or raw provider response is stored.';

    create index spot_intents_owner_created_idx
      on public.spot_intents (owner_user_id, created_at desc, id);
    create index spot_intents_expiry_idx
      on public.spot_intents (expires_at, id)
      where state = 'prepared';

    create table public.spot_intent_events (
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
      constraint spot_intent_events_owner_fk
        foreign key (intent_id, owner_user_id)
        references public.spot_intents (id, owner_user_id)
        on delete restrict,
      constraint spot_intent_events_version_unique
        unique (intent_id, intent_version),
      constraint spot_intent_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint spot_intent_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_intent_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'prepared', 'submitting', 'accepted', 'partially_filled', 'filled',
            'not_filled', 'rejected', 'unknown', 'reconciling',
            'operator_required', 'expired'
          )
        ),
      constraint spot_intent_events_to_state_check
        check (to_state in (
          'prepared', 'submitting', 'accepted', 'partially_filled', 'filled',
          'not_filled', 'rejected', 'unknown', 'reconciling',
          'operator_required', 'expired'
        )),
      constraint spot_intent_events_initial_transition_check
        check (
          (intent_version = 0 and from_state is null)
          or (intent_version > 0 and from_state is not null)
        ),
      constraint spot_intent_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_intent_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint spot_intent_events_version_check
        check (intent_version >= 0)
    );

    comment on table public.spot_intent_events is
      'Append-only sanitized Spot intent lifecycle events without provider payloads, signatures, nonces, addresses, or secret-bearing metadata.';

    create index spot_intent_events_owner_created_idx
      on public.spot_intent_events (owner_user_id, occurred_at desc, id);

    create table public.spot_agent_authorizations (
      id uuid primary key,
      owner_user_id uuid not null,
      domain text not null default 'hyperliquid',
      operation_kind text not null default 'spot_agent_authorization',
      request_sha256 text not null,
      request_digest_version text not null
        default 'spot_agent_authorization_issue_v1',
      agent_identity_id uuid not null,
      network text not null default 'testnet',
      action text not null default 'approve_agent',
      account_address text not null,
      account_kind text not null default 'master',
      binding_version bigint not null,
      signer_wallet_address text not null,
      agent_address text not null,
      agent_name text not null,
      authorization_nonce numeric not null,
      agent_valid_until timestamptz not null,
      public_review jsonb not null,
      review_sha256 text not null,
      typed_data_primary_type text not null,
      signing_digest text not null,
      typed_data_json_sha256 text not null,
      signing_expires_at timestamptz not null,
      state text not null default 'prepared',
      result_observed_at timestamptz,
      result_reason_code text,
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint spot_agent_authorizations_id_owner_unique
        unique (id, owner_user_id),
      constraint spot_agent_authorizations_provider_operation_fk
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
      constraint spot_agent_authorizations_agent_identity_fk
        foreign key (
          agent_identity_id,
          owner_user_id,
          binding_version,
          agent_address,
          agent_name
        )
        references public.spot_agent_identities (
          id,
          owner_user_id,
          binding_version,
          agent_address,
          agent_name
        )
        on delete restrict,
      constraint spot_agent_authorizations_domain_check
        check (domain = 'hyperliquid'),
      constraint spot_agent_authorizations_operation_kind_check
        check (operation_kind = 'spot_agent_authorization'),
      constraint spot_agent_authorizations_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_agent_authorizations_request_digest_version_check
        check (
          request_digest_version = 'spot_agent_authorization_issue_v1'
        ),
      constraint spot_agent_authorizations_network_check
        check (network = 'testnet'),
      constraint spot_agent_authorizations_action_check
        check (action = 'approve_agent'),
      constraint spot_agent_authorizations_account_address_check
        check (
          account_address ~ '^0x[0-9a-f]{40}$'
          and account_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint spot_agent_authorizations_account_kind_check
        check (account_kind = 'master'),
      constraint spot_agent_authorizations_binding_version_check
        check (binding_version > 0),
      constraint spot_agent_authorizations_signer_wallet_address_check
        check (
          signer_wallet_address = account_address
          and signer_wallet_address ~ '^0x[0-9a-f]{40}$'
          and signer_wallet_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint spot_agent_authorizations_agent_address_check
        check (
          agent_address ~ '^0x[0-9a-f]{40}$'
          and agent_address <> '0x0000000000000000000000000000000000000000'
          and agent_address <> signer_wallet_address
        ),
      constraint spot_agent_authorizations_agent_name_check
        check (
          char_length(agent_name) between 1 and 64
          and agent_name = btrim(agent_name)
          and agent_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
        ),
      constraint spot_agent_authorizations_nonce_check
        check (
          authorization_nonce >= 0
          and authorization_nonce = trunc(authorization_nonce)
          and authorization_nonce <= 18446744073709551615
        ),
      constraint spot_agent_authorizations_public_review_check
        check (jsonb_typeof(public_review) = 'object'),
      constraint spot_agent_authorizations_review_sha256_check
        check (review_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_agent_authorizations_primary_type_check
        check (
          typed_data_primary_type = 'HyperliquidTransaction:ApproveAgent'
        ),
      constraint spot_agent_authorizations_signing_digest_check
        check (signing_digest ~ '^0x[0-9a-f]{64}$'),
      constraint spot_agent_authorizations_typed_data_json_sha256_check
        check (typed_data_json_sha256 ~ '^[0-9a-f]{64}$'),
      constraint spot_agent_authorizations_signing_window_check
        check (
          created_at < signing_expires_at
          and signing_expires_at <= agent_valid_until
        ),
      constraint spot_agent_authorizations_state_check
        check (state in (
          'prepared',
          'submitting',
          'accepted',
          'active',
          'rejected',
          'failed',
          'unknown',
          'reconciling',
          'operator_required',
          'expired'
        )),
      constraint spot_agent_authorizations_result_reason_code_check
        check (
          result_reason_code is null
          or result_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint spot_agent_authorizations_result_presence_check
        check (
          (
            state in ('prepared', 'submitting')
            and result_observed_at is null
            and result_reason_code is null
          )
          or (
            state not in ('prepared', 'submitting')
            and result_observed_at is not null
          )
        ),
      constraint spot_agent_authorizations_record_version_check
        check (record_version >= 0),
      constraint spot_agent_authorizations_signer_digest_unique
        unique (signer_wallet_address, signing_digest),
      constraint spot_agent_authorizations_signer_payload_hash_unique
        unique (signer_wallet_address, typed_data_json_sha256),
      constraint spot_agent_authorizations_signer_nonce_unique
        unique (network, signer_wallet_address, authorization_nonce),
      constraint spot_agent_authorizations_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.spot_agent_authorizations is
      'Durable one-time Testnet approveAgent handoff. It stores the canonical nonce and digest bindings but no typed-data JSON, signature, signed bytes, key, token, wallet ID, or raw provider response.';

    create unique index spot_agent_authorizations_live_identity_unique
      on public.spot_agent_authorizations (agent_identity_id)
      where state in (
        'prepared',
        'submitting',
        'accepted',
        'active',
        'unknown',
        'reconciling',
        'operator_required'
      );
    create index spot_agent_authorizations_owner_created_idx
      on public.spot_agent_authorizations (owner_user_id, created_at desc, id);
    create index spot_agent_authorizations_expiry_idx
      on public.spot_agent_authorizations (signing_expires_at, id)
      where state = 'prepared';

    create table public.spot_agent_authorization_events (
      id uuid primary key default gen_random_uuid(),
      authorization_id uuid not null,
      owner_user_id uuid not null,
      request_id uuid not null,
      actor_type text not null,
      event_type text not null,
      from_state text,
      to_state text not null,
      outcome text not null,
      reason_code text,
      authorization_version bigint not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint spot_agent_authorization_events_owner_fk
        foreign key (authorization_id, owner_user_id)
        references public.spot_agent_authorizations (id, owner_user_id)
        on delete restrict,
      constraint spot_agent_authorization_events_version_unique
        unique (authorization_id, authorization_version),
      constraint spot_agent_authorization_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint spot_agent_authorization_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_agent_authorization_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'prepared', 'submitting', 'accepted', 'active', 'rejected',
            'failed', 'unknown', 'reconciling', 'operator_required', 'expired'
          )
        ),
      constraint spot_agent_authorization_events_to_state_check
        check (to_state in (
          'prepared', 'submitting', 'accepted', 'active', 'rejected',
          'failed', 'unknown', 'reconciling', 'operator_required', 'expired'
        )),
      constraint spot_agent_authorization_events_initial_transition_check
        check (
          (authorization_version = 0 and from_state is null)
          or (authorization_version > 0 and from_state is not null)
        ),
      constraint spot_agent_authorization_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint spot_agent_authorization_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint spot_agent_authorization_events_version_check
        check (authorization_version >= 0)
    );

    comment on table public.spot_agent_authorization_events is
      'Append-only sanitized Spot Agent authorization history without typed data, signatures, nonces, addresses, or provider payloads.';

    create index spot_agent_authorization_events_owner_created_idx
      on public.spot_agent_authorization_events (
        owner_user_id,
        occurred_at desc,
        id
      );

    create table public.hyperliquid_signer_nonce_state (
      network text not null,
      signer_address text not null,
      signer_kind text not null,
      last_allocated_nonce numeric not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (network, signer_address),
      constraint hyperliquid_signer_nonce_state_identity_unique
        unique (network, signer_address, signer_kind),
      constraint hyperliquid_signer_nonce_state_network_check
        check (network = 'testnet'),
      constraint hyperliquid_signer_nonce_state_address_check
        check (
          signer_address ~ '^0x[0-9a-f]{40}$'
          and signer_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint hyperliquid_signer_nonce_state_kind_check
        check (signer_kind in ('owner_wallet', 'spot_agent')),
      constraint hyperliquid_signer_nonce_state_nonce_check
        check (
          last_allocated_nonce >= 0
          and last_allocated_nonce = trunc(last_allocated_nonce)
          and last_allocated_nonce <= 18446744073709551615
        ),
      constraint hyperliquid_signer_nonce_state_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.hyperliquid_signer_nonce_state is
      'Persistent Testnet nonce high-water marks. Nonces are internal authority and are never returned to ordinary resource reads.';

    create table public.hyperliquid_signer_nonce_allocations (
      operation_id uuid primary key,
      owner_user_id uuid not null,
      network text not null,
      signer_address text not null,
      signer_kind text not null,
      purpose text not null,
      nonce numeric not null,
      allocated_at timestamptz not null default clock_timestamp(),
      constraint hyperliquid_signer_nonce_allocations_operation_owner_fk
        foreign key (operation_id, owner_user_id)
        references public.provider_operations (id, owner_user_id)
        on delete restrict,
      constraint hyperliquid_signer_nonce_allocations_signer_fk
        foreign key (network, signer_address, signer_kind)
        references public.hyperliquid_signer_nonce_state (
          network,
          signer_address,
          signer_kind
        )
        on delete restrict,
      constraint hyperliquid_signer_nonce_allocations_nonce_unique
        unique (network, signer_address, nonce),
      constraint hyperliquid_signer_nonce_allocations_network_check
        check (network = 'testnet'),
      constraint hyperliquid_signer_nonce_allocations_address_check
        check (
          signer_address ~ '^0x[0-9a-f]{40}$'
          and signer_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint hyperliquid_signer_nonce_allocations_kind_check
        check (signer_kind in ('owner_wallet', 'spot_agent')),
      constraint hyperliquid_signer_nonce_allocations_purpose_check
        check (purpose in ('spot_ioc_order', 'spot_agent_authorization')),
      constraint hyperliquid_signer_nonce_allocations_nonce_check
        check (
          nonce >= 0
          and nonce = trunc(nonce)
          and nonce <= 18446744073709551615
        )
    );

    comment on table public.hyperliquid_signer_nonce_allocations is
      'Append-only per-operation nonce allocation. Agent-authorization nonces are reserved at issue time because they enter the one-time signing payload; Spot order nonces are allocated with the one-attempt journal. It is never a client-visible resource.';

    create function public.enforce_spot_agent_identity_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'spot_agent_identities cannot be deleted'
          using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.lifecycle_state <> 'reserved' or new.record_version <> 0 then
          raise exception 'spot_agent_identities must start reserved at version zero'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.network is distinct from old.network
        or new.binding_version is distinct from old.binding_version
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.signer_ref is distinct from old.signer_ref
        or new.created_at is distinct from old.created_at
      then
        raise exception 'spot_agent_identities immutable authority cannot change'
          using errcode = '55000';
      end if;

      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
        or not (
          (old.lifecycle_state = 'reserved' and new.lifecycle_state in (
            'authorization_pending', 'retired', 'operator_hold'
          ))
          or (
            old.lifecycle_state = 'authorization_pending'
            and new.lifecycle_state in (
              'reserved', 'active', 'revoked', 'retired', 'operator_hold'
            )
          )
          or (
            old.lifecycle_state = 'active'
            and new.lifecycle_state in ('revoked', 'retired', 'operator_hold')
          )
        )
      then
        raise exception 'invalid Spot Agent identity transition'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger spot_agent_identities_transition_guard
      before insert or update or delete on public.spot_agent_identities
      for each row execute function public.enforce_spot_agent_identity_transition();

    create function public.enforce_spot_intent_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'spot_intents cannot be deleted' using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.state <> 'prepared' or new.record_version <> 0 then
          raise exception 'spot_intents must start prepared at version zero'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.domain is distinct from old.domain
        or new.operation_kind is distinct from old.operation_kind
        or new.request_sha256 is distinct from old.request_sha256
        or new.request_digest_version is distinct from old.request_digest_version
        or new.network is distinct from old.network
        or new.market_id is distinct from old.market_id
        or new.provider_coin is distinct from old.provider_coin
        or new.base_token_index is distinct from old.base_token_index
        or new.base_token_id is distinct from old.base_token_id
        or new.quote_token_index is distinct from old.quote_token_index
        or new.quote_token_id is distinct from old.quote_token_id
        or new.spot_pair_index is distinct from old.spot_pair_index
        or new.exchange_order_asset is distinct from old.exchange_order_asset
        or new.metadata_version is distinct from old.metadata_version
        or new.metadata_sha256 is distinct from old.metadata_sha256
        or new.policy_version is distinct from old.policy_version
        or new.side is distinct from old.side
        or new.amount_mode is distinct from old.amount_mode
        or new.amount_value is distinct from old.amount_value
        or new.computed_base_size is distinct from old.computed_base_size
        or new.reference_price is distinct from old.reference_price
        or new.worst_ioc_limit_price is distinct from old.worst_ioc_limit_price
        or new.maximum_spend_or_minimum_receive is distinct from old.maximum_spend_or_minimum_receive
        or new.fee_rate is distinct from old.fee_rate
        or new.fee_estimate is distinct from old.fee_estimate
        or new.account_address is distinct from old.account_address
        or new.account_kind is distinct from old.account_kind
        or new.binding_version is distinct from old.binding_version
        or new.agent_identity_id is distinct from old.agent_identity_id
        or new.client_order_id is distinct from old.client_order_id
        or new.canonical_action is distinct from old.canonical_action
        or new.public_review is distinct from old.public_review
        or new.review_sha256 is distinct from old.review_sha256
        or new.facts_observed_at is distinct from old.facts_observed_at
        or new.reference_source_time is distinct from old.reference_source_time
        or new.expires_at is distinct from old.expires_at
        or new.created_at is distinct from old.created_at
      then
        raise exception 'spot_intents immutable review authority cannot change'
          using errcode = '55000';
      end if;

      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
        or not (
          (old.state = 'prepared' and new.state in ('submitting', 'expired'))
          or (
            old.state = 'submitting'
            and new.state in (
              'accepted', 'partially_filled', 'filled', 'not_filled', 'rejected',
              'unknown'
            )
          )
          or (
            old.state = 'accepted'
            and new.state in (
              'partially_filled', 'filled', 'not_filled', 'rejected', 'unknown',
              'reconciling'
            )
          )
          or (
            old.state = 'unknown'
            and new.state in (
              'reconciling', 'accepted', 'partially_filled', 'filled', 'not_filled',
              'rejected', 'operator_required'
            )
          )
          or (
            old.state = 'reconciling'
            and new.state in (
              'accepted', 'partially_filled', 'filled', 'not_filled', 'rejected',
              'unknown', 'operator_required'
            )
          )
        )
      then
        raise exception 'invalid Spot intent transition' using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger spot_intents_transition_guard
      before insert or update or delete on public.spot_intents
      for each row execute function public.enforce_spot_intent_transition();

    create function public.enforce_spot_agent_authorization_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'spot_agent_authorizations cannot be deleted'
          using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.state <> 'prepared' or new.record_version <> 0 then
          raise exception 'spot_agent_authorizations must start prepared at version zero'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.domain is distinct from old.domain
        or new.operation_kind is distinct from old.operation_kind
        or new.request_sha256 is distinct from old.request_sha256
        or new.request_digest_version is distinct from old.request_digest_version
        or new.agent_identity_id is distinct from old.agent_identity_id
        or new.network is distinct from old.network
        or new.action is distinct from old.action
        or new.account_address is distinct from old.account_address
        or new.account_kind is distinct from old.account_kind
        or new.binding_version is distinct from old.binding_version
        or new.signer_wallet_address is distinct from old.signer_wallet_address
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.authorization_nonce is distinct from old.authorization_nonce
        or new.agent_valid_until is distinct from old.agent_valid_until
        or new.public_review is distinct from old.public_review
        or new.review_sha256 is distinct from old.review_sha256
        or new.typed_data_primary_type is distinct from old.typed_data_primary_type
        or new.signing_digest is distinct from old.signing_digest
        or new.typed_data_json_sha256 is distinct from old.typed_data_json_sha256
        or new.signing_expires_at is distinct from old.signing_expires_at
        or new.created_at is distinct from old.created_at
      then
        raise exception 'spot_agent_authorizations immutable issue authority cannot change'
          using errcode = '55000';
      end if;

      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
        or not (
          (old.state = 'prepared' and new.state in ('submitting', 'expired'))
          or (
            old.state = 'submitting'
            and new.state in (
              'accepted', 'active', 'rejected', 'failed', 'unknown'
            )
          )
          or (
            old.state = 'accepted'
            and new.state in ('active', 'rejected', 'unknown', 'reconciling')
          )
          or (
            old.state = 'unknown'
            and new.state in (
              'reconciling', 'active', 'rejected', 'failed',
              'operator_required'
            )
          )
          or (
            old.state = 'reconciling'
            and new.state in (
              'active', 'rejected', 'failed', 'unknown', 'operator_required'
            )
          )
        )
      then
        raise exception 'invalid Spot Agent authorization transition'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger spot_agent_authorizations_transition_guard
      before insert or update or delete on public.spot_agent_authorizations
      for each row execute function public.enforce_spot_agent_authorization_transition();

    create function public.reject_spot_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'Spot lifecycle events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger spot_agent_identity_events_append_only
      before update or delete on public.spot_agent_identity_events
      for each row execute function public.reject_spot_event_mutation();
    create trigger spot_intent_events_append_only
      before update or delete on public.spot_intent_events
      for each row execute function public.reject_spot_event_mutation();
    create trigger spot_agent_authorization_events_append_only
      before update or delete on public.spot_agent_authorization_events
      for each row execute function public.reject_spot_event_mutation();

    create function public.enforce_hyperliquid_signer_nonce_state()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'hyperliquid_signer_nonce_state cannot be deleted'
          using errcode = '55000';
      elsif tg_op = 'UPDATE' then
        if new.network is distinct from old.network
          or new.signer_address is distinct from old.signer_address
          or new.signer_kind is distinct from old.signer_kind
          or new.created_at is distinct from old.created_at
          or new.last_allocated_nonce <= old.last_allocated_nonce
          or new.updated_at < old.updated_at
        then
          raise exception 'invalid Hyperliquid signer nonce advance'
            using errcode = '55000';
        end if;
      end if;
      return new;
    end;
    $function$;

    create trigger hyperliquid_signer_nonce_state_guard
      before update or delete on public.hyperliquid_signer_nonce_state
      for each row execute function public.enforce_hyperliquid_signer_nonce_state();

    create function public.reject_hyperliquid_signer_nonce_allocation_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'hyperliquid_signer_nonce_allocations is append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger hyperliquid_signer_nonce_allocations_append_only
      before update or delete on public.hyperliquid_signer_nonce_allocations
      for each row execute function public.reject_hyperliquid_signer_nonce_allocation_mutation();

    create function public.validate_spot_operation_projection()
    returns trigger
    language plpgsql
    as $function$
    declare
      checked_operation_id uuid;
      checked_domain text;
      checked_kind text;
      operation_state text;
      projection_state text;
      projection_expected_generic_state text;
      allocation_count bigint;
    begin
      if tg_table_name = 'provider_operations' then
        checked_operation_id := new.id;
        checked_domain := new.domain;
        checked_kind := new.operation_kind;
      else
        checked_operation_id := new.id;
        checked_domain := 'hyperliquid';
        if tg_table_name = 'spot_intents' then
          checked_kind := 'spot_intent';
        else
          checked_kind := 'spot_agent_authorization';
        end if;
      end if;

      if checked_domain <> 'hyperliquid'
        or checked_kind not in ('spot_intent', 'spot_agent_authorization')
      then
        return null;
      end if;

      select operation.state
      into operation_state
      from public.provider_operations as operation
      where operation.id = checked_operation_id
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = checked_kind;

      if not found then
        raise exception 'Spot projection has no matching provider operation'
          using errcode = '23514';
      end if;

      if checked_kind = 'spot_intent' then
        select intent.state
        into projection_state
        from public.spot_intents as intent
        where intent.id = checked_operation_id;
      else
        select agent_authorization.state
        into projection_state
        from public.spot_agent_authorizations as agent_authorization
        where agent_authorization.id = checked_operation_id;
      end if;

      if not found then
        raise exception 'Spot provider operation has no domain projection'
          using errcode = '23514';
      end if;

      projection_expected_generic_state := case
        when projection_state in ('prepared', 'expired') then 'prepared'
        when projection_state = 'submitting' then 'submitting'
        when projection_state = 'accepted' then 'accepted'
        when projection_state in (
          'partially_filled', 'filled', 'not_filled', 'active'
        )
          then 'succeeded'
        when projection_state = 'rejected' then 'rejected'
        when projection_state = 'failed' then 'failed'
        when projection_state in (
          'unknown', 'reconciling', 'operator_required'
        ) then 'unknown'
        else null
      end;

      if projection_expected_generic_state is null
        or operation_state <> projection_expected_generic_state
      then
        raise exception 'Spot and provider operation states disagree'
          using errcode = '23514';
      end if;

      if operation_state <> 'prepared' then
        select count(*)
        into allocation_count
        from public.hyperliquid_signer_nonce_allocations as allocation
        where allocation.operation_id = checked_operation_id;

        if allocation_count <> 1 then
          raise exception 'Spot provider attempt has no exact nonce allocation'
          using errcode = '23514';
        end if;
      end if;

      if checked_kind = 'spot_agent_authorization' then
        select count(*)
        into allocation_count
        from public.hyperliquid_signer_nonce_allocations as allocation
        join public.spot_agent_authorizations as agent_authorization
          on agent_authorization.id = allocation.operation_id
        where allocation.operation_id = checked_operation_id
          and allocation.network = agent_authorization.network
          and allocation.signer_address = agent_authorization.signer_wallet_address
          and allocation.signer_kind = 'owner_wallet'
          and allocation.purpose = 'spot_agent_authorization'
          and allocation.nonce = agent_authorization.authorization_nonce;

        if allocation_count <> 1 then
          raise exception 'Spot Agent authorization has no exact nonce reservation'
            using errcode = '23514';
        end if;
      end if;

      return null;
    end;
    $function$;

    create constraint trigger provider_operations_spot_projection_complete
      after insert or update on public.provider_operations
      deferrable initially deferred
      for each row execute function public.validate_spot_operation_projection();
    create constraint trigger spot_intents_operation_projection_complete
      after insert or update on public.spot_intents
      deferrable initially deferred
      for each row execute function public.validate_spot_operation_projection();
    create constraint trigger spot_agent_authorizations_operation_projection_complete
      after insert or update on public.spot_agent_authorizations
      deferrable initially deferred
      for each row execute function public.validate_spot_operation_projection();

    create function public.validate_hyperliquid_signer_nonce_allocation()
    returns trigger
    language plpgsql
    as $function$
    declare
      operation_domain text;
      operation_kind text;
      operation_state text;
      expected_signer_address text;
      expected_signer_kind text;
      expected_purpose text;
      expected_nonce numeric;
      current_high_water numeric;
    begin
      select
        operation.domain,
        operation.operation_kind,
        operation.state
      into
        operation_domain,
        operation_kind,
        operation_state
      from public.provider_operations as operation
      where operation.id = new.operation_id
        and operation.owner_user_id = new.owner_user_id;

      if not found
        or operation_domain <> 'hyperliquid'
        or operation_kind not in ('spot_intent', 'spot_agent_authorization')
      then
        raise exception 'nonce allocation is not bound to one Spot operation'
          using errcode = '23514';
      end if;

      if operation_kind = 'spot_intent' then
        if operation_state = 'prepared' then
          raise exception 'Spot order nonce cannot be allocated before its attempt journal'
            using errcode = '23514';
        end if;
        select identity.agent_address
        into expected_signer_address
        from public.spot_intents as intent
        join public.spot_agent_identities as identity
          on identity.id = intent.agent_identity_id
        where intent.id = new.operation_id;
        expected_signer_kind := 'spot_agent';
        expected_purpose := 'spot_ioc_order';
      else
        select
          agent_authorization.signer_wallet_address,
          agent_authorization.authorization_nonce
        into expected_signer_address, expected_nonce
        from public.spot_agent_authorizations as agent_authorization
        where agent_authorization.id = new.operation_id;
        expected_signer_kind := 'owner_wallet';
        expected_purpose := 'spot_agent_authorization';
      end if;

      if expected_signer_address is null
        or new.signer_address <> expected_signer_address
        or new.signer_kind <> expected_signer_kind
        or new.purpose <> expected_purpose
        or (
          operation_kind = 'spot_agent_authorization'
          and new.nonce is distinct from expected_nonce
        )
      then
        raise exception 'nonce allocation signer or purpose disagrees with Spot authority'
          using errcode = '23514';
      end if;

      select nonce_state.last_allocated_nonce
      into current_high_water
      from public.hyperliquid_signer_nonce_state as nonce_state
      where nonce_state.network = new.network
        and nonce_state.signer_address = new.signer_address;

      if not found or current_high_water is distinct from new.nonce then
        raise exception 'nonce allocation is not the current persisted high-water mark'
          using errcode = '23514';
      end if;

      return null;
    end;
    $function$;

    create constraint trigger hyperliquid_signer_nonce_allocation_valid
      after insert on public.hyperliquid_signer_nonce_allocations
      deferrable initially deferred
      for each row execute function public.validate_hyperliquid_signer_nonce_allocation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.idempotency_records,
      public.provider_operations,
      public.spot_agent_identities,
      public.spot_agent_identity_events,
      public.spot_intents,
      public.spot_intent_events,
      public.spot_agent_authorizations,
      public.spot_agent_authorization_events,
      public.hyperliquid_signer_nonce_state,
      public.hyperliquid_signer_nonce_allocations
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.spot_agent_identities)
        or exists (select 1 from public.spot_agent_identity_events)
        or exists (select 1 from public.spot_intents)
        or exists (select 1 from public.spot_intent_events)
        or exists (select 1 from public.spot_agent_authorizations)
        or exists (select 1 from public.spot_agent_authorization_events)
        or exists (select 1 from public.hyperliquid_signer_nonce_state)
        or exists (select 1 from public.hyperliquid_signer_nonce_allocations)
        or exists (
          select 1
          from public.idempotency_records
          where scope in (
            'spot_intent_prepare',
            'spot_agent_authorization_issue'
          )
            or digest_version in (
              'spot_intent_request_v1',
              'spot_agent_authorization_issue_v1'
            )
        )
        or exists (
          select 1
          from public.provider_operations
          where domain = 'hyperliquid'
            and operation_kind in (
              'spot_intent',
              'spot_agent_authorization'
            )
        )
      then
        raise exception
          'cannot roll back 000007_hyperliquid_spot_closed_loop while Spot authority, history, or nonce records exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger provider_operations_spot_projection_complete
      on public.provider_operations;
    drop table public.spot_agent_authorization_events;
    drop table public.spot_intent_events;
    drop table public.spot_agent_identity_events;
    drop table public.hyperliquid_signer_nonce_allocations;
    drop table public.hyperliquid_signer_nonce_state;
    drop table public.spot_agent_authorizations;
    drop table public.spot_intents;
    drop table public.spot_agent_identities;
    drop function public.validate_hyperliquid_signer_nonce_allocation();
    drop function public.validate_spot_operation_projection();
    drop function public.reject_hyperliquid_signer_nonce_allocation_mutation();
    drop function public.enforce_hyperliquid_signer_nonce_state();
    drop function public.enforce_spot_agent_authorization_transition();
    drop function public.enforce_spot_intent_transition();
    drop function public.reject_spot_event_mutation();
    drop function public.enforce_spot_agent_identity_transition();

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
  `);
}
