import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as accounts from "../migrations/000055_admin_accounts.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

/** Decision 0109: migration contract of `000055_admin_accounts`. */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000055 admin accounts", () => {
  it("stores one immutable role per account, never deleted, disable terminal", () => {
    const sql = captureSql(accounts.up);
    expect(sql).toContain(
      "role in ('platform_admin', 'reviewer', 'testnet_acceptor', 'auditor')",
    );
    expect(sql).toContain(
      "(role in ('reviewer', 'testnet_acceptor')) = (operator_user_id is not null)",
    );
    expect(sql).toContain("references public.loop_users(id)");
    expect(sql).toContain("on public.admin_accounts (lower(username))");
    expect(sql).toContain(
      "where operator_user_id is not null and disabled_at is null",
    );
    expect(sql).toContain("admin_accounts identity columns are immutable");
    expect(sql).toContain("a disabled admin account is terminal");
    expect(sql).toContain("admin_accounts rows are never deleted");
    expect(sql).toContain("\\$argon2id");
    expect(sql).toContain("credentials_version integer not null default 1");
  });

  it("keeps account commands append-only and extends both audit trails", () => {
    const sql = captureSql(accounts.up);
    expect(sql).toContain("admin_account_commands is append-only");
    expect(sql).toContain(
      "action in ('account.create', 'account.disable', 'account.reset_password')",
    );
    expect(sql).toContain(
      "alter table public.admin_audit_log\n      add column actor_account_id uuid",
    );
    expect(sql).toContain(
      "actor_kind = 'admin_account' and source = 'admin_console'",
    );
    expect(sql).toContain(
      "action in ('operator.provision', 'operator.revoke')",
    );
    // The two earlier shapes stay, now with the new columns null.
    expect(sql).toContain(
      "actor_kind = 'deployment_admin' and source = 'deployment_cli'",
    );
    expect(sql).toContain("source in ('deployment_cli', 'admin_console')");
  });

  it("refuses to roll back over account facts", () => {
    expect(captureSql(accounts.down)).toContain(
      "admin account facts exist; refusing to roll back 000055",
    );
  });

  it("lists the new relations (head moved on in 000058)", () => {
    expect(latestMigrationName).toBe("000095_friend_direct_channel_jobs");
    expect(requiredDatabaseRelations).toContain("public.admin_accounts");
    expect(requiredDatabaseRelations).toContain(
      "public.admin_account_commands",
    );
  });
});
