import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000083_meme_list_volume_best_trades_indexes.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]).replace(/\s+/g, " ");
}

const indexes = [
  [
    "meme_trades_token_volume_idx",
    "on public.meme_trades (meme_token_id, traded_at) include (usd1_amount) where not removed;",
  ],
  [
    "meme_trades_sell_window_idx",
    "on public.meme_trades (traded_at) include (wallet, meme_token_id, usd1_amount, token_amount) where not removed and not is_buy;",
  ],
  [
    "meme_trades_wallet_buy_idx",
    "on public.meme_trades (wallet, meme_token_id) include (traded_at, usd1_amount, token_amount) where not removed and is_buy;",
  ],
] as const;

describe("000083 MEME list volume / best trades indexes (Decision 0142)", () => {
  it("creates the three covering partial indexes and nothing else", () => {
    const statement = captureSql(up);
    for (const [name, shape] of indexes) {
      expect(statement).toContain(`create index ${name} ${shape}`);
    }
    expect(statement.match(/create index/g)).toHaveLength(indexes.length);
    expect(statement).not.toContain("create table");
    expect(statement).not.toContain("alter table");
  });

  it("drops exactly those indexes on rollback", () => {
    const statement = captureSql(down);
    for (const [name] of indexes) {
      expect(statement).toContain(`drop index public.${name};`);
    }
    expect(statement.match(/drop index/g)).toHaveLength(indexes.length);
  });
});
