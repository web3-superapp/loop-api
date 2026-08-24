import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000003_perp_intents.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  const statement = sql.mock.calls[0]?.[0];
  expect(typeof statement).toBe("string");
  return String(statement);
}

describe("000003 Perp intent migration contract", () => {
  it("migrates existing scoped reservations to the explicit request digest version", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "set digest_version = 'perp_intent_request_v1'",
    );
    expect(statement).toContain("where scope = 'perp_intent_prepare'");
  });

  it("refuses rollback before dropping domain tables when prepared operations exist", () => {
    const statement = captureSql(down);
    const guardIndex = statement.indexOf("do $guard$");
    const existenceCheckIndex = statement.indexOf(
      "operation_kind = 'perp_intent'",
    );
    const firstDropIndex = statement.indexOf(
      "drop table public.perp_intent_events",
    );

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(existenceCheckIndex).toBeGreaterThan(guardIndex);
    expect(firstDropIndex).toBeGreaterThan(existenceCheckIndex);
    expect(statement).toContain("using errcode = '55000'");
  });
});
