import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000048_v2_group_rename_voice_title.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000048 group rename and voice-room title migration contract (Decision 0098)", () => {
  it("opens the name of an active group with a version bump, audits renames, and adds the room title", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column name_version integer not null default 1",
    );
    expect(statement).toContain(
      "create or replace function public.guard_communication_group_mutation()",
    );
    expect(statement).toContain("new.name_version <> old.name_version + 1");
    expect(statement).toContain("old.channel_state <> 'active'");
    expect(statement).toContain("communication group rename is invalid");
    // Identity columns stay immutable.
    expect(statement).toContain(
      "new.stream_channel_id is distinct from old.stream_channel_id",
    );
    expect(statement).toContain(
      "new.create_operation_id is distinct from old.create_operation_id",
    );
    expect(statement).toContain(
      "create table public.communication_group_events",
    );
    expect(statement).toContain("check (event_type in ('group_renamed'))");
    expect(statement).toContain("unique (idempotency_record_id)");
    expect(statement).toContain(
      "before update or delete on public.communication_group_events",
    );
    expect(statement).toContain("add column title text");
    expect(statement).toContain("char_length(title) between 1 and 40");
    expect(statement).toContain("'speaker_stepped_down'");
    // The membership audit and its trigger are not touched.
    expect(statement).not.toContain("chat_group_membership_events");
    expect(statement).not.toContain("communication_group_members");
  });

  it("refuses to roll back over recorded renames or titles and restores the immutable name", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "refusing rollback while group renames, voice-room titles, or step-downs are recorded",
    );
    expect(statement).toContain("drop table public.communication_group_events");
    expect(statement).toContain("new.name is distinct from old.name");
    expect(statement).toContain("drop column name_version");
    expect(statement).toContain("drop column title");
  });

  it("is at or below the head and its table is a required relation", () => {
    expect(Number(latestMigrationName.slice(0, 6)) >= 48).toBe(true);
    expect(requiredDatabaseRelations).toContain(
      "public.communication_group_events",
    );
  });
});
