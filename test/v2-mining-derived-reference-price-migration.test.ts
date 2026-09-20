import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000034_v2_mining_derived_reference_price.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000034 mining derived reference price migration contract (Decision 0059)", () => {
  it("widens the quality check and adds a nullable pair address that a derived row must carry", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column reference_price_pair_address text");
    expect(statement).toContain(
      "check (reference_price_quality in ('fresh', 'proxied', 'derived'))",
    );
    expect(statement).toContain(
      "reference_price_pair_address ~ '^0x[0-9a-f]{40}$'",
    );
    expect(statement).toContain(
      "reference_price_quality <> 'derived'\n          or reference_price_pair_address is not null",
    );
    // Nothing is backfilled and no row is rewritten.
    expect(statement).not.toContain("update public.mining_snapshot_powers");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
    expect(statement).not.toContain("not null default");
  });

  it("refuses to roll back while a derived power row exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where reference_price_quality = 'derived'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("drop column reference_price_pair_address");
    expect(statement).toContain(
      "check (reference_price_quality in ('fresh', 'proxied'))",
    );
  });
});
