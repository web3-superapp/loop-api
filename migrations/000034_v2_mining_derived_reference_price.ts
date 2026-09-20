import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0059: a formula version may declare how an asset is priced when
 * no pair has it as the base token, and a power row says which pair its
 * reference price came from.
 *
 * Decision 0044 recorded two qualities: `fresh` (the asset's own Provider
 * price) and `proxied` (a declared proxy asset's price). A third is now
 * possible: `derived` — the asset is the *quote* token of the pair that was
 * read and the price is that pair's `priceUsd / priceNative`, accepted only
 * inside the guard band the version declares. A derived row must name its
 * pair, so a reader can check the inversion against the same Provider fact;
 * a `fresh` or `proxied` row may name one and existing rows do not, which is
 * why the column is nullable and nothing is backfilled.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshot_powers
      add column reference_price_pair_address text,
      drop constraint mining_snapshot_powers_price_quality_check,
      add constraint mining_snapshot_powers_price_quality_check
        check (reference_price_quality in ('fresh', 'proxied', 'derived')),
      add constraint mining_snapshot_powers_price_pair_address_check
        check (
          reference_price_pair_address is null
          or reference_price_pair_address ~ '^0x[0-9a-f]{40}$'
        ),
      add constraint mining_snapshot_powers_price_derived_check
        check (
          reference_price_quality <> 'derived'
          or reference_price_pair_address is not null
        );

    comment on column public.mining_snapshot_powers.reference_price_quality is
      'Decisions 0044 and 0059: fresh = the asset is the base token of the pair that was read; proxied = the price of reference_price_proxy_asset_id, a proxy the formula version declares (native BNB <- WBNB); derived = the asset is the quote token and the price is the inverted pair price, accepted only under a declared reference pricing rule and inside its guard band.';

    comment on column public.mining_snapshot_powers.reference_price_pair_address is
      'Decision 0059: the pair the reference price was read from. Required for a derived row so the inversion can be rechecked; null on rows written before this decision.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from public.mining_snapshot_powers
        where reference_price_quality = 'derived'
      ) then
        raise exception
          'refusing to drop the derived reference price while a derived power row exists';
      end if;
    end
    $$;

    alter table public.mining_snapshot_powers
      drop constraint mining_snapshot_powers_price_derived_check,
      drop constraint mining_snapshot_powers_price_pair_address_check,
      drop constraint mining_snapshot_powers_price_quality_check,
      add constraint mining_snapshot_powers_price_quality_check
        check (reference_price_quality in ('fresh', 'proxied')),
      drop column reference_price_pair_address;
  `);
}
