import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000018_v2_message_request_send.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000018 V2 message request send migration contract", () => {
  it("adds message_request_sent to the social graph event vocabulary", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "drop constraint social_graph_events_type_check",
    );
    expect(statement).toContain("'message_request_sent'");
    for (const eventType of [
      "'followed'",
      "'unfollowed'",
      "'blocked'",
      "'unblocked'",
      "'message_request_accepted'",
      "'message_request_ignored'",
      "'message_request_reported'",
    ]) {
      expect(statement).toContain(eventType);
    }
  });

  it("touches no table other than the audit vocabulary", () => {
    const statement = captureSql(up);

    expect(statement).not.toContain("friend_requests");
    expect(statement).not.toContain("create table");
    expect(statement).not.toContain("drop table");
  });

  it("refuses to roll back once a send has been recorded", () => {
    const statement = captureSql(down);

    expect(statement).toContain(
      "lock table public.social_graph_events in access exclusive mode",
    );
    expect(statement).toContain("where event_type = 'message_request_sent'");
    expect(statement).toContain(
      "refusing rollback while V2 message request sends are recorded",
    );
    expect(statement).not.toContain("delete from");
  });
});
