import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000026_v2_launch_chain_bsc_testnet.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000026 V2 launch chain (BSC testnet) migration contract", () => {
  it("seeds the eip155:97 chain row idempotently and nothing else", () => {
    const statement = captureSql(up);
    expect(statement).toContain("insert into public.chains");
    expect(statement).toContain(
      "('eip155:97', 'eip155', 97, 'BNB Smart Chain Testnet', 'eip155:97:native', 5, 15)",
    );
    expect(statement).toContain("on conflict (chain_id) do nothing");
    // No asset, pool, or registry row exists for the testnet in this step.
    expect(statement).not.toContain("public.assets");
    expect(statement).not.toContain("public.pools");
    expect(statement).not.toContain("alter table");
    expect(statement).not.toContain("create table");
  });

  it("rolls back only the chain row and refuses while a launch or checkpoint references it", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "select 1 from public.launches where chain_id = 'eip155:97'",
    );
    expect(statement).toContain(
      "select 1 from public.indexer_checkpoints where chain_id = 'eip155:97'",
    );
    expect(statement).toContain("raise exception");
    expect(statement).toContain(
      "delete from public.chains where chain_id = 'eip155:97'",
    );
    expect(statement).not.toContain("eip155:56");
    expect(statement).not.toContain("drop table");
  });
});
