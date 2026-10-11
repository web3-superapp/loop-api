import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000070_launch2_pool_wallet_attribution.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000070 launch2 pool wallet attribution migration contract (Decision 0126)", () => {
  it("admits RouterSwap, adds the opaque trade id and the all-or-none attribution, and the router re-scan coverage", () => {
    const statement = captureSql(up);
    expect(statement).toContain("'BuybackResumed', 'Swap', 'RouterSwap'));");
    expect(statement).toContain(
      "add column pool_trade_id uuid not null default gen_random_uuid()",
    );
    for (const column of [
      "wallet_address",
      "recipient_address",
      "router_amount_in",
      "router_amount_out",
      "router_log_index",
      "pool_router_target_block",
      "pool_router_complete_at",
    ]) {
      expect(statement).toContain(`add column ${column}`);
    }
    expect(statement).toContain("unique (pool_trade_id)");
    expect(statement).toContain(
      "(wallet_address is null) = (router_log_index is null)",
    );
    expect(statement).toContain(
      "where not removed and wallet_address is not null",
    );
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back over attribution evidence", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "raise exception 'refusing to remove official-pool wallet attribution evidence'",
    );
    expect(statement).toContain("'BuybackResumed', 'Swap'));");
  });
});
