import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0149 (S206-api): fiat FX reference rates with a source.
 *
 * `fiat_fx_rates` holds one row per (base, quote, source, provider date),
 * written by the `fiat_fx_rate` worker lane from the configured provider
 * (default: the ECB reference rate via Frankfurter) and read by the net
 * worth history `fiat` block. A later fetch of the same provider date
 * refreshes `rate` (providers may revise) and `fetched_at`; a failed fetch
 * writes nothing. `quality` is what the lane saw at fetch time: `stale`
 * when the provider's date was already more than five days old.
 *
 * Number 000087 belongs to S205; this migration has no dependency on it.
 * `down` drops the table and its index.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.fiat_fx_rates (
      base text not null,
      quote text not null,
      source text not null,
      provider_as_of date not null,
      rate numeric not null,
      fetched_at timestamptz not null,
      quality text not null,
      created_at timestamptz not null default clock_timestamp(),
      primary key (base, quote, source, provider_as_of),
      constraint fiat_fx_rates_currency_check
        check (base ~ '^[A-Z]{3}$' and quote ~ '^[A-Z]{3}$' and base <> quote),
      constraint fiat_fx_rates_source_check
        check (source ~ '^[a-z]{2,16}$'),
      constraint fiat_fx_rates_rate_check
        check (rate > 0 and rate <= 1000),
      constraint fiat_fx_rates_quality_check
        check (quality in ('fresh', 'stale'))
    );

    create index fiat_fx_rates_latest_idx
      on public.fiat_fx_rates (base, quote, provider_as_of desc, fetched_at desc);

    comment on table public.fiat_fx_rates is
      'Decision 0149: fiat reference rates (quote per one base) with provider source and date; display information only.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.fiat_fx_rates;
  `);
}
