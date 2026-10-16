import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0152 (S209-api; loop-contracts Decision 0015): an S209
 * LoopDynamic Hook takes the 2 % buy fee from the USD1 input
 * (`BuyFeeCharged(round, buyer, grossQuote, fee)`); pre-S209 Hooks keep
 * taking it from the MEME output (`BuyFeeCharged(buyer, grossMeme, fee)`).
 *
 * - `launch2_dynamic_fees_side_shape`: a buy row is either the MEME shape
 *   (no round, a buyer) or the USD1 shape (a round — 0 while no round is
 *   armed — and a buyer, the zero address for an unattributed tier-3
 *   buy); a sell row is unchanged (USD1, a round, no buyer). Buys still
 *   carry no extra fee / drop.
 * - `launch2_pool_swaps_tax_side`: a buy may carry a USD1 tax (an S209
 *   Hook's buy); a sell's tax stays USD1.
 *
 * Number 000089 belongs to S214; this migration has no dependency on it.
 * `down` restores both original constraints; it fails while a USD1 buy row
 * exists (delete those first — they are re-derivable from the chain).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_dynamic_fees
      drop constraint launch2_dynamic_fees_side_shape;
    alter table public.launch2_dynamic_fees
      add constraint launch2_dynamic_fees_side_shape check (
        (side = 'sell' and fee_token = 'usd1' and round_id is not null
          and buyer_address is null)
        or (side = 'buy' and fee_token = 'meme' and round_id is null
          and buyer_address is not null and extra_fee = 0 and drop_wad = 0)
        or (side = 'buy' and fee_token = 'usd1' and round_id is not null
          and buyer_address is not null and extra_fee = 0 and drop_wad = 0));

    alter table public.launch2_pool_swaps
      drop constraint launch2_pool_swaps_tax_side;
    alter table public.launch2_pool_swaps
      add constraint launch2_pool_swaps_tax_side check (
        side = 'buy' or tax_token = 'usd1');
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_pool_swaps
      drop constraint launch2_pool_swaps_tax_side;
    alter table public.launch2_pool_swaps
      add constraint launch2_pool_swaps_tax_side check (
        (side = 'buy') = (tax_token = 'meme'));

    alter table public.launch2_dynamic_fees
      drop constraint launch2_dynamic_fees_side_shape;
    alter table public.launch2_dynamic_fees
      add constraint launch2_dynamic_fees_side_shape check (
        (side = 'buy') = (fee_token = 'meme')
        and (side = 'buy') = (round_id is null)
        and (side = 'buy') = (buyer_address is not null)
        and (side = 'sell' or (extra_fee = 0 and drop_wad = 0)));
  `);
}
