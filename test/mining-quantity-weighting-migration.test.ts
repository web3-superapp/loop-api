import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000067_mining_quantity_weighting.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000067 mining quantity weighting migration contract (Decision 0123)", () => {
  it("guards inserts and approvals with assetPowerBasis = quantity and rewrites nothing", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "create trigger mining_parameter_versions_quantity_basis\n      before insert or update on public.mining_parameter_versions",
    );
    expect(statement).toContain(
      "(tg_op = 'INSERT' or (new.status = 'approved' and old.status <> 'approved'))",
    );
    expect(statement).toContain(
      "coalesce(new.document->>'assetPowerBasis', '') <> 'quantity'",
    );
    expect(statement).not.toContain("update public.");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("rolls back by dropping only the guard", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "drop trigger mining_parameter_versions_quantity_basis",
    );
    expect(statement).toContain(
      "drop function public.require_mining_quantity_basis()",
    );
    expect(statement).not.toContain("drop table");
  });
});
