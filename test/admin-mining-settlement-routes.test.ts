import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import type {
  MiningAuditInput,
  MiningParameterVersionRecord,
  MiningSettlementRepository,
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
});
