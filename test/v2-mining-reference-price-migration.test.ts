import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000028_v2_mining_reference_price_quality.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000028 mining reference price quality migration contract (Decision 0044)", () => {
  it("adds the quality and proxy columns with a default that is true for every existing row", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column reference_price_quality text not null default 'fresh'",
    );
    expect(statement).toContain(
      "add column reference_price_proxy_asset_id text\n        references public.assets(asset_id) on delete restrict",
    );
    expect(statement).toContain(
      "check (reference_price_quality in ('fresh', 'proxied'))",
    );
    expect(statement).toContain(
      "(reference_price_quality = 'proxied')\n          = (reference_price_proxy_asset_id is not null)",
    );
    expect(statement).toContain(
      "check (reference_price_proxy_asset_id is distinct from asset_id)",
    );
    expect(statement).not.toContain("update public.mining_snapshot_powers");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back while a proxied power row exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where reference_price_quality <> 'fresh'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("drop column reference_price_proxy_asset_id");
    expect(statement).toContain("drop column reference_price_quality");
  });
});
