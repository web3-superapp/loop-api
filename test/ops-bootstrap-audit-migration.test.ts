import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";
import { down, up } from "../migrations/000049_ops_bootstrap_audit.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}
describe("deployment CLI audit migration", () => {
  it("corrects historical target-as-actor rows without inventing their previous grants", () => {
    const sql = captureSql(up);
    expect(sql).toContain("alter column actor_id drop not null");
    expect(sql).toContain("actor_kind text not null default 'user'");
    expect(sql).toContain("source text not null default 'ops_api'");
    expect(sql).toContain(
      "set actor_id=null, actor_kind='deployment_admin', source='deployment_cli'",
    );
    expect(sql).toContain("where action='operator.bootstrap'");
    expect(sql).not.toContain("set before_state");
    expect(sql).toContain("ops_audit_actor_shape");
    expect(sql).toContain("ops_audit_change_shape");
  });
  it("refuses a downgrade that would lose deployment actor provenance", () => {
    const sql = captureSql(down);
    expect(sql).toContain("where actor_kind <> 'user'");
    expect(sql).toContain("raise exception");
    expect(sql).not.toContain("delete from");
    expect(sql).toContain("alter column actor_id set not null");
  });
});
