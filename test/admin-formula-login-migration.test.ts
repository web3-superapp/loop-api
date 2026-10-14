import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as author from "../migrations/000056_formula_draft_author.js";
import * as attempts from "../migrations/000057_admin_login_attempts.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

/** Decision 0110: migration contract of 000056 and 000057. */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000056 formula draft author", () => {
  it("records author and approver and refuses self-approval in the database", () => {
    const sql = captureSql(author.up);
    expect(sql).toContain("add column draft_author_kind text");
    expect(sql).toContain("add column draft_author_account_id uuid");
    expect(sql).toContain("add column approved_by_account_id uuid");
    expect(sql).toContain("draft_author_kind = 'admin_bootstrap'");
    expect(sql).toContain(
      "draft_author_account_id is distinct from approved_by_account_id",
    );
    expect(sql).toContain(
      "approved_by_account_id is null\n        or (draft_author_kind is not null",
    );
    expect(sql).toContain("mining formula draft author is set once, on insert");
    expect(sql).toContain("mining formula approver is immutable");
    // No foreign key into admin_accounts (TRUNCATE ... CASCADE safety).
    expect(sql).not.toContain("references public.admin_accounts");
  });

  it("refuses to roll back over author facts", () => {
    expect(captureSql(author.down)).toContain(
      "formula author facts exist; refusing to roll back 000056",
    );
  });
});

describe("000057 admin login attempts", () => {
  it("keys buckets by scope and subject", () => {
    const sql = captureSql(attempts.up);
    expect(sql).toContain("create table public.admin_login_attempts");
    expect(sql).toContain("primary key (scope, subject_key)");
    expect(sql).toContain("check (scope in ('username', 'ip'))");
    expect(sql).toContain("check (failure_count >= 0)");
    expect(captureSql(attempts.down)).toContain(
      "drop table public.admin_login_attempts",
    );
  });

  it("lists the new relation (head moved on in 000058)", () => {
    expect(latestMigrationName).toBe("000081_launch2_campaigns");
    expect(requiredDatabaseRelations).toContain("public.admin_login_attempts");
  });
});
