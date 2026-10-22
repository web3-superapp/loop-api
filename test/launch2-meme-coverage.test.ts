import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000075_launch2_meme_coverage_integrity.js";
import {
  assessLaunch2MemeCoverage,
  launch2MemeCoverageMaxAttempts,
} from "../src/features/launch2/launch2-meme-coverage.js";
import { latestMigrationName } from "../src/database/schema.js";

/**
 * Decision 0129 §2: the MEME transfer coverage is complete only with the
 * deploy-block mint and no negative balance; three failed checks stop the
 * automatic re-scans.
 */

const base = {
  instanceId: "6b4f3b0c-3c1b-4a55-9a7e-0f4f3f1b2c3d",
  deployMintPresent: true,
  negativeBalanceCount: 0,
  failedAttempts: 0,
};

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("assessLaunch2MemeCoverage (Decision 0129 §2)", () => {
  it("completes when the mint is present and no balance is negative", () => {
    expect(assessLaunch2MemeCoverage(base)).toEqual({
      kind: "complete",
      instanceId: base.instanceId,
    });
  });

  it("retries without the deploy-block mint", () => {
    expect(
      assessLaunch2MemeCoverage({ ...base, deployMintPresent: false }),
    ).toEqual({
      kind: "retry",
      instanceId: base.instanceId,
      gaps: ["DEPLOY_MINT_MISSING"],
      failedAttempts: 1,
      negativeBalanceCount: 0,
    });
  });

  it("retries with a negative balance", () => {
    expect(
      assessLaunch2MemeCoverage({ ...base, negativeBalanceCount: 4 }),
    ).toMatchObject({
      kind: "retry",
      gaps: ["NEGATIVE_BALANCE"],
      negativeBalanceCount: 4,
    });
  });

  it("stalls on the third consecutive failure", () => {
    expect(launch2MemeCoverageMaxAttempts).toBe(3);
    const failing = { ...base, deployMintPresent: false };
    expect(
      assessLaunch2MemeCoverage({ ...failing, failedAttempts: 1 }),
    ).toMatchObject({ kind: "retry", failedAttempts: 2 });
    expect(
      assessLaunch2MemeCoverage({ ...failing, failedAttempts: 2 }),
    ).toMatchObject({ kind: "stalled", failedAttempts: 3 });
  });
});

describe("000075 MEME coverage integrity (Decision 0129 §2)", () => {
  it("adds the failure counter and un-marks completed coverage that fails the check, never touching transfers", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column meme_transfers_coverage_failures integer not null default 0",
    );
    expect(statement).toContain("set meme_transfers_complete_at = null");
    expect(statement).toContain("t.block_number = i.deploy_block_number");
    expect(statement).toContain("having sum(flow.delta) < 0");
    expect(statement).not.toContain("update public.launch2_meme_transfers");
    expect(statement).not.toContain("delete from");
  });

  it("rolls back only the counter", () => {
    const statement = captureSql(down);
    expect(statement).toContain("drop column meme_transfers_coverage_failures");
  });

  it("is the latest migration", () => {
    expect(latestMigrationName).toBe("000095_friend_direct_channel_jobs");
  });
});
