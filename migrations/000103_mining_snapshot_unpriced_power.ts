import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0189 (S317): under the `quantity` basis (Decision 0125) a power
 * row's power is holding × weight and its reference price is only
 * published. A power-list (roster) asset whose price cannot be read keeps
 * its power — the same holding is paid by the hourly settlement — and the
 * row says so instead of inventing a price:
 *
 * - `reference_price_usd` may be null, exactly when
 *   `reference_price_quality = 'unavailable'`;
 * - `reference_price_reason_code` carries the price reason
 *   (e.g. `MINING_PRICE_NOT_FRESH`), present exactly on those rows.
 *
 * The lane writes such rows only under `MINING_SNAPSHOT_UNPRICED_POWER_EMIT`
 * (default off, the `/v2` client reads the nullable price first). Rollback
 * refuses while an unpriced row exists (delete those snapshots first).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshot_powers
      alter column reference_price_usd drop not null,
      add column reference_price_reason_code text,
      drop constraint mining_snapshot_powers_price_quality_check,
      add constraint mining_snapshot_powers_price_quality_check
        check (
          reference_price_quality in ('fresh', 'proxied', 'derived', 'unavailable')
        ),
      add constraint mining_snapshot_powers_unpriced_check
        check (
          (reference_price_usd is null) = (reference_price_quality = 'unavailable')
          and (reference_price_reason_code is null) = (reference_price_usd is not null)
        ),
      add constraint mining_snapshot_powers_price_reason_code_check
        check (
          reference_price_reason_code is null
          or reference_price_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
        );

    comment on column public.mining_snapshot_powers.reference_price_reason_code is
      'Decision 0189: why a quantity-basis power-list row has no reference price (quality unavailable, price null). Null on every priced row.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.mining_snapshot_powers
        where reference_price_quality = 'unavailable'
      ) then
        raise exception
          'refusing to drop unpriced mining power rows while one exists';
      end if;
    end
    $$;

    alter table public.mining_snapshot_powers
      drop constraint mining_snapshot_powers_price_reason_code_check,
      drop constraint mining_snapshot_powers_unpriced_check,
      drop constraint mining_snapshot_powers_price_quality_check,
      add constraint mining_snapshot_powers_price_quality_check
        check (reference_price_quality in ('fresh', 'proxied', 'derived')),
      drop column reference_price_reason_code,
      alter column reference_price_usd set not null;
  `);
}
