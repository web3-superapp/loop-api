import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  createUnavailableMiningRepository,
  MiningRepositoryUnavailableError,
  type MiningFormulaRecord,
  type MiningRepository,
  type MiningSnapshotRecord,
} from "../src/features/mining/mining-repository.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const createdAt = "2026-09-08T01:00:00.000Z";

const draftFormula: MiningFormulaRecord = {
  configVersion: "miningFormulaV1-draft",
  formula: {
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: {},
    referralBoost: { status: "pending_approval" },
  },
  weightRange: {
    loop: {
      status: "pending_approval",
      descriptionKey: "mining.rules.weight.loopFixedMaximum",
    },
    community: {
      status: "pending_approval",
      descriptionKey: "mining.rules.weight.communityReviewed",
    },
    reviewFactorKeys: ["mining.rules.reviewFactor.communityQuality"],
  },
  priceGuardRules: [
    { ruleKey: "mining.rules.priceGuard.twap", status: "pending_approval" },
    {
      ruleKey: "mining.rules.priceGuard.liquidityCap",
      status: "pending_approval",
    },
  ],
  status: "pending_approval",
  effectiveAt: null,
  approvedAt: null,
  createdAt,
};

function repositoryFake(
  overrides: Partial<MiningRepository> = {},
): MiningRepository {
  return {
    ...createUnavailableMiningRepository(),
    getApprovedFormula: vi.fn(() => Promise.resolve(null)),
    listFormulaVersions: vi.fn(() => Promise.resolve([draftFormula])),
    getLatestSnapshot: vi.fn(() => Promise.resolve(null)),
    getCommunityWeight: vi.fn(() =>
      Promise.resolve({
        communityId,
        communityName: "Frog Holders",
        boundAssetId: null,
        status: "pending_review" as const,
        weight: null,
        configVersion: null,
        reviewedAt: null,
      }),
    ),
    ...overrides,
  };
}

describe("LOOP API V2 mining module", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    repository = repositoryFake(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig(overrides),
      contractSurface: "v2",
      database: s7Database({ mining: repository }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return { app, repository };
  }

  it("registers no mining route (including the moved referral rules) when the module is disabled", async () => {
    const { app } = await createApp(repositoryFake(), {
      V2_MODULES_ENABLED: "launch",
    });
    for (const url of ["/v2/mining/summary", "/v2/mining/referral/rules"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("keeps every power, reward, and claim unavailable and names the pending formula", async () => {
    const { app } = await createApp();
    const summary = await app.inject({
      method: "GET",
      url: "/v2/mining/summary",
      headers: s7CommonHeaders(),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.headers["cache-control"]).toBe("no-store");
    expect(summary.json()).toEqual({
      power: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      networkPower: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      estimatedToday: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      accumulated: {
        status: "unavailable",
        reasonCode: "REWARD_AUTHORITY_PENDING",
      },
      claimable: {
        status: "unavailable",
        reasonCode: "REWARD_AUTHORITY_PENDING",
      },
      referralBoost: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      formula: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        pendingVersion: "miningFormulaV1-draft",
      },
      // No version in force: a snapshot could only belong to a retired one,
      // so none is published and the reason is the baseline itself.
      snapshot: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      contractVersion: "2.0",
    });
    const rewards = await app.inject({
      method: "GET",
      url: "/v2/mining/rewards",
      headers: s7CommonHeaders(),
    });
    expect(rewards.json()).toMatchObject({
      claimable: {
        status: "unavailable",
        reasonCode: "REWARD_AUTHORITY_PENDING",
      },
      claimExecutable: false,
      ledger: [],
    });
    const assets = await app.inject({
      method: "GET",
      url: "/v2/mining/assets",
      headers: s7CommonHeaders(),
    });
    expect(assets.json()).toMatchObject({
      totalPower: { status: "unavailable" },
      included: [],
      excluded: [],
    });
  });

  it("answers the ranking as unavailable for both scopes, rejects an unknown scope, and states the anonymity rule", async () => {
    const { app } = await createApp();
    for (const scope of ["users", "communities"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/mining/rank?scope=${scope}`,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        scope,
        ranking: {
          status: "unavailable",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        },
        display: {
          anonymousMemberKey: "mining.rank.anonymousMember",
          ruleKey: "mining.rank.display.aliasOrAnonymous",
        },
      });
    }
    const unknown = await app.inject({
      method: "GET",
      url: "/v2/mining/rank?scope=whales",
      headers: s7CommonHeaders(),
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("projects a community weight record as pending review or approved", async () => {
    const { app } = await createApp();
    const pending = await app.inject({
      method: "GET",
      url: `/v2/mining/communities/${communityId}`,
      headers: s7CommonHeaders(),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      community: { communityId, name: "Frog Holders", boundAssetId: null },
      weight: {
        status: "unavailable",
        reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW",
        reviewStatus: "pending_review",
      },
      communityPower: { status: "unavailable" },
    });
    const approvedApp = await createApp(
      repositoryFake({
        getCommunityWeight: vi.fn(() =>
          Promise.resolve({
            communityId,
            communityName: "Frog Holders",
            boundAssetId:
              "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            status: "approved" as const,
            weight: "0.35",
            configVersion: "miningFormulaV1-draft",
            reviewedAt: createdAt,
          }),
        ),
      }),
    );
    const approved = await approvedApp.app.inject({
      method: "GET",
      url: `/v2/mining/communities/${communityId}`,
      headers: s7CommonHeaders(),
    });
    expect(approved.json()).toMatchObject({
      weight: {
        status: "approved",
        value: "0.35",
        configVersion: "miningFormulaV1-draft",
      },
    });
    const missing = await createApp(
      repositoryFake({
        getCommunityWeight: vi.fn(() => Promise.resolve(null)),
      }),
    );
    const notFound = await missing.app.inject({
      method: "GET",
      url: `/v2/mining/communities/${communityId}`,
      headers: s7CommonHeaders(),
    });
    expect(notFound.statusCode).toBe(404);
  });

  it("publishes the rules with the pending version marked and no weight numbers", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/mining/rules",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      approved: null,
      pendingApproval: [
        {
          configVersion: "miningFormulaV1-draft",
          status: "pending_approval",
          scope: null,
          assetWeights: {},
          dailyOutput: null,
          weightRange: { loop: { status: "pending_approval" } },
          priceGuardRules: [{ ruleKey: "mining.rules.priceGuard.twap" }, {}],
        },
      ],
      baseline: {
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
      referral: { configVersion: "referralRulesV1" },
    });
    expect(JSON.stringify(body["pendingApproval"])).not.toMatch(/0\.1|1\.0/);
  });

  it("serves the referral rules snapshot at the preserved path", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/mining/referral/rules",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configVersion: "referralRulesV1",
      appliesTo: "miningPower",
      levels: [
        { level: 1, boostPercent: "10" },
        { level: 2, boostPercent: "5" },
        { level: 3, boostPercent: "3" },
        { level: 4, boostPercent: "2" },
        { level: 5, boostPercent: "1" },
      ],
      contractVersion: "2.0",
    });
    const withKey = await app.inject({
      method: "GET",
      url: "/v2/mining/referral/rules",
      headers: s7CommandHeaders(),
    });
    expect(withKey.statusCode).toBe(400);
  });

  describe("under the approved development baseline (Decision 0043)", () => {
    const loopAsset = "eip155:56:0x0000000000000000000000000000000000000001";
    const cakeAsset = "eip155:56:0x0000000000000000000000000000000000000002";
    const nativeAsset = "eip155:56:native";
    const documents = buildMiningDevBaselineDocuments([
      loopAsset,
      cakeAsset,
      nativeAsset,
    ]);
    const approvedAt = "2026-09-15T08:00:00.000Z";
    const approvedBaseline: MiningFormulaRecord = {
      configVersion: documents.configVersion,
      formula: documents.formula,
      weightRange: documents.weightRange,
      priceGuardRules: documents.priceGuardRules,
      status: "approved",
      effectiveAt: approvedAt,
      approvedAt,
      createdAt: approvedAt,
    };
    const snapshotId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    const snapshot: MiningSnapshotRecord = {
      snapshotId,
      blockNumber: "122037728",
      blockHash: `0x${"c".repeat(64)}`,
      formulaVersion: documents.configVersion,
      priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
      totalPower: "4000",
      accountCount: 3,
      computedAt: "2026-09-15T13:30:00.000Z",
    };
    const other = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";

    function approvedRepository(overrides: Partial<MiningRepository> = {}) {
      return repositoryFake({
        getApprovedFormula: vi.fn(() => Promise.resolve(approvedBaseline)),
        listFormulaVersions: vi.fn(() =>
          Promise.resolve([approvedBaseline, draftFormula]),
        ),
        getLatestSnapshot: vi.fn(() => Promise.resolve(snapshot)),
        getAccountStanding: vi.fn(() =>
          Promise.resolve({
            totalPower: "1000",
            position: 2,
            participantCount: 3,
          }),
        ),
        listAccountPowers: vi.fn(() =>
          Promise.resolve([
            {
              ownerUserId: s7AccountId,
              assetId: cakeAsset,
              holding: "100",
              referencePriceUsd: "2.3",
              referencePriceQuality: "fresh" as const,
              referencePriceProxyAssetId: null,
              weight: "0.5",
              power: "115",
              blockNumber: "122037728",
            },
            {
              ownerUserId: s7AccountId,
              assetId: loopAsset,
              holding: "1",
              referencePriceUsd: "885",
              referencePriceQuality: "fresh" as const,
              referencePriceProxyAssetId: null,
              weight: "1",
              power: "885",
              blockNumber: "122037728",
            },
          ]),
        ),
        listAccountBalanceAssetIds: vi.fn(() =>
          Promise.resolve([cakeAsset, loopAsset, nativeAsset]),
        ),
        listCommunityWeightInputs: vi.fn(() =>
          Promise.resolve([
            {
              communityId,
              assetId: cakeAsset,
              weight: "0.5",
              status: "approved" as const,
            },
          ]),
        ),
        listAccountRanking: vi.fn(() =>
          Promise.resolve([
            {
              ownerUserId: other,
              totalPower: "3000",
              position: 1,
              publicProfileId: "d64786bb-408d-415d-8a69-6277d56c921b",
              alias: "whale",
              discoverable: true,
              anonymousMode: false,
            },
            {
              ownerUserId: s7AccountId,
              totalPower: "1000",
              position: 2,
              publicProfileId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
              alias: "me",
              discoverable: false,
              anonymousMode: false,
            },
          ]),
        ),
        listCommunityRanking: vi.fn(() =>
          Promise.resolve([
            {
              communityId,
              communityName: "Frog Holders",
              boundAssetId: cakeAsset,
              weight: "0.5",
              power: "230",
              participantCount: 2,
              position: 1,
            },
            {
              communityId: "d17b34a6-c3cc-4a24-87dd-dc165c80bd85",
              communityName: "Zero Holders",
              boundAssetId: cakeAsset,
              weight: "0.5",
              power: "0",
              participantCount: 0,
              position: null,
            },
          ]),
        ),
        getCommunityStanding: vi.fn(() =>
          Promise.resolve({
            communityId,
            communityName: "Frog Holders",
            boundAssetId: cakeAsset,
            weight: "0.5",
            power: "230",
            participantCount: 2,
            position: 1,
          }),
        ),
        getCommunityWeight: vi.fn(() =>
          Promise.resolve({
            communityId,
            communityName: "Frog Holders",
            boundAssetId: cakeAsset,
            status: "approved" as const,
            weight: "0.5",
            configVersion: documents.configVersion,
            reviewedAt: approvedAt,
          }),
        ),
        ...overrides,
      });
    }

    it("publishes the caller's power, the network power, and the share of the placeholder daily output", async () => {
      const { app } = await createApp(approvedRepository());
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/summary",
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        power: { status: "available", value: "1000" },
        networkPower: { status: "available", value: "4000" },
        // 1000000 × 1000 ÷ 4000 = 250000 (hand-computed)
        estimatedToday: {
          status: "available",
          value: "250000",
          budget: "1000000",
          unitKey: "mining.rules.dailyOutput.unit.loopTokenPending",
          budgetStatus: "development_placeholder",
          formulaVersion: "miningFormula-devBaseline-2026-09-15-r2",
          scope: "development_baseline",
        },
        accumulated: {
          status: "unavailable",
          reasonCode: "REWARD_AUTHORITY_PENDING",
        },
        claimable: {
          status: "unavailable",
          reasonCode: "REWARD_AUTHORITY_PENDING",
        },
        referralBoost: {
          status: "unavailable",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        },
        formula: {
          status: "approved",
          configVersion: "miningFormula-devBaseline-2026-09-15-r2",
          effectiveAt: approvedAt,
          scope: "development_baseline",
        },
        snapshot: {
          snapshotId,
          blockNumber: "122037728",
          blockHash: `0x${"c".repeat(64)}`,
          formulaVersion: "miningFormula-devBaseline-2026-09-15-r2",
          priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
          computedAt: "2026-09-15T13:30:00.000Z",
        },
        contractVersion: "2.0",
      });
    });

    it("keeps the estimate unavailable while the network power is zero or the caller is not in the snapshot", async () => {
      const zero = await createApp(
        approvedRepository({
          getLatestSnapshot: vi.fn(() =>
            Promise.resolve({ ...snapshot, totalPower: "0" }),
          ),
          getAccountStanding: vi.fn(() =>
            Promise.resolve({
              totalPower: "0",
              position: null,
              participantCount: 0,
            }),
          ),
        }),
      );
      const zeroSummary = await zero.app.inject({
        method: "GET",
        url: "/v2/mining/summary",
        headers: s7CommonHeaders(),
      });
      expect(zeroSummary.json()).toMatchObject({
        power: { status: "available", value: "0" },
        networkPower: { status: "available", value: "0" },
        estimatedToday: {
          status: "unavailable",
          reasonCode: "MINING_NETWORK_POWER_ZERO",
        },
      });
      const absent = await createApp(
        approvedRepository({
          getAccountStanding: vi.fn(() => Promise.resolve(null)),
        }),
      );
      const absentSummary = await absent.app.inject({
        method: "GET",
        url: "/v2/mining/summary",
        headers: s7CommonHeaders(),
      });
      expect(absentSummary.json()).toMatchObject({
        power: {
          status: "unavailable",
          reasonCode: "MINING_ACCOUNT_NOT_IN_SNAPSHOT",
        },
        networkPower: { status: "available", value: "4000" },
        estimatedToday: {
          status: "unavailable",
          reasonCode: "MINING_ACCOUNT_NOT_IN_SNAPSHOT",
        },
      });
    });

    it("refuses a snapshot computed under another version as stale", async () => {
      const { app } = await createApp(
        approvedRepository({
          getLatestSnapshot: vi.fn(() =>
            Promise.resolve({
              ...snapshot,
              formulaVersion: "miningFormulaV1-draft",
            }),
          ),
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/summary",
        headers: s7CommonHeaders(),
      });
      expect(response.json()).toMatchObject({
        power: { status: "unavailable", reasonCode: "MINING_SNAPSHOT_STALE" },
        formula: { status: "approved" },
        snapshot: {
          status: "unavailable",
          reasonCode: "MINING_SNAPSHOT_STALE",
        },
      });
    });

    it("does not open while the version is approved but not yet effective", async () => {
      const { app } = await createApp(
        approvedRepository({
          getApprovedFormula: vi.fn(() =>
            Promise.resolve({
              ...approvedBaseline,
              effectiveAt: "2999-01-01T00:00:00.000Z",
            }),
          ),
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/summary",
        headers: s7CommonHeaders(),
      });
      expect(response.json()).toMatchObject({
        power: {
          status: "unavailable",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        },
        formula: { status: "unavailable" },
      });
    });

    it("lists the caller's included power rows and re-derives why a held asset was excluded", async () => {
      const { app } = await createApp(approvedRepository());
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/assets",
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalPower: { status: "available", value: "1000" },
        included: [
          {
            assetId: cakeAsset,
            holding: "100",
            referencePriceUsd: "2.3",
            referencePriceQuality: "fresh",
            referencePriceProxyAssetId: null,
            weight: "0.5",
            power: "115",
            blockNumber: "122037728",
          },
          {
            assetId: loopAsset,
            holding: "1",
            referencePriceUsd: "885",
            referencePriceQuality: "fresh",
            referencePriceProxyAssetId: null,
            weight: "1",
            power: "885",
            blockNumber: "122037728",
          },
        ],
        // Native BNB is weighted (1), unbound, and its WBNB proxy is
        // declared, so the only way the lane skipped it is a stale price.
        excluded: [
          { assetId: nativeAsset, reasonCode: "MINING_PRICE_NOT_FRESH" },
        ],
        source: {
          snapshotId,
          blockNumber: "122037728",
          blockHash: `0x${"c".repeat(64)}`,
          formulaVersion: "miningFormula-devBaseline-2026-09-15-r2",
          priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
          computedAt: "2026-09-15T13:30:00.000Z",
        },
        referencePrice: {
          status: "available",
          priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
        },
        contractVersion: "2.0",
      });
    });

    it("keeps rewards unclaimable while carrying the same estimate", async () => {
      const { app } = await createApp(approvedRepository());
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/rewards",
        headers: s7CommonHeaders(),
      });
      expect(response.json()).toMatchObject({
        claimable: {
          status: "unavailable",
          reasonCode: "REWARD_AUTHORITY_PENDING",
        },
        claimExecutable: false,
        estimatedToday: { status: "available", value: "250000" },
        accumulated: {
          status: "unavailable",
          reasonCode: "REWARD_AUTHORITY_PENDING",
        },
        ledger: [],
      });
    });

    it("ranks users with the alias-or-anonymous rule and communities with an approved weight", async () => {
      const { app } = await createApp(approvedRepository());
      const users = await app.inject({
        method: "GET",
        url: "/v2/mining/rank?scope=users",
        headers: s7CommonHeaders(),
      });
      expect(users.statusCode).toBe(200);
      expect(users.json()).toMatchObject({
        scope: "users",
        ranking: {
          status: "available",
          scope: "users",
          items: [
            {
              position: 1,
              power: "3000",
              display: {
                kind: "alias",
                alias: "whale",
                publicProfileId: "d64786bb-408d-415d-8a69-6277d56c921b",
              },
              isSelf: false,
            },
            {
              position: 2,
              power: "1000",
              display: {
                kind: "anonymous",
                labelKey: "mining.rank.anonymousMember",
              },
              isSelf: true,
            },
          ],
          participants: 3,
        },
        myPosition: { status: "available", position: 2, power: "1000" },
        snapshot: { snapshotId },
      });
      expect(users.body).not.toContain('"alias":"me"');
      const communities = await app.inject({
        method: "GET",
        url: "/v2/mining/rank?scope=communities",
        headers: s7CommonHeaders(),
      });
      const communityRanking = communities.json<{
        scope: string;
        ranking: {
          status: string;
          scope: string;
          items: unknown[];
          participants: number;
        };
        myPosition: unknown;
      }>();
      expect(communityRanking.scope).toBe("communities");
      expect(communityRanking.ranking).toMatchObject({
        status: "available",
        scope: "communities",
        participants: 1,
      });
      expect(communityRanking.ranking.items).toHaveLength(2);
      expect(communityRanking.ranking.items[0]).toEqual({
        position: 1,
        power: "230",
        community: {
          communityId,
          name: "Frog Holders",
          boundAssetId: cakeAsset,
        },
        weight: "0.5",
        participants: 2,
      });
      expect(communityRanking.myPosition).toEqual({
        status: "unavailable",
        reasonCode: "MINING_RANK_NOT_APPLICABLE",
      });
      // A bound, weighted community at zero power is listed, not ranked.
      expect(
        communities.json<{ ranking: { items: unknown[] } }>().ranking.items[1],
      ).toEqual({
        position: null,
        power: "0",
        community: {
          communityId: "d17b34a6-c3cc-4a24-87dd-dc165c80bd85",
          name: "Zero Holders",
          boundAssetId: cakeAsset,
        },
        weight: "0.5",
        participants: 0,
      });
      const unranked = await createApp(
        approvedRepository({
          getAccountStanding: vi.fn(() =>
            Promise.resolve({
              totalPower: "0",
              position: null,
              participantCount: 3,
            }),
          ),
        }),
      );
      const zero = await unranked.app.inject({
        method: "GET",
        url: "/v2/mining/rank",
        headers: s7CommonHeaders(),
      });
      expect(zero.json()).toMatchObject({
        myPosition: {
          status: "unavailable",
          reasonCode: "MINING_RANK_NOT_RANKED",
        },
      });
    });

    it("projects a community's standing, the caller's contribution on the bound asset, and the reasons it has none", async () => {
      const { app } = await createApp(approvedRepository());
      const response = await app.inject({
        method: "GET",
        url: `/v2/mining/communities/${communityId}`,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        community: {
          communityId,
          name: "Frog Holders",
          boundAssetId: cakeAsset,
        },
        weight: {
          status: "approved",
          value: "0.5",
          configVersion: "miningFormula-devBaseline-2026-09-15-r2",
          reviewedAt: approvedAt,
        },
        communityPower: { status: "available", value: "230" },
        myContribution: { status: "available", value: "115" },
        rank: { status: "available", position: 1, power: "230" },
        participants: { status: "available", count: 2 },
        snapshot: { snapshotId },
      });
      const unbound = await createApp(
        approvedRepository({
          getCommunityStanding: vi.fn(() => Promise.resolve(null)),
          getCommunityWeight: vi.fn(() =>
            Promise.resolve({
              communityId,
              communityName: "Frog Holders",
              boundAssetId: null,
              status: "pending_review" as const,
              weight: null,
              configVersion: null,
              reviewedAt: null,
            }),
          ),
        }),
      );
      const unboundResponse = await unbound.app.inject({
        method: "GET",
        url: `/v2/mining/communities/${communityId}`,
        headers: s7CommonHeaders(),
      });
      expect(unboundResponse.json()).toMatchObject({
        communityPower: {
          status: "unavailable",
          reasonCode: "COMMUNITY_ASSET_NOT_BOUND",
        },
        rank: {
          status: "unavailable",
          reasonCode: "COMMUNITY_ASSET_NOT_BOUND",
        },
      });
      const pending = await createApp(
        approvedRepository({
          getCommunityStanding: vi.fn(() => Promise.resolve(null)),
        }),
      );
      const pendingResponse = await pending.app.inject({
        method: "GET",
        url: `/v2/mining/communities/${communityId}`,
        headers: s7CommonHeaders(),
      });
      expect(pendingResponse.json()).toMatchObject({
        communityPower: {
          status: "unavailable",
          reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW",
        },
      });
    });

    it("publishes the baseline's parameters on the rules page, labelled as a development baseline", async () => {
      const { app } = await createApp(approvedRepository());
      const response = await app.inject({
        method: "GET",
        url: "/v2/mining/rules",
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        approved: {
          configVersion: "miningFormula-devBaseline-2026-09-15-r2",
          status: "approved",
          scope: "development_baseline",
          assetWeights: {
            [loopAsset]: "1",
            [cakeAsset]: "1",
            [nativeAsset]: "1",
          },
          dailyOutput: {
            status: "development_placeholder",
            budget: "1000000",
            unitKey: "mining.rules.dailyOutput.unit.loopTokenPending",
          },
          weightRange: {
            loop: { status: "pending_approval" },
            community: { status: "approved", range: { min: "0.5", max: "2" } },
          },
          referralBoost: { status: "pending_approval" },
        },
        pendingApproval: [{ configVersion: "miningFormulaV1-draft" }],
        baseline: {
          status: "approved",
          configVersion: "miningFormula-devBaseline-2026-09-15-r2",
          effectiveAt: approvedAt,
          scope: "development_baseline",
        },
      });
    });

    it("flips the communityMining capability on the formula fact in both directions", async () => {
      const pending = await createApp(repositoryFake());
      const pendingCapabilities = await pending.app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      const pendingById = Object.fromEntries(
        pendingCapabilities
          .json<{
            capabilities: { capabilityId: string; availability: string }[];
          }>()
          .capabilities.map((capability) => [
            capability.capabilityId,
            capability,
          ]),
      );
      expect(pendingById["communityMining"]).toEqual({
        capabilityId: "communityMining",
        availability: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        evidence: { status: "notApplicable", reasonCode: null },
      });
      const approved = await createApp(approvedRepository());
      const approvedCapabilities = await approved.app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      const approvedById = Object.fromEntries(
        approvedCapabilities
          .json<{
            capabilities: { capabilityId: string; availability: string }[];
          }>()
          .capabilities.map((capability) => [
            capability.capabilityId,
            capability,
          ]),
      );
      expect(approvedById["communityMining"]).toEqual({
        capabilityId: "communityMining",
        availability: "available",
        reasonCode: null,
        evidence: { status: "notApplicable", reasonCode: null },
      });
      // The `mining` module gate is unchanged by the fact: it was available
      // before and stays available; its evidence still names the 02 freeze.
      expect(approvedById["mining"]).toMatchObject({
        availability: "available",
        evidence: {
          status: "pending",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        },
      });
      expect(
        Object.values(approvedById).filter(
          (c) => c.availability === "available",
        ).length -
          Object.values(pendingById).filter(
            (c) => (c as { availability: string }).availability === "available",
          ).length,
      ).toBe(1);
      const broken = await createApp(
        repositoryFake({
          getApprovedFormula: () =>
            Promise.reject(new MiningRepositoryUnavailableError()),
        }),
      );
      const brokenCapabilities = await broken.app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      const brokenById = Object.fromEntries(
        brokenCapabilities
          .json<{ capabilities: { capabilityId: string }[] }>()
          .capabilities.map((capability) => [
            capability.capabilityId,
            capability,
          ]),
      );
      expect(brokenById["communityMining"]).toMatchObject({
        availability: "unavailable",
        reasonCode: "MINING_RUNTIME_UNAVAILABLE",
      });
    });
  });
});
