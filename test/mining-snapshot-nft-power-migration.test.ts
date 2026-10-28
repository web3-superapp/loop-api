import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000104_mining_snapshot_nft_power.js";
import { latestMigrationName } from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000104 mining snapshot nft_power migration contract (Decision 0192)", () => {
  it("is the latest migration", () => {
    expect(latestMigrationName).toBe("000104_mining_snapshot_nft_power");
  });

  it("adds a nullable decimal column bounded by power and rewrites no history", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column nft_power text,");
    expect(statement).not.toContain("not null");
    expect(statement).toContain("nft_power is null");
    expect(statement).toContain("nft_power::numeric <= power::numeric");
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
  });

  it("rolls back by dropping only the column and its check", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "drop constraint mining_snapshot_powers_nft_power_check",
    );
    expect(statement).toContain("drop column nft_power");
    expect(statement).not.toContain("drop table");
  });
});
