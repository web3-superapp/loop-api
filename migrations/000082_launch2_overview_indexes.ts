import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0141 (S185): the time-descending partial indexes that
 * `GET /v2/launch2/overview` activity needs at scale (Decision 0139 §3).
 *
 * Each activity branch reads `order by <time> desc, block desc, log desc
 * limit N` over the non-removed facts; with these indexes the branch walks
 * the index newest-first (an incremental sort settles the block / log tie
 * within one second) instead of sorting the whole table.
 *
 * - `launch2_trades (traded_at desc) where not removed`
 * - `launch2_pool_swaps (swapped_at desc) where not removed`
 * - `launch2_nft_mints (minted_at desc) where not removed`
 * - `launch2_buybacks (executed_at desc) where not removed and outcome =
 *   'executed'`
 * - `launch2_dynamic_claims (claimed_at desc) where not removed`
 * - `launch2_dynamic_rounds (activated_at desc)` (projection; no `removed`)
 *
 * `down` drops the six indexes.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create index launch2_trades_overview_idx
      on public.launch2_trades (traded_at desc)
      where not removed;

    create index launch2_pool_swaps_overview_idx
      on public.launch2_pool_swaps (swapped_at desc)
      where not removed;

    create index launch2_nft_mints_overview_idx
      on public.launch2_nft_mints (minted_at desc)
      where not removed;

    create index launch2_buybacks_overview_idx
      on public.launch2_buybacks (executed_at desc)
      where not removed and outcome = 'executed';

    create index launch2_dynamic_claims_overview_idx
      on public.launch2_dynamic_claims (claimed_at desc)
      where not removed;

    create index launch2_dynamic_rounds_overview_idx
      on public.launch2_dynamic_rounds (activated_at desc);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.launch2_dynamic_rounds_overview_idx;
    drop index public.launch2_dynamic_claims_overview_idx;
    drop index public.launch2_buybacks_overview_idx;
    drop index public.launch2_nft_mints_overview_idx;
    drop index public.launch2_pool_swaps_overview_idx;
    drop index public.launch2_trades_overview_idx;
  `);
}
