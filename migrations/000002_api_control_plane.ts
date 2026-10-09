import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.idempotency_records (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      scope text not null,
      idempotency_key uuid not null,
      key_source text not null,
      request_sha256 text not null,
      digest_version text not null default 'sha256_v1',
      created_at timestamptz not null default clock_timestamp(),
      last_seen_at timestamptz not null default clock_timestamp(),
      constraint idempotency_records_id_owner_unique
        unique (id, owner_user_id),
      constraint idempotency_records_id_owner_digest_unique
        unique (id, owner_user_id, request_sha256),
      constraint idempotency_records_scope_key_unique
        unique (scope, idempotency_key),
      constraint idempotency_records_scope_check
        check (scope ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint idempotency_records_key_source_check
        check (key_source in ('client', 'server')),
      constraint idempotency_records_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint idempotency_records_digest_version_check
        check (digest_version = 'sha256_v1')
    );

    comment on table public.idempotency_records is
      'Globally conflict-safe UUID idempotency keys bound to one owner, scope, source, and versioned request digest.';

    create table public.provider_operations (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null,
      idempotency_record_id uuid not null unique,
      domain text not null,
      operation_kind text not null,
      request_sha256 text not null,
      state text not null default 'prepared',
      attempt_count integer not null default 0,
      transport_attempt_id uuid unique,
      attempt_committed_at timestamptz,
      attempt_deadline_at timestamptz,
      reconciliation_status text not null default 'not_required',
      reconciliation_attempt_count integer not null default 0,
      reconcile_after timestamptz,
      operator_required_at timestamptz,
      lease_owner uuid,
      lease_expires_at timestamptz,
      fence_token bigint not null default 0,
      record_version bigint not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint provider_operations_id_owner_unique
        unique (id, owner_user_id),
      constraint provider_operations_idempotency_owner_fk
        foreign key (idempotency_record_id, owner_user_id, request_sha256)
        references public.idempotency_records(
          id,
          owner_user_id,
          request_sha256
        )
        on delete restrict,
      constraint provider_operations_domain_check
        check (domain ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint provider_operations_kind_check
        check (operation_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint provider_operations_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint provider_operations_state_check
        check (state in (
          'prepared',
          'submitting',
          'accepted',
          'succeeded',
          'rejected',
          'failed',
          'unknown'
        )),
      constraint provider_operations_attempt_count_check
        check (attempt_count between 0 and 1),
      constraint provider_operations_attempt_lifecycle_check
        check (
          (
            state = 'prepared'
            and attempt_count = 0
            and transport_attempt_id is null
            and attempt_committed_at is null
            and attempt_deadline_at is null
          )
          or
          (
            state <> 'prepared'
            and attempt_count = 1
            and transport_attempt_id is not null
            and attempt_committed_at is not null
            and attempt_deadline_at is not null
            and attempt_deadline_at > attempt_committed_at
          )
        ),
      constraint provider_operations_reconciliation_status_check
        check (reconciliation_status in (
          'not_required',
          'pending',
          'leased',
          'operator_required',
          'complete'
        )),
      constraint provider_operations_reconciliation_attempt_count_check
        check (reconciliation_attempt_count >= 0),
      constraint provider_operations_fence_token_check
        check (fence_token >= 0),
      constraint provider_operations_fence_attempt_match_check
        check (fence_token = reconciliation_attempt_count),
      constraint provider_operations_record_version_check
        check (record_version >= 0),
      constraint provider_operations_reconciliation_state_check
        check (
          (
            reconciliation_status = 'not_required'
            and state in (
              'prepared',
              'submitting',
              'accepted',
              'succeeded',
              'rejected',
              'failed'
            )
            and reconcile_after is null
            and operator_required_at is null
            and lease_owner is null
            and lease_expires_at is null
          )
          or
          (
            reconciliation_status = 'pending'
            and state = 'unknown'
            and reconcile_after is not null
            and operator_required_at is null
            and lease_owner is null
            and lease_expires_at is null
          )
          or
          (
            reconciliation_status = 'leased'
            and state = 'unknown'
            and reconcile_after is not null
            and operator_required_at is null
            and lease_owner is not null
            and lease_expires_at is not null
          )
          or
          (
            reconciliation_status = 'operator_required'
            and state = 'unknown'
            and reconcile_after is null
            and operator_required_at is not null
            and lease_owner is null
            and lease_expires_at is null
          )
          or
          (
            reconciliation_status = 'complete'
            and state in ('accepted', 'succeeded', 'rejected', 'failed')
            and reconcile_after is null
            and operator_required_at is null
            and lease_owner is null
            and lease_expires_at is null
          )
        )
    );

    comment on table public.provider_operations is
      'Durable LOOP provider-write journal. It stores no token, signature, nonce, signed payload, key, or raw provider response.';

    create index provider_operations_owner_created_idx
      on public.provider_operations (owner_user_id, created_at desc, id);
    create index provider_operations_stale_submission_idx
      on public.provider_operations (attempt_deadline_at, id)
      where state = 'submitting' and reconciliation_status = 'not_required';
    create index provider_operations_reconciliation_due_idx
      on public.provider_operations (reconcile_after, created_at, id)
      where reconciliation_status in ('pending', 'leased');

    create table public.audit_events (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null,
      operation_id uuid not null,
      request_id uuid not null,
      actor_type text not null,
      event_type text not null,
      from_state text,
      to_state text not null,
      from_reconciliation_status text,
      to_reconciliation_status text not null,
      outcome text not null,
      reason_code text,
      operation_version bigint not null,
      fence_token bigint not null,
      transport_attempt_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint audit_events_operation_owner_fk
        foreign key (operation_id, owner_user_id)
        references public.provider_operations(id, owner_user_id)
        on delete restrict,
      constraint audit_events_operation_version_unique
        unique (operation_id, operation_version),
      constraint audit_events_actor_type_check
        check (actor_type in ('api', 'worker')),
      constraint audit_events_event_type_check
        check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint audit_events_state_check
        check (
          from_state is null
          or from_state in (
            'prepared',
            'submitting',
            'accepted',
            'succeeded',
            'rejected',
            'failed',
            'unknown'
          )
        ),
      constraint audit_events_to_state_check
        check (to_state in (
          'prepared',
          'submitting',
          'accepted',
          'succeeded',
          'rejected',
          'failed',
          'unknown'
        )),
      constraint audit_events_reconciliation_status_check
        check (
          from_reconciliation_status is null
          or from_reconciliation_status in (
            'not_required',
            'pending',
            'leased',
            'operator_required',
            'complete'
          )
        ),
      constraint audit_events_to_reconciliation_status_check
        check (to_reconciliation_status in (
          'not_required',
          'pending',
          'leased',
          'operator_required',
          'complete'
        )),
      constraint audit_events_initial_transition_check
        check (
          (
            operation_version = 0
            and from_state is null
            and from_reconciliation_status is null
            and transport_attempt_id is null
          )
          or
          (
            operation_version > 0
            and from_state is not null
            and from_reconciliation_status is not null
            and transport_attempt_id is not null
          )
        ),
      constraint audit_events_outcome_check
        check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint audit_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint audit_events_operation_version_check
        check (operation_version >= 0),
      constraint audit_events_fence_token_check
        check (fence_token >= 0)
    );

    comment on table public.audit_events is
      'Append-only sanitized control-plane transitions without secret-bearing metadata.';

    create index audit_events_operation_created_idx
      on public.audit_events (operation_id, occurred_at, id);
    create index audit_events_owner_created_idx
      on public.audit_events (owner_user_id, occurred_at desc, id);

    create function public.reject_audit_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'audit_events is append-only' using errcode = '55000';
    end;
    $function$;

    create trigger audit_events_append_only
      before update or delete on public.audit_events
      for each row execute function public.reject_audit_event_mutation();

    create table public.issuance_rate_records (
      capability text not null,
      policy_version text not null,
      subject_kind text not null,
      subject_hmac text not null,
      window_started_at timestamptz not null,
      window_duration_seconds integer not null,
      capacity integer not null,
      issued_count integer not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (
        capability,
        policy_version,
        subject_kind,
        subject_hmac,
        window_started_at
      ),
      constraint issuance_rate_records_capability_check
        check (capability ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint issuance_rate_records_policy_version_check
        check (policy_version ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint issuance_rate_records_subject_kind_check
        check (subject_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint issuance_rate_records_subject_hmac_check
        check (subject_hmac ~ '^[0-9a-f]{64}$'),
      constraint issuance_rate_records_window_duration_check
        check (window_duration_seconds between 1 and 86400),
      constraint issuance_rate_records_capacity_check
        check (capacity > 0),
      constraint issuance_rate_records_count_check
        check (issued_count between 1 and capacity)
    );

    comment on table public.issuance_rate_records is
      'Persistent multi-bucket issuance counters keyed by server-HMAC subjects and a versioned policy snapshot.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.issuance_rate_records;
    drop table public.audit_events;
    drop function public.reject_audit_event_mutation();
    drop table public.provider_operations;
    drop table public.idempotency_records;
  `);
}
