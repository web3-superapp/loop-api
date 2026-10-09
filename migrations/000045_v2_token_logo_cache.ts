import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0089: the token logo proxy's server-side cache.
 *
 * One row per (chain, token) the proxy route was asked for. `status` is what
 * the upstreams (Decision 0072 origins) answered the last time they were
 * asked:
 *
 * - `found`: the picture bytes (at most 256 KiB, a sniffed raster type), the
 *   strong ETag the route publishes, and which origin served them;
 * - `missing`: every origin answered "no such file" (kept 24 h);
 * - `oversize`: the picture exceeds 256 KiB; no bytes are stored and the
 *   route redirects to `source_url` (kept 24 h).
 *
 * An upstream timeout or failure never writes a row. `candidate_url` is the
 * highest-priority origin URL at fetch time: when a Provider image appears
 * later the key no longer matches and the row is refetched early.
 *
 * `address` is the token contract's lowercase address (or `native`). It is
 * the key of a cache of a public external fact, like `market_fact_cache`'s
 * subject key; no LOOP entity is identified or joined by it.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.token_logo_cache (
      chain_id text not null,
      address text not null,
      status text not null,
      bytes bytea,
      content_type text,
      etag text,
      source text,
      source_url text,
      candidate_url text not null,
      fetched_at timestamptz not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, address),
      constraint token_logo_cache_chain_check
        check (chain_id ~ '^eip155:[0-9]{1,20}$'),
      constraint token_logo_cache_address_check
        check (address ~ '^(0x[0-9a-f]{40}|native)$'),
      constraint token_logo_cache_status_check
        check (status in ('found', 'missing', 'oversize')),
      constraint token_logo_cache_source_check
        check (source is null or source in ('dexscreener', 'trustwallet')),
      constraint token_logo_cache_url_check
        check (
          char_length(candidate_url) between 9 and 512
          and candidate_url ~ '^https://'
          and (source_url is null or (char_length(source_url) between 9 and 512 and source_url ~ '^https://'))
        ),
      constraint token_logo_cache_found_check
        check (
          status <> 'found' or (
            bytes is not null
            and octet_length(bytes) between 1 and 262144
            and content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
            and etag ~ '^"[A-Za-z0-9_-]{16,64}"$'
            and source is not null
            and source_url is not null
          )
        ),
      constraint token_logo_cache_missing_check
        check (
          status <> 'missing' or (
            bytes is null and content_type is null and etag is null
          )
        ),
      constraint token_logo_cache_oversize_check
        check (
          status <> 'oversize' or (
            bytes is null and content_type is null and etag is null
            and source is not null and source_url is not null
          )
        ),
      constraint token_logo_cache_time_check
        check (expires_at > fetched_at and updated_at >= created_at)
    );

    comment on table public.token_logo_cache is
      'Decision 0089: the logo proxy cache. found = picture bytes (<= 256 KiB) with ETag; missing = every origin answered no such file (24 h); oversize = no bytes, the route redirects to source_url (24 h). An upstream timeout never writes a row.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`drop table public.token_logo_cache;`);
}
