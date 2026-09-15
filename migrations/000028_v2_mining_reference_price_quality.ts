import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0044: a Mining power row names how its reference price was
 * observed.
 *
 * Native BNB has no token address a DEX Provider can price; its reference
 * price is WBNB's, a 1:1 wrapper on this chain. Decision 0036 refused every
 * proxied price, which kept BNB out of every snapshot for good. Decision
 * 0044 accepts a proxy the formula version declares, on the condition that
 * nothing downstream can mistake it for a direct observation: every
 * `mining_snapshot_powers` row therefore carries `reference_price_quality`
 * (`fresh` = the asset's own Provider price, `proxied` = a declared proxy
 * asset's price) and, when proxied, the proxy asset itself.
 *
 * Existing rows were all written from the asset's own price (a proxied
 * price could not reach the table before this decision), so the default
 * `fresh` is a true statement about them, not a backfill guess.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshot_powers
      add column reference_price_quality text not null default 'fresh',
      add column reference_price_proxy_asset_id text
        references public.assets(asset_id) on delete restrict,
      add constraint mining_snapshot_powers_price_quality_check
        check (reference_price_quality in ('fresh', 'proxied')),
      add constraint mining_snapshot_powers_price_proxy_check
        check (
          (reference_price_quality = 'proxied')
          = (reference_price_proxy_asset_id is not null)
        ),
      add constraint mining_snapshot_powers_price_proxy_self_check
        check (reference_price_proxy_asset_id is distinct from asset_id);

    comment on column public.mining_snapshot_powers.reference_price_quality is
      'Decision 0044: fresh = the asset''s own Provider price; proxied = the price of reference_price_proxy_asset_id, a proxy the formula version declares (native BNB <- WBNB).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from public.mining_snapshot_powers
        where reference_price_quality <> 'fresh'
      ) then
        raise exception
          'refusing to drop the reference price quality while a proxied power row exists';
      end if;
    end
    $$;

    alter table public.mining_snapshot_powers
      drop constraint mining_snapshot_powers_price_proxy_self_check,
      drop constraint mining_snapshot_powers_price_proxy_check,
      drop constraint mining_snapshot_powers_price_quality_check,
      drop column reference_price_proxy_asset_id,
      drop column reference_price_quality;
  `);
}
