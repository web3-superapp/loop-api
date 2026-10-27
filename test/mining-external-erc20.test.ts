import { describe, expect, it, vi } from "vitest";

import { settleMiningHour } from "../src/features/mining/hourly-settlement-calculator.js";
import type { MiningParameterDocument } from "../src/features/mining/hourly-settlement-contract.js";
import type {
  MiningAssetFact,
  MiningSettlementFacts,
  MiningSettlementRepository,
} from "../src/features/mining/hourly-settlement-ports.js";
import {
  createMiningSettlementRunner,
  prepareMiningHour,
} from "../src/features/mining/hourly-settlement-runner.js";
import { rollMiningErc20Holder } from "../src/features/mining/mining-erc20-holdings.js";
import {
  miningPoolExternalFor,
  miningPoolSettleability,
  type MiningPoolCandidate,
} from "../src/features/mining/mining-pool-roster.js";
import {
  computeMiningSnapshot,
  selectMiningWeight,
  type MiningBalanceInput,
  type MiningCommunityWeightInput,
} from "../src/features/mining/mining-snapshot.js";
import {
  createInMemoryMiningSettlement,
  epochRecord,
  loop,
  parameterVersion,
} from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0189: external (BSC mainnet) tokens let in to the power list are
 * settled hourly from pinned balance readings + indexed ERC-20 transfers; a
 * holder whose balance is not reconstructable counts 0; a stale
 * erc20_transfer lane leaves the external assets out of the hour without
 * holding back the platform MEMEs; the snapshot weights a power-list asset
 * without a formula entry.
 */

const S = BigInt(Date.parse("2026-10-27T10:00:00.000Z") / 1000);
const C1 = "c0000000-0000-4000-8000-000000000001";
const C3 = "c0000000-0000-4000-8000-000000000003";
const MEME1 = "0x1111111111111111111111111111111111116666";
const ASSET1 = `eip155:97:${MEME1}`;
const CAKE_ADDRESS = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const CAKE = `eip155:56:${CAKE_ADDRESS}`;
const U1 = "a0000000-0000-4000-8000-000000000001";
const U2 = "a0000000-0000-4000-8000-000000000002";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const B2 = "0x00000000000000000000000000000000000000b3";
const W1 = "e0000000-0000-4000-8000-000000000001";
const W2 = "e0000000-0000-4000-8000-000000000002";
const hash = `0x${"c".repeat(64)}`;

function documentWith(
  overrides: Partial<MiningParameterDocument> = {},
): MiningParameterDocument {
  return { ...parameterVersion().document, ...overrides };
}

function versionWith(overrides: Partial<MiningParameterDocument> = {}) {
  return parameterVersion({
    effectiveFrom: "2026-10-27T00:00:00.000Z",
    document: documentWith(overrides),
  });
}

const platform: MiningPoolCandidate = {
  communityId: C1,
  communityName: "Alpha",
  assetId: ASSET1,
  chainId: "eip155:97",
  memeAddress: MEME1,
  kind: "platform",
  symbol: "ALPHA",
  instanceId: "d0000000-0000-4000-8000-000000000001",
  launchId: `0x${"1".repeat(64)}`,
  settlementSource: "launch2",
};
const cake: MiningPoolCandidate = {
  communityId: C3,
  communityName: "BSC News",
  assetId: CAKE,
  chainId: "eip155:56",
  memeAddress: CAKE_ADDRESS,
  kind: "external",
  symbol: "CAKE",
  instanceId: null,
  launchId: null,
  settlementSource: "erc20",
};

const platformFact: MiningAssetFact = {
  assetId: ASSET1,
  source: "launch2",
  graduatedAt: null,
  openingPriceE18: loop / 100n,
  openingBalances: [{ address: A, balanceRaw: 100n * loop }],
  moves: [],
};

function cakeFact(overrides: Partial<MiningAssetFact> = {}): MiningAssetFact {
  return {
    assetId: CAKE,
    source: "erc20",
    graduatedAt: null,
    openingPriceE18: 0n,
    // U1 holds 10 CAKE and receives 20 at half past; U2 holds 40 in B2
    // but B (also U2's) has no opening reading.
    openingBalances: [
      { address: A, balanceRaw: 10n * loop },
      { address: B2, balanceRaw: 40n * loop },
    ],
    moves: [
      { address: A, deltaRaw: 20n * loop, at: S + 1800n, priceAfterE18: 0n },
    ],
    unknownHolders: [
      { address: B, reasonCode: "MINING_EXTERNAL_OPENING_MISSING" },
    ],
    openingPins: [
      { assetId: CAKE, walletId: W1, blockNumber: "900" },
      { assetId: CAKE, walletId: W2, blockNumber: "901" },
    ],
    ...overrides,
  };
}

function facts(
  overrides: Partial<MiningSettlementFacts> = {},
): MiningSettlementFacts {
  return {
    nftInstances: [],
    nftOpenings: [],
    nftMoves: [],
    assets: [platformFact, cakeFact()],
    unknownAssetIds: [],
    walletOwners: [
      { address: A, userIds: [U1] },
      { address: B, userIds: [U2] },
      { address: B2, userIds: [U2] },
    ],
    referralEdges: [],
    membershipGate: {
      assetCommunities: [
        { assetId: ASSET1, communityIds: [C1] },
        { assetId: CAKE, communityIds: [C3] },
      ],
      memberships: [
        { userId: U1, communityId: C1, from: 0n, to: null },
        { userId: U1, communityId: C3, from: 0n, to: null },
        { userId: U2, communityId: C3, from: 0n, to: null },
      ],
    },
    walletKinds: "all",
    ...overrides,
  };
}

const external = { assetIds: [CAKE], readable: new Set([CAKE]) };

describe("Decision 0189 erc20 external tokens (settlement)", () => {
  it("treats an erc20 external row as readable / settleable on any settlement chain", () => {
    expect(miningPoolSettleability(cake, "eip155:97")).toEqual({
      settleable: true,
      reasonCode: null,
    });
    expect(
      miningPoolSettleability({ ...cake, settlementSource: null }, "eip155:97"),
    ).toEqual({
      settleable: false,
      reasonCode: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
    });
    expect(
      miningPoolSettleability(
        { ...platform, chainId: "eip155:56" },
        "eip155:97",
      ).settleable,
    ).toBe(false);
    expect(
      [
        ...(miningPoolExternalFor(
          [platform, cake],
          [versionWith({ includedAssets: [CAKE] })],
          "eip155:97",
        )?.readable ?? []),
      ].sort(),
    ).toEqual([CAKE]);
  });

  it("settles a let-in erc20 token time-weighted, and a holder with an unknown wallet counts 0", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [versionWith({ includedAssets: [CAKE] })],
      facts: facts(),
      poolAssetIds: [ASSET1],
      poolExternal: external,
    });
    const result = settleMiningHour(prepared.input);
    const u1 = result.users.find((row) => row.userId === U1);
    const u2 = result.users.find((row) => row.userId === U2);
    // U1: 100 ALPHA + CAKE 10 for half an hour then 30 → 20 average.
    expect(u1?.assetSelfPower).toBe(120n * loop);
    expect(
      u1?.assetHoldings.find((row) => row.assetId === CAKE)?.balanceAtEndRaw,
    ).toBe(30n * loop);
    // U2 holds 40 in B2, but B has no opening reading: 0 for CAKE.
    expect(u2?.assetSelfPower ?? 0n).toBe(0n);
    expect(prepared.summary["externalUnknownHolders"]).toEqual([
      {
        assetId: CAKE,
        reasonCode: "MINING_EXTERNAL_OPENING_MISSING",
        userCount: 1,
      },
    ]);
    expect(prepared.summary["externalOpeningPins"]).toEqual([
      { assetId: CAKE, walletId: W1, blockNumber: "900" },
      { assetId: CAKE, walletId: W2, blockNumber: "901" },
    ]);
    expect(prepared.summary["poolRosterRule"]).toBe("participating");
  });

  it("gates erc20 holdings by membership (a non-member counts 0)", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [versionWith({ includedAssets: [CAKE] })],
      facts: facts({
        membershipGate: {
          assetCommunities: [
            { assetId: ASSET1, communityIds: [C1] },
            { assetId: CAKE, communityIds: [C3] },
          ],
          memberships: [{ userId: U1, communityId: C1, from: 0n, to: null }],
        },
      }),
      poolAssetIds: [ASSET1],
      poolExternal: external,
    });
    const u1 = settleMiningHour(prepared.input).users.find(
      (row) => row.userId === U1,
    );
    expect(u1?.assetSelfPower).toBe(100n * loop);
  });

  it("does not let an erc20 token weigh when not let in", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [versionWith()],
      facts: facts(),
      poolAssetIds: [ASSET1],
      poolExternal: external,
    });
    const u1 = settleMiningHour(prepared.input).users.find(
      (row) => row.userId === U1,
    );
    expect(u1?.assetSelfPower).toBe(100n * loop);
  });

  function runnerWith(
    lanes: Awaited<
      ReturnType<MiningSettlementRepository["readIndexerFreshness"]>
    >["lanes"],
    read: MiningSettlementRepository["readSettlementFacts"],
  ) {
    const repo = createInMemoryMiningSettlement();
    repo.versions.push(versionWith({ includedAssets: [CAKE] }));
    repo.poolCandidates.push(platform, cake);
    const freshness = vi.fn(() => Promise.resolve({ lanes }));
    repo.readIndexerFreshness = freshness;
    const reads = vi.fn(read);
    repo.readSettlementFacts = reads;
    const commit = vi.fn(() =>
      Promise.resolve({ created: true, epoch: epochRecord() }),
    );
    repo.commitEpoch = commit;
    const runner = createMiningSettlementRunner({
      repository: repo,
      chainId: "eip155:97",
      indexerGraceSeconds: 120,
      embeddedWalletOnly: false,
      now: () => new Date("2026-10-27T11:10:00.000Z"),
    });
    return { repo, runner, reads, commit, freshness };
  }

  it("leaves the external assets out when their erc20 lane is stale, settles the platform MEMEs, and replays the same way", async () => {
    const { repo, runner, reads, commit, freshness } = runnerWith(
      [
        {
          lane: "launch2_event",
          hasSources: true,
          updatedAt: "2026-10-27T11:09:00.000Z",
        },
        {
          lane: "erc20_transfer",
          hasSources: true,
          // Last tick before hour end + grace: stale.
          updatedAt: "2026-10-27T10:30:00.000Z",
          chainId: "eip155:56",
          externalAssetIds: [CAKE],
        },
      ],
      (input) =>
        Promise.resolve(
          facts({
            assets: [platformFact],
            externalExcludedAssets: (input.external?.staleAssetIds ?? []).map(
              (assetId) => ({
                assetId,
                reasonCode: "MINING_SETTLEMENT_SOURCE_STALE",
              }),
            ),
          }),
        ),
    );
    const outcome = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(outcome.kind).toBe("settled");
    expect(freshness).toHaveBeenCalledWith(
      expect.objectContaining({ externalAssetIds: [CAKE] }),
    );
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        assetIds: [CAKE, ASSET1],
        external: { assetIds: [CAKE], staleAssetIds: [CAKE], pins: null },
      }),
    );
    const committed = (
      commit.mock.calls as unknown as [
        {
          inputSummary: Record<string, unknown>;
          inputDigest: string;
          rewards: { userId: string; assetSelfPower: string }[];
        },
      ][]
    )[0]?.[0];
    expect(committed?.inputSummary["externalStaleAssetIds"]).toEqual([CAKE]);
    expect(committed?.inputSummary["excludedAssets"]).toEqual([
      {
        assetId: CAKE,
        reasonCode: "MINING_SETTLEMENT_SOURCE_STALE",
        from: "2026-10-27T10:00:00.000Z",
      },
    ]);
    expect(
      committed?.rewards.find((row) => row.userId === U1)?.assetSelfPower,
    ).toBe("100");

    // Replay: the lane has caught up since, but the hour is read the same.
    repo.epochs.push(
      epochRecord({
        hourStart: "2026-10-27T10:00:00.000Z",
        hourEnd: "2026-10-27T11:00:00.000Z",
        inputDigest: committed?.inputDigest ?? null,
        inputSummary: committed?.inputSummary ?? {},
      }),
    );
    reads.mockClear();
    const replay = await runner.replay(epochRecord().epochId);
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        external: { assetIds: [CAKE], staleAssetIds: [CAKE], pins: null },
      }),
    );
    expect(replay?.digestMatches).toBe(true);
  });

  it("does not hold the hour back for a stale erc20 lane, but still does for a stale launch2 lane", async () => {
    const { runner } = runnerWith(
      [
        {
          lane: "launch2_event",
          hasSources: true,
          updatedAt: "2026-10-27T10:30:00.000Z",
        },
      ],
      () => Promise.resolve(facts()),
    );
    expect(
      await runner.settleHour({ hourStart: S, trigger: "scheduled" }),
    ).toEqual({
      kind: "skipped",
      reasonCode: "MINING_SETTLEMENT_INDEXER_BEHIND",
    });
  });

  it("replays an erc20 hour with the pinned opening readings", async () => {
    const { repo, runner, reads, commit } = runnerWith(
      [
        {
          lane: "erc20_transfer",
          hasSources: true,
          updatedAt: "2026-10-27T11:09:00.000Z",
          chainId: "eip155:56",
          externalAssetIds: [CAKE],
        },
      ],
      () => Promise.resolve(facts()),
    );
    expect(
      (await runner.settleHour({ hourStart: S, trigger: "scheduled" })).kind,
    ).toBe("settled");
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        external: { assetIds: [CAKE], staleAssetIds: [], pins: null },
      }),
    );
    const committed = (
      commit.mock.calls as unknown as [
        { inputSummary: Record<string, unknown>; inputDigest: string },
      ][]
    )[0]?.[0];
    repo.epochs.push(
      epochRecord({
        hourStart: "2026-10-27T10:00:00.000Z",
        hourEnd: "2026-10-27T11:00:00.000Z",
        inputDigest: committed?.inputDigest ?? null,
        inputSummary: committed?.inputSummary ?? {},
      }),
    );
    reads.mockClear();
    const replay = await runner.replay(epochRecord().epochId);
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        external: {
          assetIds: [CAKE],
          staleAssetIds: [],
          pins: [
            { assetId: CAKE, walletId: W1, blockNumber: "900" },
            { assetId: CAKE, walletId: W2, blockNumber: "901" },
          ],
        },
      }),
    );
    expect(replay).toMatchObject({ digestMatches: true, reasonCode: null });
  });
});

describe("Decision 0189 power-list assets in the snapshot", () => {
  const formula = {
    configVersion: "miningFormulaTestOnly",
    document: {
      kind: "holding_times_reference_price_times_weight" as const,
      expressionKey: "k",
      dailyOutputKey: "k",
      // No entry for CAKE: the console has no formula editor.
      assetWeights: {},
      referralBoost: { status: "pending_approval" as const },
    },
  };
  const roster: MiningCommunityWeightInput[] = [
    {
      communityId: C3,
      assetId: CAKE,
      weight: "1.5",
      status: "approved",
      source: "roster",
      rosterExcluded: false,
    },
  ];
  const balances: MiningBalanceInput[] = [
    {
      ownerUserId: U1,
      walletId: W1,
      assetId: CAKE,
      decimals: 18,
      rawValue: (10n * loop).toString(),
      blockNumber: "100",
      blockHash: hash,
      source: "chain",
    },
  ];

  it("weights a participating power-list asset without a formula entry", () => {
    expect(selectMiningWeight(CAKE, formula.document, roster)).toEqual({
      kind: "weight",
      weight: "1.5",
    });
    const computed = computeMiningSnapshot(
      {
        balances,
        prices: [
          {
            assetId: CAKE,
            priceUsd: "2",
            quality: "fresh",
            fetchedAt: "2026-10-27T10:00:00.000Z",
            source: "dexscreener",
          },
        ],
        communityWeights: roster,
      },
      formula,
    );
    expect(computed.kind).toBe("computed");
    if (computed.kind === "computed") {
      expect(computed.powers.map((row) => [row.weight, row.power])).toEqual([
        ["1.5", "15"],
      ]);
    }
  });

  it("still needs a formula entry for an asset no verified community binds", () => {
    expect(selectMiningWeight(CAKE, formula.document, [])).toEqual({
      kind: "skip",
      reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
    });
  });

  it("keeps a power-list asset's power without a price under MINING_SNAPSHOT_UNPRICED_POWER_EMIT", () => {
    const computed = computeMiningSnapshot(
      {
        balances,
        prices: [],
        communityWeights: roster,
        unpricedRosterPower: true,
      },
      formula,
    );
    expect(computed.kind).toBe("computed");
    if (computed.kind !== "computed") return;
    expect(computed.priceVersion).toBe("unpriced");
    expect(computed.totalPower).toBe("15");
    expect(computed.powers).toEqual([
      expect.objectContaining({
        assetId: CAKE,
        holding: "10",
        weight: "1.5",
        power: "15",
        referencePriceUsd: null,
        referencePriceQuality: "unavailable",
        referencePriceReasonCode: "MINING_PRICE_NOT_FRESH",
      }),
    ]);
    // An asset no verified community binds still needs its price.
    expect(
      computeMiningSnapshot(
        {
          balances,
          prices: [],
          communityWeights: [],
          unpricedRosterPower: true,
        },
        {
          ...formula,
          document: { ...formula.document, assetWeights: { [CAKE]: "1" } },
        },
      ).kind,
    ).toBe("incomplete");
  });

  it("skips (not unread) a power-list asset without a price", () => {
    const computed = computeMiningSnapshot(
      { balances, prices: [], communityWeights: roster },
      formula,
    );
    expect(computed.kind).toBe("unavailable");
    expect(computed.skipped).toEqual([
      { assetId: CAKE, reasonCode: "MINING_PRICE_NOT_FRESH" },
    ]);
  });
});

describe("Decision 0189 erc20 roll-forward of one holder", () => {
  const move = (
    blockNumber: bigint,
    logIndex: number,
    deltaRaw: bigint,
    at: bigint,
  ) => ({ blockNumber, logIndex, deltaRaw, at });

  it("rolls the reading forward, ignoring transfers at or below its block", () => {
    expect(
      rollMiningErc20Holder({
        hourStart: S,
        readingRaw: 10n,
        readingBlock: 100n,
        transfers: [
          move(90n, 0, 7n, S - 900n),
          move(110n, 0, 5n, S - 600n),
          move(120n, 0, -3n, S + 1800n),
        ],
      }),
    ).toEqual({
      kind: "known",
      openingRaw: 15n,
      moves: [{ deltaRaw: -3n, at: S + 1800n }],
    });
  });

  it("marks a negative balance in chain order inconsistent", () => {
    expect(
      rollMiningErc20Holder({
        hourStart: S,
        readingRaw: 10n,
        readingBlock: 100n,
        transfers: [move(110n, 0, -12n, S + 60n), move(111n, 0, 20n, S + 30n)],
      }),
    ).toEqual({ kind: "inconsistent" });
  });

  it("checks in block / log order, not observed order (a reorg replay re-stamps observed_at)", () => {
    // Chain order: +20 (block 110) then −25 (block 111) → never negative.
    // The replayed +20 was re-observed later than the −25: it is not judged
    // inconsistent, and the −25 is placed no earlier than the +20.
    expect(
      rollMiningErc20Holder({
        hourStart: S,
        readingRaw: 10n,
        readingBlock: 100n,
        transfers: [move(111n, 0, -25n, S + 60n), move(110n, 3, 20n, S + 120n)],
      }),
    ).toEqual({
      kind: "known",
      openingRaw: 10n,
      moves: [
        { deltaRaw: 20n, at: S + 120n },
        { deltaRaw: -25n, at: S + 120n },
      ],
    });
    // A re-stamped log that moves into the hour carries its successors.
    expect(
      rollMiningErc20Holder({
        hourStart: S,
        readingRaw: 10n,
        readingBlock: 100n,
        transfers: [move(110n, 0, 5n, S + 30n), move(111n, 0, -15n, S - 60n)],
      }),
    ).toEqual({
      kind: "known",
      openingRaw: 10n,
      moves: [
        { deltaRaw: 5n, at: S + 30n },
        { deltaRaw: -15n, at: S + 30n },
      ],
    });
    // Same-block transfers follow the log index.
    expect(
      rollMiningErc20Holder({
        hourStart: S,
        readingRaw: 0n,
        readingBlock: 100n,
        transfers: [move(110n, 2, -5n, S + 60n), move(110n, 1, 5n, S + 60n)],
      }).kind,
    ).toBe("known");
  });
});
