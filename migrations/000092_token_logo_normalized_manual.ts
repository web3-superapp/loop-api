import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0161 (S238): the logo proxy stores normalised pictures and
 * accepts operator overrides.
 *
 * - `source` may be `manual`: an operator's upload (`POST
 *   /admin/v1/market/logos/{chainId}/{address}`). A manual row has no
 *   upstream (`source_url` and `candidate_url` are null) and is never
 *   refetched; its `expires_at` is the far-future sentinel.
 * - `candidate_url` becomes nullable for that reason; every non-manual row
 *   still needs one.
 * - Every `found` / `oversize` row written before this migration is marked
 *   expired (`expires_at` one millisecond after `fetched_at`): the proxy
 *   refetches and re-encodes it into the 128 x 128 WebP on its next request
 *   or pre-warm pass, and keeps serving the old bytes if that refetch fails.
 *   `missing` rows keep their 24 h.
 *
 * `down` removes manual rows (a cache of re-fetchable pictures plus
 * operator uploads that the console can upload again), then restores the
 * Decision 0089 checks.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.token_logo_cache
      drop constraint token_logo_cache_source_check,
      drop constraint token_logo_cache_found_check;

    alter table public.token_logo_cache
      alter column candidate_url drop not null;

    alter table public.token_logo_cache
      add constraint token_logo_cache_source_check
        check (source is null or source in ('dexscreener', 'trustwallet', 'manual')),
      add constraint token_logo_cache_candidate_check
        check (
          (source = 'manual' and status = 'found'
            and candidate_url is null and source_url is null)
          or (source is distinct from 'manual' and candidate_url is not null)
        ),
      add constraint token_logo_cache_found_check
        check (
          status <> 'found' or (
            bytes is not null
            and octet_length(bytes) between 1 and 262144
            and content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
            and etag ~ '^"[A-Za-z0-9_-]{16,64}"$'
            and source is not null
            and (source = 'manual' or source_url is not null)
          )
        );

    update public.token_logo_cache
      set expires_at = fetched_at + interval '1 millisecond',
          updated_at = clock_timestamp()
      where status in ('found', 'oversize')
        and expires_at > fetched_at + interval '1 millisecond';

    comment on table public.token_logo_cache is
      'Decisions 0089, 0161: the logo proxy cache. found = the picture as a 128 x 128 WebP (rows older than 0161 may hold the upstream type until refreshed) with ETag, 7 days; source manual = an operator upload, never refetched; missing = every origin answered no such file or the picture could not be decoded (24 h); oversize = upstream picture above the read limit, no bytes (24 h). An upstream timeout never writes a row.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    delete from public.token_logo_cache where source = 'manual';

    alter table public.token_logo_cache
      drop constraint token_logo_cache_candidate_check,
      drop constraint token_logo_cache_source_check,
      drop constraint token_logo_cache_found_check;

    alter table public.token_logo_cache
      alter column candidate_url set not null;

    alter table public.token_logo_cache
      add constraint token_logo_cache_source_check
        check (source is null or source in ('dexscreener', 'trustwallet')),
      add constraint token_logo_cache_found_check
        check (
          status <> 'found' or (
            bytes is not null
            and octet_length(bytes) between 1 and 262144
            and content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
            and etag ~ '^"[A-Za-z0-9_-]{16,64}"$'
            and source is not null
            and source_url is not null
          )
        );

    comment on table public.token_logo_cache is
      'Decision 0089: the logo proxy cache. found = picture bytes (<= 256 KiB) with ETag; missing = every origin answered no such file (24 h); oversize = no bytes, the route redirects to source_url (24 h). An upstream timeout never writes a row.';
  `);
}
