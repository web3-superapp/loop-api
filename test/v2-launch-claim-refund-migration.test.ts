import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000044_v2_launch_claim_refund_intents.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000044 Launch claim / refund Intent migration contract (Decision 0087)", () => {
  it("widens direction to the three kinds, keeps claims round-less and unpaid, and adds settlement records", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "check (direction in ('buy', 'claim', 'claim_refund'))",
    );
    expect(statement).toContain("alter column round_id drop not null");
    expect(statement).toContain("(direction <> 'buy' or pay_amount_raw > 0)");
    expect(statement).toContain("(direction = 'buy' or pay_amount_raw = 0)");
    expect(statement).toContain("launch_intents_kind_round_check");
    expect(statement).toContain(
      "create table public.launch_settlement_records",
    );
    expect(statement).toContain("check (kind in ('claimed', 'refunded'))");
    expect(statement).toContain("unique (transaction_hash, log_index)");
    // Append-only: no earlier constraint of 000023/000042/000043 is edited
    // beyond the two it replaces.
    expect(statement).not.toContain("launch_intents_state_check");
    expect(statement).not.toContain("launch_intents_report_check");
  });

  it("refuses to roll back over claim / refund facts and restores the buy-only checks", () => {
    const statement = captureSql(down);
    expect(statement).toContain("refusing to roll back 000044");
    expect(statement).toContain("check (direction = 'buy')");
    expect(statement).toContain("alter column round_id set not null");
    expect(statement).toContain("drop table public.launch_settlement_records");
  });

  it("remains required after later logo and operations migrations", () => {
    expect(latestMigrationName).toBe("000049_ops_bootstrap_audit");
    expect(requiredDatabaseRelations).toContain(
      "public.launch_settlement_records",
    );
  });
});
