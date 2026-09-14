import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000027_v2_community_transfer_audit.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000027 community ownership transfer audit migration contract", () => {
  it("scopes the audit uniqueness to one row per command per subject", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "alter table public.community_role_events\n      drop constraint community_role_events_idempotency_unique",
    );
    expect(statement).toContain(
      "add constraint community_role_events_idempotency_unique\n      unique (idempotency_record_id, target_user_id)",
    );
    expect(statement).toContain(
      "comment on constraint community_role_events_idempotency_unique",
    );
  });

  it("adds no column, rewrites no row, and keeps the append-only guard", () => {
    const statement = captureSql(up);

    expect(statement).not.toContain("add column");
    expect(statement).not.toContain("drop column");
    expect(statement).not.toContain("update public.community_role_events");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("drop trigger");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back while a command holds more than one audit row", () => {
    const statement = captureSql(down);

    expect(statement).toContain("from public.community_role_events");
    expect(statement).toContain("group by idempotency_record_id");
    expect(statement).toContain("having count(*) > 1");
    expect(statement).toContain("raise exception");
    expect(statement).toContain(
      "add constraint community_role_events_idempotency_unique\n      unique (idempotency_record_id)",
    );
    expect(statement).not.toContain("drop table");
  });
});
