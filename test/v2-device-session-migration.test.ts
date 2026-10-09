import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000014_v2_device_sessions.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000014 V2 device-session migration contract", () => {
  it("creates owner-bound sessions and durable terminal logout commands", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.device_sessions");
    expect(statement).toContain("create table public.device_session_commands");
    expect(statement).toContain("create table public.device_session_events");
    expect(statement).toContain(
      "bootstrap_digest_version text not null default 'device_session_bootstrap_v1'",
    );
    expect(statement).toContain(
      "request_digest_version text not null default 'device_session_logout_v1'",
    );
    expect(statement).toContain("check (contract_version = '2.0')");
    expect(statement).toContain("[0-9]*[A-Za-z-][0-9A-Za-z-]*");
    expect(statement).toContain("client_version !~ '[^0-9A-Za-z.+-]'");
    expect(statement).toContain(
      "foreign key (resolved_session_id, owner_user_id)",
    );
    expect(statement).toContain("result_status in ('not_found', 'revoked')");
    expect(statement).toContain("resolved_session_id is not null");
    expect(statement).toContain(
      "and resolved_session_id = requested_session_id",
    );
  });

  it("makes idempotency bindings immutable and events append-only", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "new.bootstrap_idempotency_key is distinct from old.bootstrap_idempotency_key",
    );
    expect(statement).toContain(
      "new.bootstrap_request_sha256 is distinct from old.bootstrap_request_sha256",
    );
    expect(statement).toContain(
      "new.idempotency_key is distinct from old.idempotency_key",
    );
    expect(statement).toContain(
      "new.result_status is distinct from old.result_status",
    );
    expect(statement).toContain("device_session_commands are permanent");
    expect(statement).toContain("device_session_events are append-only");
  });

  it("permits only monotonic session revocation and last-seen updates", () => {
    const statement = captureSql(up);

    expect(statement).toContain("new.last_seen_at < old.last_seen_at");
    expect(statement).toContain("old.status = 'active'");
    expect(statement).toContain("new.status = 'revoked'");
    expect(statement).toContain("old.status = 'revoked'");
    expect(statement).toContain(
      "new.revoked_at is distinct from old.revoked_at",
    );
  });

  it("locks and refuses a destructive rollback once session data exists", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const guardIndex = statement.indexOf("do $guard$");
    const dropIndex = statement.indexOf(
      "drop trigger device_session_events_immutable",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(lockIndex);
    expect(dropIndex).toBeGreaterThan(guardIndex);
    expect(statement).toContain("refusing destructive rollback");
    expect(statement).toContain("using errcode = '55000'");
    expect(statement).toContain(
      "drop trigger device_session_commands_guard_mutation",
    );
    expect(statement).toContain("drop trigger device_sessions_guard_mutation");
  });
});
