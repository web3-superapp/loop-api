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
        'perp_agent_authorization_issue_v1'
      ));
    update public.idempotency_records
      set digest_version = 'perp_agent_authorization_issue_v1'
      where scope = 'perp_agent_authorization_issue';

    create table public.perp_agent_identities (
      id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      network text not null default 'testnet',
      agent_address text not null,
      agent_name text not null,
      lifecycle_state text not null default 'reserved',
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint perp_agent_identities_id_owner_unique
        unique (id, owner_user_id),
      constraint perp_agent_identities_binding_unique
        unique (id, owner_user_id, agent_address, agent_name),
      constraint perp_agent_identities_address_unique
        unique (agent_address),
      constraint perp_agent_identities_network_check
        check (network = 'testnet'),
      constraint perp_agent_identities_address_check
        check (
          agent_address ~ '^0x[0-9a-f]{40}$'
          and agent_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint perp_agent_identities_name_check
        check (
          agent_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
          and agent_name = btrim(agent_name)
        ),
      constraint perp_agent_identities_lifecycle_state_check
        check (lifecycle_state in (
          'reserved',
          'authorized',
          'revoked',
          'retired',
          'operator_hold'
        )),
      constraint perp_agent_identities_record_version_check
        check (record_version >= 0)
    );

    comment on table public.perp_agent_identities is
      'Non-secret, non-reusable Testnet Agent identity registry. It stores an address and sanitized name, never a wallet key, signing credential, or recovery secret.';

    create index perp_agent_identities_owner_created_idx
      on public.perp_agent_identities (owner_user_id, created_at desc, id);

    create table public.perp_agent_authorizations (
      id uuid primary key,
      owner_user_id uuid not null,
      domain text not null default 'hyperliquid',
      operation_kind text not null default 'agent_authorization',
      request_sha256 text not null,
      request_digest_version text not null
        default 'perp_agent_authorization_issue_v1',
      agent_identity_id uuid not null unique,
      network text not null default 'testnet',
      action text not null default 'approve_agent',
      account_address text not null,
      account_kind text not null,
      binding_version bigint not null,
      signer_wallet_address text not null,
      agent_address text not null,
      agent_name text not null,
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
      constraint perp_agent_authorizations_id_owner_unique
        unique (id, owner_user_id),
      constraint perp_agent_authorizations_provider_operation_fk
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
      constraint perp_agent_authorizations_agent_identity_fk
        foreign key (
          agent_identity_id,
          owner_user_id,
          agent_address,
          agent_name
        )
        references public.perp_agent_identities (
          id,
          owner_user_id,
          agent_address,
          agent_name
        )
        on delete restrict,
      constraint perp_agent_authorizations_domain_check
        check (domain = 'hyperliquid'),
      constraint perp_agent_authorizations_operation_kind_check
        check (operation_kind = 'agent_authorization'),
      constraint perp_agent_authorizations_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint perp_agent_authorizations_request_digest_version_check
        check (
          request_digest_version = 'perp_agent_authorization_issue_v1'
        ),
      constraint perp_agent_authorizations_network_check
        check (network = 'testnet'),
      constraint perp_agent_authorizations_action_check
        check (action = 'approve_agent'),
      constraint perp_agent_authorizations_account_address_check
        check (
          account_address ~ '^0x[0-9a-f]{40}$'
          and account_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint perp_agent_authorizations_account_kind_check
        check (account_kind in ('master', 'subaccount')),
      constraint perp_agent_authorizations_binding_version_check
        check (binding_version > 0),
      constraint perp_agent_authorizations_signer_wallet_address_check
        check (
          signer_wallet_address ~ '^0x[0-9a-f]{40}$'
          and signer_wallet_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint perp_agent_authorizations_signer_is_not_agent_check
        check (signer_wallet_address <> agent_address),
      constraint perp_agent_authorizations_agent_address_check
        check (
          agent_address ~ '^0x[0-9a-f]{40}$'
          and agent_address <> '0x0000000000000000000000000000000000000000'
        ),
      constraint perp_agent_authorizations_agent_name_check
        check (
          agent_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
          and agent_name = btrim(agent_name)
        ),
      constraint perp_agent_authorizations_public_review_check
        check (jsonb_typeof(public_review) = 'object'),
      constraint perp_agent_authorizations_review_sha256_check
        check (review_sha256 ~ '^[0-9a-f]{64}$'),
      constraint perp_agent_authorizations_primary_type_check
        check (typed_data_primary_type ~ '^[A-Za-z][A-Za-z0-9_]{0,127}$'),
      constraint perp_agent_authorizations_signing_digest_check
        check (signing_digest ~ '^0x[0-9a-f]{64}$'),
      constraint perp_agent_authorizations_typed_data_json_sha256_check
        check (typed_data_json_sha256 ~ '^[0-9a-f]{64}$'),
      constraint perp_agent_authorizations_signing_window_check
        check (signing_expires_at <= agent_valid_until),
      constraint perp_agent_authorizations_state_check
        check (state in (
          'prepared',
          'submitting',
          'accepted',
          'active',
          'rejected',
          'failed',
          'unknown',
          'reconciling',
          'expired'
        )),
      constraint perp_agent_authorizations_result_reason_code_check
        check (
          result_reason_code is null
          or result_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint perp_agent_authorizations_result_presence_check
        check (
          (
            state in ('prepared', 'submitting', 'accepted', 'expired')
            and result_observed_at is null
            and result_reason_code is null
          )
          or
          (
            state in ('active', 'rejected', 'failed', 'unknown', 'reconciling')
            and result_observed_at is not null
          )
        ),
      constraint perp_agent_authorizations_record_version_check
        check (record_version >= 0),
      constraint perp_agent_authorizations_signer_digest_unique
        unique (signer_wallet_address, signing_digest),
      constraint perp_agent_authorizations_signer_payload_hash_unique
        unique (signer_wallet_address, typed_data_json_sha256)
    );

    comment on table public.perp_agent_authorizations is
      'Durable owner-bound Testnet approveAgent lifecycle and non-secret digest binding. It stores no typed-data JSON, complete authorization payload, signature, nonce, signed bytes, key, token, or raw provider response.';

    create index perp_agent_authorizations_owner_created_idx
      on public.perp_agent_authorizations (owner_user_id, created_at desc, id);
    create index perp_agent_authorizations_expiry_idx
      on public.perp_agent_authorizations (signing_expires_at, id)
      where state = 'prepared';

    create table public.perp_agent_authorization_events (
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
      constraint perp_agent_authorization_events_owner_fk
        foreign key (authorization_id, owner_user_id)
        references public.perp_agent_authorizations (id, owner_user_id)
        on delete restrict,
      constraint perp_agent_authorization_events_version_unique
        unique (authorization_id, authorization_version),
      constraint perp_agent_authorization_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint perp_agent_authorization_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint perp_agent_authorization_events_from_state_check
        check (
          from_state is null
          or from_state in (
            'prepared',
            'submitting',
            'accepted',
            'active',
            'rejected',
            'failed',
            'unknown',
            'reconciling',
            'expired'
          )
        ),
      constraint perp_agent_authorization_events_to_state_check
        check (to_state in (
          'prepared',
          'submitting',
          'accepted',
          'active',
          'rejected',
          'failed',
          'unknown',
          'reconciling',
          'expired'
        )),
      constraint perp_agent_authorization_events_initial_transition_check
        check (
          (authorization_version = 0 and from_state is null)
          or (authorization_version > 0 and from_state is not null)
        ),
      constraint perp_agent_authorization_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint perp_agent_authorization_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint perp_agent_authorization_events_version_check
        check (authorization_version >= 0)
    );

    comment on table public.perp_agent_authorization_events is
      'Append-only sanitized Agent authorization lifecycle events without signatures, nonces, payloads, credentials, or raw provider errors.';

    create index perp_agent_authorization_events_authorization_created_idx
      on public.perp_agent_authorization_events (
        authorization_id,
        occurred_at,
        id
      );
    create index perp_agent_authorization_events_owner_created_idx
      on public.perp_agent_authorization_events (
        owner_user_id,
        occurred_at desc,
        id
      );

    create function public.reject_perp_agent_identity_immutable_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'perp_agent_identities cannot be deleted'
          using errcode = '55000';
      elsif new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.network is distinct from old.network
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.created_at is distinct from old.created_at
      then
        raise exception 'perp_agent_identities immutable fields cannot change'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger perp_agent_identities_immutable_fields
      before update or delete on public.perp_agent_identities
      for each row execute function public.reject_perp_agent_identity_immutable_mutation();

    create function public.reject_perp_agent_authorization_immutable_mutation()
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
        or new.agent_identity_id is distinct from old.agent_identity_id
        or new.network is distinct from old.network
        or new.action is distinct from old.action
        or new.account_address is distinct from old.account_address
        or new.account_kind is distinct from old.account_kind
        or new.binding_version is distinct from old.binding_version
        or new.signer_wallet_address is distinct from old.signer_wallet_address
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.agent_valid_until is distinct from old.agent_valid_until
        or new.public_review is distinct from old.public_review
        or new.review_sha256 is distinct from old.review_sha256
        or new.typed_data_primary_type is distinct from old.typed_data_primary_type
        or new.signing_digest is distinct from old.signing_digest
        or new.typed_data_json_sha256 is distinct from old.typed_data_json_sha256
        or new.signing_expires_at is distinct from old.signing_expires_at
        or new.created_at is distinct from old.created_at
      then
        raise exception 'perp_agent_authorizations immutable issue fields cannot change'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger perp_agent_authorizations_immutable_fields
      before update on public.perp_agent_authorizations
      for each row execute function public.reject_perp_agent_authorization_immutable_mutation();

    create function public.reject_perp_agent_authorization_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'perp_agent_authorization_events is append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger perp_agent_authorization_events_append_only
      before update or delete on public.perp_agent_authorization_events
      for each row execute function public.reject_perp_agent_authorization_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.idempotency_records,
      public.provider_operations,
      public.perp_agent_identities,
      public.perp_agent_authorizations,
      public.perp_agent_authorization_events
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.perp_agent_identities)
        or exists (
          select 1
          from public.provider_operations
          where domain = 'hyperliquid'
            and operation_kind = 'agent_authorization'
        )
      then
        raise exception
          'cannot roll back 000004_agent_authorizations while Agent identities or issued operations exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop table public.perp_agent_authorization_events;
    drop function public.reject_perp_agent_authorization_event_mutation();
    drop table public.perp_agent_authorizations;
    drop function public.reject_perp_agent_authorization_immutable_mutation();
    drop table public.perp_agent_identities;
    drop function public.reject_perp_agent_identity_immutable_mutation();
    update public.idempotency_records
      set digest_version = 'sha256_v1'
      where scope = 'perp_agent_authorization_issue';
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in ('sha256_v1', 'perp_intent_request_v1'));
  `);
}
