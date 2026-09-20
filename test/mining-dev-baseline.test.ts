import { describe, expect, it, vi } from "vitest";

import {
  attemptOf,
  createMiningFormulaBaselineProbe,
  resolveMiningBaseline,
} from "../src/features/mining/mining-baseline.js";
import {
  compareUnsignedDecimals,
  isCommunityWeightWithinRange,
  miningFormulaDocumentSchema,
  miningWeightRangeDocumentSchema,
} from "../src/features/mining/mining-contract.js";
import { estimateDailyOutputShare } from "../src/features/mining/mining-daily-output.js";
import {
  assertMiningDevBaselineConstants,
  buildMiningDevBaselineDocuments,
  miningDevBaselineCommunityWeightRange,
  miningDevBaselineConfigVersion,
  miningDevBaselineDailyOutputBudget,
} from "../src/features/mining/mining-dev-baseline.js";
import { createMiningPowerReader } from "../src/features/mining/mining-power-reader.js";
import {
  createUnavailableMiningRepository,
  type MiningFormulaRecord,
  type MiningSnapshotAttemptRecord,
  type MiningSnapshotRecord,
} from "../src/features/mining/mining-repository.js";

/**
 * Decision 0043: the development baseline's constants, range, share
 * arithmetic, and baseline resolution. Expected values are hand-written.
 */

const documents = buildMiningDevBaselineDocuments([
  "eip155:56:native",
  "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
]);
const approvedAt = "2026-09-15T08:00:00.000Z";
const approved: MiningFormulaRecord = {
  configVersion: documents.configVersion,
  formula: documents.formula,
  weightRange: documents.weightRange,
  priceGuardRules: documents.priceGuardRules,
  status: "approved",
  effectiveAt: approvedAt,
  approvedAt,
  createdAt: approvedAt,
};
const snapshot: MiningSnapshotRecord = {
  snapshotId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  blockNumber: "122037728",
  blockHash: `0x${"c".repeat(64)}`,
  formulaVersion: documents.configVersion,
  priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
  totalPower: "4000",
  accountCount: 2,
  computedAt: "2026-09-15T13:30:00.000Z",
};
const now = new Date("2026-09-15T12:00:00.000Z");

describe("development baseline documents", () => {
  it("names itself, weighs every registered asset at 1, and carries the placeholder budget inside the version", () => {
    assertMiningDevBaselineConstants();
    expect(miningDevBaselineConfigVersion).toBe(
      "miningFormula-devBaseline-2026-09-15-r2",
    );
    expect(miningDevBaselineConfigVersion).toMatch(/devBaseline/);
    expect(miningDevBaselineConfigVersion).not.toMatch(/V1\b/);
    expect(documents.formula).toEqual({
      kind: "holding_times_reference_price_times_weight",
      expressionKey:
        "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
      dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
      assetWeights: {
        "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "1",
        "eip155:56:native": "1",
      },
      referralBoost: { status: "pending_approval" },
      scope: "development_baseline",
      dailyOutput: {
        status: "development_placeholder",
        budget: "1000000",
        unitKey: "mining.rules.dailyOutput.unit.loopTokenPending",
      },
      // WBNB is not in this registry, so no proxy is declared for BNB.
      priceProxies: {},
    });
    expect(miningDevBaselineDailyOutputBudget).toBe("1000000");
    expect(documents.weightRange.community).toEqual({
      status: "approved",
      descriptionKey: "mining.rules.weight.communityReviewed",
      range: { min: "0.5", max: "2" },
    });
    expect(documents.weightRange.loop.status).toBe("pending_approval");
    expect(
      documents.priceGuardRules.every(
        (rule) => rule.status === "pending_approval",
      ),
    ).toBe(true);
    // The stored documents round-trip through the persistence schemas.
    expect(miningFormulaDocumentSchema.parse(documents.formula)).toEqual(
      documents.formula,
    );
    expect(
      miningWeightRangeDocumentSchema.parse(documents.weightRange),
    ).toEqual(documents.weightRange);
  });

  it("declares the WBNB proxy for native BNB only when both are registered (Decision 0044)", () => {
    const wbnb = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
    expect(
      buildMiningDevBaselineDocuments(["eip155:56:native", wbnb]).formula
        .priceProxies,
    ).toEqual({ "eip155:56:native": wbnb });
    expect(
      buildMiningDevBaselineDocuments([wbnb]).formula.priceProxies,
    ).toEqual({});
    expect(() =>
      miningFormulaDocumentSchema.parse({
        ...documents.formula,
        priceProxies: { [wbnb]: wbnb },
      }),
    ).toThrow();
  });

  it("deduplicates and sorts asset IDs, refuses a malformed one, and computes nothing from an empty registry", () => {
    expect(
      Object.keys(
        buildMiningDevBaselineDocuments([
          "eip155:56:native",
          "eip155:56:native",
          "eip155:56:0x0000000000000000000000000000000000000001",
        ]).formula.assetWeights,
      ),
    ).toEqual([
      "eip155:56:0x0000000000000000000000000000000000000001",
      "eip155:56:native",
    ]);
    expect(() => buildMiningDevBaselineDocuments(["BNB"])).toThrow();
    expect(buildMiningDevBaselineDocuments([]).formula.assetWeights).toEqual(
      {},
    );
  });

  it("still parses the product draft, which declares no scope, range, or budget", () => {
    const draft = miningFormulaDocumentSchema.parse({
      kind: "holding_times_reference_price_times_weight",
      expressionKey: "k",
      dailyOutputKey: "k",
      assetWeights: {},
      referralBoost: { status: "pending_approval" },
    });
    expect(draft.scope).toBeUndefined();
    expect(draft.dailyOutput).toBeUndefined();
    expect(() =>
      miningWeightRangeDocumentSchema.parse({
        loop: { status: "pending_approval", descriptionKey: "k" },
        community: {
          status: "approved",
          descriptionKey: "k",
          range: { min: "2", max: "0.5" },
        },
        reviewFactorKeys: [],
      }),
    ).toThrow();
  });
});

describe("community weight range", () => {
  const range = miningDevBaselineCommunityWeightRange;

  it("accepts both inclusive boundaries and values between them", () => {
    for (const weight of ["0.5", "0.50", "1", "1.25", "1.999999", "2", "2.0"]) {
      expect(isCommunityWeightWithinRange(weight, range), weight).toBe(true);
    }
  });

  it("refuses values just outside, zero, malformed, and signed input", () => {
    for (const weight of [
      "0.499999999999999999",
      "2.000000000000000001",
      "0",
      "3",
      "-1",
      "+1",
      "1e0",
      "1.",
      ".5",
      "",
      "0.5 ",
    ]) {
      expect(isCommunityWeightWithinRange(weight, range), weight).toBe(false);
    }
  });

  it("compares decimal strings exactly, never through floating point", () => {
    expect(compareUnsignedDecimals("0.1", "0.10")).toBe(0);
    expect(compareUnsignedDecimals("0.30000000000000004", "0.3")).toBe(1);
    expect(
      compareUnsignedDecimals("9007199254740993", "9007199254740992"),
    ).toBe(1);
    expect(() => compareUnsignedDecimals("1e3", "1")).toThrow();
  });
});

describe("share of network power (daily output estimate)", () => {
  it("computes budget × account ÷ network exactly and truncates to six digits", () => {
    // 1000000 × 1000 ÷ 4000 = 250000
    expect(
      estimateDailyOutputShare({
        budget: "1000000",
        accountPower: "1000",
        networkPower: "4000",
      }),
    ).toBe("250000");
    // 1000000 × 1 ÷ 3 = 333333.333333… → truncated
    expect(
      estimateDailyOutputShare({
        budget: "1000000",
        accountPower: "1",
        networkPower: "3",
      }),
    ).toBe("333333.333333");
    // 1000000 × 0.00000000000000072078 ÷ 1331.09500000000000072078 ≈ 5.4e-13 → 0
    expect(
      estimateDailyOutputShare({
        budget: "1000000",
        accountPower: "0.00000000000000072078",
        networkPower: "1331.09500000000000072078",
      }),
    ).toBe("0");
    // 100 × 2.5 ÷ 10 = 25
    expect(
      estimateDailyOutputShare({
        budget: "100",
        accountPower: "2.5",
        networkPower: "10",
      }),
    ).toBe("25");
    // The whole network: 1000000 × 4000 ÷ 4000 = 1000000
    expect(
      estimateDailyOutputShare({
        budget: "1000000",
        accountPower: "4000",
        networkPower: "4000",
      }),
    ).toBe("1000000");
  });

  it("has no share while the network power is zero and refuses malformed input", () => {
    expect(
      estimateDailyOutputShare({
        budget: "1000000",
        accountPower: "0",
        networkPower: "0",
      }),
    ).toBeNull();
    expect(() =>
      estimateDailyOutputShare({
        budget: "1e6",
        accountPower: "1",
        networkPower: "1",
      }),
    ).toThrow();
  });
});

describe("baseline resolution", () => {
  function repository(
    formula: MiningFormulaRecord | null,
    latest: MiningSnapshotRecord | null,
    attempt: MiningSnapshotAttemptRecord | null = null,
  ) {
    return {
      getApprovedFormula: vi.fn(() => Promise.resolve(formula)),
      getLatestSnapshot: vi.fn(() => Promise.resolve(latest)),
      getLatestSnapshotAttempt: vi.fn(() => Promise.resolve(attempt)),
    };
  }
  const usdtAsset = "eip155:56:0x55d398326f99059ff775485246999027b3197955";
  const incompleteAttempt: MiningSnapshotAttemptRecord = {
    snapshotId: "537e93ea-1c9f-43f8-b29a-c6eb4a8e7dee",
    status: "incomplete",
    formulaVersion: "miningFormula-devBaseline-2026-09-15-r2",
    blockNumber: "123000110",
    computedAt: "2026-09-20T13:51:26.116Z",
    unreadInputs: [
      { assetId: usdtAsset, reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" },
    ],
    invalidatedAt: null,
    invalidationReason: null,
  };

  it("is pending without an approved version or before effectiveAt, and never reads the snapshot then", async () => {
    const none = repository(null, snapshot);
    expect(await resolveMiningBaseline(none, now)).toEqual({
      status: "pending",
    });
    expect(none.getLatestSnapshot).not.toHaveBeenCalled();
    const future = repository(
      { ...approved, effectiveAt: "2026-09-15T12:00:00.001Z" },
      snapshot,
    );
    expect(await resolveMiningBaseline(future, now)).toEqual({
      status: "pending",
    });
    const exact = repository(
      { ...approved, effectiveAt: "2026-09-15T12:00:00.000Z" },
      snapshot,
    );
    expect((await resolveMiningBaseline(exact, now)).status).toBe("approved");
  });

  it("attaches the snapshot only when it was computed under the version in force", async () => {
    expect(
      await resolveMiningBaseline(repository(approved, snapshot), now),
    ).toEqual({
      status: "approved",
      formula: approved,
      snapshot,
      snapshotReasonCode: null,
      stale: false,
      latestAttempt: attemptOf(snapshot),
    });
    expect(
      await resolveMiningBaseline(repository(approved, null), now),
    ).toMatchObject({
      status: "approved",
      snapshot: null,
      snapshotReasonCode: "MINING_SNAPSHOT_NOT_AVAILABLE",
      stale: false,
      latestAttempt: null,
    });
    expect(
      await resolveMiningBaseline(
        repository(approved, {
          ...snapshot,
          formulaVersion: "miningFormulaV1-draft",
        }),
        now,
      ),
    ).toMatchObject({
      status: "approved",
      snapshot: null,
      snapshotReasonCode: "MINING_SNAPSHOT_STALE",
    });
  });

  it("keeps the last complete snapshot and marks it stale when a newer attempt did not complete (Decision 0057)", async () => {
    // The 2026-09-20 case: USDT could not be priced, the attempt was
    // recorded, and the last complete snapshot stays the one that is read.
    const resolution = await resolveMiningBaseline(
      repository(approved, snapshot, incompleteAttempt),
      now,
    );
    expect(resolution).toEqual({
      status: "approved",
      formula: approved,
      snapshot,
      snapshotReasonCode: null,
      stale: true,
      latestAttempt: incompleteAttempt,
    });
    // A withdrawn snapshot newer than the last complete one is stale too.
    const invalidated: MiningSnapshotAttemptRecord = {
      ...incompleteAttempt,
      status: "invalidated",
      unreadInputs: [],
      invalidatedAt: "2026-09-20T15:00:00.000Z",
      invalidationReason: "MINING_SNAPSHOT_PUBLISHED_INCOMPLETE",
    };
    expect(
      await resolveMiningBaseline(
        repository(approved, snapshot, invalidated),
        now,
      ),
    ).toMatchObject({ snapshot, stale: true, latestAttempt: invalidated });
    // The snapshot itself as the newest attempt is not stale.
    expect(
      await resolveMiningBaseline(
        repository(approved, snapshot, attemptOf(snapshot)),
        now,
      ),
    ).toMatchObject({ snapshot, stale: false });
  });

  it("is MINING_SNAPSHOT_INCOMPLETE, never a zero, while the version in force has only incomplete attempts", async () => {
    expect(
      await resolveMiningBaseline(
        repository(approved, null, incompleteAttempt),
        now,
      ),
    ).toEqual({
      status: "approved",
      formula: approved,
      snapshot: null,
      snapshotReasonCode: "MINING_SNAPSHOT_INCOMPLETE",
      stale: false,
      latestAttempt: incompleteAttempt,
    });
    // An older complete snapshot of another version does not soften it.
    expect(
      await resolveMiningBaseline(
        repository(
          approved,
          { ...snapshot, formulaVersion: "miningFormulaV1-draft" },
          incompleteAttempt,
        ),
        now,
      ),
    ).toMatchObject({
      snapshot: null,
      snapshotReasonCode: "MINING_SNAPSHOT_INCOMPLETE",
    });
    // Only invalidated rows under the version: nothing usable, not incomplete.
    expect(
      await resolveMiningBaseline(
        repository(approved, null, {
          ...incompleteAttempt,
          status: "invalidated",
          unreadInputs: [],
          invalidatedAt: "2026-09-20T15:00:00.000Z",
          invalidationReason: "MINING_SNAPSHOT_PUBLISHED_INCOMPLETE",
        }),
        now,
      ),
    ).toMatchObject({
      snapshot: null,
      snapshotReasonCode: "MINING_SNAPSHOT_NOT_AVAILABLE",
    });
  });

  it("probes to approved/pending/unavailable without ever opening on a failure", async () => {
    expect(
      await createMiningFormulaBaselineProbe(
        repository(approved, null),
        () => now,
      )(),
    ).toEqual({
      status: "approved",
      configVersion: "miningFormula-devBaseline-2026-09-15-r2",
      effectiveAt: approvedAt,
      scope: "development_baseline",
    });
    expect(
      await createMiningFormulaBaselineProbe(
        repository(null, null),
        () => now,
      )(),
    ).toEqual({ status: "pending" });
    expect(
      await createMiningFormulaBaselineProbe(
        createUnavailableMiningRepository(),
        () => now,
      )(),
    ).toEqual({ status: "unavailable" });
  });
});

describe("community mining power reader", () => {
  const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const weightRecord = {
    communityId,
    communityName: "Frog Holders",
    boundAssetId: "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
    status: "approved" as const,
    weight: "0.8",
    configVersion: documents.configVersion,
    reviewedAt: "2026-09-15T09:00:00.000Z",
  };

  it("explains a community's power with the version scope, the reviewed weight, and the participant count (Decision 0045)", async () => {
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: () => Promise.resolve(approved),
        getLatestSnapshot: () => Promise.resolve(snapshot),
        getLatestSnapshotAttempt: () => Promise.resolve(null),
        getCommunityWeight: () => Promise.resolve(weightRecord),
        getCommunityStanding: () =>
          Promise.resolve({
            communityId,
            communityName: "Frog Holders",
            boundAssetId: weightRecord.boundAssetId,
            weight: "0.8",
            power: "92",
            participantCount: 3,
            position: 1,
          }),
      },
      now: () => now,
    });
    expect(await reader.readCommunityPower(communityId)).toEqual({
      status: "available",
      subject: "community",
      power: "92",
      snapshotId: snapshot.snapshotId,
      formulaVersion: documents.configVersion,
      computedAt: snapshot.computedAt,
      scope: "development_baseline",
      stale: false,
      weight: {
        status: "approved",
        value: "0.8",
        configVersion: documents.configVersion,
        reviewedAt: "2026-09-15T09:00:00.000Z",
      },
      participants: { status: "available", count: 3 },
    });
  });

  it("keeps the unavailable branch to status and reasonCode without a standing", async () => {
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: () => Promise.resolve(approved),
        getLatestSnapshot: () => Promise.resolve(snapshot),
        getLatestSnapshotAttempt: () => Promise.resolve(null),
        getCommunityWeight: () =>
          Promise.resolve({
            ...weightRecord,
            status: "pending_review" as const,
            weight: null,
            configVersion: null,
            reviewedAt: null,
          }),
        getCommunityStanding: () => Promise.resolve(null),
      },
      now: () => now,
    });
    const projection = await reader.readCommunityPower(communityId);
    expect(projection).toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW",
    });
    expect(JSON.stringify(projection)).toBe(
      '{"status":"unavailable","reasonCode":"COMMUNITY_WEIGHT_PENDING_REVIEW"}',
    );
  });

  it("projects an account's total power with the scope and no community facts", async () => {
    const viewer = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
    const profileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: () =>
          Promise.resolve({
            ...approved,
            // A product version declares no scope.
            formula: { ...approved.formula, scope: undefined },
          }),
        getLatestSnapshot: () => Promise.resolve(snapshot),
        getLatestSnapshotAttempt: () => Promise.resolve(null),
        listMemberPowers: () =>
          Promise.resolve([
            {
              publicProfileId: profileId,
              ownerUserId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
              totalPower: "1138.67",
              visibleToOthers: true,
            },
          ]),
      },
      now: () => now,
    });
    const powers = await reader.readMemberPowers({
      viewerUserId: viewer,
      publicProfileIds: [profileId],
    });
    expect(powers.get(profileId)).toEqual({
      status: "available",
      subject: "account",
      power: "1138.67",
      snapshotId: snapshot.snapshotId,
      formulaVersion: documents.configVersion,
      computedAt: snapshot.computedAt,
      scope: null,
      stale: false,
    });
  });

  it("marks both subjects stale while a newer attempt under the version did not complete, and keeps the last complete numbers (Decision 0057)", async () => {
    const profileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
    const repository = {
      ...createUnavailableMiningRepository(),
      getApprovedFormula: () => Promise.resolve(approved),
      getLatestSnapshot: () => Promise.resolve(snapshot),
      getLatestSnapshotAttempt: () =>
        Promise.resolve({
          snapshotId: "537e93ea-1c9f-43f8-b29a-c6eb4a8e7dee",
          status: "incomplete" as const,
          formulaVersion: documents.configVersion,
          blockNumber: "123000110",
          computedAt: "2026-09-20T13:51:26.116Z",
          unreadInputs: [
            {
              assetId: "eip155:56:0x55d398326f99059ff775485246999027b3197955",
              reasonCode: "MINING_PRICE_PAIR_NOT_FOUND",
            },
          ],
          invalidatedAt: null,
          invalidationReason: null,
        }),
      getCommunityWeight: () => Promise.resolve(weightRecord),
      getCommunityStanding: () =>
        Promise.resolve({
          communityId,
          communityName: "Frog Holders",
          boundAssetId: weightRecord.boundAssetId,
          weight: "0.8",
          power: "92",
          participantCount: 3,
          position: 1,
        }),
      listMemberPowers: () =>
        Promise.resolve([
          {
            publicProfileId: profileId,
            ownerUserId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
            totalPower: "4.482309",
            visibleToOthers: true,
          },
        ]),
    };
    const reader = createMiningPowerReader({ repository, now: () => now });
    expect(await reader.readCommunityPower(communityId)).toMatchObject({
      status: "available",
      power: "92",
      snapshotId: snapshot.snapshotId,
      stale: true,
    });
    const powers = await reader.readMemberPowers({
      viewerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      publicProfileIds: [profileId],
    });
    expect(powers.get(profileId)).toMatchObject({
      status: "available",
      power: "4.482309",
      stale: true,
    });
  });

  it("publishes no number at all while the version in force has only an incomplete attempt (Decision 0057)", async () => {
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: () => Promise.resolve(approved),
        getLatestSnapshot: () => Promise.resolve(null),
        getLatestSnapshotAttempt: () =>
          Promise.resolve({
            snapshotId: "537e93ea-1c9f-43f8-b29a-c6eb4a8e7dee",
            status: "incomplete" as const,
            formulaVersion: documents.configVersion,
            blockNumber: "123000110",
            computedAt: "2026-09-20T13:51:26.116Z",
            unreadInputs: [
              {
                assetId: "eip155:56:0x55d398326f99059ff775485246999027b3197955",
                reasonCode: "MINING_PRICE_PAIR_NOT_FOUND",
              },
            ],
            invalidatedAt: null,
            invalidationReason: null,
          }),
      },
      now: () => now,
    });
    expect(await reader.readCommunityPower(communityId)).toEqual({
      status: "unavailable",
      reasonCode: "MINING_SNAPSHOT_INCOMPLETE",
    });
    const powers = await reader.readMemberPowers({
      viewerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      publicProfileIds: ["9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f"],
    });
    expect(powers.get("9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f")).toEqual({
      status: "unavailable",
      reasonCode: "MINING_SNAPSHOT_INCOMPLETE",
    });
  });

  it("fails closed on any repository failure instead of estimating", async () => {
    const reader = createMiningPowerReader({
      repository: {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: () => Promise.resolve(approved),
        getLatestSnapshot: () => Promise.resolve(snapshot),
      },
      now: () => now,
    });
    expect(await reader.readCommunityPower(snapshot.snapshotId)).toEqual({
      status: "unavailable",
      reasonCode: "MINING_RUNTIME_UNAVAILABLE",
    });
    const powers = await reader.readMemberPowers({
      viewerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      publicProfileIds: ["9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f"],
    });
    expect(powers.get("9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f")).toEqual({
      status: "unavailable",
      reasonCode: "MINING_RUNTIME_UNAVAILABLE",
    });
    expect(
      (
        await reader.readMemberPowers({
          viewerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
          publicProfileIds: [],
        })
      ).size,
    ).toBe(0);
  });
});
