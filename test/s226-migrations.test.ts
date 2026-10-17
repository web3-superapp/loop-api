import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000091_launch2_pool_user_trades_buyback_tx.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000091 user pool trades exclude buyback transactions (Decision 0158)", () => {
  it("recomputes only the three user columns of graduated instances, without buyback transactions", () => {
    const statement = captureSql(up);
    expect(statement).toContain("from public.launch2_buybacks b");
    expect(statement).toContain("b.transaction_hash = s.transaction_hash");
    expect(statement).toContain("target.graduated_at is not null");
    expect(statement).toMatch(/pool_user_trade_count = coalesce/u);
    expect(statement).not.toMatch(/pool_trade_count =/u);
    expect(statement).not.toMatch(/delete from|insert into|alter table/u);
  });

  it("restores the Decision 0127 caller rule on down", () => {
    const statement = captureSql(down);
    expect(statement).not.toContain("launch2_buybacks");
    expect(statement).toContain("buyback_adapter_address");
  });
});
