import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000024_v2_security_settings_support.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000024 V2 security, settings, and support migration contract", () => {
  it("adds the revoke command kind with its own digest version", () => {
    const statement = captureSql(up);
    expect(statement).toContain("check (command_kind in ('logout', 'revoke'))");
    expect(statement).toContain(
      "command_kind = 'revoke' and request_digest_version = 'device_session_revoke_v1'",
    );
    expect(statement).toContain("'support_ticket_create_v1'");
  });

  it("creates the fixed-value CAS settings row", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.account_settings");
    expect(statement).toContain("check (display_currency = 'USD')");
    expect(statement).toContain("check (language = 'zh-CN')");
    expect(statement).toContain("check (record_version > 0)");
  });

  it("creates permanent tickets with an append-only lifecycle and no attachment column", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.support_tickets");
    expect(statement).toContain(
      "'account', 'security', 'wallet', 'trade', 'launch', 'mining',",
    );
    expect(statement).toContain("char_length(body) between 1 and 2000");
    expect(statement).toContain("public.loop_alias_text_is_safe(body)");
    expect(statement).toContain("status in ('open', 'answered', 'closed')");
    expect(statement).toContain("support_tickets are permanent");
    expect(statement).toContain(
      "old.status = 'closed' and new.status is distinct from 'closed'",
    );
    expect(statement).toContain("create table public.support_ticket_events");
    expect(statement).toContain(
      "event_type = 'created' and actor = 'user' and event_version = 0",
    );
    expect(statement).toContain("support_ticket_events are append-only");
    expect(statement).not.toMatch(/attachment\s+(text|bytea|uuid|jsonb)/);
  });

  it("refuses a destructive rollback once data exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "refusing destructive rollback of v2 security, settings, and support data",
    );
    expect(statement).toContain("where command_kind = 'revoke'");
    expect(statement).toContain("check (command_kind = 'logout')");
  });
});
