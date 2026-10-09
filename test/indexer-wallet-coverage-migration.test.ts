import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000040_indexer_wallet_coverage.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000040 indexer wallet coverage migration contract (Decision 0075)", () => {
  it("creates the per-wallet coverage table keyed by chain, lane, and address", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.indexer_wallet_coverage");
    expect(statement).toContain("primary key (chain_id, lane, address)");
    expect(statement).toContain("from_block_number bigint not null");
    expect(statement).toContain(
      "first_covered_at timestamptz not null default clock_timestamp()",
    );
    expect(statement).toContain("check (lane in ('erc20_transfer'))");
    expect(statement).toContain("check (address ~ '^0x[0-9a-f]{40}$')");
    expect(statement).toContain("references public.chains(chain_id)");
  });

  it("leaves the indexed event tables untouched", () => {
    const statement = captureSql(up);

    expect(statement).not.toContain("indexed_transfers");
    expect(statement).not.toContain("indexed_approvals");
    expect(statement).not.toContain("indexer_checkpoints");
  });

  it("drops only the coverage table on rollback", () => {
    expect(captureSql(down).trim()).toBe(
      "drop table public.indexer_wallet_coverage;",
    );
  });
});
