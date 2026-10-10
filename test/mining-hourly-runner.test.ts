import { describe, expect, it, vi } from "vitest";

import type { MiningSettlementFacts } from "../src/features/mining/hourly-settlement-ports.js";
import {
  createMiningSettlementRunner,
  miningParameterSlices,
  miningVersionAt,
  prepareMiningHour,
} from "../src/features/mining/hourly-settlement-runner.js";
import { settleMiningHour } from "../src/features/mining/hourly-settlement-calculator.js";
import { createMiningSettlementLane } from "../src/mining-settlement-worker.js";
import {
  createInMemoryMiningSettlement,
  epochRecord,
  loop,
  parameterVersion,
} from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0116 runner: facts → time-sliced, attributed calculator input;
 * the version in force; graduation exclusion; idempotent re-runs; the lane
 * order (§9-10 结算任务重复执行 → 同一周期只记账一次).
 */

const S = BigInt(Date.parse("2026-10-10T10:00:00.000Z") / 1000);
const C = "c0000000-0000-4000-8000-000000000001";
const ASSET = "eip155:97:0x1111111111111111111111111111111111116666";
const INSTANCE = "i0000000-0000-4000-8000-000000000001";
const U1 = "a0000000-0000-4000-8000-000000000001";
const U2 = "a0000000-0000-4000-8000-000000000002";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const X = "0x00000000000000000000000000000000000000c3";

function version(
  coefficient = "2",
  effectiveFrom = "2026-10-10T00:00:00.000Z",
) {
  return parameterVersion({
    versionId: `v-${coefficient}-${effectiveFrom}`,
    effectiveFrom,
    document: {
      ...parameterVersion().document,
      assetWeights: [{ assetId: ASSET, weight: "1" }],
      communityCoefficients: [{ communityId: C, coefficient }],
    },
  });
}

function facts(
  overrides: Partial<MiningSettlementFacts> = {},
): MiningSettlementFacts {
  return {
    nftInstances: [
      { instanceId: INSTANCE, memeAssetId: ASSET, communityIds: [C] },
    ],
    nftOpenings: [{ instanceId: INSTANCE, address: A, count: 2n }],
    nftMoves: [],
    assets: [],
    unknownAssetIds: [],
    walletOwners: [
      { address: A, userIds: [U1] },
      { address: B, userIds: [U2] },
      { address: X, userIds: [U1, U2] },
    ],
    referralEdges: [],
    ...overrides,
  };
}

describe("Decision 0116 runner — inputs", () => {
  it("picks the version in force and slices a mid-hour change", () => {
    const versions = [version("2"), version("4", "2026-10-10T10:30:00.000Z")];
    expect(
      miningVersionAt(versions, S)?.document.communityCoefficients[0]
        ?.coefficient,
    ).toBe("2");
    const slices = miningParameterSlices(versions, S, S + 3_600n);
    expect(slices.map((entry) => [entry.from - S, entry.to - S])).toEqual([
      [0n, 1_800n],
      [1_800n, 3_600n],
    ]);
  });

  it("builds an NFT timeline from transfers inside the hour (transfer moves power at block time)", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts({
        nftMoves: [
          {
            instanceId: INSTANCE,
            from: A,
            to: B,
            at: S + 900n,
            blockNumber: 10n,
            logIndex: 0,
          },
        ],
      }),
    });
    const result = settleMiningHour(prepared.input);
    const u1 = result.users.find((row) => row.userId === U1);
    const u2 = result.users.find((row) => row.userId === U2);
    // A held 2 for 15 min then 1; B held 1 for 45 min. Coefficient 2.
    expect(u1?.nftSelfPower).toBe(
      (2n * loop * 2n * 900n + 1n * loop * 2n * 2_700n) / 3_600n,
    );
    expect(u2?.nftSelfPower).toBe((1n * loop * 2n * 2_700n) / 3_600n);
    expect(u1?.nftHoldings[0]?.countAtEnd).toBe(1n);
  });

  it("drops ambiguous and unbound addresses and reports them", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts({
        nftOpenings: [
          { instanceId: INSTANCE, address: X, count: 1n },
          {
            instanceId: INSTANCE,
            address: "0x00000000000000000000000000000000000000d4",
            count: 1n,
          },
        ],
      }),
    });
    expect(prepared.input.nftHoldings).toEqual([]);
    expect(prepared.summary).toMatchObject({
      ambiguousAddressCount: 1,
      unattributedHoldingCount: 2,
    });
  });

  it("prices the asset track from the curve step function and excludes it from graduation on", () => {
    const graduation = S + 1_800n;
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts({
        nftOpenings: [],
        assets: [
          {
            assetId: ASSET,
            source: "launch2",
            graduatedAt: graduation,
            openingPriceE18: loop / 100n,
            openingBalances: [{ address: A, balanceRaw: 100n * loop }],
            moves: [
              {
                address: B,
                deltaRaw: 100n * loop,
                at: S + 900n,
                priceAfterE18: loop / 50n,
              },
            ],
          },
        ],
      }),
    });
    expect(
      prepared.input.prices.map((p) => [p.from - S, p.to - S, p.priceE18]),
    ).toEqual([
      [0n, 900n, loop / 100n],
      [900n, 1_800n, loop / 50n],
    ]);
    expect(prepared.summary["excludedAssets"]).toEqual([
      {
        assetId: ASSET,
        reasonCode: "MINING_ASSET_GRADUATED_UNREADABLE",
        from: "2026-10-10T10:30:00.000Z",
      },
    ]);
    const result = settleMiningHour(prepared.input);
    const u1 = result.users.find((row) => row.userId === U1);
    // 100 tokens: $1 for 15 min, $2 for 15 min, nothing after graduation.
    expect(u1?.assetSelfPower).toBe(
      (1n * loop * 900n + 2n * loop * 900n) / 3_600n,
    );
  });

  it("refuses an admitted asset without a source", () => {
    expect(() =>
      prepareMiningHour({
        hourStart: S,
        versions: [version()],
        facts: facts({ unknownAssetIds: [ASSET] }),
      }),
    ).toThrow(/MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN/u);
  });

  it("produces the same digest for the same facts (replayable input)", () => {
    const one = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts(),
    });
    const two = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts(),
    });
    expect(one.digest).toBe(two.digest);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/u);
    const other = prepareMiningHour({
      hourStart: S,
      versions: [version()],
      facts: facts({
        nftOpenings: [{ instanceId: INSTANCE, address: A, count: 3n }],
      }),
    });
    expect(other.digest).not.toBe(one.digest);
  });
});

describe("Decision 0116 runner — settle", () => {
  function runnerWith(now: string) {
    const repo = createInMemoryMiningSettlement();
    repo.versions.push(version());
    repo.readIndexerFreshness = vi.fn(() =>
      Promise.resolve({
        lanes: [
          {
            lane: "launch2_event",
            hasSources: true,
            updatedAt: "2026-10-10T11:05:00.000Z",
          },
        ],
      }),
    );
    repo.readSettlementFacts = vi.fn(() => Promise.resolve(facts()));
    const commit = vi.fn(() =>
      Promise.resolve({ created: true, epoch: epochRecord() }),
    );
    repo.commitEpoch = commit;
    const runner = createMiningSettlementRunner({
      repository: repo,
      chainId: "eip155:97",
      indexerGraceSeconds: 120,
      now: () => new Date(now),
    });
    return { repo, runner, commit };
  }

  it("§9-10 结算任务重复执行：已结算的小时不再计算、不再入账", async () => {
    const { repo, runner, commit } = runnerWith("2026-10-10T11:10:00.000Z");
    const first = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(first.kind).toBe("settled");
    expect(commit).toHaveBeenCalledTimes(1);
    repo.epochs.push(epochRecord());
    const second = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(second.kind).toBe("already_settled");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("waits for the hour end + grace and for the indexer", async () => {
    const early = runnerWith("2026-10-10T11:01:00.000Z");
    expect(
      await early.runner.settleHour({ hourStart: S, trigger: "scheduled" }),
    ).toEqual({
      kind: "skipped",
      reasonCode: "MINING_SETTLEMENT_HOUR_NOT_COMPLETE",
    });
    const behind = runnerWith("2026-10-10T11:10:00.000Z");
    behind.repo.readIndexerFreshness = vi.fn(() =>
      Promise.resolve({
        lanes: [
          {
            lane: "launch2_event",
            hasSources: true,
            updatedAt: "2026-10-10T11:00:30.000Z",
          },
        ],
      }),
    );
    expect(
      await behind.runner.settleHour({ hourStart: S, trigger: "scheduled" }),
    ).toEqual({
      kind: "skipped",
      reasonCode: "MINING_SETTLEMENT_INDEXER_BEHIND",
    });
    expect(behind.commit).not.toHaveBeenCalled();
  });

  it("does not settle without an approved version or outside the release", async () => {
    const none = runnerWith("2026-10-10T11:10:00.000Z");
    none.repo.versions = [];
    expect(
      await none.runner.settleHour({ hourStart: S, trigger: "scheduled" }),
    ).toEqual({
      kind: "skipped",
      reasonCode: "MINING_PARAMETERS_PENDING",
    });
    const before = runnerWith("2026-10-10T11:10:00.000Z");
    expect(
      await before.runner.settleHour({
        hourStart: S - 86_400n,
        trigger: "scheduled",
      }),
    ).toMatchObject({ kind: "skipped" });
  });

  it("records a failed hour with its reason and commits nothing", async () => {
    const { repo, runner, commit } = runnerWith("2026-10-10T11:10:00.000Z");
    repo.readSettlementFacts = vi.fn(() =>
      Promise.resolve(facts({ unknownAssetIds: [ASSET] })),
    );
    const failure = vi.fn(() =>
      Promise.resolve(epochRecord({ status: "failed" })),
    );
    repo.recordEpochFailure = failure;
    const outcome = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      reasonCode: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the lane settles oldest first and stops at an hour still waiting on its inputs", async () => {
    const { runner } = runnerWith("2026-10-10T13:10:00.000Z");
    const hours = await runner.candidateHours(3);
    expect(
      hours.map((hour) => new Date(Number(hour) * 1000).toISOString()),
    ).toEqual([
      "2026-10-10T10:00:00.000Z",
      "2026-10-10T11:00:00.000Z",
      "2026-10-10T12:00:00.000Z",
    ]);
    const repo = createInMemoryMiningSettlement();
    const fakeRunner = {
      candidateHours: () => Promise.resolve(hours),
      replay: () => Promise.resolve(null),
      settleHour: vi
        .fn()
        .mockResolvedValueOnce({ kind: "settled", epoch: epochRecord() })
        .mockResolvedValueOnce({
          kind: "skipped",
          reasonCode: "MINING_SETTLEMENT_INDEXER_BEHIND",
        }),
    };
    const lane = createMiningSettlementLane({
      runner: fakeRunner,
      repository: repo,
      rewards: null,
      pollIntervalMs: 60_000,
      catchupHours: 3,
      maxHoursPerTick: 6,
    });
    const tick = await lane.runOnce();
    expect(tick.outcomes.map((entry) => entry.outcome)).toEqual([
      "settled",
      "skipped",
    ]);
    expect(fakeRunner.settleHour).toHaveBeenCalledTimes(2);
  });
});
