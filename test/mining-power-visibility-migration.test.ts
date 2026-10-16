import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000087_mining_power_visibility_default_everyone.js";
import { latestMigrationName } from "../src/database/schema.js";
import { defaultPrivacyV2Values } from "../src/features/profile/profile-v2-contract.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000087 mining power visibility default migration contract (Decision 0148)", () => {
  it("moves the default to everyone and flips only stored self rows with a new version", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "alter column mining_power_visibility set default 'everyone'",
    );
    expect(statement).toMatch(
      /update public\.privacy_preferences_v2\s+set mining_power_visibility = 'everyone',\s+record_version = record_version \+ 1,/,
    );
    expect(statement).toContain("where mining_power_visibility = 'self'");
    expect(statement).not.toMatch(/\bdelete\b/i);
    expect(statement).not.toMatch(/\binsert\b/i);
  });

  it("rolls back only the default, never the rows", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "alter column mining_power_visibility set default 'self'",
    );
    expect(statement).not.toMatch(/\bupdate\b/i);
  });

  it("is the schema head and matches the contract default", () => {
    expect(latestMigrationName).toBe("000089_launch_slot_mainnet_chain_ids");
    expect(defaultPrivacyV2Values.visibility.miningPower).toBe("everyone");
  });
});
