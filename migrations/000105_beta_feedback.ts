import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0193 (S332-api, 主代理决策 0262): beta feedback.
 *
 * 1. `media_objects`: a new kind `feedback_image` (uploaded through
 *    `POST /v2/media/feedback-images`, owner-bound, never pinned, aspect
 *    ratio kept). Rows stay immutable (000046 trigger).
 * 2. `beta_feedback`: one row per submitted report. `account_id` is the
 *    reporting LOOP account; `context` holds only the seven client
 *    environment keys (appVersion, build, platform, osVersion, deviceModel,
 *    route, locale) as strings; `status` open → triaged / resolved /
 *    wont_fix (any to any, console only); `admin_note` is the console note.
 *    The App's Idempotency-Key and the SHA-256 of the normalized request
 *    live on the row (unique per account).
 * 3. `beta_feedback_attachments`: up to four screenshots per report, in
 *    `sort` order 0..3. A media object is attached at most once.
 *
 * `down` refuses while a `feedback_image` object exists, then drops both
 * tables and restores the 000096 kind check.
 */

const contextKeys = `array['appVersion', 'build', 'platform', 'osVersion',
  'deviceModel', 'route', 'locale']::text[]`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.media_objects
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo', 'campaign_cover',
          'project_nft_image', 'feedback_image'));

    create table public.beta_feedback (
      id uuid primary key,
      account_id uuid not null
        references public.loop_users(id) on delete restrict,
      category text not null,
      body text not null,
      context jsonb not null default '{}'::jsonb,
      status text not null default 'open',
      admin_note text,
      create_idempotency_key uuid not null,
      create_request_sha256 text not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint beta_feedback_category_check
        check (category in ('bug', 'suggestion', 'other')),
      constraint beta_feedback_body_check
        check (char_length(body) between 1 and 2000),
      constraint beta_feedback_context_check
        check (
          jsonb_typeof(context) = 'object'
          and context - ${contextKeys} = '{}'::jsonb
        ),
      constraint beta_feedback_status_check
        check (status in ('open', 'triaged', 'resolved', 'wont_fix')),
      constraint beta_feedback_admin_note_check
        check (admin_note is null or char_length(admin_note) between 1 and 1000),
      constraint beta_feedback_request_sha256_check
        check (create_request_sha256 ~ '^[0-9a-f]{64}$'),
      constraint beta_feedback_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.beta_feedback is
      'Decision 0193: beta feedback reports (POST /v2/feedback); console triage under /admin/v1/feedback (audited).';

    create unique index beta_feedback_account_key_unique
      on public.beta_feedback (account_id, create_idempotency_key);
    create index beta_feedback_account_created_idx
      on public.beta_feedback (account_id, created_at desc, id desc);
    create index beta_feedback_created_idx
      on public.beta_feedback (created_at desc, id desc);
    create index beta_feedback_status_created_idx
      on public.beta_feedback (status, created_at desc, id desc);

    create table public.beta_feedback_attachments (
      feedback_id uuid not null
        references public.beta_feedback(id) on delete cascade,
      media_id uuid not null
        references public.media_objects(media_id) on delete restrict,
      sort smallint not null,
      primary key (feedback_id, sort),
      constraint beta_feedback_attachments_media_unique unique (media_id),
      constraint beta_feedback_attachments_sort_check
        check (sort between 0 and 3)
    );

    comment on table public.beta_feedback_attachments is
      'Decision 0193: the screenshots of a beta feedback report (feedback_image media, at most four, each attached once).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.media_objects
                 where kind = 'feedback_image')
      then
        raise exception 'feedback_image media exist; refusing to roll back 000105';
      end if;
    end
    $$;

    drop table public.beta_feedback_attachments;
    drop table public.beta_feedback;

    alter table public.media_objects
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo', 'campaign_cover',
          'project_nft_image'));
  `);
}
