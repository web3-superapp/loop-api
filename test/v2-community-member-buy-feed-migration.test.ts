import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000047_v2_community_member_buy_feed.js";
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

describe("000047 community member buy feed migration (Decision 0097)", () => {
  it("creates the feed cursor and the de-duplicating event table", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.community_feed_cursors");
    expect(statement).toContain("primary key (lane, chain_id)");
    expect(statement).toContain("lane in ('community_member_buy_feed')");
    expect(statement).toContain(
      "create table public.community_member_buy_events",
    );
    expect(statement).toContain(
      "primary key (chain_id, transaction_hash, log_index, community_id)",
    );
    expect(statement).toContain("'^loop_buy_[0-9a-f]{32}$'");
    expect(statement).toContain("where outcome = 'pending'");
  });

  it("rolls back by dropping both derived tables", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "drop table public.community_member_buy_events",
    );
    expect(statement).toContain("drop table public.community_feed_cursors");
  });

  it("is at or below the head and both tables are required relations", () => {
    expect(Number(latestMigrationName.slice(0, 6)) >= 47).toBe(true);
    expect(requiredDatabaseRelations).toContain(
      "public.community_feed_cursors",
    );
    expect(requiredDatabaseRelations).toContain(
      "public.community_member_buy_events",
    );
  });
});
