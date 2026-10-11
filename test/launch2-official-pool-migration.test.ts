import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000068_launch2_official_pool_trades.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000068 launch2 official-pool trades migration contract (Decision 0124)", () => {
  it("admits Swap facts, adds the typed swap table, the pool projection and the pool intent kinds without rewriting rows", () => {
    const statement = captureSql(up);
    expect(statement).toContain("'BuybackResumed', 'Swap'));");
    expect(statement).toContain("create table public.launch2_pool_swaps (");
    expect(statement).toContain(
      "primary key (chain_id, transaction_hash, log_index)",
    );
    expect(statement).toContain("check (side in ('buy', 'sell'))");
    expect(statement).toContain("(side = 'buy') = (tax_token = 'meme')");
    for (const column of [
      "pool_trade_count",
      "pool_buy_count",
      "pool_sell_count",
      "pool_buy_volume_usd1",
      "pool_sell_volume_usd1",
      "pool_tax_usd1",
      "pool_tax_meme",
      "pool_last_price_e18",
      "pool_last_trade_at",
    ]) {
      expect(statement).toContain(`add column ${column}`);
    }
    expect(statement).toContain(
      "check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell'))",
    );
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
  });

  it("refuses to roll back over official-pool evidence", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "raise exception 'refusing to remove official-pool trade evidence'",
    );
    expect(statement).toContain("drop table public.launch2_pool_swaps;");
    expect(statement).toContain("check (kind in ('nft_mint', 'buy', 'sell'))");
  });
});
