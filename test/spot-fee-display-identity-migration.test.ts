import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000010_spot_fee_display_identity.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000010 Spot fee display identity migration contract", () => {
  it("widens only the fee identity constraint under an exclusive writer lock", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "lock table public.spot_intents in access exclusive mode",
    );
    expect(statement).toContain(
      "drop constraint spot_intents_result_fee_identity_check",
    );
    expect(statement).toContain("^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$");
    expect(statement).toContain("result_fee_token_index = base_token_index");
    expect(statement).toContain("result_fee_token_index = quote_token_index");
    expect(statement).not.toMatch(
      /\b(?:update|delete from|insert into) public\.spot_intents\b/,
    );
    expect(statement).not.toContain("drop table");
  });

  it("refuses a lossy rollback before restoring the legacy constraint", () => {
    const statement = captureSql(down);
    const guardIndex = statement.indexOf("do $guard$");
    const constraintDropIndex = statement.indexOf(
      "drop constraint spot_intents_result_fee_identity_check",
    );

    expect(statement).toContain("in access exclusive mode");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(constraintDropIndex).toBeGreaterThan(guardIndex);
    expect(statement).toContain("!~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'");
    expect(statement).toContain("using errcode = '55000'");
    expect(statement).toContain("^[A-Z0-9][A-Z0-9._-]{0,63}$");
    expect(statement).not.toContain("drop table");
  });
});
