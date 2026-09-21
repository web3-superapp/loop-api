import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000035_v2_discover_sorts_and_mock_holdings.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000035 discover sorts and mock holdings migration contract (Decision 0061)", () => {
  it("marks every existing balance as a chain observation and allows exactly one other kind", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column source text not null default 'chain'",
    );
    expect(statement).toContain("check (source in ('chain', 'mock_seed'))");
    // Nothing is reclassified: a row written before this migration was
    // written by the wallet read path, which only ever observed a chain.
    expect(statement).not.toContain("update public.wallet_balance_snapshots");
  });

  it("records on each snapshot which kinds of balance produced its numbers", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column holdings_source text not null default 'chain'",
    );
    expect(statement).toContain(
      "check (holdings_source in ('chain', 'mock_seed', 'mixed'))",
    );
  });

  it("gives the activity observation a mandatory observation time and a bounded-count flag", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "create table public.community_channel_activity",
    );
    expect(statement).toContain("community_id uuid primary key");
    expect(statement).toContain("on delete cascade");
    expect(statement).toContain("observed_at timestamptz not null");
    expect(statement).toContain("recent_message_count bigint not null");
    expect(statement).toContain("recent_count_bounded boolean not null");
    expect(statement).toContain("check (window_days = 7)");
    expect(statement).toContain(
      "stream_channel_id ~ '^loop_community_[0-9a-f]{32}$'",
    );
    expect(statement).toContain(
      "create index community_channel_activity_recent_idx",
    );
  });

  it("refuses to roll back the balance source while a seeded holding exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("where source <> 'chain'");
    expect(statement).toContain("raise exception");
    expect(statement).toContain("drop table public.community_channel_activity");
    expect(statement).toContain("drop column holdings_source");
    expect(statement).toContain("drop column source");
  });
});
