import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0199 (S359): per-project launch terms filled in with the
 * application — the medal NFT price (whole USD1, 1..1,000, default 100)
 * and the per-address curve purchase cap (whole ‰ of the 1e9 MEME supply,
 * 1..1,000, default 5 = 5,000,000 MEME).
 *
 * They live on the immutable application version
 * (`hooks_launch_project_config_versions`, append-only, 000051 trigger):
 * every saved version carries the terms it was saved with, so the version
 * the reviewer approved and the project signed is the version deployed.
 * Existing versions take the defaults — exactly what their contracts were
 * or will be deployed with on a pre-S359 Factory. Adding a column with a
 * constant default rewrites no row (the immutability trigger is not hit).
 *
 * `down` refuses while a version carries non-default terms, then drops the
 * columns.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_project_config_versions
      add column nft_price_usd1 integer not null default 100,
      add column wallet_cap_per_mille integer not null default 5,
      add constraint hooks_launch_config_nft_price_usd1_check
        check (nft_price_usd1 between 1 and 1000),
      add constraint hooks_launch_config_wallet_cap_per_mille_check
        check (wallet_cap_per_mille between 1 and 1000);

    comment on column public.hooks_launch_project_config_versions.nft_price_usd1 is
      'Decision 0199: the project medal NFT price in whole USD1 (on chain n x 1e18); default 100.';
    comment on column public.hooks_launch_project_config_versions.wallet_cap_per_mille is
      'Decision 0199: the per-address curve purchase cap in whole permille of the 1e9 MEME supply (on chain maxCumulativeBuy = n x 1e24); default 5.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.hooks_launch_project_config_versions
        where nft_price_usd1 <> 100 or wallet_cap_per_mille <> 5
      )
      then
        raise exception 'configs with non-default launch terms exist; refusing to roll back 000108';
      end if;
    end
    $$;

    alter table public.hooks_launch_project_config_versions
      drop constraint hooks_launch_config_wallet_cap_per_mille_check,
      drop constraint hooks_launch_config_nft_price_usd1_check,
      drop column wallet_cap_per_mille,
      drop column nft_price_usd1;
  `);
}
