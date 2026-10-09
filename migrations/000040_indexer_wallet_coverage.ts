import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0075: the `erc20_transfer` lane indexes only logs that touch an
 * active LOOP wallet. `indexer_wallet_coverage` records, per lane and wallet
 * address, the first block from which that address was part of the lane's
 * wallet filter. The row is written in the same transaction that advances
 * the lane checkpoint and is never rewritten afterwards, so it is the lower
 * bound a later on-demand history backfill has to start below. No backfill
 * reads it yet, and `indexed_transfers` / `indexed_approvals` are unchanged.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.indexer_wallet_coverage (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      lane text not null,
      address text not null,
      from_block_number bigint not null,
      first_covered_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, lane, address),
      constraint indexer_wallet_coverage_lane_check
        check (lane in ('erc20_transfer')),
      constraint indexer_wallet_coverage_address_check
        check (address ~ '^0x[0-9a-f]{40}$'),
      constraint indexer_wallet_coverage_block_check
        check (from_block_number >= 0)
    );

    comment on table public.indexer_wallet_coverage is
      'First block from which each wallet address was in the indexer lane wallet filter. Written with the checkpoint advance, never rewritten. History below from_block_number is not indexed for that address.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.indexer_wallet_coverage;
  `);
}
