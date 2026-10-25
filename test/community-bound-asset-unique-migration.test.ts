import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000100_community_bound_asset_unique.js";
import { communityBoundAssetUniqueIndex } from "../src/database/community-bound-asset.js";
import { latestMigrationName } from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]).replace(/\s+/g, " ");
}

describe("000100 community bound asset unique (Decision 0182)", () => {
  it("is the schema head", () => {
    expect(latestMigrationName).toBe("000102_account_wallet_archived_reason");
  });

  it("releases duplicates (verified first, then oldest; rejected excluded) before the partial unique index", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "where bound_asset_key is not null and verification_status <> 'rejected' window holders as ( partition by bound_asset_key order by (verification_status = 'verified') desc, created_at asc, community_id asc )",
    );
    expect(statement).toContain("set bound_asset_key = null");
    expect(statement).toContain("'bound_asset_dedup_0182'");
    expect(statement).toContain("raise notice 'Decision 0182: community %");
    const cleanup = statement.indexOf("set bound_asset_key = null");
    const index = statement.indexOf(
      `create unique index ${communityBoundAssetUniqueIndex} on public.communities (bound_asset_key) where bound_asset_key is not null and verification_status <> 'rejected';`,
    );
    expect(cleanup).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(cleanup);
  });

  it("only drops the index on rollback (released bindings stay released)", () => {
    const statement = captureSql(down);
    expect(statement.trim()).toBe(
      `drop index public.${communityBoundAssetUniqueIndex};`,
    );
  });
});
