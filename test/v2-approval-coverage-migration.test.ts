import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000025_v2_approval_coverage.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000025 V2 approval coverage migration contract", () => {
  it("adds a nullable approval coverage start that only the transfer lane may hold", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column approval_coverage_from_block bigint",
    );
    expect(statement).not.toMatch(
      /approval_coverage_from_block bigint not null/,
    );
    expect(statement).toContain("approval_coverage_from_block is null");
    expect(statement).toContain("lane = 'erc20_transfer'");
    expect(statement).toContain(
      "approval_coverage_from_block <= last_block_number + 1",
    );
  });

  it("rolls back by dropping only the new column and its constraint", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "drop constraint indexer_checkpoints_approval_coverage_check",
    );
    expect(statement).toContain("drop column approval_coverage_from_block");
    expect(statement).not.toContain("drop table");
  });
});
