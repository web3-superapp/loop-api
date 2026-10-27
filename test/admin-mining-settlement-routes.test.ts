import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import {
  MiningCommunityUnknownError,
  type MiningAuditInput,
  type MiningParameterVersionRecord,
  type MiningSettlementRepository,
} from "../src/features/mining/hourly-settlement-ports.js";
import { createInMemoryAdminRepository } from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
  type InMemoryAdminAccounts,
} from "./helpers/admin-role-fakes.js";
import {
  createInMemoryMiningSettlement,
  epochRecord,
  loop,
  type InMemoryMiningSettlement,
} from "./helpers/mining-settlement-fakes.js";
import { s7Database, s7PrivyVerifier, s7TestConfig } from "./s7-route-fakes.js";

/**
 * Decision 0116 console contract: parameter drafts (platform_admin), approval
 * (reviewer only, formula.approve), epoch list / detail / funding for
 * auditors, and the test trigger switch.
 */

const accountPassword = "account-password-0123";
const sessionSecret = "s138-admin-session-secret-0123456789abcdef";
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashAdminPassword("bootstrap-password-0123");
});

function withAdminWrites(repo: InMemoryMiningSettlement) {
  const audits: string[] = [];
  const audit = (action: string) => {
    audits.push(action);
    return {
      auditId: randomUUID(),
      seq: audits.length,
      at: new Date().toISOString(),
      action,
    };
  };
  repo.recordAudit = vi.fn((input: MiningAuditInput) =>
    Promise.resolve(audit(input.action)),
  );
  repo.createParameterDraft = vi.fn(
    (
      input: Parameters<MiningSettlementRepository["createParameterDraft"]>[0],
    ) => {
      const version: MiningParameterVersionRecord = {
        versionId: randomUUID(),
        configVersion: input.configVersion,
        status: "pending_approval",
        document: input.document,
        effectiveFrom: input.effectiveFrom,
        draftAuthor: input.author,
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      };
      repo.versions.push(version);
      return Promise.resolve({ version, audit: audit(input.audit.action) });
    },
  );
  repo.approveParameterVersion = vi.fn(
    (
      input: Parameters<
        MiningSettlementRepository["approveParameterVersion"]
      >[0],
    ) => {
      const index = repo.versions.findIndex(
        (entry) => entry.versionId === input.versionId,
      );
      const version = {
        ...(repo.versions[index] as MiningParameterVersionRecord),
        status: "approved" as const,
        approvedBy: input.approver.actor,
        approvedAt: new Date().toISOString(),
      };
      repo.versions[index] = version;
      return Promise.resolve({ version, audit: audit(input.audit.action) });
    },
  );
  return audits;
}

describe("Operator console mining settlement (Decision 0116)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function harness(env: Readonly<Record<string, string>> = {}) {
    const admin = createInMemoryAdminRepository();
    const accounts: InMemoryAdminAccounts = createInMemoryAdminAccounts(admin);
    const settlement = createInMemoryMiningSettlement();
    const audits = withAdminWrites(settlement);
    settlement.epochs.push(epochRecord());
    settlement.balances.set(randomUUID(), {
      settled: 5n * loop,
      claimed: loop,
    });
    const reviewerUserId = randomUUID();
    const app = await buildApp({
      config: s7TestConfig({
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: sessionSecret,
        ...env,
      }),
      database: {
        ...s7Database({}),
        admin,
        adminAccounts: accounts,
        adminLaunchReview: createInMemoryAdminLaunchReview([], new Map()),
        hooksLaunchReview: createFakeHooksReview({
          grants: new Map(),
          owners: new Map(),
        }),
        miningSettlement: settlement,
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      logger: false,
    });
    apps.push(app);
    const cookies = new Map<AdminRole, string>();
    for (const role of [
      "platform_admin",
      "reviewer",
      "auditor",
      "testnet_acceptor",
    ] as const) {
      const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
      await accounts.seed({
        username,
        password: accountPassword,
        role,
        operatorUserId:
          role === "reviewer" || role === "testnet_acceptor"
            ? reviewerUserId
            : null,
      });
      const login = await app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username, password: accountPassword },
      });
      expect(login.statusCode, login.body).toBe(200);
      cookies.set(
        role,
        (login.headers["set-cookie"] as string).split(";")[0] as string,
      );
    }
    const call = (
      role: AdminRole,
      method: "GET" | "POST",
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: { cookie: cookies.get(role) as string },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    return { app, settlement, audits, call };
  }

  const draft = {
    configVersion: "miningHourlyV1",
    effectiveFrom: "2099-01-01T00:00:00.000Z",
    parameters: { releaseStartAt: "2099-01-01T00:00:00.000Z" },
  };

  it("platform_admin drafts, the reviewer approves, nobody else can", async () => {
    const { call, audits } = await harness();
    for (const role of ["reviewer", "auditor", "testnet_acceptor"] as const) {
      const refused = await call(
        role,
        "POST",
        "/admin/v1/mining/parameter-versions",
        draft,
      );
      expect(refused.statusCode, role).toBe(403);
    }
    const created = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      draft,
    );
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<{
      version: { versionId: string; document: Record<string, unknown> };
    }>().version;
    expect(version.document).toMatchObject({
      referralRatiosBps: [1000, 500, 300, 200, 100],
      dailyBudgetNftRaw: (500_000n * loop).toString(),
      releaseDays: 900,
      timezone: "UTC",
      // Decision 0123: stored as quantity, unlisted communities 1.0.
      assetPowerBasis: "quantity",
      defaultCommunityCoefficient: "1",
    });
    const approveUrl = `/admin/v1/mining/parameter-versions/${version.versionId}/approve`;
    for (const role of ["platform_admin", "auditor"] as const) {
      expect((await call(role, "POST", approveUrl)).statusCode, role).toBe(403);
    }
    const approved = await call("reviewer", "POST", approveUrl);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ version: { status: "approved" } });
    expect(audits).toEqual([
      "mining.parameters.draft",
      "mining.parameters.approve.requested",
      "mining.parameters.approve",
    ]);
  });

  it("validates a draft (effective time in the future, every field by name)", async () => {
    const { call } = await harness();
    const past = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      { ...draft, effectiveFrom: "2020-01-01T00:00:00.000Z" },
    );
    expect(past.statusCode).toBe(422);
    expect(past.json()).toMatchObject({
      detailsSafe: { reasonCode: "ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED" },
    });
    const ratios = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      { ...draft, parameters: { ...draft.parameters, referralRatiosBps: [1] } },
    );
    expect(ratios.statusCode).toBe(422);
    expect(ratios.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "ADMIN_MINING_PARAMETERS_INVALID",
        field: "referralRatiosBps",
      },
    });
  });

  it("Decision 0123: a draft cannot ask for the valuation rule or carry a price source", async () => {
    const { call } = await harness();
    for (const [extra, field] of [
      [{ assetPowerBasis: "valuation" }, "assetPowerBasis"],
      [{ referencePriceSource: "curve" }, "referencePriceSource"],
      [{ defaultCommunityCoefficient: "-1" }, "defaultCommunityCoefficient"],
    ] as const) {
      const refused = await call(
        "platform_admin",
        "POST",
        "/admin/v1/mining/parameter-versions",
        { ...draft, parameters: { ...draft.parameters, ...extra } },
      );
      expect(refused.statusCode, field).toBe(422);
      expect(refused.json()).toMatchObject({
        detailsSafe: { reasonCode: "ADMIN_MINING_PARAMETERS_INVALID", field },
      });
    }
    const listed = await call(
      "platform_admin",
      "GET",
      "/admin/v1/mining/parameter-versions",
    );
    expect(listed.json()).toMatchObject({
      defaults: {
        assetPowerBasis: "quantity",
        defaultCommunityCoefficient: "1",
      },
    });
  });

  it("Decision 0183: a community table naming unknown or unverified communities is 422 MINING_COMMUNITY_UNKNOWN on draft and approval", async () => {
    const { call, settlement, audits } = await harness();
    const verified = "81a1763f-56bf-472c-a795-9370b20590c8";
    const missing = "0d6e4b8c-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
    const pending = "9c5d3a7b-2e1f-4a6b-9c8d-7e6f5a4b3c2d";
    const unverified = new Set([missing, pending]);
    settlement.findUnverifiedCommunityIds = vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.filter((id) => unverified.has(id))),
    );
    const refused = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      {
        ...draft,
        parameters: {
          ...draft.parameters,
          communityCoefficients: [
            { communityId: verified, coefficient: "1.5" },
            { communityId: missing, coefficient: "2" },
            { communityId: pending, coefficient: "1" },
          ],
        },
      },
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      code: "MINING_COMMUNITY_UNKNOWN",
      category: "validation",
      detailsSafe: {
        reasonCode: "MINING_COMMUNITY_UNKNOWN",
        field: "communityCoefficients",
        unknownCommunityIds: [missing, pending],
      },
    });
    expect(audits).not.toContain("mining.parameters.draft");

    const accepted = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      {
        ...draft,
        parameters: {
          ...draft.parameters,
          communityCoefficients: [
            { communityId: verified, coefficient: "1.5" },
          ],
        },
      },
    );
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).not.toHaveProperty("skippedCommunityIds");

    // Approval re-checks inside the repository transaction.
    settlement.approveParameterVersion = vi.fn(() =>
      Promise.reject(new MiningCommunityUnknownError([verified])),
    );
    const versionId = accepted.json<{ version: { versionId: string } }>()
      .version.versionId;
    const approval = await call(
      "reviewer",
      "POST",
      `/admin/v1/mining/parameter-versions/${versionId}/approve`,
    );
    expect(approval.statusCode, approval.body).toBe(422);
    expect(approval.json()).toMatchObject({
      code: "MINING_COMMUNITY_UNKNOWN",
      detailsSafe: { unknownCommunityIds: [verified] },
    });
  });

  it("Decision 0183: the frozen copy drops unverified communities and lists them in skippedCommunityIds", async () => {
    const { call, settlement } = await harness();
    const kept = "81a1763f-56bf-472c-a795-9370b20590c8";
    const dropped = "9c5d3a7b-2e1f-4a6b-9c8d-7e6f5a4b3c2d";
    settlement.listApprovedCommunityWeights = vi.fn(() =>
      Promise.resolve([
        { communityId: kept, weight: "1.2" },
        { communityId: dropped, weight: "0.8" },
      ]),
    );
    settlement.findUnverifiedCommunityIds = vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.filter((id) => id === dropped)),
    );
    const created = await call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/parameter-versions",
      draft,
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      skippedCommunityIds: [dropped],
      version: {
        document: {
          communityCoefficients: [{ communityId: kept, coefficient: "1.2" }],
        },
      },
    });
  });

  it("lets auditors and reviewers read epochs and funding", async () => {
    const { call } = await harness();
    for (const role of ["auditor", "reviewer", "platform_admin"] as const) {
      const epochs = await call(role, "GET", "/admin/v1/mining/epochs");
      expect(epochs.statusCode, role).toBe(200);
      expect(epochs.json()).toMatchObject({
        items: [{ status: "settled", inputDigest: "a".repeat(64) }],
      });
    }
    const funding = await call("auditor", "GET", "/admin/v1/mining/funding");
    expect(funding.statusCode).toBe(200);
    expect(funding.json()).toMatchObject({
      status: "unavailable",
      reasonCode: "MINING_CLAIM_CONTRACT_NOT_CONFIGURED",
      liabilityRaw: (4n * loop).toString(),
      alert: null,
    });
    const detail = await call(
      "auditor",
      "GET",
      `/admin/v1/mining/epochs/${epochRecord().epochId}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(
      (await call("testnet_acceptor", "GET", "/admin/v1/mining/epochs"))
        .statusCode,
    ).toBe(200);
  });

  it("refuses the manual settlement unless the test trigger is on", async () => {
    const off = await harness();
    const refused = await off.call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/epochs/settle",
      { hourStart: "2026-10-10T10:00:00.000Z" },
    );
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      detailsSafe: { reasonCode: "MINING_SETTLEMENT_TEST_TRIGGER_DISABLED" },
    });
    const on = await harness({ MINING_SETTLEMENT_TEST_TRIGGER: "true" });
    const settled = await on.call(
      "platform_admin",
      "POST",
      "/admin/v1/mining/epochs/settle",
      { hourStart: "2026-10-10T10:00:00.000Z" },
    );
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ outcome: "already_settled" });
    expect(
      (
        await on.call("auditor", "POST", "/admin/v1/mining/epochs/settle", {
          hourStart: "2026-10-10T10:00:00.000Z",
        })
      ).statusCode,
    ).toBe(403);
  });
  describe("Decision 0187 mining pool roster", () => {
    const communities = [
      "c0000000-0000-4000-8000-000000000001",
      "c0000000-0000-4000-8000-000000000002",
      "c0000000-0000-4000-8000-000000000003",
    ];
    const memes = [
      "0x1111111111111111111111111111111111116666",
      "0x2222222222222222222222222222222222226666",
      "0x3333333333333333333333333333333333336666",
    ];
    function seed(settlement: InMemoryMiningSettlement) {
      ["Alpha", "Beta", "Gamma"].forEach((name, index) => {
        settlement.poolCandidates.push({
          communityId: communities[index] as string,
          communityName: name,
          assetId: `eip155:97:${memes[index] as string}`,
          chainId: "eip155:97",
          memeAddress: memes[index] as string,
          kind: "platform",
          symbol: name.toUpperCase(),
          instanceId: `d0000000-0000-4000-8000-00000000000${String(index + 1)}`,
          launchId: `0x${String(index + 1).repeat(64)}`,
        });
      });
      settlement.versions.push({
        versionId: "11111111-1111-4111-8111-111111111111",
        configVersion: "inForce",
        status: "approved",
        document: {
          referralRatiosBps: [1000, 500, 300, 200, 100],
          dailyBudgetNftRaw: "0",
          dailyBudgetAssetRaw: "0",
          releaseStartAt: "2026-10-10T00:00:00.000Z",
          releaseDays: 900,
          timezone: "UTC",
          minimumClaimRaw: "1",
          assetWeights: [
            { assetId: `eip155:97:${memes[1] as string}`, weight: "2" },
          ],
          communityCoefficients: [],
          assetPowerBasis: "quantity",
          defaultCommunityCoefficient: "1",
          excludedAssets: [`eip155:97:${memes[2] as string}`],
          excludedCommunities: [communities[2] as string],
        },
        effectiveFrom: "2026-10-10T00:00:00.000Z",
        draftAuthor: { actor: "admin", accountId: null },
        approvedBy: "reviewer",
        approvedAt: "2026-10-09T00:00:00.000Z",
        createdAt: "2026-10-09T00:00:00.000Z",
      });
    }

    it("lists every roster row with the in-force values (default / explicit / excluded)", async () => {
      const { call, settlement } = await harness();
      seed(settlement);
      for (const role of ["platform_admin", "auditor", "reviewer"] as const) {
        const listed = await call(role, "GET", "/admin/v1/mining/pool");
        expect(listed.statusCode, role).toBe(200);
      }
      const listed = await call("auditor", "GET", "/admin/v1/mining/pool");
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json()).toEqual({
        inForce: {
          versionId: "11111111-1111-4111-8111-111111111111",
          configVersion: "inForce",
          effectiveFrom: "2026-10-10T00:00:00.000Z",
        },
        pendingDraftVersion: null,
        items: [
          expect.objectContaining({
            communityName: "Alpha",
            participate: true,
            tokenWeight: "1",
            nftCoefficient: "1",
            source: "default",
            pendingDraft: null,
          }),
          expect.objectContaining({
            communityName: "Beta",
            participate: true,
            tokenWeight: "2",
            nftCoefficient: "1",
            source: "explicit",
          }),
          expect.objectContaining({
            communityName: "Gamma",
            memeAddress: memes[2],
            symbol: "GAMMA",
            participate: false,
            tokenWeight: "0",
            nftCoefficient: "0",
            source: "explicit",
          }),
        ],
        nextCursor: null,
      });
    });

    it("refuses a role without console.read / formula.approve", async () => {
      const { call } = await harness();
      expect(
        (await call("testnet_acceptor", "GET", "/admin/v1/mining/pool"))
          .statusCode,
      ).toBe(403);
    });

    it("filters by contract address (exact, case-insensitive) and by q", async () => {
      const { call, settlement } = await harness();
      seed(settlement);
      const upper = `0x${(memes[1] as string).slice(2).toUpperCase()}`;
      const byAddress = await call(
        "platform_admin",
        "GET",
        `/admin/v1/mining/pool?address=${upper}`,
      );
      expect(byAddress.statusCode, byAddress.body).toBe(200);
      expect(
        byAddress
          .json<{ items: { communityName: string }[] }>()
          .items.map((row) => row.communityName),
      ).toEqual(["Beta"]);
      const byQ = await call(
        "platform_admin",
        "GET",
        "/admin/v1/mining/pool?q=gam",
      );
      expect(
        byQ
          .json<{ items: { communityName: string }[] }>()
          .items.map((row) => row.communityName),
      ).toEqual(["Gamma"]);
      const bad = await call(
        "platform_admin",
        "GET",
        "/admin/v1/mining/pool?address=0x12",
      );
      expect(bad.statusCode).toBe(400);
    });

    it("pages with a signed cursor bound to the filter", async () => {
      const { call, settlement } = await harness();
      seed(settlement);
      const first = await call(
        "platform_admin",
        "GET",
        "/admin/v1/mining/pool?limit=2",
      );
      const page1 = first.json<{
        items: { communityName: string }[];
        nextCursor: string;
      }>();
      expect(page1.items.map((row) => row.communityName)).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const second = await call(
        "platform_admin",
        "GET",
        `/admin/v1/mining/pool?cursor=${encodeURIComponent(page1.nextCursor)}`,
      );
      expect(second.statusCode, second.body).toBe(200);
      expect(
        second.json<{
          items: { communityName: string }[];
          nextCursor: string | null;
        }>(),
      ).toMatchObject({
        items: [{ communityName: "Gamma" }],
        nextCursor: null,
      });
      const otherFilter = await call(
        "platform_admin",
        "GET",
        `/admin/v1/mining/pool?q=a&cursor=${encodeURIComponent(page1.nextCursor)}`,
      );
      expect(otherFilter.statusCode).toBe(400);
      const both = await call(
        "platform_admin",
        "GET",
        `/admin/v1/mining/pool?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      );
      expect(both.statusCode).toBe(400);
    });

    it("shows the pending draft per row and accepts the excluded keys in a draft", async () => {
      const { call, settlement } = await harness();
      seed(settlement);
      const created = await call(
        "platform_admin",
        "POST",
        "/admin/v1/mining/parameter-versions",
        {
          ...draft,
          parameters: {
            ...draft.parameters,
            communityCoefficients: [],
            excludedAssets: [`eip155:97:${memes[0] as string}`],
            excludedCommunities: [communities[0]],
          },
        },
      );
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({
        version: {
          document: {
            excludedAssets: [`eip155:97:${memes[0] as string}`],
            excludedCommunities: [communities[0]],
          },
        },
      });
      const listed = await call(
        "platform_admin",
        "GET",
        `/admin/v1/mining/pool?address=${memes[0] as string}`,
      );
      expect(listed.json()).toMatchObject({
        pendingDraftVersion: { configVersion: "miningHourlyV1" },
        items: [
          {
            participate: true,
            pendingDraft: {
              configVersion: "miningHourlyV1",
              participate: false,
              tokenWeight: "0",
              nftCoefficient: "0",
              source: "explicit",
            },
          },
        ],
      });
    });

    describe("Decision 0189 external tokens on the power list", () => {
      const cakeAddress = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
      const cake = `eip155:56:${cakeAddress}`;
      const newsId = "c0000000-0000-4000-8000-000000000004";
      function seedExternal(settlement: InMemoryMiningSettlement) {
        seed(settlement);
        settlement.poolCandidates.push({
          communityId: newsId,
          communityName: "BSC News",
          assetId: cake,
          chainId: "eip155:56",
          memeAddress: cakeAddress,
          kind: "external",
          symbol: "CAKE",
          instanceId: null,
          launchId: null,
          settlementSource: null,
        });
      }

      it("lists an external row out by default and filters by kind", async () => {
        const { call, settlement } = await harness();
        seedExternal(settlement);
        const external = await call(
          "auditor",
          "GET",
          "/admin/v1/mining/pool?kind=external",
        );
        expect(external.statusCode, external.body).toBe(200);
        expect(external.json<{ items: unknown[] }>().items).toEqual([
          {
            communityId: newsId,
            communityName: "BSC News",
            assetId: cake,
            chainId: "eip155:56",
            memeAddress: cakeAddress,
            kind: "external",
            symbol: "CAKE",
            instanceId: null,
            launchId: null,
            participate: false,
            tokenWeight: "0",
            nftCoefficient: "0",
            source: "default",
            settleable: false,
            settleableReasonCode: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
            pendingDraft: null,
          },
        ]);
        const platform = await call(
          "auditor",
          "GET",
          "/admin/v1/mining/pool?kind=platform",
        );
        expect(
          platform
            .json<{ items: { kind: string }[] }>()
            .items.map((row) => row.kind),
        ).toEqual(["platform", "platform", "platform"]);
        const byAddress = await call(
          "auditor",
          "GET",
          `/admin/v1/mining/pool?address=${cakeAddress.toUpperCase().replace("0X", "0x")}`,
        );
        expect(
          byAddress
            .json<{ items: { communityName: string }[] }>()
            .items.map((row) => row.communityName),
        ).toEqual(["BSC News"]);
        expect(
          (await call("auditor", "GET", "/admin/v1/mining/pool?kind=other"))
            .statusCode,
        ).toBe(400);
      });

      it("Decision 0189: marks an erc20-sourced external row and a platform row settleable", async () => {
        const { call, settlement } = await harness({ LAUNCH_CHAIN_ID: "97" });
        seedExternal(settlement);
        const row = settlement.poolCandidates.find(
          (candidate) => candidate.assetId === cake,
        );
        settlement.poolCandidates.splice(
          settlement.poolCandidates.indexOf(row!),
          1,
          { ...row!, settlementSource: "erc20" },
        );
        const listed = await call("auditor", "GET", "/admin/v1/mining/pool");
        expect(listed.statusCode, listed.body).toBe(200);
        const items = listed.json<{
          items: {
            kind: string;
            chainId: string;
            settleable: boolean;
            settleableReasonCode: string | null;
          }[];
        }>().items;
        expect(
          items
            .filter((item) => item.kind === "external")
            .map((item) => [item.settleable, item.settleableReasonCode]),
        ).toEqual([[true, null]]);
        for (const item of items.filter((entry) => entry.kind === "platform")) {
          expect(item.settleable).toBe(item.chainId === "eip155:97");
        }
      });

      it("accepts includedAssets for a bound external token and shows the draft", async () => {
        const { call, settlement } = await harness();
        seedExternal(settlement);
        // CAKE has no launch2 / MEME v1 source.
        settlement.findUnknownAssetIds = vi.fn((ids: readonly string[]) =>
          Promise.resolve(ids.filter((id) => id === cake)),
        );
        const created = await call(
          "platform_admin",
          "POST",
          "/admin/v1/mining/parameter-versions",
          {
            ...draft,
            parameters: {
              ...draft.parameters,
              communityCoefficients: [],
              includedAssets: [cake],
              assetWeights: [{ assetId: cake, weight: "1.5" }],
            },
          },
        );
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json()).toMatchObject({
          version: { document: { includedAssets: [cake] } },
        });
        const listed = await call(
          "platform_admin",
          "GET",
          "/admin/v1/mining/pool?kind=external",
        );
        expect(listed.json()).toMatchObject({
          items: [
            {
              participate: false,
              pendingDraft: {
                participate: true,
                tokenWeight: "1.5",
                source: "explicit",
              },
            },
          ],
        });
        // A weight alone (not let in) still needs a settlement source.
        const refused = await call(
          "platform_admin",
          "POST",
          "/admin/v1/mining/parameter-versions",
          {
            ...draft,
            configVersion: "miningHourlyV2",
            parameters: {
              ...draft.parameters,
              communityCoefficients: [],
              assetWeights: [{ assetId: cake, weight: "1.5" }],
            },
          },
        );
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          detailsSafe: {
            reasonCode: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
            assetId: cake,
          },
        });
      });
    });

    it("refuses an unknown excluded community as MINING_COMMUNITY_UNKNOWN", async () => {
      const { call, settlement } = await harness();
      const unknown = "c0000000-0000-4000-8000-0000000000ff";
      settlement.findUnverifiedCommunityIds = vi.fn((ids: readonly string[]) =>
        Promise.resolve(ids.filter((id) => id === unknown)),
      );
      const refused = await call(
        "platform_admin",
        "POST",
        "/admin/v1/mining/parameter-versions",
        {
          ...draft,
          parameters: {
            ...draft.parameters,
            communityCoefficients: [],
            excludedCommunities: [unknown],
          },
        },
      );
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "MINING_COMMUNITY_UNKNOWN",
        detailsSafe: {
          field: "excludedCommunities",
          unknownCommunityIds: [unknown],
        },
      });
    });
  });
});
