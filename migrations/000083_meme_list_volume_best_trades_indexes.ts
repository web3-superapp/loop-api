import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0142 (S187-api-a): covering partial indexes on `meme_trades` for
 * the list row's 24-hour volume and the weekly best trades read.
 *
 * - `meme_trades_token_volume_idx (meme_token_id, traded_at) include
 *   (usd1_amount) where not removed`: the list / detail `volume24hUsd1`
 *   aggregate (one bounded range per page row inside the single list
 *   statement) becomes an index-only scan instead of heap fetches.
 * - `meme_trades_sell_window_idx (traded_at) include (wallet,
 *   meme_token_id, usd1_amount, token_amount) where not removed and not
 *   is_buy`: the 7-day sells of `GET /v2/meme/best-trades`.
 * - `meme_trades_wallet_buy_idx (wallet, meme_token_id) include (traded_at,
 *   usd1_amount, token_amount) where not removed and is_buy`: the buy cost
 *   basis of each (wallet, token) pair that sold in the window.
 *
 * No table changes. `down` drops the three indexes.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create index meme_trades_token_volume_idx
      on public.meme_trades (meme_token_id, traded_at) include (usd1_amount)
      where not removed;

    create index meme_trades_sell_window_idx
      on public.meme_trades (traded_at) include (wallet, meme_token_id, usd1_amount, token_amount)
      where not removed and not is_buy;

    create index meme_trades_wallet_buy_idx
      on public.meme_trades (wallet, meme_token_id) include (traded_at, usd1_amount, token_amount)
      where not removed and is_buy;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.meme_trades_wallet_buy_idx;
    drop index public.meme_trades_sell_window_idx;
    drop index public.meme_trades_token_volume_idx;
  `);
}
