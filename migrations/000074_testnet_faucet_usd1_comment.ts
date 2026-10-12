import type { MigrationBuilder } from "node-pg-migrate";

/**
 * S156b (Decision 0128 amendment): documents what
 * `testnet_faucet_grants.usd1_token_address` records. Comment only; no row
 * or constraint changes (000073 is applied on staging and stays as is).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    comment on column public.testnet_faucet_grants.usd1_token_address is
      'The USD1 contract this grant actually called mint(address,uint256) on: TESTNET_FAUCET_USD1_ADDRESS, else the Hooks Factory usd1() (the MEME v2 / launch2 USD1), else LAUNCH_USD1_ADDRESS. Grants before S156b recorded LAUNCH_USD1_ADDRESS.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    comment on column public.testnet_faucet_grants.usd1_token_address is null;
  `);
}
