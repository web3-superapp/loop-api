import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0140 (S183): operator campaigns on the launch desk.
 *
 * - `launch2_campaigns`: one row per operator campaign card (title,
 *   subtitle, cover picture, CTA, in-app route or https link, window,
 *   pinned / sort order). `status` moves draft → published → archived
 *   (draft → archived too); archived is final. `created_by` is the acting
 *   `admin_accounts.id` (null for the ADMIN_USERNAME bootstrap
 *   administrator) and `created_by_actor` the console user name. No foreign
 *   keys — neither into `admin_accounts` (like every console fact since
 *   0110) nor into `media_objects` (test suites truncate `media_objects`
 *   without CASCADE); the API checks the cover reference on every write.
 * - `media_objects` gains kind `campaign_cover` (1200 x 600 WebP uploaded
 *   from the console). A cover has no LOOP user owner: `owner_user_id` is
 *   null exactly for that kind.
 *
 * - Idempotency (0109 style, optional `Idempotency-Key`): a create keeps its
 *   key and the SHA-256 of its normalized fields (unique key → replay); a
 *   cover keeps the key in `media_objects.idempotency_key`, unique among
 *   `campaign_cover` rows.
 *
 * `down` drops the table and the uploaded covers outright (no data guard).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.media_objects
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo', 'campaign_cover')),
      alter column owner_user_id drop not null,
      add constraint media_objects_owner_kind_check
        check ((owner_user_id is null) = (kind = 'campaign_cover'));

    create table public.launch2_campaigns (
      campaign_id uuid primary key,
      title text not null,
      subtitle text,
      cover_media_id uuid,
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      cta_label text not null default '查看',
      link_kind text not null,
      link_value text not null,
      pinned boolean not null default false,
      sort_order integer not null default 0,
      status text not null default 'draft',
      created_by uuid,
      created_by_actor text not null,
      create_idempotency_key uuid,
      create_request_sha256 text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint launch2_campaigns_title_check
        check (char_length(title) between 1 and 24),
      constraint launch2_campaigns_subtitle_check
        check (subtitle is null or char_length(subtitle) between 1 and 60),
      constraint launch2_campaigns_cta_label_check
        check (char_length(cta_label) between 1 and 8),
      constraint launch2_campaigns_window_check
        check (ends_at > starts_at),
      constraint launch2_campaigns_link_check
        check (
          (link_kind = 'route' and link_value ~ '^/[^[:space:]]*$')
          or (link_kind = 'url' and link_value ~ '^https://[^[:space:]]+$')
        ),
      constraint launch2_campaigns_link_length_check
        check (char_length(link_value) between 1 and 1024),
      constraint launch2_campaigns_status_check
        check (status in ('draft', 'published', 'archived')),
      constraint launch2_campaigns_actor_check
        check (char_length(created_by_actor) between 1 and 200),
      constraint launch2_campaigns_create_key_check
        check (
          (create_idempotency_key is null) = (create_request_sha256 is null)
          and (create_request_sha256 is null
            or create_request_sha256 ~ '^[0-9a-f]{64}$')
        ),
      constraint launch2_campaigns_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.launch2_campaigns is
      'Decision 0140: operator campaign cards of the launch desk (GET /v2/launch2/campaigns). Written only by the console (console.write, audited).';

    create index launch2_campaigns_status_ends_idx
      on public.launch2_campaigns (status, ends_at);

    create unique index launch2_campaigns_create_key_unique
      on public.launch2_campaigns (create_idempotency_key)
      where create_idempotency_key is not null;

    create unique index media_objects_campaign_cover_key_unique
      on public.media_objects (idempotency_key)
      where kind = 'campaign_cover';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.launch2_campaigns;
    drop index public.media_objects_campaign_cover_key_unique;
    delete from public.media_objects where kind = 'campaign_cover';
    alter table public.media_objects
      drop constraint media_objects_owner_kind_check,
      alter column owner_user_id set not null,
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo'));
  `);
}
