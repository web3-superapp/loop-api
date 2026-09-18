import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000030_v2_voice_room_speaker_unmute.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000030 voice room speaker unmute migration contract (Decision 0053)", () => {
  it("extends the audit event types by exactly speaker_unmuted and touches no column", () => {
    const statement = captureSql(up);
    expect(statement).toContain("drop constraint voice_room_events_type_check");
    expect(statement).toContain(
      "'speaker_muted',\n          'speaker_unmuted',\n          'muted_all',",
    );
    expect(statement).not.toContain("add column");
    expect(statement).not.toContain("drop column");
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back while a speaker_unmuted audit row exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where event_type = 'speaker_unmuted'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("'speaker_muted',\n          'muted_all',");
    expect(statement).not.toContain(
      "'speaker_unmuted',\n          'muted_all'",
    );
  });
});
