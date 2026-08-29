import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000011_issuance_quota_retention.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000011 issuance quota retention migration contract", () => {
  it("adds only the time-leading cleanup index", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "create index issuance_rate_records_cleanup_idx",
    );
    expect(statement).toMatch(
      /on public\.issuance_rate_records\s*\(\s*window_started_at,\s*capability,\s*policy_version,\s*subject_kind,\s*subject_hmac\s*\)/,
    );
    expect(statement).not.toMatch(/\b(?:delete|truncate|drop table)\b/);
  });

  it("rolls back only the cleanup index", () => {
    const statement = captureSql(down);

    expect(statement).toContain(
      "drop index public.issuance_rate_records_cleanup_idx",
    );
    expect(statement).not.toMatch(/\b(?:delete|truncate|drop table)\b/);
  });
});
