import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000077_launch2_dynamic_pool_attribution.js";
import {
  assessLaunch2MemeCoverage,
  compareLaunch2MemeBalances,
  selectLaunch2MemeBalanceSample,
} from "../src/features/launch2/launch2-meme-coverage.js";

/**
 * Decision 0132: migration 000077 (LoopDynamic tx.from attribution shape)
 * and the pure balance-check rules of the MEME transfer coverage.
 */

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000077 launch2 LoopDynamic pool attribution migration (Decision 0132)", () => {
  it("adds the attribution source, back-fills router_swap, and allows a sender attribution without a router log", () => {
    const statement = captureSql(up);
    expect(statement).toContain("add column attribution_source text");
    expect(statement).toContain(
      "check (attribution_source in ('router_swap', 'transaction_sender'))",
    );
    expect(statement).toContain(
      "set attribution_source = 'router_swap'\n      where wallet_address is not null",
    );
    expect(statement).toContain(
      "or (attribution_source = 'transaction_sender'",
    );
    expect(statement).toContain("and router_log_index is null));");
    expect(statement).not.toContain("delete from");
    expect(statement).not.toContain("create table");
  });

  it("refuses to roll back over sender attributions and restores the 0126 shape", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "raise exception 'refusing to remove LoopDynamic pool wallet attribution evidence'",
    );
    expect(statement).toContain(
      "(wallet_address is null) = (router_log_index is null)",
    );
    expect(statement).toContain("drop column attribution_source");
  });
});

describe("MEME balance spot check rules (Decision 0132)", () => {
  const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  it("samples the hot contracts first, then the most-moved addresses, never the zero address", () => {
    const sample = selectLaunch2MemeBalanceSample({
      hot: [a(0xc0), a(0xc0), a(0)],
      transfers: [
        { from: a(0), to: a(1), amount: "5" },
        { from: a(1), to: a(2), amount: "100" },
        { from: a(3), to: a(4), amount: "100" },
      ],
      max: 4,
    });
    expect(sample).toEqual([a(0xc0), a(1), a(2), a(3)]);
  });

  it("names both directions and the supply", () => {
    const ledger = new Map([
      [a(1), 10n],
      [a(2), 5n],
    ]);
    expect(
      compareLaunch2MemeBalances({
        ledger,
        ledgerSupply: 15n,
        chain: new Map([
          [a(1), 10n],
          [a(2), 5n],
        ]),
        chainSupply: 15n,
      }),
    ).toEqual({ kind: "verified" });
    expect(
      compareLaunch2MemeBalances({
        ledger,
        ledgerSupply: 15n,
        chain: new Map([
          [a(1), 9n],
          [a(2), 6n],
        ]),
        chainSupply: 16n,
      }),
    ).toEqual({
      kind: "mismatch",
      gaps: ["LEDGER_ABOVE_CHAIN", "LEDGER_BELOW_CHAIN", "SUPPLY_MISMATCH"],
      mismatchedCount: 2,
    });
  });

  it("completes only with a verified balance check when one ran", () => {
    const facts = {
      instanceId: "i",
      deployMintPresent: true,
      negativeBalanceCount: 0,
      failedAttempts: 0,
    };
    expect(assessLaunch2MemeCoverage(facts).kind).toBe("complete");
    expect(
      assessLaunch2MemeCoverage({ ...facts, balance: { kind: "verified" } })
        .kind,
    ).toBe("complete");
    expect(
      assessLaunch2MemeCoverage({ ...facts, balance: { kind: "unverified" } }),
    ).toEqual({ kind: "pending", instanceId: "i" });
    expect(
      assessLaunch2MemeCoverage({
        ...facts,
        balance: {
          kind: "mismatch",
          gaps: ["LEDGER_ABOVE_CHAIN"],
          mismatchedCount: 1,
        },
      }),
    ).toMatchObject({ kind: "retry", gaps: ["LEDGER_ABOVE_CHAIN"] });
  });
});

describe("000078 Hooks launch LoopDynamic config migration (Decision 0132)", () => {
  it("admits only poolHookKind = loopDynamic beside the eleven keys", async () => {
    const migration =
      await import("../migrations/000078_hooks_launch_loop_dynamic_config.js");
    const statement = captureSql(migration.up);
    expect(statement).toContain("|| array['poolHookKind']");
    expect(statement).toContain("config->>'poolHookKind' = 'loopDynamic'");
    expect(statement).not.toContain("update public.");
    const rollback = captureSql(migration.down);
    expect(rollback).toContain(
      "raise exception 'refusing to remove LoopDynamic Hooks launch configs'",
    );
  });
});
