import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  LaunchDataStaleError,
  LaunchNotFoundError,
  LaunchVersionConflictError,
  createUnavailableLaunchRepository,
  type LaunchCatalogRecord,
  type LaunchDetailRecord,
  type LaunchProjectRecord,
  type LaunchRepository,
} from "../src/features/launch/launch-repository.js";
import {
  calls,
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7RequestIdPattern,
  s7TestConfig,
} from "./s7-route-fakes.js";

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const launchId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const otherAccountId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const createdAt = "2026-09-08T01:00:00.000Z";

const draft: LaunchProjectRecord = Object.freeze({
  projectId,
  ownerUserId: s7AccountId,
  name: "MoonCat",
  ticker: "MCAT",
  narrative: "A curated meme with a story.",
  officialLinks: {
    website: "https://mooncat.example",
    x: null,
    telegram: null,
    discord: null,
  },
  materialVersion: 1,
  reviewStatus: "draft",
  kybStatus: "unavailable",
  reviewReasonCode: null,
  submittedAt: null,
  reviewedAt: null,
  launchId: null,
  version: 1,
  createdAt,
  updatedAt: createdAt,
});

const approved: LaunchProjectRecord = Object.freeze({
  ...draft,
  reviewStatus: "approved",
  submittedAt: createdAt,
  reviewedAt: createdAt,
  launchId,
  version: 3,
});

const catalog: LaunchCatalogRecord = {
  launch: {
    launchId,
    projectId,
    chainId: "eip155:56",
    contractAddress: null,
    configDigest: null,
    scheduleStatus: "unscheduled",
    createdAt,
    updatedAt: createdAt,
  },
  projectName: "MoonCat",
  projectTicker: "MCAT",
  confirmedConfigVersion: null,
};

const detail: LaunchDetailRecord = {
  launch: catalog.launch,
  project: approved,
  configs: [
    {
      configId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
      launchId,
      configVersion: "launchMoonCatV1",
      parameters: { walletRoundCap: "5000000", tierModeV1: "community" },
      status: "pending_confirmation",
      effectiveAt: null,
    },
  ],
  rounds: [
    {
      roundId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      launchId,
      roundIndex: 1,
      configVersion: "launchMoonCatV1",
      status: "pending_confirmation",
      startsAt: null,
      endsAt: null,
      priceUsd1: null,
      eligibilityTier: null,
      walletRoundCapRaw: null,
    },
  ],
};

function repositoryFake(overrides: Partial<LaunchRepository> = {}) {
  const repository: LaunchRepository = {
    ...createUnavailableLaunchRepository(),
    createProject: vi.fn(() => Promise.resolve(draft)),
    getProject: vi.fn(() => Promise.resolve(draft)),
    listProjects: vi.fn(() => Promise.resolve([draft])),
    replaceProject: vi.fn(() =>
      Promise.resolve({ ...draft, version: 2, materialVersion: 2 }),
    ),
    submitProject: vi.fn(() =>
      Promise.resolve({
        ...draft,
        reviewStatus: "submitted" as const,
        submittedAt: createdAt,
        version: 2,
      }),
    ),
    listLaunches: vi.fn(() => Promise.resolve([catalog])),
    getLaunch: vi.fn(() => Promise.resolve(detail)),
    listMilestones: vi.fn(() => Promise.resolve([])),
    getEconomyCounts: vi.fn(() =>
      Promise.resolve({
        projectsByStatus: {
          draft: 1,
          submitted: 0,
          in_review: 0,
          returned: 0,
          approved: 1,
          rejected: 0,
        },
        launchesByScheduleStatus: {
          unscheduled: 1,
          scheduled: 0,
          live: 0,
          ended: 0,
        },
        confirmedRoundCount: 0,
        observedAt: createdAt,
      }),
    ),
    ...overrides,
  };
  return repository;
}

describe("LOOP API V2 launch module", () => {
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
      database: s7Database({ launch: repository }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return { app, repository };
  }

  it("registers no launch route when the module is disabled", async () => {
    const { app } = await createApp(repositoryFake(), {
      V2_MODULES_ENABLED: "mining",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch/overview",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("publishes the catalog with every on-chain axis unavailable and no supply or tax", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch/overview",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(s7RequestIdPattern);
    const body = response.json<{
      readonly segments: {
        readonly upcoming: readonly Record<string, unknown>[];
        readonly awaitingSchedule: readonly Record<string, unknown>[];
      };
      readonly graduated: unknown;
      readonly staking: unknown;
      readonly myEligibility: unknown;
    }>();
    // unscheduled is its own segment and is never presented as upcoming.
    expect(body.segments.upcoming).toHaveLength(0);
    expect(body.segments.awaitingSchedule).toHaveLength(1);
    expect(body.segments.awaitingSchedule[0]).toMatchObject({
      launchId,
      contractAddress: null,
      scheduleStatus: "unscheduled",
      onChainState: {
        saleState: "unavailable",
        entitlementState: "unavailable",
        liquidityState: "unavailable",
        operationalState: "unavailable",
        stateTupleDigest: null,
        snapshotBlockNumber: null,
        snapshotBlockHash: null,
        reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
      },
    });
    expect(body.graduated).toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    expect(body.staking).toEqual({
      status: "unavailable",
      reasonCode: "STAKING_CONTRACT_PENDING",
    });
    expect(body.myEligibility).toEqual({
      status: "unavailable",
      reasonCode: "TIER_MODE_PENDING",
    });
    expect(JSON.stringify(body)).not.toMatch(/tax|totalSupply|1%|LOOP$/);
  });

  it("creates a draft with an Idempotency-Key and rejects a missing one", async () => {
    const { app, repository } = await createApp();
    const payload = {
      name: "MoonCat",
      ticker: "MCAT",
      narrative: "A curated meme with a story.",
      officialLinks: { website: "https://mooncat.example" },
    };
    const created = await app.inject({
      method: "POST",
      url: "/v2/launch/projects",
      headers: s7CommandHeaders(),
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      project: {
        projectId,
        reviewStatus: "draft",
        kyb: {
          status: "unavailable",
          state: "unavailable",
          reasonCode: "KYB_PROVIDER_NOT_SELECTED",
        },
        attachments: {
          status: "unavailable",
          reasonCode: "ATTACHMENT_STORAGE_NOT_SELECTED",
        },
        configVersion: "launchCatalogV1",
      },
      contractVersion: "2.0",
    });
    expect(calls(repository, "createProject")).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: s7AccountId,
        values: expect.objectContaining({ ticker: "MCAT" }) as unknown,
      }),
    );
    const missingKey = await app.inject({
      method: "POST",
      url: "/v2/launch/projects",
      headers: s7CommonHeaders(),
      payload,
    });
    expect(missingKey.statusCode).toBe(400);
    const badTicker = await app.inject({
      method: "POST",
      url: "/v2/launch/projects",
      headers: s7CommandHeaders(),
      payload: { ...payload, ticker: "mcat" },
    });
    expect(badTicker.statusCode).toBe(400);
  });

  it("replaces material by compare-and-swap, rejects an Idempotency-Key, and maps stale/conflict errors", async () => {
    const { app, repository } = await createApp();
    const body = {
      expectedVersion: 1,
      project: {
        name: "MoonCat",
        ticker: "MCAT",
        narrative: null,
        officialLinks: {},
      },
    };
    const replaced = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
      payload: body,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      project: { version: 2, materialVersion: 2 },
    });
    // officialLinks may be omitted entirely: it is the same as all-null.
    const omitted = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
      payload: {
        expectedVersion: 2,
        project: { name: "MoonCat", ticker: "MCAT", narrative: null },
      },
    });
    expect(omitted.statusCode).toBe(200);
    expect(calls(repository, "replaceProject")).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          officialLinks: {
            website: null,
            x: null,
            telegram: null,
            discord: null,
          },
        }) as unknown,
      }),
    );
    const withKey = await app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommandHeaders(),
      payload: body,
    });
    expect(withKey.statusCode).toBe(400);

    const conflict = await createApp(
      repositoryFake({
        replaceProject: vi.fn(() =>
          Promise.reject(new LaunchVersionConflictError()),
        ),
      }),
    );
    const conflictResponse = await conflict.app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
      payload: body,
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({ code: "VERSION_CONFLICT" });

    const stale = await createApp(
      repositoryFake({
        replaceProject: vi.fn(() => Promise.reject(new LaunchDataStaleError())),
      }),
    );
    const staleResponse = await stale.app.inject({
      method: "PUT",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
      payload: body,
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toMatchObject({ code: "DATA_STALE" });
  });

  it("submits a draft and reports a non-editable status as DATA_STALE", async () => {
    const { app } = await createApp();
    const submitted = await app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/submit`,
      headers: s7CommandHeaders(),
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      project: { reviewStatus: "submitted" },
    });

    const stale = await createApp(
      repositoryFake({
        submitProject: vi.fn(() => Promise.reject(new LaunchDataStaleError())),
      }),
    );
    const staleResponse = await stale.app.inject({
      method: "POST",
      url: `/v2/launch/projects/${projectId}/submit`,
      headers: s7CommandHeaders(),
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toMatchObject({ code: "DATA_STALE" });
  });

  it("hides another account's unapproved project without enumeration", async () => {
    const { app } = await createApp(
      repositoryFake({
        getProject: vi.fn(() =>
          Promise.resolve({ ...draft, ownerUserId: otherAccountId }),
        ),
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(404);
    const approvedApp = await createApp(
      repositoryFake({
        getProject: vi.fn(() =>
          Promise.resolve({ ...approved, ownerUserId: otherAccountId }),
        ),
      }),
    );
    const visible = await approvedApp.app.inject({
      method: "GET",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
    });
    expect(visible.statusCode).toBe(200);
    // The public projection carries no review trail or CAS version.
    expect(visible.json()).toMatchObject({
      project: {
        reviewStatus: "approved",
        reviewReasonCode: null,
        submittedAt: null,
        reviewedAt: null,
        version: null,
      },
    });
    const own = await app.inject({
      method: "GET",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
    });
    expect(own.statusCode).toBe(404);
  });

  it("lists the caller's projects with an owner-bound cursor and rejects limit with cursor", async () => {
    const many = Array.from({ length: 3 }, (_, index) => ({
      ...draft,
      projectId: `3fa85f64-5717-4562-b3fc-2c963f66afa${String(index)}`,
      createdAt: `2026-09-08T01:00:0${String(index)}.000Z`,
    }));
    const { app } = await createApp(
      repositoryFake({ listProjects: vi.fn(() => Promise.resolve(many)) }),
    );
    const first = await app.inject({
      method: "GET",
      url: "/v2/launch/projects?limit=2&status=draft",
      headers: s7CommonHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      readonly items: unknown[];
      readonly nextCursor: string | null;
    }>();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const both = await app.inject({
      method: "GET",
      url: `/v2/launch/projects?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
      headers: s7CommonHeaders(),
    });
    expect(both.statusCode).toBe(400);
    const otherFilter = await app.inject({
      method: "GET",
      url: `/v2/launch/projects?status=submitted&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
      headers: s7CommonHeaders(),
    });
    expect(otherFilter.statusCode).toBe(400);
    const next = await app.inject({
      method: "GET",
      url: `/v2/launch/projects?status=draft&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
      headers: s7CommonHeaders(),
    });
    expect(next.statusCode).toBe(200);
  });

  it("projects a launch with pending configuration slots, rounds, and pending graduation steps", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/launches/${launchId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      launch: { launchId, contractAddress: null, configVersion: null },
      config: {
        configVersion: "launchMoonCatV1",
        status: "pending_confirmation",
        slots: {
          walletRoundCap: {
            status: "unavailable",
            reasonCode: "LAUNCH_CONFIG_PENDING_CONFIRMATION",
          },
          tierModeV1: {
            status: "unavailable",
            reasonCode: "LAUNCH_CONFIG_PENDING_CONFIRMATION",
          },
        },
      },
      configPending: {
        status: "unavailable",
        reasonCode: "LAUNCH_CONFIG_PENDING_CONFIRMATION",
      },
      rounds: [
        { roundIndex: 1, status: "pending_confirmation", priceUsd1: null },
      ],
      graduation: {
        steps: [
          { step: "stop_internal_trading", status: "pending" },
          { step: "prepare_pool", status: "pending" },
          { step: "add_and_lock_liquidity", status: "pending" },
          { step: "open_external_trading", status: "pending" },
        ],
        poolEvidence: {
          status: "unavailable",
          reasonCode: "LAUNCH_POOL_EVIDENCE_UNAVAILABLE",
        },
      },
      holders: { status: "unavailable" },
    });
    const missing = await createApp(
      repositoryFake({ getLaunch: vi.fn(() => Promise.resolve(null)) }),
    );
    const notFound = await missing.app.inject({
      method: "GET",
      url: `/v2/launches/${launchId}`,
      headers: s7CommonHeaders(),
    });
    expect(notFound.statusCode).toBe(404);
  });

  it("answers eligibility, holders, history, and stake as unavailable and never depends on staking", async () => {
    const { app } = await createApp();
    const eligibility = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/eligibility`,
      headers: s7CommonHeaders(),
    });
    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json()).toMatchObject({
      mode: "unavailable",
      result: {
        tier: null,
        reasonCode: "TIER_MODE_PENDING",
        snapshotBlock: null,
      },
      dependsOnStaking: false,
    });
    const holders = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/holders`,
      headers: s7CommonHeaders(),
    });
    expect(holders.json()).toMatchObject({
      holders: {
        status: "unavailable",
        reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
      },
    });
    const history = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/history`,
      headers: s7CommonHeaders(),
    });
    expect(history.json()).toEqual({
      launchId,
      purchaseRecords: [],
      entitlements: [],
      refunds: [],
      source: {
        status: "unavailable",
        reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
      },
      contractVersion: "2.0",
    });
    const stake = await app.inject({
      method: "GET",
      url: "/v2/launch/stake",
      headers: s7CommonHeaders(),
    });
    expect(stake.json()).toEqual({
      stake: { status: "unavailable", reasonCode: "STAKING_CONTRACT_PENDING" },
      executable: false,
      contractVersion: "2.0",
    });
  });

  it("reports a confirmed tierModeV1 slot as the eligibility mode", async () => {
    const { app } = await createApp(
      repositoryFake({
        getLaunch: vi.fn(() =>
          Promise.resolve({
            ...detail,
            configs: [
              {
                ...detail.configs[0]!,
                status: "confirmed" as const,
                effectiveAt: createdAt,
              },
            ],
          }),
        ),
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/eligibility`,
      headers: s7CommonHeaders(),
    });
    expect(response.json()).toMatchObject({
      mode: "community",
      result: { tier: null, reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING" },
      configVersion: "launchMoonCatV1",
      effectiveAt: createdAt,
    });
  });

  it("refuses every Launch Intent with 503 and never touches the repository", async () => {
    const { app, repository } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: {
        walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
        roundId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        payAmount: "100",
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
    });
    expect(calls(repository, "getLaunch")).not.toHaveBeenCalled();
    const numberAmount = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: {
        walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
        roundId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        payAmount: 100,
      },
    });
    expect(numberAmount.statusCode).toBe(400);
  });

  it("lists milestones for a visible project and publishes only provable economy counts", async () => {
    const { app } = await createApp(
      repositoryFake({
        listMilestones: vi.fn(() =>
          Promise.resolve([
            {
              venueMilestoneId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
              projectId,
              venue: "lbank" as const,
              marketType: "spot" as const,
              state: "APPLIED" as const,
              evidenceDigest: null,
              evidenceRecordedAt: null,
              evidenceObservedAt: null,
              reviewer: null,
              version: 2,
              updatedAt: createdAt,
            },
          ]),
        ),
      }),
    );
    const milestones = await app.inject({
      method: "GET",
      url: `/v2/launch/projects/${projectId}/milestones`,
      headers: s7CommonHeaders(),
    });
    expect(milestones.statusCode).toBe(200);
    // The stored row first, then an implicit PREPARING row for each of the
    // other four 03 §8.4 tracks (nothing is written for them).
    expect(milestones.json()).toMatchObject({
      projectId,
      items: [
        {
          venueMilestoneId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
          venue: "lbank",
          marketType: "spot",
          state: "APPLIED",
          evidence: { digest: null, recordedAt: null, observedAt: null },
          version: 2,
        },
        {
          venueMilestoneId: null,
          venue: "binance",
          marketType: "alpha",
          state: "PREPARING",
          evidence: {
            digest: null,
            recordedAt: null,
            observedAt: null,
            reviewer: null,
          },
          version: 0,
          updatedAt: null,
        },
        { venue: "binance", marketType: "perpetual", state: "PREPARING" },
        { venue: "binance", marketType: "spot", state: "PREPARING" },
        { venue: "bithumb", marketType: "spot", state: "PREPARING" },
      ],
    });
    const economy = await app.inject({
      method: "GET",
      url: "/v2/launch/economy",
      headers: s7CommonHeaders(),
    });
    expect(economy.statusCode).toBe(200);
    expect(economy.json()).toEqual({
      projects: {
        draft: 1,
        submitted: 0,
        in_review: 0,
        returned: 0,
        approved: 1,
        rejected: 0,
      },
      launches: { unscheduled: 1, scheduled: 0, live: 0, ended: 0 },
      confirmedRoundCount: 0,
      totalSupply: {
        status: "unavailable",
        reasonCode: "LAUNCH_ECONOMY_CONTRACT_PENDING",
      },
      distributed: {
        status: "unavailable",
        reasonCode: "LAUNCH_ECONOMY_CONTRACT_PENDING",
      },
      ecosystemTax: {
        status: "unavailable",
        reasonCode: "LAUNCH_ECONOMY_CONTRACT_PENDING",
      },
      source: "loop_db",
      observedAt: createdAt,
      contractVersion: "2.0",
    });
  });

  it("maps a missing project to NOT_FOUND and rejects a read with an Idempotency-Key", async () => {
    const { app } = await createApp(
      repositoryFake({
        getProject: vi.fn(() => Promise.reject(new LaunchNotFoundError())),
      }),
    );
    const notFound = await app.inject({
      method: "GET",
      url: `/v2/launch/projects/${projectId}`,
      headers: s7CommonHeaders(),
    });
    expect(notFound.statusCode).toBe(404);
    const withKey = await app.inject({
      method: "GET",
      url: "/v2/launch/overview",
      headers: s7CommandHeaders(),
    });
    expect(withKey.statusCode).toBe(400);
  });
});
