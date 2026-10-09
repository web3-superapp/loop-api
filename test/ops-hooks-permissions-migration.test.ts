import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";
import {
  down,
  up,
} from "../migrations/000051_ops_hooks_workbench_permissions.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("Hooks operations permission migration", () => {
  it("adds separate read, edit, approve and acceptance grants", () => {
    const sql = captureSql(up);
    for (const permission of [
      "launch.read",
      "launch.edit",
      "launch.approve",
      "testnet.read",
      "testnet.accept",
    ]) {
      expect(sql).toContain(`'${permission}'`);
    }
  });

  it("refuses downgrade while any new scoped grant remains", () => {
    const sql = captureSql(down);
    expect(sql).toContain("refusing to remove active Hooks workbench grants");
    expect(sql).toContain("using errcode = '55000'");
    expect(sql).not.toContain("delete from public.ops_grants");
  });
});
