import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000029_v2_voice_room_member_mute.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000029 voice room member mute migration contract (Decision 0052)", () => {
  it("adds a nullable mute intent that only a speaker can carry", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column muted_at timestamptz,");
    expect(statement).toContain("check (muted_at is null or role = 'speaker')");
    expect(statement).toContain(
      "check (muted_at is null or muted_at >= joined_at)",
    );
    expect(statement).not.toContain("not null default");
    expect(statement).not.toContain("update public.voice_room_members");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("extends the audit event types by exactly speaker_muted", () => {
    const statement = captureSql(up);
    expect(statement).toContain("drop constraint voice_room_events_type_check");
    expect(statement).toContain(
      "'speaker_removed',\n          'speaker_muted',",
    );
    expect(statement).toContain("'muted_all',\n          'room_ended'");
  });

  it("refuses to roll back while a speaker_muted audit row exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where event_type = 'speaker_muted'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("drop column muted_at");
    expect(statement).not.toContain("'speaker_muted',\n          'muted_all'");
  });
});
