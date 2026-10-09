import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000042_v2_launch_event_lane.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000042 launch_event lane migration contract (Decision 0077)", () => {
  it("adds the lane, the raw event table with the 14 names, and keeps digests without 0x", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "check (lane in ('erc20_transfer', 'pool_event', 'launch_event'))",
    );
    expect(statement).toContain("create table public.launch_indexed_events");
    expect(statement).toContain(
      "primary key (chain_id, transaction_hash, log_index)",
    );
    for (const name of [
      "SaleStateChanged",
      "Purchased",
      "SaleFinalized",
      "BudgetsFrozen",
      "RefundLiabilityFrozen",
      "Refunded",
      "VestingScheduleCreated",
      "Claimed",
      "PoolPrepared",
      "LiquidityAdded",
      "LPNFTLocked",
      "LiquidityRetryScheduled",
      "Paused",
      "Unpaused",
    ]) {
      expect(statement).toContain(`'${name}'`);
    }
    expect(statement).toContain("state_config_version ~ '^[0-9a-f]{64}$'");
    expect(statement).toContain("check (root ~ '^[0-9a-f]{64}$')");
    expect(statement).toContain("launch_round_allowlist_roots are append-only");
    expect(statement).toContain(
      "add column pool_id uuid references public.pools(pool_id)",
    );
    expect(statement).toContain("'sale_registered'");
    // Wallet addresses are data, never a primary key.
    expect(statement).toContain("allowlist_entry_id uuid primary key");
    expect(statement).not.toMatch(/primary key \([^)]*address/);
  });

  it("refuses to roll back over lane facts, allowlists, or Intents", () => {
    const statement = captureSql(down);
    expect(statement).toContain("refusing to roll back 000042");
    expect(statement).toContain("lane = 'launch_event'");
    expect(statement).toContain(
      "check (lane in ('erc20_transfer', 'pool_event'))",
    );
  });
});
