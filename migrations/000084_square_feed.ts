import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0143 (S187-api-b): the square「动态」timeline.
 *
 * - `square_posts`: one row per timeline post. `kind` opinion (an App
 *   user's post, published at once), buy / claim / graduation (written by
 *   the `square_feed_ingest` lane from existing read models, deduplicated
 *   by the unique `source_event_id`, facts in `event_payload`, no text),
 *   system (a console post: draft → published → archived, the only kind
 *   that may be pinned, no author). `published_at` is the timeline key
 *   (an event post's event time). `token_kind` + `token_id` reference a
 *   MEME v1 token (`meme_tokens.meme_token_id`) or a launch2 instance
 *   (`launch2_instances.instance_id`) — no foreign key: a reference is
 *   checked when written and read with a left join.
 * - `square_post_likes`: one row per (post, user).
 *
 * Idempotency (optional for the console, required for the App): the key
 * and the SHA-256 of the normalized request live on the created row
 * (unique per author; per console for system posts).
 *
 * `down` drops both tables outright (no data guard).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.square_posts (
      post_id uuid primary key,
      kind text not null,
      author_user_id uuid references public.loop_users(id) on delete restrict,
      text text,
      token_kind text,
      token_id uuid,
      event_payload jsonb,
      source_event_id text,
      pinned boolean not null default false,
      status text not null,
      published_at timestamptz,
      archived_by text,
      created_by uuid,
      created_by_actor text,
      create_idempotency_key uuid,
      create_request_sha256 text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint square_posts_kind_check
        check (kind in ('opinion', 'buy', 'claim', 'graduation', 'system')),
      constraint square_posts_status_check
        check (status in ('draft', 'published', 'archived')),
      constraint square_posts_author_check
        check ((kind = 'system') = (author_user_id is null)),
      constraint square_posts_text_check
        check (text is null or char_length(text) between 1 and 500),
      constraint square_posts_text_required_check
        check (kind not in ('opinion', 'system') or text is not null),
      constraint square_posts_event_text_check
        check (kind not in ('buy', 'claim', 'graduation') or text is null),
      constraint square_posts_token_check
        check (
          (token_kind is null) = (token_id is null)
          and (token_kind is null or token_kind in ('meme', 'launch2'))
        ),
      constraint square_posts_source_check
        check (
          (kind in ('buy', 'claim', 'graduation')) = (source_event_id is not null)
          and (source_event_id is null
            or char_length(source_event_id) between 1 and 200)
          and (kind in ('buy', 'claim', 'graduation')) = (event_payload is not null)
          and (event_payload is null or jsonb_typeof(event_payload) = 'object')
        ),
      constraint square_posts_pinned_check
        check (not pinned or kind = 'system'),
      constraint square_posts_draft_check
        check (kind = 'system' or status <> 'draft'),
      constraint square_posts_published_check
        check (status <> 'published' or published_at is not null),
      constraint square_posts_archived_by_check
        check (
          (status = 'archived') = (archived_by is not null)
          and (archived_by is null or archived_by in ('author', 'console'))
        ),
      constraint square_posts_console_check
        check (
          (kind = 'system') = (created_by_actor is not null)
          and (created_by_actor is null
            or char_length(created_by_actor) between 1 and 200)
          and (created_by is null or kind = 'system')
        ),
      constraint square_posts_create_key_check
        check (
          (create_idempotency_key is null) = (create_request_sha256 is null)
          and (create_request_sha256 is null
            or create_request_sha256 ~ '^[0-9a-f]{64}$')
          and (kind in ('opinion', 'system') or create_idempotency_key is null)
          and (kind <> 'opinion' or create_idempotency_key is not null)
        ),
      constraint square_posts_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.square_posts is
      'Decision 0143: the square timeline (GET /v2/square/feed). opinion = App users; buy / claim / graduation = the square_feed_ingest lane (source_event_id dedupes); system = the console (audited).';

    create unique index square_posts_source_event_unique
      on public.square_posts (source_event_id)
      where source_event_id is not null;
    create unique index square_posts_author_key_unique
      on public.square_posts (author_user_id, create_idempotency_key)
      where kind = 'opinion';
    create unique index square_posts_console_key_unique
      on public.square_posts (create_idempotency_key)
      where kind = 'system' and create_idempotency_key is not null;
    create index square_posts_timeline_idx
      on public.square_posts (published_at desc, post_id desc)
      where status = 'published' and not pinned;
    create index square_posts_author_timeline_idx
      on public.square_posts (author_user_id, published_at desc, post_id desc)
      where status = 'published' and not pinned;
    create index square_posts_pinned_idx
      on public.square_posts (published_at desc, post_id desc)
      where status = 'published' and pinned;
    create index square_posts_author_created_idx
      on public.square_posts (author_user_id, created_at desc)
      where kind = 'opinion';
    create index square_posts_created_idx
      on public.square_posts (created_at desc, post_id);

    create table public.square_post_likes (
      post_id uuid not null
        references public.square_posts(post_id) on delete cascade,
      user_id uuid not null
        references public.loop_users(id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      primary key (post_id, user_id)
    );

    comment on table public.square_post_likes is
      'Decision 0143: one like per (square post, LOOP user).';

    create index square_post_likes_user_idx
      on public.square_post_likes (user_id, created_at desc);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.square_post_likes;
    drop table public.square_posts;
  `);
}
