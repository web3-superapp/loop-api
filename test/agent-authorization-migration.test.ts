import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000004_agent_authorizations.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  const statement = sql.mock.calls[0]?.[0];
  expect(typeof statement).toBe("string");
  return String(statement);
}

describe("000004 Agent authorization migration contract", () => {
  it("migrates scoped reservations to the explicit request digest version", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "set digest_version = 'perp_agent_authorization_issue_v1'",
    );
    expect(statement).toContain(
      "where scope = 'perp_agent_authorization_issue'",
    );
    expect(statement).toContain(
      "request_digest_version = 'perp_agent_authorization_issue_v1'",
    );
  });

  it("makes Agent identity deletion and signer reuse impossible", () => {
    const statement = captureSql(up);

    expect(statement).toContain("if tg_op = 'DELETE' then");
    expect(statement).toContain("perp_agent_identities cannot be deleted");
    expect(statement).toContain(
      "check (signer_wallet_address <> agent_address)",
    );
  });

  it("locks writers and refuses rollback before dropping durable identity", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const identityLockIndex = statement.indexOf(
      "public.perp_agent_identities,",
    );
    const guardIndex = statement.indexOf("do $guard$");
    const identityCheckIndex = statement.indexOf(
      "exists (select 1 from public.perp_agent_identities)",
    );
    const existenceCheckIndex = statement.indexOf(
      "operation_kind = 'agent_authorization'",
    );
    const firstDropIndex = statement.indexOf(
      "drop table public.perp_agent_authorization_events",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(identityLockIndex).toBeGreaterThan(lockIndex);
    expect(statement).toContain("in access exclusive mode");
    expect(guardIndex).toBeGreaterThan(identityLockIndex);
    expect(identityCheckIndex).toBeGreaterThan(guardIndex);
    expect(existenceCheckIndex).toBeGreaterThan(guardIndex);
    expect(firstDropIndex).toBeGreaterThan(identityCheckIndex);
    expect(firstDropIndex).toBeGreaterThan(existenceCheckIndex);
    expect(statement).toContain("using errcode = '55000'");
  });
});
