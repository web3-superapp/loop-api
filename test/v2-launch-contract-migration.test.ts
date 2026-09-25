import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000041_v2_launch_contract_adapter.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000041 Launch contract adapter migration contract (Decision 0076)", () => {
  it("widens the axis check to the 06 §2 names and keeps unavailable", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "drop constraint launches_axes_unavailable_check",
    );
    expect(statement).toContain(
      "'unavailable', 'SCHEDULED', 'LIVE', 'ENDED', 'SUCCEEDED', 'FAILED', 'CANCELLED'",
    );
    expect(statement).toContain(
      "'unavailable', 'NONE', 'FROZEN', 'VESTING', 'COMPLETED', 'REFUNDING', 'REFUNDED'",
    );
    expect(statement).toContain(
      "'unavailable', 'NOT_STARTED', 'PREPARING', 'V3_LIVE', 'LP_LOCKED', 'COMPLETED',\n          'RETRY_SCHEDULED'",
    );
    expect(statement).toContain(
      "operational_state in ('unavailable', 'ACTIVE', 'PAUSED')",
    );
  });

  it("adds the sale registry and reserves launch_intent_v1", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column sale_id bigint");
    expect(statement).toContain("add column contract_version text");
    expect(statement).toContain("add column config_version_onchain text");
    // contract_address already exists since 000023.
    expect(statement).not.toContain("add column contract_address");
    expect(statement).toContain("check (sale_id is null or sale_id >= 1)");
    expect(statement).toContain("launches_sale_registry_check");
    expect(statement).toContain(
      "on public.launches (chain_id, contract_address, sale_id)",
    );
    expect(statement).toContain(
      "'community_ai_report_v1',\n        'launch_intent_v1'",
    );
  });

  it("refuses to roll back over chain facts or launch_intent_v1 records", () => {
    const statement = captureSql(down);
    expect(statement).toContain("refusing to roll back 000041");
    expect(statement).toContain("digest_version = 'launch_intent_v1'");
    expect(statement).toContain("sale_state = 'unavailable'");
    expect(statement).not.toContain("'launch_intent_v1'\n      ));");
  });
});
