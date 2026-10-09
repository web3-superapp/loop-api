import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000037_v2_push_channel.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000037 V2 push channel migration contract", () => {
  it("binds one active token to one session and one device", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.device_push_tokens");
    expect(statement).toContain(
      "references public.device_sessions(session_id) on delete restrict",
    );
    expect(statement).toContain(
      "create unique index device_push_tokens_active_session_key",
    );
    expect(statement).toContain(
      "create unique index device_push_tokens_active_token_key",
    );
    expect(statement).toContain("where status = 'active'");
    expect(statement).toContain("check (platform in ('android', 'ios'))");
    expect(statement).toContain("check (provider = 'fcm')");
  });

  it("only allows the four documented revoke reasons and a consistent state", () => {
    const statement = captureSql(up);
    for (const reason of [
      "client_unregister",
      "session_revoked",
      "provider_unregistered",
      "replaced_by_session",
    ]) {
      expect(statement).toContain(`'${reason}'`);
    }
    expect(statement).toContain(
      "(status = 'active' and revoked_at is null and revoke_reason is null)",
    );
  });

  it("makes one event reach one device at most once", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.push_deliveries");
    expect(statement).toContain("unique (push_token_id, event_key)");
    expect(statement).toContain("'price_alert_triggered'");
    expect(statement).toContain("'security_event'");
    expect(statement).toContain("'community_voice_room_started'");
    expect(statement).toContain("create index push_deliveries_budget_idx");
    expect(statement).toContain("push_deliveries are append-only");
    expect(statement).toContain("a resolved push delivery is immutable");
  });

  it("stores no payload, message text, address, or amount on a delivery", () => {
    const statement = captureSql(up);
    const deliveries = statement.slice(
      statement.indexOf("create table public.push_deliveries"),
      statement.indexOf("create index push_deliveries_budget_idx"),
    );
    expect(deliveries).not.toMatch(/\bpayload\b/u);
    expect(deliveries).not.toMatch(
      /\b(title|body|message_text|address|amount)\b/u,
    );
  });

  it("records the register and unregister idempotency outcomes without the token", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "create table public.device_push_token_commands",
    );
    expect(statement).toContain("unique (command_kind, idempotency_key)");
    expect(statement).toContain("'device_push_token_register_v1'");
    expect(statement).toContain("'device_push_token_unregister_v1'");
    const commands = statement.slice(
      statement.indexOf("create table public.device_push_token_commands"),
      statement.indexOf("create table public.push_deliveries"),
    );
    expect(commands).not.toMatch(/\btoken text\b/u);
  });

  it("refuses a destructive rollback once a token or a delivery exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "refusing destructive rollback of push channel data",
    );
    expect(statement).toContain("drop table public.push_deliveries");
    expect(statement).toContain("drop table public.device_push_tokens");
  });
});
