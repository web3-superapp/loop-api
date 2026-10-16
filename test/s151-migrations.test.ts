import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down as ownerDown,
  up as ownerUp,
} from "../migrations/000071_hooks_launch_owner_config_versions.js";
import {
  down as poolDown,
  up as poolUp,
} from "../migrations/000072_launch2_pool_user_trades.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000071 owner-unique Hooks config versions (Decision 0127)", () => {
  it("creates the monotonic counter and backfills it from existing versions only", () => {
    const statement = captureSql(ownerUp);
    expect(statement).toContain(
      "create table public.hooks_launch_owner_config_versions",
    );
    expect(statement).toContain("check (last_config_version > 0)");
    expect(statement).toContain(
      "select owner_user_id, max(config_version)\n    from public.hooks_launch_project_config_versions\n    group by owner_user_id;",
    );
    expect(statement).toContain("only increase");
    // History is never rewritten.
    expect(statement).not.toMatch(
      /update public\.hooks_launch_(project_config_versions|deployment_tasks|config_approvals)/u,
    );
    expect(statement).not.toContain("delete from");
  });

  it("drops only its own objects", () => {
    const statement = captureSql(ownerDown);
    expect(statement).toContain(
      "drop table public.hooks_launch_owner_config_versions;",
    );
    expect(statement).not.toContain("hooks_launch_project_config_versions");
  });
});

describe("000072 official-pool market trades apart from buybacks (Decision 0127)", () => {
  it("adds the three user columns, backfills them from facts, and bounds them by the totals", () => {
    const statement = captureSql(poolUp);
    for (const column of [
      "pool_user_trade_count",
      "pool_user_buy_volume_usd1",
      "pool_user_sell_volume_usd1",
    ]) {
      expect(statement).toContain(`add column ${column}`);
    }
    expect(statement).toContain(
      "s.caller_address is distinct from owner_instance.buyback_adapter_address",
    );
    expect(statement).toContain(
      "s.caller_address is distinct from owner_instance.buyback_executor_address",
    );
    expect(statement).toContain("pool_user_trade_count <= pool_trade_count");
    expect(statement).not.toContain("update public.launch2_pool_swaps");
    expect(statement).not.toContain("delete from");
  });

  it("rolls back only the projection columns", () => {
    const statement = captureSql(poolDown);
    expect(statement).toContain("drop column pool_user_trade_count");
    expect(statement).not.toContain("launch2_pool_swaps");
  });

  it("is the latest migration and the counter table is a schema table", () => {
    expect(latestMigrationName).toBe("000088_fiat_fx_rates");
    expect(requiredDatabaseRelations).toContain(
      "public.hooks_launch_owner_config_versions",
    );
  });
});
