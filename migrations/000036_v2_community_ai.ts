import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0066: Community AI, answered by a real model.
 *
 * - `community_ai_usage` is the durable quota ledger. One row per model call,
 *   inserted `reserved` **before** the Provider is called and advanced once to
 *   `completed` or `failed`. Both quotas (per account per minute, per
 *   community per day) are counted from this table, so a restart, a second
 *   process, or a failing Provider cannot widen the budget.
 * - `community_ai_answers` holds what the report path and an audit need: the
 *   question, the answer, the citations, the model, and the token counts. It
 *   deliberately has **no column for message text**: the chat source that fed
 *   the prompt is not retained anywhere.
 * - `community_ai_answer_reports` is one report per (answer, reporter).
 *
 * Retention is not decided here (product plan §6.4 still lists it as open);
 * this step stores the minimum the report path needs and nothing more.
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
        'price_alert_create_v2',
        'launch_command_v1',
        'referral_command_v1',
        'support_ticket_create_v1',
        'community_ai_ask_v1',
        'community_ai_report_v1'
      ));

    create table public.community_ai_usage (
      usage_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      kind text not null,
      status text not null default 'reserved',
      model text,
      input_tokens integer,
      output_tokens integer,
      request_id uuid not null,
      created_at timestamptz not null default clock_timestamp(),
      settled_at timestamptz,
      constraint community_ai_usage_kind_check
        check (kind in ('ask', 'brief')),
      constraint community_ai_usage_status_check
        check (status in ('reserved', 'completed', 'failed')),
      constraint community_ai_usage_model_check
        check (model is null or char_length(model) between 1 and 128),
      constraint community_ai_usage_tokens_check
        check (
          (input_tokens is null or input_tokens >= 0)
          and (output_tokens is null or output_tokens >= 0)
        ),
      constraint community_ai_usage_settled_check
        check (
          (status = 'reserved' and settled_at is null)
          or (status <> 'reserved' and settled_at is not null)
        )
    );

    comment on table public.community_ai_usage is
      'Decision 0066: the Community AI quota ledger. One row per model call, reserved before the Anthropic request and settled after it. A failed call still consumes quota: the budget is a cost ceiling, not a success counter. No prompt, question, or message text is stored here.';

    create index community_ai_usage_owner_recent_idx
      on public.community_ai_usage (owner_user_id, created_at desc);

    create index community_ai_usage_community_recent_idx
      on public.community_ai_usage (community_id, created_at desc);

    create function public.guard_community_ai_usage_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'community_ai_usage rows are permanent'
          using errcode = '55000';
      end if;
      if new.usage_id is distinct from old.usage_id
        or new.community_id is distinct from old.community_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.kind is distinct from old.kind
        or new.request_id is distinct from old.request_id
        or new.created_at is distinct from old.created_at
        or old.status <> 'reserved'
      then
        raise exception 'a community_ai_usage row only advances once out of reserved'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger community_ai_usage_guard_mutation
      before update or delete on public.community_ai_usage
      for each row execute function public.guard_community_ai_usage_mutation();

    create table public.community_ai_answers (
      answer_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      usage_id uuid not null
        references public.community_ai_usage(usage_id) on delete restrict,
      question text not null,
      answer text not null,
      refusal text,
      citations jsonb not null default '[]'::jsonb,
      model text not null,
      input_tokens integer,
      output_tokens integer,
      create_idempotency_record_id uuid not null
        references public.idempotency_records(id) on delete restrict,
      create_request_sha256 text not null,
      contract_version text not null default '2.0',
      created_at timestamptz not null default clock_timestamp(),
      constraint community_ai_answers_owner_unique
        unique (answer_id, owner_user_id),
      constraint community_ai_answers_create_record_unique
        unique (create_idempotency_record_id),
      constraint community_ai_answers_usage_unique
        unique (usage_id),
      constraint community_ai_answers_question_check
        check (
          char_length(question) between 1 and 2000
          and question = btrim(question)
        ),
      constraint community_ai_answers_answer_check
        check (char_length(answer) between 0 and 8000),
      constraint community_ai_answers_refusal_check
        check (refusal is null or char_length(refusal) between 1 and 2000),
      constraint community_ai_answers_answer_present_check
        check (char_length(answer) > 0 or refusal is not null),
      constraint community_ai_answers_citations_check
        check (jsonb_typeof(citations) = 'array'),
      constraint community_ai_answers_model_check
        check (char_length(model) between 1 and 128),
      constraint community_ai_answers_tokens_check
        check (
          (input_tokens is null or input_tokens >= 0)
          and (output_tokens is null or output_tokens >= 0)
        ),
      constraint community_ai_answers_sha256_check
        check (create_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint community_ai_answers_contract_version_check
        check (contract_version = '2.0')
    );

    comment on table public.community_ai_answers is
      'Decision 0066: one stored Community AI answer, kept so it can be reported and audited. It holds the question, the answer, and the citation handles only. The community messages the answer was derived from are never written here or anywhere else.';

    create index community_ai_answers_community_recent_idx
      on public.community_ai_answers (community_id, created_at desc);

    create function public.guard_community_ai_answer_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'community_ai_answers are immutable'
        using errcode = '55000';
    end;
    $function$;

    create trigger community_ai_answers_immutable
      before update or delete on public.community_ai_answers
      for each row execute function public.guard_community_ai_answer_mutation();

    create table public.community_ai_answer_reports (
      report_id uuid primary key default gen_random_uuid(),
      answer_id uuid not null,
      reporter_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      reason text not null,
      note text,
      create_idempotency_record_id uuid not null
        references public.idempotency_records(id) on delete restrict,
      request_id uuid not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint community_ai_answer_reports_answer_fk
        foreign key (answer_id, reporter_user_id)
        references public.community_ai_answers(answer_id, owner_user_id)
        on delete restrict,
      constraint community_ai_answer_reports_once
        unique (answer_id, reporter_user_id),
      constraint community_ai_answer_reports_create_record_unique
        unique (create_idempotency_record_id),
      constraint community_ai_answer_reports_reason_check
        check (reason in ('inaccurate', 'harmful', 'offTopic', 'privacy', 'other')),
      constraint community_ai_answer_reports_note_check
        check (
          note is null
          or (
            char_length(note) between 1 and 500
            and note = btrim(note)
            and public.loop_alias_text_is_safe(note)
          )
        )
    );

    comment on table public.community_ai_answer_reports is
      'Decision 0066: one report per (answer, reporter). A caller can only report an answer it received, which the composite foreign key enforces at the database level as well as in the route.';

    create function public.reject_community_ai_report_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'community_ai_answer_reports are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger community_ai_answer_reports_immutable
      before update or delete on public.community_ai_answer_reports
      for each row execute function public.reject_community_ai_report_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.community_ai_answer_reports,
      public.community_ai_answers,
      public.community_ai_usage
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.community_ai_answer_reports)
        or exists (select 1 from public.community_ai_answers)
        or exists (select 1 from public.community_ai_usage)
        or exists (
          select 1 from public.idempotency_records
          where digest_version in ('community_ai_ask_v1', 'community_ai_report_v1')
        )
      then
        raise exception 'refusing destructive rollback of community AI answers, reports, or quota ledger'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger community_ai_answer_reports_immutable
      on public.community_ai_answer_reports;
    drop function public.reject_community_ai_report_mutation();
    drop table public.community_ai_answer_reports;
    drop trigger community_ai_answers_immutable on public.community_ai_answers;
    drop function public.guard_community_ai_answer_mutation();
    drop table public.community_ai_answers;
    drop trigger community_ai_usage_guard_mutation on public.community_ai_usage;
    drop function public.guard_community_ai_usage_mutation();
    drop table public.community_ai_usage;

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
        'price_alert_create_v2',
        'launch_command_v1',
        'referral_command_v1',
        'support_ticket_create_v1'
      ));
  `);
}
