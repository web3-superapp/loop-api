import { describe, expect, it, vi } from "vitest";

import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { settleMiningHour } from "../src/features/mining/hourly-settlement-calculator.js";
import {
  MiningParameterDocumentError,
  parseMiningParameterDocument,
  parseMiningParameterDraft,
  type MiningParameterDocument,
} from "../src/features/mining/hourly-settlement-contract.js";
import type { MiningSettlementFacts } from "../src/features/mining/hourly-settlement-ports.js";
import {
  admittedAssetIds,
  createMiningSettlementRunner,
  miningInputDigest,
  prepareMiningHour,
} from "../src/features/mining/hourly-settlement-runner.js";
import {
  createUnavailableMiningRepository,
  type MiningFormulaRecord,
  type MiningRepository,
  type WriteMiningSnapshotInput,
} from "../src/features/mining/mining-repository.js";
import {
  computeMiningPoolSnapshot,
  miningPoolSnapshotReasonCodes,
} from "../src/features/mining/mining-pool-snapshot.js";
import {
  miningEffectiveAssetWeights,
  miningEffectiveCommunityCoefficients,
  miningIgnoredNonRosterAssetIds,
  miningPoolExternalFor,
  resolveMiningPoolEntry,
  type MiningPoolCandidate,
} from "../src/features/mining/mining-pool-roster.js";
import {
  computeMiningSnapshot,
  selectMiningWeight,
  type MiningBalanceInput,
  type MiningCommunityWeightInput,
} from "../src/features/mining/mining-snapshot.js";
import { createMiningSnapshotWorker } from "../src/mining-snapshot-worker.js";
import { projectCommunityWeight } from "../src/features/mining/mining-community-projection.js";
import { createMiningPowerReader } from "../src/features/mining/mining-power-reader.js";
import {
  createInMemoryMiningSettlement,
  epochRecord,
  loop,
  parameterVersion,
} from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0187: the mining pool roster — platform MEMEs of verified
 * communities take part at token weight 1 / NFT coefficient 1 unless the
 * parameter document says otherwise; settlement and snapshot share the rule.
 */

const S = BigInt(Date.parse("2026-10-27T10:00:00.000Z") / 1000);
const C1 = "c0000000-0000-4000-8000-000000000001";
const C2 = "c0000000-0000-4000-8000-000000000002";
const MEME1 = "0x1111111111111111111111111111111111116666";
const MEME2 = "0x2222222222222222222222222222222222226666";
const ASSET1 = `eip155:97:${MEME1}`;
const ASSET2 = `eip155:97:${MEME2}`;
const BTCB = "eip155:56:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const I1 = "d0000000-0000-4000-8000-000000000001";
const I2 = "d0000000-0000-4000-8000-000000000002";
const U1 = "a0000000-0000-4000-8000-000000000001";
const U2 = "a0000000-0000-4000-8000-000000000002";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const hash = `0x${"c".repeat(64)}`;

function candidate(
  overrides: Partial<MiningPoolCandidate> = {},
): MiningPoolCandidate {
  return {
    communityId: C1,
    communityName: "Alpha",
    assetId: ASSET1,
    chainId: "eip155:97",
    memeAddress: MEME1,
    kind: "platform",
    symbol: "ALPHA",
    instanceId: I1,
    launchId: `0x${"1".repeat(64)}`,
    ...overrides,
  };
}

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

function facts(
  overrides: Partial<MiningSettlementFacts> = {},
): MiningSettlementFacts {
  return {
    nftInstances: [
      { instanceId: I1, memeAssetId: ASSET1, communityIds: [C1] },
      { instanceId: I2, memeAssetId: ASSET2, communityIds: [C2] },
    ],
    nftOpenings: [
      { instanceId: I1, address: A, count: 2n },
      { instanceId: I2, address: B, count: 1n },
    ],
    nftMoves: [],
    assets: [
      {
        assetId: ASSET1,
        source: "launch2",
        graduatedAt: null,
        openingPriceE18: loop / 100n,
        openingBalances: [
          { address: A, balanceRaw: 100n * loop },
          { address: B, balanceRaw: 50n * loop },
        ],
        moves: [],
      },
    ],
    unknownAssetIds: [],
    walletOwners: [
      { address: A, userIds: [U1] },
      { address: B, userIds: [U2] },
    ],
    referralEdges: [],
    ...overrides,
  };
}

describe("Decision 0187 roster rule (pure)", () => {
  it("defaults a candidate to token weight 1 and NFT coefficient 1", () => {
    const document = documentWith();
    expect(miningEffectiveAssetWeights(document, [ASSET1]).get(ASSET1)).toBe(
      loop,
    );
    expect(resolveMiningPoolEntry(document, candidate())).toEqual({
      participate: true,
      tokenWeight: "1",
      nftCoefficient: "1",
      source: "default",
    });
  });

  it("uses the explicit values and marks the row explicit", () => {
    const document = documentWith({
      assetWeights: [{ assetId: ASSET1, weight: "2.5" }],
      communityCoefficients: [{ communityId: C1, coefficient: "0.5" }],
    });
    expect(miningEffectiveAssetWeights(document, [ASSET1]).get(ASSET1)).toBe(
      (loop * 5n) / 2n,
    );
    expect(resolveMiningPoolEntry(document, candidate())).toEqual({
      participate: true,
      tokenWeight: "2.5",
      nftCoefficient: "0.5",
      source: "explicit",
    });
  });

  it("excluded wins over explicit and default (participate false = both 0)", () => {
    const document = documentWith({
      assetWeights: [{ assetId: ASSET1, weight: "3" }],
      communityCoefficients: [{ communityId: C1, coefficient: "2" }],
      excludedAssets: [ASSET1],
      excludedCommunities: [C1],
    });
    expect(miningEffectiveAssetWeights(document, [ASSET1]).get(ASSET1)).toBe(
      0n,
    );
    expect(miningEffectiveCommunityCoefficients(document).get(C1)).toBe(0n);
    expect(resolveMiningPoolEntry(document, candidate())).toEqual({
      participate: false,
      tokenWeight: "0",
      nftCoefficient: "0",
      source: "explicit",
    });
  });

  it("does not admit an asset outside the candidate set (non-verified / non-platform)", () => {
    const document = documentWith();
    const weights = miningEffectiveAssetWeights(document, [ASSET1]);
    expect(weights.has(ASSET2)).toBe(false);
    expect(weights.has(BTCB)).toBe(false);
    // Document rule (replay of an hour settled before 0191): a non-roster
    // asset keeps its explicit weight; the roster rule drops it.
    expect(
      miningEffectiveAssetWeights(
        documentWith({ assetWeights: [{ assetId: BTCB, weight: "1" }] }),
        [],
      ).get(BTCB),
    ).toBe(loop);
  });

  it("keeps a valuation (pre-0123 replay) document without roster defaults", () => {
    const document = documentWith({
      assetPowerBasis: "valuation",
      defaultCommunityCoefficient: "0",
    });
    expect(miningEffectiveAssetWeights(document, [ASSET1]).size).toBe(0);
    expect(resolveMiningPoolEntry(document, candidate()).tokenWeight).toBe("0");
  });

  it("shows defaults when no version is approved", () => {
    expect(resolveMiningPoolEntry(null, candidate())).toEqual({
      participate: true,
      tokenWeight: "1",
      nftCoefficient: "1",
      source: "default",
    });
  });
});

describe("Decision 0187 parameter document", () => {
  const base = {
    referralRatiosBps: [1000, 500, 300, 200, 100],
    dailyBudgetNftRaw: (500_000n * loop).toString(),
    dailyBudgetAssetRaw: (500_000n * loop).toString(),
    releaseStartAt: "2026-10-10T00:00:00.000Z",
    releaseDays: 900,
    timezone: "UTC",
    minimumClaimRaw: loop.toString(),
    assetWeights: [],
    communityCoefficients: [],
  };

  it("reads a stored document without the new keys as empty lists", () => {
    const parsed = parseMiningParameterDocument(base);
    expect(parsed.excludedAssets).toEqual([]);
    expect(parsed.excludedCommunities).toEqual([]);
  });

  it("accepts, sorts, and validates excludedAssets / excludedCommunities", () => {
    const parsed = parseMiningParameterDraft({
      ...base,
      excludedAssets: [ASSET2, ASSET1],
      excludedCommunities: [C2, C1],
    });
    expect(parsed.excludedAssets).toEqual([ASSET1, ASSET2]);
    expect(parsed.excludedCommunities).toEqual([C1, C2]);
    for (const [key, value] of [
      ["excludedAssets", [ASSET1, ASSET1]],
      ["excludedAssets", ["BTCB"]],
      ["excludedAssets", "x"],
      ["excludedCommunities", ["not-a-uuid"]],
      ["excludedCommunities", [C1, C1]],
    ] as const) {
      try {
        parseMiningParameterDraft({ ...base, [key]: value });
        expect.unreachable(key);
      } catch (error) {
        expect(error).toBeInstanceOf(MiningParameterDocumentError);
        expect((error as MiningParameterDocumentError).field).toBe(key);
      }
    }
  });
});

describe("Decision 0187 settlement", () => {
  it("settles a roster MEME at weight 1 with no assetWeights entry", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [versionWith()],
      facts: facts(),
      poolAssetIds: [ASSET1],
    });
    const result = settleMiningHour(prepared.input);
    const u1 = result.users.find((row) => row.userId === U1);
    const u2 = result.users.find((row) => row.userId === U2);
    // 100 and 50 tokens × 1; NFT 2 × 1 and 1 × 1.
    expect(u1?.assetSelfPower).toBe(100n * loop);
    expect(u2?.assetSelfPower).toBe(50n * loop);
    expect(u1?.nftSelfPower).toBe(2n * loop);
    expect(u2?.nftSelfPower).toBe(1n * loop);
    // Allocation invariants: every track sums to its budget.
    for (const track of [result.asset, result.nft]) {
      expect(track.allocatedRaw + track.unallocatedRaw).toBe(track.budgetRaw);
    }
    expect(
      result.users.reduce((sum, row) => sum + row.assetRewardRaw, 0n),
    ).toBe(result.asset.allocatedRaw);
    // U1 holds 2/3 of the asset power.
    expect(u1?.assetRewardRaw).toBe((result.asset.budgetRaw * 2n) / 3n);
    expect(prepared.summary["poolRosterAssetIds"]).toEqual([ASSET1]);
  });

  it("gives an excluded asset / community nothing", () => {
    const prepared = prepareMiningHour({
      hourStart: S,
      versions: [
        versionWith({ excludedAssets: [ASSET1], excludedCommunities: [C1] }),
      ],
      facts: facts(),
      poolAssetIds: [ASSET1],
    });
    const result = settleMiningHour(prepared.input);
    const u1 = result.users.find((row) => row.userId === U1);
    const u2 = result.users.find((row) => row.userId === U2);
    expect(u1?.assetSelfPower ?? 0n).toBe(0n);
    expect(u1?.nftSelfPower ?? 0n).toBe(0n);
    expect(u2?.assetSelfPower ?? 0n).toBe(0n);
    // C2 is not excluded: its NFT still counts at the default 1.
    expect(u2?.nftSelfPower).toBe(loop);
  });

  it("admits roster assets for the facts read, only with a positive weight", () => {
    expect(admittedAssetIds([versionWith()], S, S + 3_600n, [ASSET1])).toEqual([
      ASSET1,
    ]);
    expect(
      admittedAssetIds(
        [versionWith({ excludedAssets: [ASSET1] })],
        S,
        S + 3_600n,
        [ASSET1],
      ),
    ).toEqual([]);
    expect(admittedAssetIds([versionWith()], S, S + 3_600n)).toEqual([]);
  });

  it("digests an hour without roster assets exactly as before 0187", () => {
    const factsWithoutAssets = facts({ assets: [] });
    const without = prepareMiningHour({
      hourStart: S,
      versions: [versionWith()],
      facts: factsWithoutAssets,
    });
    const empty = prepareMiningHour({
      hourStart: S,
      versions: [versionWith()],
      facts: factsWithoutAssets,
      poolAssetIds: [],
    });
    expect(empty.digest).toBe(without.digest);
    expect(miningInputDigest(empty.input)).toBe(without.digest);
    expect(without.summary["poolRosterAssetIds"]).toBeUndefined();
  });

  it("reads the roster on the settlement chain and replays with the stored one", async () => {
    const repo = createInMemoryMiningSettlement();
    repo.versions.push(versionWith());
    repo.poolCandidates.push(
      candidate(),
      candidate({
        communityId: C2,
        communityName: "Beta",
        assetId: "eip155:56:0x3333333333333333333333333333333333336666",
        chainId: "eip155:56",
        memeAddress: "0x3333333333333333333333333333333333336666",
      }),
    );
    repo.readIndexerFreshness = vi.fn(() =>
      Promise.resolve({
        lanes: [
          {
            lane: "launch2_event",
            hasSources: true,
            updatedAt: "2026-10-27T11:05:00.000Z",
          },
        ],
      }),
    );
    const reads = vi.fn(() => Promise.resolve(facts()));
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
    const outcome = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(outcome.kind).toBe("settled");
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [ASSET1] }),
    );
    const committed = (
      commit.mock.calls as unknown as [
        { inputSummary: Record<string, unknown>; inputDigest: string },
      ][]
    )[0]?.[0];
    expect(committed?.inputSummary["poolRosterAssetIds"]).toEqual([ASSET1]);

    // Replay with the stored roster, even after the roster changed.
    repo.poolCandidates.length = 0;
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
      expect.objectContaining({ assetIds: [ASSET1] }),
    );
    expect(replay?.digestMatches).toBe(true);

    // An hour settled before 0187 replays without a roster.
    repo.epochs.length = 0;
    repo.epochs.push(
      epochRecord({
        hourStart: "2026-10-27T10:00:00.000Z",
        inputSummary: { excludedAssets: [] },
      }),
    );
    reads.mockClear();
    await runner.replay(epochRecord().epochId);
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [] }),
    );
  });
});

describe("Decision 0187 snapshot pool part", () => {
  const block = { blockNumber: "900", blockHash: hash };

  it("values coin + NFT per (account, MEME) on the Launch chain by the settlement rules", () => {
    const part = computeMiningPoolSnapshot({
      at: S + 17n,
      versions: [versionWith()],
      poolAssetIds: [ASSET1, ASSET2],
      facts: facts(),
      block,
      registeredAssetIds: new Set([ASSET1, ASSET2]),
    });
    expect(part.kind).toBe("computed");
    if (part.kind !== "computed") return;
    expect(part.assetIds).toEqual([ASSET1, ASSET2]);
    expect(part.priceVersion).toBe("launch2_curve:2026-10-27T10:00:17.000Z");
    expect(
      part.powers.map((row) => [
        row.ownerUserId,
        row.assetId,
        row.holding,
        row.weight,
        row.power,
        row.referencePriceUsd,
        row.blockNumber,
      ]),
    ).toEqual([
      // 100 tokens × 1 + 2 NFTs × 1
      [U1, ASSET1, "100", "1", "102", "0.01", "900"],
      // 50 tokens × 1
      [U2, ASSET1, "50", "1", "50", "0.01", "900"],
      // NFT only: 1 × 1 (ASSET2 balance not read: no facts)
      [U2, ASSET2, "0", "1", "1", "0", "900"],
    ]);
  });

  it("keeps the NFT share folded into each MEME row as nftPower (Decision 0192)", () => {
    const part = computeMiningPoolSnapshot({
      at: S + 17n,
      versions: [versionWith()],
      poolAssetIds: [ASSET1, ASSET2],
      facts: facts(),
      block,
      registeredAssetIds: new Set([ASSET1, ASSET2]),
    });
    expect(part.kind).toBe("computed");
    if (part.kind !== "computed") return;
    expect(
      part.powers.map((row) => [
        row.ownerUserId,
        row.assetId,
        row.power,
        row.nftPower,
      ]),
    ).toEqual([
      // both: 100 tokens + 2 NFTs
      [U1, ASSET1, "102", "2"],
      // token only
      [U2, ASSET1, "50", "0"],
      // NFT only
      [U2, ASSET2, "1", "1"],
    ]);
  });

  it("applies explicit weights / coefficients and exclusions", () => {
    const part = computeMiningPoolSnapshot({
      at: S,
      versions: [
        versionWith({
          assetWeights: [{ assetId: ASSET1, weight: "2" }],
          communityCoefficients: [{ communityId: C1, coefficient: "3" }],
          excludedAssets: [ASSET2],
          excludedCommunities: [C2],
        }),
      ],
      poolAssetIds: [ASSET1, ASSET2],
      facts: facts(),
      block,
      registeredAssetIds: new Set([ASSET1, ASSET2]),
    });
    if (part.kind !== "computed") throw new Error(part.kind);
    expect(
      part.powers.map((row) => [row.ownerUserId, row.assetId, row.power]),
    ).toEqual([
      [U1, ASSET1, "206"],
      [U2, ASSET1, "100"],
    ]);
    expect(part.skipped).toEqual([
      { assetId: ASSET2, reasonCode: miningPoolSnapshotReasonCodes.excluded },
    ]);
  });

  it("counts only members of the verified community (membership gate)", () => {
    const part = computeMiningPoolSnapshot({
      at: S,
      versions: [versionWith()],
      poolAssetIds: [ASSET1],
      facts: facts({
        membershipGate: {
          assetCommunities: [{ assetId: ASSET1, communityIds: [C1] }],
          memberships: [{ userId: U2, communityId: C1, from: 0n, to: null }],
        },
      }),
      block,
      registeredAssetIds: new Set([ASSET1]),
    });
    if (part.kind !== "computed") throw new Error(part.kind);
    expect(
      part.powers.map((row) => [row.ownerUserId, row.assetId, row.power]),
    ).toEqual([[U2, ASSET1, "50"]]);
  });

  it("is unavailable without a parameter version or a launch2 checkpoint, and skips unregistered assets", () => {
    expect(
      computeMiningPoolSnapshot({
        at: S,
        versions: [],
        poolAssetIds: [ASSET1],
        facts: facts(),
        block,
        registeredAssetIds: new Set([ASSET1]),
      }),
    ).toEqual({ kind: "unavailable", reasonCode: "MINING_PARAMETERS_PENDING" });
    expect(
      computeMiningPoolSnapshot({
        at: S,
        versions: [versionWith()],
        poolAssetIds: [ASSET1],
        facts: facts(),
        block: null,
        registeredAssetIds: new Set([ASSET1]),
      }),
    ).toEqual({
      kind: "unavailable",
      reasonCode: miningPoolSnapshotReasonCodes.checkpointMissing,
    });
    const part = computeMiningPoolSnapshot({
      at: S,
      versions: [versionWith()],
      poolAssetIds: [ASSET1],
      facts: facts(),
      block,
      registeredAssetIds: new Set(),
    });
    if (part.kind !== "computed") throw new Error(part.kind);
    expect(part.powers).toEqual([]);
    expect(part.skipped).toEqual([
      {
        assetId: ASSET1,
        reasonCode: miningPoolSnapshotReasonCodes.assetUnregistered,
      },
    ]);
  });

  const formula = {
    configVersion: "miningFormulaTestOnly",
    document: {
      kind: "holding_times_reference_price_times_weight" as const,
      expressionKey: "mining.rules.formula.holdingTimesWeight",
      dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
      assetWeights: { [BTCB]: "1", [ASSET1]: "5" },
      referralBoost: { status: "pending_approval" as const },
    },
  };

  function balance(assetId: string, rawValue: string): MiningBalanceInput {
    return {
      ownerUserId: U1,
      walletId: "e0000000-0000-4000-8000-000000000001",
      assetId,
      decimals: 18,
      rawValue,
      blockNumber: "100",
      blockHash: hash,
      source: "chain",
    };
  }

  it("merges the pool rows into the snapshot and leaves the formula path for other assets", () => {
    const part = computeMiningPoolSnapshot({
      at: S,
      versions: [versionWith()],
      poolAssetIds: [ASSET1],
      facts: facts(),
      block,
      registeredAssetIds: new Set([ASSET1]),
    });
    if (part.kind !== "computed") throw new Error(part.kind);
    const computation = computeMiningSnapshot(
      {
        // The formula weighs ASSET1 at 5 — ignored: the pool owns it.
        balances: [
          balance(BTCB, (2n * loop).toString()),
          balance(ASSET1, (999n * loop).toString()),
        ],
        prices: [
          {
            assetId: BTCB,
            priceUsd: "60000",
            quality: "fresh",
            fetchedAt: "2026-10-27T10:00:00.000Z",
            source: "dexscreener",
          },
        ],
        communityWeights: [],
        pool: part,
      },
      formula,
    );
    expect(computation.kind).toBe("computed");
    if (computation.kind !== "computed") return;
    expect(
      computation.powers.map((row) => [
        row.ownerUserId,
        row.assetId,
        row.power,
        row.nftPower,
      ]),
    ).toEqual([
      // Decision 0192: a formula-path row stores nftPower 0.
      [U1, BTCB, "2", "0"],
      [U1, ASSET1, "102", "2"],
      [U2, ASSET1, "50", "0"],
    ]);
    expect(computation.totalPower).toBe("154");
    expect(computation.blockNumber).toBe("900");
    expect(computation.priceVersion).toBe(
      "dexscreener:2026-10-27T10:00:00.000Z",
    );
  });

  it("computes a snapshot from the pool alone (no observed balances, no price)", () => {
    const part = computeMiningPoolSnapshot({
      at: S,
      versions: [versionWith()],
      poolAssetIds: [ASSET1],
      facts: facts(),
      block,
      registeredAssetIds: new Set([ASSET1]),
    });
    if (part.kind !== "computed") throw new Error(part.kind);
    const computation = computeMiningSnapshot(
      { balances: [], prices: [], communityWeights: [], pool: part },
      formula,
    );
    expect(computation.kind).toBe("computed");
    if (computation.kind !== "computed") return;
    expect(computation.totalPower).toBe("152");
    expect(computation.priceVersion).toBe(
      "launch2_curve:2026-10-27T10:00:00.000Z",
    );
    expect(computation.holdingsSource).toBe("chain");
  });
});

describe("Decision 0187 snapshot lane", () => {
  const formulaRecord: MiningFormulaRecord = {
    configVersion: "miningFormulaTestOnly",
    formula: {
      kind: "holding_times_reference_price_times_weight",
      expressionKey:
        "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
      dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
      assetWeights: {},
      referralBoost: { status: "pending_approval" },
    },
    weightRange: {
      loop: { status: "approved", descriptionKey: "k" },
      community: { status: "pending_approval", descriptionKey: "k" },
      reviewFactorKeys: [],
    },
    priceGuardRules: [],
    status: "approved",
    effectiveAt: "2026-09-08T00:00:00.000Z",
    approvedAt: "2026-09-08T00:00:00.000Z",
    createdAt: "2026-09-08T00:00:00.000Z",
  };
  const memeAsset: AssetRecord = Object.freeze({
    assetId: ASSET1,
    chainId: "eip155:97",
    address: MEME1,
    symbol: "ALPHA",
    name: "Alpha",
    decimals: 18,
    status: "pending",
    sourceKind: "chain_call",
    sourceBlockNumber: "1",
    sourceVerifiedAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });

  it("writes Launch-chain roster rows that the formula does not weight", async () => {
    const writeSnapshot = vi.fn((input: WriteMiningSnapshotInput) =>
      Promise.resolve({
        snapshotId: input.snapshotId,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        formulaVersion: input.formulaVersion,
        priceVersion: input.priceVersion,
        totalPower: input.totalPower,
        accountCount: 2,
        computedAt: "2026-10-27T10:00:00.000Z",
        holdingsSource: input.holdingsSource,
      }),
    );
    const repository: MiningRepository = {
      ...createUnavailableMiningRepository(),
      getApprovedFormula: vi.fn(() => Promise.resolve(formulaRecord)),
      listBalanceInputs: vi.fn(() => Promise.resolve([])),
      listCommunityWeightInputs: vi.fn(() => Promise.resolve([])),
      writeSnapshot,
    };
    const settlement = createInMemoryMiningSettlement();
    settlement.versions.push(versionWith());
    settlement.poolCandidates.push(candidate());
    settlement.launch2Checkpoint = { blockNumber: "900", blockHash: hash };
    const reads = vi.fn(() =>
      Promise.resolve(
        facts({
          walletKinds: "all" as const,
          nftInstances: [],
          nftOpenings: [],
        }),
      ),
    );
    settlement.readSettlementFacts = reads;
    const readAssetPrice = vi.fn(() => Promise.reject(new Error("unused")));
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([memeAsset])) },
      prices: {
        readAssetPrice,
        readPair: vi.fn(() => Promise.reject(new Error("unused"))),
      },
      pool: { repository: settlement, chainId: "eip155:97" },
      now: () => new Date("2026-10-27T10:00:00.000Z"),
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("snapshotted");
    expect(readAssetPrice).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: "eip155:97",
        hourStart: S,
        hourEnd: S + 1n,
        assetIds: [ASSET1],
        embeddedWalletOnly: false,
      }),
    );
    const written = writeSnapshot.mock.calls[0]?.[0];
    expect(written?.totalPower).toBe("150");
    expect(written?.powers.map((row) => [row.assetId, row.power])).toEqual([
      [ASSET1, "100"],
      [ASSET1, "50"],
    ]);
  });

  it("keeps the pre-0187 lane when the roster is empty", async () => {
    const repository: MiningRepository = {
      ...createUnavailableMiningRepository(),
      getApprovedFormula: vi.fn(() => Promise.resolve(formulaRecord)),
      listBalanceInputs: vi.fn(() => Promise.resolve([])),
      listCommunityWeightInputs: vi.fn(() => Promise.resolve([])),
    };
    const settlement = createInMemoryMiningSettlement();
    const reads = vi.fn(() => Promise.resolve(facts()));
    settlement.readSettlementFacts = reads;
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: {
        readAssetPrice: vi.fn(() => Promise.reject(new Error("unused"))),
        readPair: vi.fn(() => Promise.reject(new Error("unused"))),
      },
      pool: { repository: settlement, chainId: "eip155:97" },
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      kind: "idle",
      reasonCode: "MINING_NO_BALANCE_INPUTS",
    });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("Decision 0187 appendix A community weight projection", () => {
  const base = {
    communityId: C1,
    communityName: "Alpha",
    boundAssetId: ASSET1,
  };

  it("projects a participating roster community as approved with its token weight", () => {
    expect(
      projectCommunityWeight({
        ...base,
        status: "approved",
        weight: "2.5",
        configVersion: "s313-pool",
        reviewedAt: "2026-10-27T00:00:00.000Z",
        source: "roster",
        rosterExcluded: false,
      }),
    ).toEqual({
      status: "approved",
      value: "2.5",
      configVersion: "s313-pool",
      reviewedAt: "2026-10-27T00:00:00.000Z",
    });
  });

  it("never says COMMUNITY_WEIGHT_PENDING_REVIEW for an unticked roster community", () => {
    expect(
      projectCommunityWeight({
        ...base,
        status: "pending_review",
        weight: null,
        configVersion: null,
        reviewedAt: null,
        source: "roster",
        rosterExcluded: true,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MINING_POOL_EXCLUDED",
      reviewStatus: "not_applicable",
    });
  });

  it("keeps the review rule for a non-roster community", () => {
    expect(
      projectCommunityWeight({
        ...base,
        status: "pending_review",
        weight: null,
        configVersion: null,
        reviewedAt: null,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW",
      reviewStatus: "pending_review",
    });
  });

  it("explains an unticked roster community's missing standing on the community page", async () => {
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: vi.fn(() =>
          Promise.resolve({
            configVersion: "f",
            formula: {
              kind: "holding_times_reference_price_times_weight" as const,
              expressionKey: "k",
              dailyOutputKey: "k",
              assetWeights: {},
              referralBoost: { status: "pending_approval" as const },
            },
            weightRange: {
              loop: { status: "approved" as const, descriptionKey: "k" },
              community: {
                status: "pending_approval" as const,
                descriptionKey: "k",
              },
              reviewFactorKeys: [],
            },
            priceGuardRules: [],
            status: "approved" as const,
            effectiveAt: "2026-09-08T00:00:00.000Z",
            approvedAt: "2026-09-08T00:00:00.000Z",
            createdAt: "2026-09-08T00:00:00.000Z",
          }),
        ),
        getLatestSnapshot: vi.fn(() =>
          Promise.resolve({
            snapshotId: "e0000000-0000-4000-8000-000000000009",
            blockNumber: "1",
            blockHash: hash,
            formulaVersion: "f",
            priceVersion: "launch2_curve:2026-10-27T10:00:00.000Z",
            totalPower: "1",
            accountCount: 1,
            computedAt: new Date().toISOString(),
            holdingsSource: "chain" as const,
          }),
        ),
        getLatestSnapshotAttempt: vi.fn(() => Promise.resolve(null)),
        getCommunityStanding: vi.fn(() => Promise.resolve(null)),
        getCommunityWeight: vi.fn(() =>
          Promise.resolve({
            ...base,
            status: "pending_review" as const,
            weight: null,
            configVersion: null,
            reviewedAt: null,
            source: "roster" as const,
            rosterExcluded: true,
          }),
        ),
      },
    });
    expect(await reader.readCommunityPower(C1)).toEqual({
      status: "unavailable",
      reasonCode: "MINING_POOL_EXCLUDED",
    });
  });
});

/**
 * Decision 0189 (power list): an external token bound by a verified
 * community is a roster row that takes part only once `includedAssets` lets
 * it in; the roster is the only rule (no community_mining_weights).
 */
describe("Decision 0189 external tokens", () => {
  const C3 = "c0000000-0000-4000-8000-000000000003";
  const CAKE_ADDRESS = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
  const CAKE = `eip155:56:${CAKE_ADDRESS}`;
  const V1_ADDRESS = "0x4444444444444444444444444444444444446666";
  const V1 = `eip155:97:${V1_ADDRESS}`;
  const cake = candidate({
    communityId: C3,
    communityName: "BSC News",
    assetId: CAKE,
    chainId: "eip155:56",
    memeAddress: CAKE_ADDRESS,
    kind: "external",
    symbol: "CAKE",
    instanceId: null,
    launchId: null,
    settlementSource: null,
  });
  const memeV1 = candidate({
    communityId: C2,
    communityName: "Old Meme",
    assetId: V1,
    memeAddress: V1_ADDRESS,
    kind: "external",
    symbol: "OLD",
    instanceId: null,
    launchId: null,
    settlementSource: "meme_v1",
  });

  it("shows an external row out by default, in once let in, out again when removed", () => {
    // No approved version: out (a platform row would be in at 1 / 1).
    expect(resolveMiningPoolEntry(null, cake)).toEqual({
      participate: false,
      tokenWeight: "0",
      nftCoefficient: "0",
      source: "default",
    });
    // Not let in: out even with a weight listed (weight ≠ participation).
    expect(
      resolveMiningPoolEntry(
        documentWith({ assetWeights: [{ assetId: CAKE, weight: "2" }] }),
        cake,
      ),
    ).toMatchObject({ participate: false, tokenWeight: "0" });
    // Let in: explicit weight, else 1.
    expect(
      resolveMiningPoolEntry(documentWith({ includedAssets: [CAKE] }), cake),
    ).toEqual({
      participate: true,
      tokenWeight: "1",
      nftCoefficient: "1",
      source: "explicit",
    });
    expect(
      resolveMiningPoolEntry(
        documentWith({
          includedAssets: [CAKE],
          assetWeights: [{ assetId: CAKE, weight: "1.8" }],
        }),
        cake,
      ),
    ).toMatchObject({ participate: true, tokenWeight: "1.8" });
    // Excluded wins over let in.
    expect(
      resolveMiningPoolEntry(
        documentWith({ includedAssets: [CAKE], excludedAssets: [CAKE] }),
        cake,
      ),
    ).toMatchObject({ participate: false, tokenWeight: "0" });
  });

  it("weighs an external asset only while let in (and readable when given)", () => {
    const external = { assetIds: [CAKE, V1] };
    const listed = [
      { assetId: CAKE, weight: "2" },
      { assetId: V1, weight: "3" },
    ];
    expect([
      ...miningEffectiveAssetWeights(
        documentWith({ assetWeights: listed }),
        [ASSET1],
        external,
      ).entries(),
    ]).toEqual([[ASSET1, loop]]);
    expect([
      ...miningEffectiveAssetWeights(
        documentWith({ includedAssets: [V1] }),
        [],
        external,
      ).entries(),
    ]).toEqual([[V1, loop]]);
    // A settlement without a source for CAKE never weighs it.
    expect([
      ...miningEffectiveAssetWeights(
        documentWith({ includedAssets: [CAKE, V1], assetWeights: listed }),
        [],
        { assetIds: [CAKE, V1], readable: new Set([V1]) },
      ).entries(),
    ]).toEqual([[V1, 3n * loop]]);
  });

  it("gates every external candidate and every let-in asset that is not a platform MEME", () => {
    const external = miningPoolExternalFor(
      [candidate(), cake, memeV1],
      [
        versionWith({
          includedAssets: [ASSET1, BTCB],
        }),
      ],
      "eip155:97",
    );
    expect(external?.assetIds).toEqual([CAKE, BTCB, V1].sort());
    expect([...(external?.readable ?? [])]).toEqual([V1]);
    expect(miningPoolExternalFor([candidate()], [versionWith()], null)).toBe(
      null,
    );
  });

  it("parses includedAssets (absent → empty; sorted; unique; well-formed)", () => {
    const stored = parseMiningParameterDocument({
      ...documentWith(),
      includedAssets: undefined,
    });
    expect(stored.includedAssets).toEqual([]);
    expect(
      parseMiningParameterDraft({
        ...documentWith(),
        includedAssets: [V1, CAKE],
      }).includedAssets,
    ).toEqual([CAKE, V1].sort());
    for (const bad of [[CAKE, CAKE], ["CAKE"], "x"]) {
      expect(() =>
        parseMiningParameterDraft({ ...documentWith(), includedAssets: bad }),
      ).toThrow(MiningParameterDocumentError);
    }
  });

  it("settles a let-in MEME v1 token, never an unreadable one, and replays with the stored external roster", async () => {
    const repo = createInMemoryMiningSettlement();
    repo.versions.push(
      versionWith({
        includedAssets: [CAKE, V1],
        assetWeights: [{ assetId: CAKE, weight: "2" }],
      }),
    );
    repo.poolCandidates.push(candidate(), cake, memeV1);
    repo.readIndexerFreshness = vi.fn(() =>
      Promise.resolve({ lanes: [] as never[] }),
    );
    const v1Fact = {
      assetId: V1,
      source: "meme_v1" as const,
      graduatedAt: null,
      openingPriceE18: 0n,
      openingBalances: [{ address: B, balanceRaw: 10n * loop }],
      moves: [],
    };
    const reads = vi.fn(() =>
      Promise.resolve(facts({ assets: [...facts().assets, v1Fact] })),
    );
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
    expect(
      (await runner.settleHour({ hourStart: S, trigger: "scheduled" })).kind,
    ).toBe("settled");
    // CAKE (BSC mainnet, no settlement source) is never read here.
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [ASSET1, V1] }),
    );
    const committed = (
      commit.mock.calls as unknown as [
        { inputSummary: Record<string, unknown>; inputDigest: string },
      ][]
    )[0]?.[0];
    expect(committed?.inputSummary["poolExternalAssetIds"]).toEqual([CAKE, V1]);
    expect(committed?.inputSummary["poolExternalReadableAssetIds"]).toEqual([
      V1,
    ]);
    // The replay gates the same assets after the roster changed.
    repo.poolCandidates.length = 0;
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
      expect.objectContaining({ assetIds: [ASSET1, V1] }),
    );
    expect(replay?.reasonCode).toBeNull();
    expect(replay?.digestMatches).toBe(true);
  });

  it("gives an external token not let in (or removed by a newer version) nothing in the settlement", () => {
    const external = { assetIds: [V1], readable: new Set([V1]) };
    const v1Facts = facts({
      assets: [
        {
          assetId: V1,
          source: "meme_v1",
          graduatedAt: null,
          openingPriceE18: 0n,
          openingBalances: [{ address: B, balanceRaw: 10n * loop }],
          moves: [],
        },
      ],
    });
    const letIn = versionWith({ includedAssets: [V1] });
    const removed = parameterVersion({
      versionId: "22222222-2222-4222-8222-222222222222",
      configVersion: "removed",
      effectiveFrom: "2026-10-27T10:00:00.000Z",
      document: documentWith({
        assetWeights: [{ assetId: V1, weight: "5" }],
      }),
    });
    const power = (versions: ReturnType<typeof versionWith>[]) =>
      settleMiningHour(
        prepareMiningHour({
          hourStart: S,
          versions,
          facts: v1Facts,
          poolAssetIds: [],
          poolExternal: external,
        }).input,
      ).users.find((row) => row.userId === U2)?.assetSelfPower ?? 0n;
    expect(power([letIn])).toBe(10n * loop);
    expect(power([letIn, removed])).toBe(0n);
    expect(
      settleMiningHour(
        prepareMiningHour({
          hourStart: S,
          versions: [
            versionWith({ assetWeights: [{ assetId: V1, weight: "5" }] }),
          ],
          facts: v1Facts,
          poolAssetIds: [],
          poolExternal: external,
        }).input,
      ).users.find((row) => row.userId === U2)?.assetSelfPower ?? 0n,
    ).toBe(0n);
  });

  it("values an external token in the snapshot by the power list only while let in", () => {
    const formula = {
      configVersion: "miningFormulaTestOnly",
      document: {
        kind: "holding_times_reference_price_times_weight" as const,
        expressionKey: "mining.rules.formula.holdingTimesWeight",
        dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
        assetWeights: { [CAKE]: "1" },
        referralBoost: { status: "pending_approval" as const },
      },
    };
    const roster = (
      participate: boolean,
      weight: string | null,
    ): MiningCommunityWeightInput[] => [
      {
        communityId: C3,
        assetId: CAKE,
        weight: participate ? weight : null,
        status: participate ? "approved" : "pending_review",
        source: "roster",
        rosterExcluded: !participate,
      },
    ];
    // Not let in (or removed): MINING_POOL_EXCLUDED, never the old 1.8.
    expect(
      selectMiningWeight(CAKE, formula.document, roster(false, null)),
    ).toEqual({ kind: "skip", reasonCode: "MINING_POOL_EXCLUDED" });
    // Let in: the list's weight is the weight (not × the formula entry).
    expect(
      selectMiningWeight(CAKE, formula.document, roster(true, "1.8")),
    ).toEqual({ kind: "weight", weight: "1.8" });
    const balances: MiningBalanceInput[] = [
      {
        ownerUserId: U1,
        walletId: "e0000000-0000-4000-8000-000000000001",
        assetId: CAKE,
        decimals: 18,
        rawValue: (10n * loop).toString(),
        blockNumber: "100",
        blockHash: hash,
        source: "chain",
      },
    ];
    const prices = [
      {
        assetId: CAKE,
        priceUsd: "2",
        quality: "fresh" as const,
        fetchedAt: "2026-10-27T10:00:00.000Z",
        source: "dexscreener",
      },
    ];
    const included = computeMiningSnapshot(
      { balances, prices, communityWeights: roster(true, "1.8") },
      formula,
    );
    expect(included.kind).toBe("computed");
    if (included.kind === "computed") {
      expect(included.powers.map((row) => [row.weight, row.power])).toEqual([
        ["1.8", "18"],
      ]);
    }
    const out = computeMiningSnapshot(
      { balances, prices, communityWeights: roster(false, null) },
      formula,
    );
    expect(out).toMatchObject({
      kind: "unavailable",
      skipped: [{ assetId: CAKE, reasonCode: "MINING_POOL_EXCLUDED" }],
    });
  });

  it("keeps external tokens out of the snapshot pool part and does not price one not let in", async () => {
    const repository: MiningRepository = {
      ...createUnavailableMiningRepository(),
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          configVersion: "miningFormulaTestOnly",
          formula: {
            kind: "holding_times_reference_price_times_weight" as const,
            expressionKey: "k",
            dailyOutputKey: "k",
            assetWeights: { [CAKE]: "1" },
            referralBoost: { status: "pending_approval" as const },
          },
          weightRange: {
            loop: { status: "approved" as const, descriptionKey: "k" },
            community: {
              status: "pending_approval" as const,
              descriptionKey: "k",
            },
            reviewFactorKeys: [],
          },
          priceGuardRules: [],
          status: "approved" as const,
          effectiveAt: "2026-09-08T00:00:00.000Z",
          approvedAt: "2026-09-08T00:00:00.000Z",
          createdAt: "2026-09-08T00:00:00.000Z",
        }),
      ),
      listBalanceInputs: vi.fn(() =>
        Promise.resolve([
          {
            ownerUserId: U1,
            walletId: "e0000000-0000-4000-8000-000000000001",
            assetId: CAKE,
            decimals: 18,
            rawValue: (10n * loop).toString(),
            blockNumber: "100",
            blockHash: hash,
            source: "chain" as const,
          },
        ]),
      ),
      listCommunityWeightInputs: vi.fn(() =>
        Promise.resolve([
          {
            communityId: C3,
            assetId: CAKE,
            weight: null,
            status: "pending_review" as const,
            source: "roster" as const,
            rosterExcluded: true,
          },
        ]),
      ),
    };
    const settlement = createInMemoryMiningSettlement();
    // CAKE carries an explicit weight but is not let in.
    settlement.versions.push(
      versionWith({ assetWeights: [{ assetId: CAKE, weight: "2" }] }),
    );
    settlement.poolCandidates.push(candidate(), cake);
    settlement.launch2Checkpoint = { blockNumber: "900", blockHash: hash };
    const reads = vi.fn(() =>
      Promise.resolve(
        facts({
          walletKinds: "all" as const,
          nftInstances: [],
          nftOpenings: [],
        }),
      ),
    );
    settlement.readSettlementFacts = reads;
    const readAssetPrice = vi.fn(() => Promise.reject(new Error("unused")));
    const writeSnapshot = vi.fn((input: WriteMiningSnapshotInput) =>
      Promise.resolve({
        snapshotId: input.snapshotId,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        formulaVersion: input.formulaVersion,
        priceVersion: input.priceVersion,
        totalPower: input.totalPower,
        accountCount: 2,
        computedAt: "2026-10-27T10:00:00.000Z",
        holdingsSource: input.holdingsSource,
      }),
    );
    const worker = createMiningSnapshotWorker({
      repository: { ...repository, writeSnapshot },
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: {
        readAssetPrice,
        readPair: vi.fn(() => Promise.reject(new Error("unused"))),
      },
      pool: { repository: settlement, chainId: "eip155:97" },
      now: () => new Date("2026-10-27T10:00:00.000Z"),
    });
    await worker.runOnce();
    // The pool part reads ASSET1 only — never the external CAKE.
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [ASSET1] }),
    );
    expect(readAssetPrice).not.toHaveBeenCalled();
  });
});

describe("Decision 0191 settlement asset set is the roster (S321)", () => {
  const U3 = "a0000000-0000-4000-8000-000000000003";
  const X = "0x00000000000000000000000000000000000000c3";
  // ASSET2 is listed in assetWeights but no verified community binds it
  // (staging 2026-10-28: a pending community's MEME).
  const stale = { assetWeights: [{ assetId: ASSET2, weight: "1" }] };

  function factsWithStale(): MiningSettlementFacts {
    const base = facts();
    return {
      ...base,
      assets: [
        ...base.assets,
        {
          assetId: ASSET2,
          source: "launch2",
          graduatedAt: null,
          openingPriceE18: loop / 100n,
          openingBalances: [{ address: X, balanceRaw: 30n * loop }],
          moves: [],
        },
      ],
      walletOwners: [...base.walletOwners, { address: X, userIds: [U3] }],
      referralEdges: [
        { inviterUserId: U1, inviteeUserId: U3, depth: 1, from: 0n, to: null },
      ],
    };
  }

  it("drops an assetWeights entry for a non-roster asset under the roster rule only", () => {
    const document = documentWith(stale);
    const roster = miningEffectiveAssetWeights(
      document,
      [ASSET1],
      null,
      "roster",
    );
    expect([...roster.keys()]).toEqual([ASSET1]);
    expect(miningIgnoredNonRosterAssetIds(document, [ASSET1])).toEqual([
      ASSET2,
    ]);
    // The document rule (replay of an hour settled before 0191) keeps it.
    expect(miningEffectiveAssetWeights(document, [ASSET1]).get(ASSET2)).toBe(
      loop,
    );
    // A valuation document has no roster: nothing is reported ignored.
    expect(
      miningIgnoredNonRosterAssetIds(
        documentWith({ ...stale, assetPowerBasis: "valuation" }),
        [ASSET1],
      ),
    ).toEqual([]);
    expect(
      admittedAssetIds(
        [versionWith(stale)],
        S,
        S + 3_600n,
        [ASSET1],
        null,
        "roster",
      ),
    ).toEqual([ASSET1]);
  });

  it("gives a non-roster assetWeights asset no holdings, no self and no referral power", () => {
    const roster = prepareMiningHour({
      hourStart: S,
      versions: [versionWith(stale)],
      facts: factsWithStale(),
      poolAssetIds: [ASSET1],
      assetRule: "roster",
    });
    const result = settleMiningHour(roster.input);
    expect(
      roster.input.assetHoldings.some((row) => row.assetId === ASSET2),
    ).toBe(false);
    const u3 = result.users.find((row) => row.userId === U3);
    expect(u3?.assetSelfPower ?? 0n).toBe(0n);
    expect(u3?.assetHoldings ?? []).toEqual([]);
    const u1 = result.users.find((row) => row.userId === U1);
    expect(u1?.assetReferralPower ?? 0n).toBe(0n);
    // Only the roster MEME counts: 100 + 50 tokens × 1.
    expect(result.asset.denominatorPower).toBe(150n * loop);
    expect(roster.summary["ignoredNonRosterAssetIds"]).toEqual([ASSET2]);

    // The pre-0191 rule (what staging settled): the listed asset counted.
    const legacy = prepareMiningHour({
      hourStart: S,
      versions: [versionWith(stale)],
      facts: factsWithStale(),
      poolAssetIds: [ASSET1],
    });
    const before = settleMiningHour(legacy.input);
    expect(before.users.find((row) => row.userId === U3)?.assetSelfPower).toBe(
      30n * loop,
    );
    expect(
      before.users.find((row) => row.userId === U1)?.assetReferralPower,
    ).toBeGreaterThan(0n);
    expect(legacy.summary["ignoredNonRosterAssetIds"]).toBeUndefined();
  });

  it("settles the roster only, records the ignored ids, and replays each hour under its own rule", async () => {
    const repo = createInMemoryMiningSettlement();
    repo.versions.push(versionWith(stale));
    repo.poolCandidates.push(candidate());
    repo.readIndexerFreshness = vi.fn(() =>
      Promise.resolve({
        lanes: [
          {
            lane: "launch2_event",
            hasSources: true,
            updatedAt: "2026-10-27T11:05:00.000Z",
          },
        ],
      }),
    );
    const reads = vi.fn(() => Promise.resolve(factsWithStale()));
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
    const outcome = await runner.settleHour({
      hourStart: S,
      trigger: "scheduled",
    });
    expect(outcome.kind).toBe("settled");
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [ASSET1] }),
    );
    const committed = (
      commit.mock.calls as unknown as [
        {
          inputSummary: Record<string, unknown>;
          inputDigest: string;
          denominatorAssetPower: string;
          rewards: readonly { userId: string; assetHoldings: unknown[] }[];
        },
      ][]
    )[0]?.[0];
    expect(committed?.inputSummary["ignoredNonRosterAssetIds"]).toEqual([
      ASSET2,
    ]);
    expect(committed?.denominatorAssetPower).toBe("150");
    expect(
      committed?.rewards.find((row) => row.userId === U3)?.assetHoldings ?? [],
    ).toEqual([]);

    // Replay under the roster rule reproduces the digest.
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
      expect.objectContaining({ assetIds: [ASSET1] }),
    );
    expect(replay?.digestMatches).toBe(true);

    // An hour settled before 0191 (roster stored, no ignored key) replays
    // under the document rule: history is never rewritten.
    const older = Object.fromEntries(
      Object.entries(committed?.inputSummary ?? {}).filter(
        ([key]) => key !== "ignoredNonRosterAssetIds",
      ),
    );
    repo.epochs.length = 0;
    repo.epochs.push(
      epochRecord({
        hourStart: "2026-10-27T10:00:00.000Z",
        hourEnd: "2026-10-27T11:00:00.000Z",
        inputSummary: older,
      }),
    );
    reads.mockClear();
    await runner.replay(epochRecord().epochId);
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: [ASSET1, ASSET2] }),
    );
  });
});
