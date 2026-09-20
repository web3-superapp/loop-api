import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000033_v2_mining_snapshot_completeness.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000033 mining snapshot completeness migration contract (Decision 0057)", () => {
  it("adds a status every existing row satisfies, pins the incomplete shape, and refuses power rows on an incomplete snapshot", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column status text not null default 'complete'",
    );
    expect(statement).toContain(
      "add column unread_inputs jsonb not null default '[]'::jsonb",
    );
    expect(statement).toContain("alter column price_version drop not null");
    expect(statement).toContain(
      "check (status in ('complete', 'incomplete', 'invalidated'))",
    );
    // Incomplete rows carry the unread list and no number; complete and
    // invalidated rows carry a price version.
    expect(statement).toContain(
      "check ((status = 'incomplete') = (jsonb_array_length(unread_inputs) > 0))",
    );
    expect(statement).toContain(
      "check (status <> 'incomplete' or (total_power = '0' and account_count = 0))",
    );
    expect(statement).toContain(
      "check (status = 'incomplete' or price_version is not null)",
    );
    expect(statement).toContain(
      "((status = 'invalidated') = (invalidated_at is not null))",
    );
    expect(statement).toContain(
      "((status = 'invalidated') = (invalidation_reason is not null))",
    );
    // Only complete rows are read as latest.
    expect(statement).toContain(
      "create index mining_snapshots_complete_recent_idx",
    );
    expect(statement).toContain("where status = 'complete'");
    // A power row needs a complete parent; a row is append-only apart from
    // the single complete -> invalidated transition.
    expect(statement).toContain(
      "create trigger mining_snapshot_powers_require_complete",
    );
    expect(statement).toContain(
      "if old.status <> 'complete' or new.status <> 'invalidated' then",
    );
    expect(statement).toContain("create trigger mining_snapshots_guard_update");
    expect(statement).not.toContain("update public.mining_snapshots");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back while an incomplete or invalidated snapshot exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where status <> 'complete'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("drop column status");
    expect(statement).toContain("drop column unread_inputs");
    expect(statement).toContain("alter column price_version set not null");
  });
});
