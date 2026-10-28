import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0192 (S323): the NFT share of a snapshot power row.
 *
 * The pool part of a snapshot (Decision 0187) folds every NFT's power into
 * its MEME row's `power`. `nft_power` stores that NFT share so a read can
 * split an account's power into the asset pool (token holdings × weight)
 * and the NFT pool (NFT units × coefficient) without re-running the
 * settlement facts:
 *
 * - new rows: the pool part writes the folded NFT power, the formula path
 *   `0` (it has no NFTs); `0 <= nft_power <= power`;
 * - rows stored before this migration stay null (no history rewrite): a
 *   read of such a snapshot publishes no split.
 *
 * Rollback drops the column (the split becomes unreadable, the totals are
 * untouched).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshot_powers
      add column nft_power text,
      add constraint mining_snapshot_powers_nft_power_check
        check (
          nft_power is null
          or (
            nft_power ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'
            and nft_power::numeric <= power::numeric
          )
        );

    comment on column public.mining_snapshot_powers.nft_power is
      'Decision 0192: the NFT share folded into power (pool part, Decision 0187); 0 on formula-path rows; null on rows stored before 0192.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshot_powers
      drop constraint mining_snapshot_powers_nft_power_check,
      drop column nft_power;
  `);
}
