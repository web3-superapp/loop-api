import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000043_v2_launch_intent_reconcile.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000043 launch intent reconciliation migration contract (Decision 0080)", () => {
  it("adds the receipt fact, reason code, revert reason, and lease column; reverted and failed need a hash", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column receipt jsonb");
    expect(statement).toContain("add column reason_code text");
    expect(statement).toContain("add column revert_reason text");
    expect(statement).toContain("add column reconcile_after timestamptz");
    expect(statement).toContain(
      "receipt ->> 'status' in ('success', 'reverted')",
    );
    expect(statement).toContain(
      "state not in ('submitted', 'confirmed', 'reverted', 'failed')",
    );
    expect(statement).toContain(
      "state = 'reverted' and char_length(revert_reason)",
    );
    expect(statement).toContain("create index launch_intents_reconcile_idx");
    // Append-only: the 000023 state check already admits every target state.
    expect(statement).not.toContain("launch_intents_state_check");
  });

  it("refuses to roll back over reconciled Intents and restores the 0077 report check", () => {
    const statement = captureSql(down);
    expect(statement).toContain("refusing to roll back 000043");
    expect(statement).toContain(
      "(state not in ('submitted', 'confirmed') or transaction_hash is not null)",
    );
    expect(statement).toContain("drop column receipt");
  });
});
