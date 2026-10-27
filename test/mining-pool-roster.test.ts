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
  resolveMiningPoolEntry,
  type MiningPoolCandidate,
} from "../src/features/mining/mining-pool-roster.js";
import {
  computeMiningSnapshot,
  type MiningBalanceInput,
} from "../src/features/mining/mining-snapshot.js";
import { createMiningSnapshotWorker } from "../src/mining-snapshot-worker.js";
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
    // A non-platform asset keeps its explicit weight (pre-0187 rule).
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
      ]),
    ).toEqual([
      [U1, BTCB, "2"],
      [U1, ASSET1, "102"],
      [U2, ASSET1, "50"],
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
