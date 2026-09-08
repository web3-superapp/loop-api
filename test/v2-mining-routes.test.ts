import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createUnavailableMiningRepository,
  type MiningFormulaRecord,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";
import {
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
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
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
      snapshot: {
        status: "unavailable",
        reasonCode: "MINING_SNAPSHOT_NOT_AVAILABLE",
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
});
