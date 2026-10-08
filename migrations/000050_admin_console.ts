import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0102: the operator console management surface (`/admin/v1/*`).
 *
 * - `admin_settings`: operator overrides read "database first, constant or
 *   environment second" — `recommended_community_ids`, `intel_promotions`,
 *   and the reserved `meme_listing_policy` key. A missing row means the
 *   shipped constant / environment variable is in force.
 * - `admin_audit_log`: one row per management write (and per login,
 *   logout, refused login). Append-only: UPDATE, DELETE, and TRUNCATE are
 *   refused by triggers.
 * - `community_review_notes`: the operator's decision trail on a community
 *   application (decision, reason code, free text), beside the existing
 *   `community_audit_events` rows the review itself writes.
 * - `meme_tokens.listing`: `listed | hidden`, default `listed`. A hidden
 *   token leaves the launchpad lists and `category=meme`; its detail stays
 *   readable and carries the listing state.
 * - `mining_formula_versions.community_weights`: the community weights a
 *   draft version proposes; the admin approval applies them in the same
 *   transaction that makes the version the one in force.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.admin_settings (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default clock_timestamp(),
      updated_by text not null,
      constraint admin_settings_key_check
        check (key in ('recommended_community_ids', 'intel_promotions', 'meme_listing_policy')),
      constraint admin_settings_updated_by_check
        check (updated_by ~ '^[A-Za-z0-9._@-]{1,64}$')
    );

    comment on table public.admin_settings is
      'Operator console overrides (Decision 0102). A row replaces the shipped constant or environment value for its key; no row means the constant is in force.';

    create table public.admin_audit_log (
      audit_id uuid primary key,
      seq bigint generated always as identity unique,
      at timestamptz not null default clock_timestamp(),
      actor text not null,
      action text not null,
      target_type text not null,
      target_id text,
      before jsonb,
      after jsonb,
      request_id uuid not null,
      constraint admin_audit_log_actor_check
        check (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
      constraint admin_audit_log_action_check
        check (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
      constraint admin_audit_log_target_type_check
        check (target_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint admin_audit_log_target_id_check
        check (target_id is null or char_length(target_id) between 1 and 128)
    );

    create index admin_audit_log_actor_idx
      on public.admin_audit_log (actor, seq desc);
    create index admin_audit_log_action_idx
      on public.admin_audit_log (action, seq desc);

    comment on table public.admin_audit_log is
      'Append-only operator console audit (Decision 0102): one row per management write. Rows are never updated or deleted.';

    create function public.admin_audit_log_append_only()
      returns trigger
      language plpgsql
    as $$
    begin
      raise exception 'admin_audit_log is append-only';
    end
    $$;

    create trigger admin_audit_log_no_update_delete
      before update or delete on public.admin_audit_log
      for each row execute function public.admin_audit_log_append_only();

    create trigger admin_audit_log_no_truncate
      before truncate on public.admin_audit_log
      for each statement execute function public.admin_audit_log_append_only();

    create table public.community_review_notes (
      note_id uuid primary key,
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      at timestamptz not null default clock_timestamp(),
      actor text not null,
      decision text not null,
      reason_code text not null,
      reason_text text,
      audit_id uuid not null,
      constraint community_review_notes_actor_check
        check (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
      constraint community_review_notes_decision_check
        check (decision in ('verify', 'reject')),
      constraint community_review_notes_reason_code_check
        check (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint community_review_notes_reason_text_check
        check (reason_text is null or char_length(reason_text) between 1 and 280),
      constraint community_review_notes_reject_text_check
        check (decision <> 'reject' or reason_text is not null)
    );

    create index community_review_notes_community_idx
      on public.community_review_notes (community_id, at desc, note_id desc);

    comment on table public.community_review_notes is
      'Operator decisions on community applications made in the console (Decision 0102).';

    alter table public.meme_tokens
      add column listing text not null default 'listed',
      add column listing_reason_code text,
      add column listing_reason_text text,
      add column listing_changed_at timestamptz,
      add constraint meme_tokens_listing_check
        check (listing in ('listed', 'hidden')),
      add constraint meme_tokens_listing_reason_code_check
        check (listing_reason_code is null or listing_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      add constraint meme_tokens_listing_reason_text_check
        check (listing_reason_text is null or char_length(listing_reason_text) between 1 and 280),
      add constraint meme_tokens_listing_hidden_reason_check
        check (listing = 'listed' or (listing_reason_code is not null and listing_changed_at is not null));

    alter table public.mining_formula_versions
      add column community_weights jsonb,
      add constraint mining_formula_versions_community_weights_check
        check (community_weights is null or jsonb_typeof(community_weights) = 'array');

    comment on column public.mining_formula_versions.community_weights is
      'Decision 0102: community weights a draft proposes ([{communityId, weight}]); the console approval applies them to community_mining_weights in the approving transaction.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.admin_audit_log)
        or exists (select 1 from public.community_review_notes)
        or exists (select 1 from public.admin_settings)
        or exists (select 1 from public.meme_tokens where listing <> 'listed')
        or exists (
          select 1 from public.mining_formula_versions
          where community_weights is not null
        )
      then
        raise exception 'operator console facts exist; refusing to roll back 000050';
      end if;
    end
    $$;

    alter table public.mining_formula_versions
      drop constraint mining_formula_versions_community_weights_check,
      drop column community_weights;

    alter table public.meme_tokens
      drop constraint meme_tokens_listing_hidden_reason_check,
      drop constraint meme_tokens_listing_reason_text_check,
      drop constraint meme_tokens_listing_reason_code_check,
      drop constraint meme_tokens_listing_check,
      drop column listing_changed_at,
      drop column listing_reason_text,
      drop column listing_reason_code,
      drop column listing;

    drop table public.community_review_notes;
    drop trigger admin_audit_log_no_truncate on public.admin_audit_log;
    drop trigger admin_audit_log_no_update_delete on public.admin_audit_log;
    drop table public.admin_audit_log;
    drop function public.admin_audit_log_append_only();
    drop table public.admin_settings;
  `);
}
