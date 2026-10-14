import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000082_launch2_overview_indexes.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]).replace(/\s+/g, " ");
}

const indexes = [
  [
    "launch2_trades_overview_idx",
    "on public.launch2_trades (traded_at desc) where not removed;",
  ],
  [
    "launch2_pool_swaps_overview_idx",
    "on public.launch2_pool_swaps (swapped_at desc) where not removed;",
  ],
  [
    "launch2_nft_mints_overview_idx",
    "on public.launch2_nft_mints (minted_at desc) where not removed;",
  ],
  [
    "launch2_buybacks_overview_idx",
    "on public.launch2_buybacks (executed_at desc) where not removed and outcome = 'executed';",
  ],
  [
    "launch2_dynamic_claims_overview_idx",
    "on public.launch2_dynamic_claims (claimed_at desc) where not removed;",
  ],
  [
    "launch2_dynamic_rounds_overview_idx",
    "on public.launch2_dynamic_rounds (activated_at desc);",
  ],
] as const;

describe("000082 launch2 overview indexes migration contract (Decision 0141)", () => {
  it("creates the six time-descending activity indexes and nothing else", () => {
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
