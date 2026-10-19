import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000094_launch_token_text_utf8.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string[] {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map((call) => String(call[0]));
}

describe("000094 UTF-8 ticker floor (Decision 0164)", () => {
  it("replaces the three ASCII ticker checks with a byte / trim floor", () => {
    const statements = captureSql(up);
    expect(statements).toHaveLength(3);
    const all = statements.join("\n");
    for (const constraint of [
      "launch_projects_ticker_check",
      "launch2_instances_ticker_check",
      "meme_tokens_symbol_check",
    ]) {
      expect(all).toContain(`drop constraint ${constraint}`);
      expect(all).toContain(`add constraint ${constraint}`);
    }
    expect(all).toContain("octet_length(ticker) between 1 and 80");
    expect(all).toContain("octet_length(symbol) between 1 and 80");
    expect(all).toContain("btrim(ticker,");
    expect(all).not.toMatch(/A-Z0-9/u);
    expect(all).not.toMatch(/alter column|delete from|update /u);
  });

  it("restores the old patterns on down, refusing while rows break them", () => {
    const all = captureSql(down).join("\n");
    expect(all).toContain("check (ticker ~ '^[A-Z0-9]{2,12}$')");
    expect(all).toContain("check (symbol ~ '^[A-Z0-9]{2,10}$')");
    expect(all.match(/raise exception/gu)).toHaveLength(3);
  });
});
