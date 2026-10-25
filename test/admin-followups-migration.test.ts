import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as followups from "../migrations/000058_admin_followups.js";
import { latestMigrationName } from "../src/database/schema.js";

/** Decision 0111: migration contract of 000058. */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000058 admin follow-ups", () => {
  it("lets the CLI record cli:<name> without an account and refuses its own draft", () => {
    const sql = captureSql(followups.up);
    expect(sql).toContain(
      "drop constraint mining_formula_versions_approved_by_check",
    );
    expect(sql).toContain("approved_by ~ '^cli:[A-Za-z0-9._@-]{1,60}$'");
    expect(sql).toContain(
      "lower(approved_by) <> 'cli:' || lower(draft_author)",
    );
    // The console shape is unchanged: a name with an account ID.
    expect(sql).toContain(
      "(approved_by_account_id is not null\n              and approved_by ~ '^[A-Za-z0-9._@-]{1,64}$')",
    );
    expect(sql).toContain("'account.reset_password', 'account.unlock'");
    expect(sql).not.toContain("create table");
  });

  it("refuses to roll back over CLI approvals or unlock commands, and is the head", () => {
    expect(captureSql(followups.down)).toContain(
      "S130 facts exist; refusing to roll back 000058",
    );
    expect(latestMigrationName).toBe("000101_community_membership_history");
  });
});
