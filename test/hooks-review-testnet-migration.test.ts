import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";
import {
  down,
  up,
} from "../migrations/000052_hooks_review_and_testnet_acceptance.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("Hooks review and Testnet evidence migration", () => {
  it("persists immutable independent approvals and BSC Testnet-only acceptance evidence", () => {
    const sql = captureSql(up);
    expect(sql).toContain("edited_by_operator_id");
    expect(sql).toContain("hooks_launch_config_approvals");
    expect(sql).toContain("hooks_testnet_acceptances");
    expect(sql).toContain("check (chain_id = 97)");
    expect(sql).toContain("before update or delete");
  });

  it("protects recorded evidence from downgrade deletion", () => {
    const sql = captureSql(down);
    expect(sql).toContain(
      "refusing to remove Hooks review or acceptance evidence",
    );
    expect(sql).toContain("using errcode = '55000'");
  });
});
