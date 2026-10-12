import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as joinNotifications from "../migrations/000060_join_notifications_preference.js";
import { latestMigrationName } from "../src/database/schema.js";

/** Decision 0115: migration contract of 000060. */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000060 join notification preference", () => {
  it("adds the preference with a default every existing row reads, and the applied mark only for muted rows", () => {
    const sql = captureSql(joinNotifications.up);
    expect(sql).toContain(
      "add column notifications text not null default 'default'",
    );
    expect(sql).toContain("check (notifications in ('default', 'muted'))");
    expect(sql).toContain(
      "check (notifications_applied_at is null or notifications = 'muted')",
    );
    expect(sql).not.toContain("create table");
  });

  it("rolls back both columns (head moved on to 000061 in S134)", () => {
    const sql = captureSql(joinNotifications.down);
    expect(sql).toContain("drop column notifications_applied_at");
    expect(sql).toContain("drop column notifications;");
    expect(latestMigrationName).toBe("000075_launch2_meme_coverage_integrity");
  });
});
