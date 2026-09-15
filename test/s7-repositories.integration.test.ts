import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresReferralRepository } from "../src/database/referral-repository.js";
import {
  launchCommandDigest,
  launchProjectDigestParts,
  venueEvidenceDigest,
  type LaunchProjectValues,
} from "../src/features/launch/launch-contract.js";
import {
  LaunchDataStaleError,
  LaunchIdempotencyConflictError,
  LaunchMilestoneTransitionError,
  LaunchNotFoundError,
  LaunchVersionConflictError,
  type LaunchRepository,
} from "../src/features/launch/launch-repository.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  MiningCommunityAssetNotBoundError,
  MiningCommunityNotFoundError,
  MiningCommunityWeightConflictError,
  MiningFormulaExistsError,
  MiningFormulaNotFoundError,
  MiningFormulaStateError,
  MiningWeightOutOfRangeError,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";
import { generateInviteCode } from "../src/features/referral/invite-code.js";
import {
  materializeReferralEdges,
  referralCommandDigest,
  referralMaximumDepth,
} from "../src/features/referral/referral-contract.js";
import {
  ReferralAlreadyBoundError,
  ReferralCodeTakenError,
  type ReferralRepository,
} from "../src/features/referral/referral-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Client, Pool } = pg;

const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(targetDatabaseUrl: string): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => undefined,
  });
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  const admin = new Client({
    connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

const projectValues: LaunchProjectValues = Object.freeze({
  name: "MoonCat",
  ticker: "MCAT",
  narrative: "A curated meme with a story.",
  officialLinks: Object.freeze({
    website: "https://mooncat.example",
    x: null,
    telegram: null,
    discord: null,
  }),
});

describe("PostgreSQL S7 repositories (launch, mining, referral)", () => {
  const databaseName = `loop_s7_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let launch: LaunchRepository;
  let mining: MiningRepository;
  let referral: ReferralRepository;

  async function createUser(
    activated: boolean,
    withWallet = false,
    activatedDaysAgo = 0,
  ): Promise<string> {
    const inserted = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:${randomUUID()}`],
    });
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) {
      throw new Error("user insert failed");
    }
    if (activated) {
      await pool.query({
        text: `
          insert into public.user_profiles (
            owner_user_id, alias, profile_status, activated_at, created_at, updated_at
          )
          values (
            $1, $2, 'active',
            now() - make_interval(days => $3),
            now() - make_interval(days => $3),
            now() - make_interval(days => $3)
          )
        `,
        values: [userId, `alias_${userId.slice(0, 8)}`, activatedDaysAgo],
      });
    }
    if (withWallet) {
      await pool.query({
        text: `
          insert into public.account_wallets (owner_user_id, address, kind, is_active)
          values ($1, $2, 'external', true)
        `,
        values: [
          userId,
          `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
        ],
      });
    }
    return userId;
  }

  beforeAll(async () => {
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
    } finally {
      await admin.end();
    }
    temporaryDatabaseUrl = databaseConnectionUrl(databaseUrl, databaseName);
    try {
      await migrate(temporaryDatabaseUrl);
    } catch (error) {
      await dropTemporaryDatabase(databaseName);
      throw error;
    }
    pool = new Pool({ connectionString: temporaryDatabaseUrl });
    launch = createPostgresLaunchRepository(pool);
    mining = createPostgresMiningRepository(pool);
    referral = createPostgresReferralRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  describe("launch catalog", () => {
    it("walks draft → replace (CAS) → submit → approve and creates the catalog launch with every axis unavailable", async () => {
      const owner = await createUser(true);
      const key = randomUUID();
      const digest = launchCommandDigest(
        "createProject",
        launchProjectDigestParts(projectValues),
      );
      const created = await launch.createProject({
        ownerUserId: owner,
        idempotencyKey: key,
        requestSha256: digest,
        requestId: randomUUID(),
        values: projectValues,
      });
      expect(created).toMatchObject({
        reviewStatus: "draft",
        kybStatus: "unavailable",
        version: 1,
        materialVersion: 1,
        launchId: null,
      });
      // Same key + same digest replays; same key + other digest conflicts.
      const replay = await launch.createProject({
        ownerUserId: owner,
        idempotencyKey: key,
        requestSha256: digest,
        requestId: randomUUID(),
        values: projectValues,
      });
      expect(replay.projectId).toBe(created.projectId);
      await expect(
        launch.createProject({
          ownerUserId: owner,
          idempotencyKey: key,
          requestSha256: launchCommandDigest("createProject", ["other"]),
          requestId: randomUUID(),
          values: projectValues,
        }),
      ).rejects.toBeInstanceOf(LaunchIdempotencyConflictError);

      const replaced = await launch.replaceProject({
        ownerUserId: owner,
        projectId: created.projectId,
        expectedVersion: 1,
        values: { ...projectValues, narrative: null },
        requestId: randomUUID(),
      });
      expect(replaced).toMatchObject({
        version: 2,
        materialVersion: 2,
        narrative: null,
      });
      await expect(
        launch.replaceProject({
          ownerUserId: owner,
          projectId: created.projectId,
          expectedVersion: 1,
          values: projectValues,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchVersionConflictError);
      await expect(
        launch.replaceProject({
          ownerUserId: await createUser(true),
          projectId: created.projectId,
          expectedVersion: 2,
          values: projectValues,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchNotFoundError);

      const submitKey = randomUUID();
      const submitted = await launch.submitProject({
        ownerUserId: owner,
        projectId: created.projectId,
        idempotencyKey: submitKey,
        requestSha256: launchCommandDigest("submitProject", [
          created.projectId,
        ]),
        requestId: randomUUID(),
      });
      expect(submitted.reviewStatus).toBe("submitted");
      expect(submitted.submittedAt).not.toBeNull();
      await expect(
        launch.replaceProject({
          ownerUserId: owner,
          projectId: created.projectId,
          expectedVersion: submitted.version,
          values: projectValues,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchDataStaleError);
      await expect(
        launch.submitProject({
          ownerUserId: owner,
          projectId: created.projectId,
          idempotencyKey: randomUUID(),
          requestSha256: launchCommandDigest("submitProject", [
            created.projectId,
          ]),
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchDataStaleError);

      const returned = await launch.reviewProject({
        projectId: created.projectId,
        decision: "return",
        reasonCode: "needs_more_material",
        requestId: randomUUID(),
      });
      expect(returned.project.reviewStatus).toBe("returned");
      expect(returned.launch).toBeNull();
      const resubmitted = await launch.submitProject({
        ownerUserId: owner,
        projectId: created.projectId,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("submitProject", [
          created.projectId,
        ]),
        requestId: randomUUID(),
      });
      expect(resubmitted.reviewStatus).toBe("submitted");
      const approved = await launch.reviewProject({
        projectId: created.projectId,
        decision: "approve",
        reasonCode: "operator_manual_review",
        requestId: randomUUID(),
      });
      expect(approved.project.reviewStatus).toBe("approved");
      expect(approved.launch).toMatchObject({
        projectId: created.projectId,
        chainId: "eip155:56",
        contractAddress: null,
        configDigest: null,
        scheduleStatus: "unscheduled",
      });
      await expect(
        launch.reviewProject({
          projectId: created.projectId,
          decision: "approve",
          reasonCode: "twice",
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchDataStaleError);

      const catalog = await launch.listLaunches();
      expect(
        catalog.some(
          (row) => row.launch.launchId === approved.launch?.launchId,
        ),
      ).toBe(true);
      const detail = await launch.getLaunch(approved.launch?.launchId ?? "");
      expect(detail?.project.reviewStatus).toBe("approved");
      expect(detail?.configs).toEqual([]);
      expect(detail?.rounds).toEqual([]);

      const audit = await pool.query<{
        event_type: string;
        actor_type: string;
      }>({
        text: `
          select event_type, actor_type
          from public.launch_review_events
          where project_id = $1
          order by occurred_at asc, event_id asc
        `,
        values: [created.projectId],
      });
      expect(audit.rows.map((row) => row.event_type)).toEqual([
        "project_created",
        "project_updated",
        "project_submitted",
        "project_returned",
        "project_submitted",
        "project_approved",
      ]);
      expect(audit.rows.map((row) => row.actor_type)).toContain("operator");
      await expect(
        pool.query({
          text: `delete from public.launch_review_events where project_id = $1`,
          values: [created.projectId],
        }),
      ).rejects.toThrow(/append-only/);

      const counts = await launch.getEconomyCounts();
      expect(counts.projectsByStatus.approved).toBeGreaterThanOrEqual(1);
      expect(
        counts.launchesByScheduleStatus.unscheduled,
      ).toBeGreaterThanOrEqual(1);
      expect(counts.confirmedRoundCount).toBe(0);

      const listed = await launch.listProjects({
        ownerUserId: owner,
        status: "approved",
        limit: 10,
        after: null,
      });
      expect(listed.map((row) => row.projectId)).toEqual([created.projectId]);
    });

    it("refuses a round whose config version has no launch_configs row", async () => {
      const owner = await createUser(true);
      const project = await launch.createProject({
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", ["roundfk"]),
        requestId: randomUUID(),
        values: { ...projectValues, ticker: "RNDF" },
      });
      await launch.submitProject({
        ownerUserId: owner,
        projectId: project.projectId,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("submitProject", [
          project.projectId,
        ]),
        requestId: randomUUID(),
      });
      const approved = await launch.reviewProject({
        projectId: project.projectId,
        decision: "approve",
        reasonCode: "operator_manual_review",
        requestId: randomUUID(),
      });
      const launchId = approved.launch?.launchId ?? "";
      await expect(
        pool.query({
          text: `insert into public.launch_rounds (launch_id, round_index, config_version) values ($1, 1, 'launchRndfV1')`,
          values: [launchId],
        }),
      ).rejects.toThrow(/launch_rounds_config_fk/);
      await pool.query({
        text: `insert into public.launch_configs (launch_id, config_version) values ($1, 'launchRndfV1')`,
        values: [launchId],
      });
      await pool.query({
        text: `insert into public.launch_rounds (launch_id, round_index, config_version) values ($1, 1, 'launchRndfV1')`,
        values: [launchId],
      });
      const detail = await launch.getLaunch(launchId);
      expect(detail?.rounds.map((round) => round.configVersion)).toEqual([
        "launchRndfV1",
      ]);
      expect(detail?.configs[0]?.status).toBe("pending_confirmation");
    });

    it("stamps an approved launch with the configured launch chain slot (Decision 0038)", async () => {
      const testnetRepository = createPostgresLaunchRepository(pool, {
        launchChainId: "eip155:97",
      });
      const owner = await createUser(true);
      const created = await testnetRepository.createProject({
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", ["testnet"]),
        requestId: randomUUID(),
        values: { ...projectValues, ticker: "TNET" },
      });
      await testnetRepository.submitProject({
        ownerUserId: owner,
        projectId: created.projectId,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("submitProject", [
          created.projectId,
        ]),
        requestId: randomUUID(),
      });
      const approved = await testnetRepository.reviewProject({
        projectId: created.projectId,
        decision: "approve",
        reasonCode: "operator_manual_review",
        requestId: randomUUID(),
      });
      expect(approved.launch).toMatchObject({
        projectId: created.projectId,
        chainId: "eip155:97",
        contractAddress: null,
        scheduleStatus: "unscheduled",
      });
      // The stored chain, not the reading repository's slot, is what a read
      // publishes: the default (mainnet) repository still reports 97.
      const detail = await launch.getLaunch(approved.launch?.launchId ?? "");
      expect(detail?.launch.chainId).toBe("eip155:97");
      const catalog = await launch.listLaunches();
      expect(
        catalog.find((row) => row.launch.launchId === approved.launch?.launchId)
          ?.launch.chainId,
      ).toBe("eip155:97");
      // A chain outside the seeded slots is refused by the foreign key.
      const other = await testnetRepository.createProject({
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", ["other-chain"]),
        requestId: randomUUID(),
        values: { ...projectValues, ticker: "OTHR" },
      });
      await expect(
        pool.query({
          text: `
            insert into public.launches (launch_id, project_id, chain_id)
            values ($1, $2, 'eip155:1')
          `,
          values: [randomUUID(), other.projectId],
        }),
      ).rejects.toThrow(/foreign key/);
    });

    it("refuses a non-null on-chain axis at the schema", async () => {
      const owner = await createUser(true);
      const project = await launch.createProject({
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", ["axis"]),
        requestId: randomUUID(),
        values: { ...projectValues, ticker: "AXIS" },
      });
      await expect(
        pool.query({
          text: `
            insert into public.launches (launch_id, project_id, sale_state)
            values ($1, $2, 'ACTIVE')
          `,
          values: [randomUUID(), project.projectId],
        }),
      ).rejects.toThrow(/launches_axes_unavailable_check/);
    });

    it("records venue milestones through the state machine with evidence digests", async () => {
      const owner = await createUser(true);
      const project = await launch.createProject({
        ownerUserId: owner,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", ["milestone"]),
        requestId: randomUUID(),
        values: { ...projectValues, ticker: "MILE" },
      });
      const applied = await launch.recordMilestone({
        projectId: project.projectId,
        venue: "lbank",
        marketType: "spot",
        state: "APPLIED",
        evidenceDigest: null,
        evidenceObservedAt: null,
        reviewer: null,
        requestId: randomUUID(),
      });
      expect(applied).toMatchObject({
        state: "APPLIED",
        evidenceDigest: null,
        version: 1,
      });
      await expect(
        launch.recordMilestone({
          projectId: project.projectId,
          venue: "lbank",
          marketType: "spot",
          state: "LISTED",
          evidenceDigest: null,
          evidenceObservedAt: null,
          reviewer: null,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(LaunchMilestoneTransitionError);
      const pending = await launch.recordMilestone({
        projectId: project.projectId,
        venue: "lbank",
        marketType: "spot",
        state: "EVIDENCE_PENDING",
        evidenceDigest: null,
        evidenceObservedAt: null,
        reviewer: null,
        requestId: randomUUID(),
      });
      expect(pending.version).toBe(2);
      const digest = venueEvidenceDigest(
        "https://lbank.example/announcement/1",
      );
      const listed = await launch.recordMilestone({
        projectId: project.projectId,
        venue: "lbank",
        marketType: "spot",
        state: "LISTED",
        evidenceDigest: digest,
        evidenceObservedAt: "2026-09-01T08:00:00.000Z",
        reviewer: "ops.alice",
        requestId: randomUUID(),
      });
      expect(listed).toMatchObject({
        state: "LISTED",
        evidenceDigest: digest,
        evidenceObservedAt: "2026-09-01T08:00:00.000Z",
        reviewer: "ops.alice",
      });
      expect(listed.evidenceRecordedAt).not.toBeNull();
      // observedAt without evidence is refused at the schema.
      await expect(
        pool.query({
          text: `
            insert into public.venue_milestones (project_id, venue, market_type, state, evidence_observed_at)
            values ($1, 'bithumb', 'spot', 'APPLIED', now())
          `,
          values: [project.projectId],
        }),
      ).rejects.toThrow(/venue_milestones_observed_check/);
      // Binance Alpha is its own machine; it never moves the spot row.
      const alpha = await launch.recordMilestone({
        projectId: project.projectId,
        venue: "binance",
        marketType: "alpha",
        state: "APPLIED",
        evidenceDigest: null,
        evidenceObservedAt: null,
        reviewer: null,
        requestId: randomUUID(),
      });
      expect(alpha.state).toBe("APPLIED");
      const milestones = await launch.listMilestones(project.projectId);
      expect(milestones).toHaveLength(2);
      expect(milestones.find((row) => row.venue === "lbank")?.state).toBe(
        "LISTED",
      );
    });
  });

  describe("mining skeleton", () => {
    it("seeds the draft formula as pending_approval and has no approved version", async () => {
      expect(await mining.getApprovedFormula()).toBeNull();
      const versions = await mining.listFormulaVersions();
      expect(versions.map((row) => row.configVersion)).toContain(
        "miningFormulaV1-draft",
      );
      const draft = versions.find(
        (row) => row.configVersion === "miningFormulaV1-draft",
      );
      expect(draft?.status).toBe("pending_approval");
      expect(draft?.formula.assetWeights).toEqual({});
      expect(draft?.weightRange.loop.status).toBe("pending_approval");
      expect(draft?.priceGuardRules.map((rule) => rule.ruleKey)).toEqual([
        "mining.rules.priceGuard.twap",
        "mining.rules.priceGuard.multiPeriodMultiSource",
        "mining.rules.priceGuard.liquidityCap",
      ]);
      expect(await mining.getLatestSnapshot()).toBeNull();
    });

    it("reads the latest balance per wallet and asset as snapshot input", async () => {
      const owner = await createUser(true, true);
      const wallet = await pool.query<{ wallet_id: string }>({
        text: `select wallet_id from public.account_wallets where owner_user_id = $1`,
        values: [owner],
      });
      const walletId = wallet.rows[0]?.wallet_id ?? "";
      for (const [block, value] of [
        ["100", "1000000000000000000"],
        ["120", "2000000000000000000"],
      ]) {
        await pool.query({
          text: `
            insert into public.wallet_balance_snapshots (wallet_id, asset_id, block_number, block_hash, raw_value)
            values ($1, 'eip155:56:native', $2, $3, $4)
          `,
          values: [walletId, block, `0x${"c".repeat(64)}`, value],
        });
      }
      const inputs = await mining.listBalanceInputs();
      const mine = inputs.filter((row) => row.ownerUserId === owner);
      expect(mine).toEqual([
        {
          ownerUserId: owner,
          walletId,
          assetId: "eip155:56:native",
          decimals: 18,
          rawValue: "2000000000000000000",
          blockNumber: "120",
          blockHash: `0x${"c".repeat(64)}`,
        },
      ]);
    });

    it("writes a snapshot with per-account powers only under an approved formula, and approve is single and one-way", async () => {
      // A TEST-ONLY version; the seeded draft is never approved by this suite.
      await pool.query({
        text: `
          insert into public.mining_formula_versions (config_version, formula, weight_range, price_guard_rules)
          values ('miningFormulaTestOnly', $1::jsonb, $2::jsonb, '[]'::jsonb)
        `,
        values: [
          JSON.stringify({
            kind: "holding_times_reference_price_times_weight",
            expressionKey: "k",
            dailyOutputKey: "k",
            assetWeights: { "eip155:56:native": "1" },
            referralBoost: { status: "pending_approval" },
          }),
          JSON.stringify({
            loop: { status: "approved", descriptionKey: "k" },
            community: { status: "pending_approval", descriptionKey: "k" },
            reviewFactorKeys: [],
          }),
        ],
      });
      await expect(
        mining.writeSnapshot({
          snapshotId: randomUUID(),
          blockNumber: "120",
          blockHash: `0x${"c".repeat(64)}`,
          formulaVersion: "miningFormulaNope",
          priceVersion: "dexscreener:2026-09-08T00:00:00.000Z",
          totalPower: "0",
          powers: [],
        }),
      ).rejects.toThrow();
      const approved = await mining.approveFormula({
        configVersion: "miningFormulaTestOnly",
        requestId: randomUUID(),
      });
      expect(approved.status).toBe("approved");
      expect(approved.effectiveAt).not.toBeNull();
      expect((await mining.getApprovedFormula())?.configVersion).toBe(
        "miningFormulaTestOnly",
      );
      await expect(
        mining.approveFormula({
          configVersion: "miningFormulaTestOnly",
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(MiningFormulaStateError);
      const owner = await createUser(true, true);
      const snapshotId = randomUUID();
      const written = await mining.writeSnapshot({
        snapshotId,
        blockNumber: "120",
        blockHash: `0x${"c".repeat(64)}`,
        formulaVersion: "miningFormulaTestOnly",
        priceVersion: "dexscreener:2026-09-08T00:00:00.000Z",
        totalPower: "2.5",
        powers: [
          {
            ownerUserId: owner,
            assetId: "eip155:56:native",
            holding: "2",
            referencePriceUsd: "1.25",
            weight: "1",
            power: "2.5",
            blockNumber: "120",
          },
        ],
      });
      expect(written).toMatchObject({
        snapshotId,
        accountCount: 1,
        totalPower: "2.5",
      });
      expect((await mining.getLatestSnapshot())?.snapshotId).toBe(snapshotId);
      // Community weights are read per formula version: a weight reviewed
      // under a retired version never enters a snapshot of the current one.
      await pool.query({
        text: `
          insert into public.mining_formula_versions (config_version, formula, weight_range, price_guard_rules, status)
          values ('miningFormulaRetiredTestOnly', $1::jsonb, $2::jsonb, '[]'::jsonb, 'retired')
        `,
        values: [
          JSON.stringify({
            kind: "holding_times_reference_price_times_weight",
            expressionKey: "k",
            dailyOutputKey: "k",
            assetWeights: {},
            referralBoost: { status: "pending_approval" },
          }),
          JSON.stringify({
            loop: { status: "approved", descriptionKey: "k" },
            community: { status: "pending_approval", descriptionKey: "k" },
            reviewFactorKeys: [],
          }),
        ],
      });
      const communities = await pool.query<{ community_id: string }>({
        text: `
          insert into public.communities (name, slug, bound_asset_key, created_by_user_id)
          values ('Weight Current', 'weight-current', 'eip155:56:0x00000000000000000000000000000000000000aa', $1),
                 ('Weight Retired', 'weight-retired', 'eip155:56:0x00000000000000000000000000000000000000bb', $1)
          returning community_id
        `,
        values: [owner],
      });
      const [current, retired] = communities.rows.map(
        (row) => row.community_id,
      );
      await pool.query({
        text: `
          insert into public.community_mining_weights (community_id, status, weight, config_version, reviewed_at)
          values ($1, 'approved', '0.5', 'miningFormulaTestOnly', now()),
                 ($2, 'approved', '0.9', 'miningFormulaRetiredTestOnly', now())
        `,
        values: [current, retired],
      });
      // Decision 0043: every bound community is listed; a weight reviewed
      // under another version reads as pending_review with no value.
      const byCommunity = (
        rows: readonly {
          communityId: string;
          weight: string | null;
          status: string;
        }[],
      ) =>
        Object.fromEntries(
          rows
            .filter(
              (row) =>
                row.communityId === current || row.communityId === retired,
            )
            .map((row) => [row.communityId, [row.status, row.weight]]),
        );
      expect(
        byCommunity(
          await mining.listCommunityWeightInputs("miningFormulaTestOnly"),
        ),
      ).toEqual({
        [current ?? ""]: ["approved", "0.5"],
        [retired ?? ""]: ["pending_review", null],
      });
      expect(
        byCommunity(
          await mining.listCommunityWeightInputs(
            "miningFormulaRetiredTestOnly",
          ),
        ),
      ).toEqual({
        [current ?? ""]: ["pending_review", null],
        [retired ?? ""]: ["approved", "0.9"],
      });
      expect(
        byCommunity(
          await mining.listCommunityWeightInputs("miningFormulaV1-draft"),
        ),
      ).toEqual({
        [current ?? ""]: ["pending_review", null],
        [retired ?? ""]: ["pending_review", null],
      });
      // Retire it again so the seeded draft remains the only visible version.
      await pool.query({
        text: `update public.mining_formula_versions set status = 'retired' where config_version = 'miningFormulaTestOnly'`,
      });
      expect(await mining.getApprovedFormula()).toBeNull();
    });
  });

  describe("development baseline (Decision 0043)", () => {
    const cakeAsset = "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
    const nativeAsset = "eip155:56:native";
    const hash = `0x${"d".repeat(64)}`;
    let baselineVersion = "";
    let boundCommunity = "";
    let secondBoundCommunity = "";
    let unboundCommunity = "";
    let alice = "";
    let bob = "";
    let carol = "";

    async function profileOf(userId: string): Promise<string> {
      const result = await pool.query<{ public_profile_id: string }>({
        text: `select public_profile_id from public.user_profiles where owner_user_id = $1`,
        values: [userId],
      });
      return result.rows[0]?.public_profile_id ?? "";
    }

    it("creates the baseline version as pending_approval from the registry assets and refuses a duplicate", async () => {
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          )
          values (
            $1, 'eip155:56', '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', 'Cake',
            'PancakeSwap Token', 18, 'pending', 'chain_call', 122037728, now()
          )
          on conflict (asset_id) do nothing
        `,
        values: [cakeAsset],
      });
      const documents = buildMiningDevBaselineDocuments([
        nativeAsset,
        cakeAsset,
      ]);
      baselineVersion = documents.configVersion;
      const created = await mining.createFormulaVersion({
        configVersion: documents.configVersion,
        formula: documents.formula,
        weightRange: documents.weightRange,
        priceGuardRules: documents.priceGuardRules,
        requestId: randomUUID(),
      });
      expect(created).toMatchObject({
        configVersion: "miningFormula-devBaseline-2026-09-15",
        status: "pending_approval",
        effectiveAt: null,
        formula: {
          scope: "development_baseline",
          assetWeights: { [cakeAsset]: "1", [nativeAsset]: "1" },
          dailyOutput: { status: "development_placeholder", budget: "1000000" },
        },
        weightRange: { community: { range: { min: "0.5", max: "2" } } },
      });
      await expect(
        mining.createFormulaVersion({
          configVersion: documents.configVersion,
          formula: documents.formula,
          weightRange: documents.weightRange,
          priceGuardRules: documents.priceGuardRules,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(MiningFormulaExistsError);
      expect(await mining.getApprovedFormula()).toBeNull();
    });

    it("records a community weight only inside the version's range, on a bound asset, once per asset", async () => {
      alice = await createUser(true, true);
      bob = await createUser(true, true);
      carol = await createUser(true, false);
      const communities = await pool.query<{ community_id: string }>({
        text: `
          insert into public.communities (name, slug, bound_asset_key, created_by_user_id)
          values ('Cake Holders', 'cake-holders', $2, $1),
                 ('Cake Rivals', 'cake-rivals', $2, $1),
                 ('No Token', 'no-token', null, $1)
          returning community_id
        `,
        values: [alice, cakeAsset],
      });
      [boundCommunity = "", secondBoundCommunity = "", unboundCommunity = ""] =
        communities.rows.map((row) => row.community_id);
      const attempt = (
        communityId: string,
        weight: string,
        configVersion = baselineVersion,
      ) =>
        mining.setCommunityWeight({
          communityId,
          weight,
          configVersion,
          requestId: randomUUID(),
        });
      await expect(attempt(unboundCommunity, "1")).rejects.toBeInstanceOf(
        MiningCommunityAssetNotBoundError,
      );
      await expect(attempt(boundCommunity, "0.499")).rejects.toBeInstanceOf(
        MiningWeightOutOfRangeError,
      );
      await expect(attempt(boundCommunity, "2.001")).rejects.toBeInstanceOf(
        MiningWeightOutOfRangeError,
      );
      // The product draft pins no range, so nothing can be reviewed under it.
      await expect(
        attempt(boundCommunity, "1", "miningFormulaV1-draft"),
      ).rejects.toBeInstanceOf(MiningWeightOutOfRangeError);
      await expect(
        attempt(boundCommunity, "1", "miningFormulaNope"),
      ).rejects.toBeInstanceOf(MiningFormulaNotFoundError);
      await expect(
        attempt(boundCommunity, "1", "miningFormulaRetiredTestOnly"),
      ).rejects.toBeInstanceOf(MiningFormulaStateError);
      await expect(attempt(randomUUID(), "1")).rejects.toBeInstanceOf(
        MiningCommunityNotFoundError,
      );
      const stored = await attempt(boundCommunity, "1.5");
      expect(stored).toMatchObject({
        communityId: boundCommunity,
        communityName: "Cake Holders",
        boundAssetId: cakeAsset,
        status: "approved",
        weight: "1.5",
        configVersion: baselineVersion,
      });
      expect(stored.reviewedAt).not.toBeNull();
      // Boundaries are inclusive and a re-review replaces the value.
      expect((await attempt(boundCommunity, "2")).weight).toBe("2");
      expect((await attempt(boundCommunity, "0.5")).weight).toBe("0.5");
      await expect(attempt(secondBoundCommunity, "1")).rejects.toBeInstanceOf(
        MiningCommunityWeightConflictError,
      );
      const inputs = await mining.listCommunityWeightInputs(baselineVersion);
      expect(inputs.find((row) => row.communityId === boundCommunity)).toEqual({
        communityId: boundCommunity,
        assetId: cakeAsset,
        weight: "0.5",
        status: "approved",
      });
      expect(
        inputs.find((row) => row.communityId === secondBoundCommunity),
      ).toEqual({
        communityId: secondBoundCommunity,
        assetId: cakeAsset,
        weight: null,
        status: "pending_review",
      });
      expect(inputs.some((row) => row.communityId === unboundCommunity)).toBe(
        false,
      );
    });

    it("aggregates standings, rankings, and member powers from stored snapshot rows with exact arithmetic and the privacy rule", async () => {
      const approved = await mining.approveFormula({
        configVersion: baselineVersion,
        requestId: randomUUID(),
      });
      expect(approved.status).toBe("approved");
      await pool.query({
        text: `
          insert into public.community_memberships (community_id, owner_user_id, role, status)
          values ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active'), ($1, $4, 'member', 'banned')
        `,
        values: [boundCommunity, alice, bob, carol],
      });
      await pool.query({
        text: `
          insert into public.privacy_preferences_v2 (owner_user_id, discoverable, anonymous_mode, mining_power_visibility)
          values ($1, true, false, 'everyone'), ($2, true, true, 'self')
        `,
        values: [alice, bob],
      });
      const snapshotId = randomUUID();
      await mining.writeSnapshot({
        snapshotId,
        blockNumber: "122037728",
        blockHash: hash,
        formulaVersion: baselineVersion,
        priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
        // 1081.17 + 57.5 + 0.0000000000000001 + 34.5 + 0
        totalPower: "1173.1700000000000001",
        powers: [
          // alice: 1.5 BNB × 720.78 × 1 = 1081.17
          {
            ownerUserId: alice,
            assetId: nativeAsset,
            holding: "1.5",
            referencePriceUsd: "720.78",
            weight: "1",
            power: "1081.17",
            blockNumber: "122037728",
          },
          // alice: 50 Cake × 2.3 × (1 × 0.5) = 57.5
          {
            ownerUserId: alice,
            assetId: cakeAsset,
            holding: "50",
            referencePriceUsd: "2.3",
            weight: "0.5",
            power: "57.5",
            blockNumber: "122037728",
          },
          // bob: dust BNB
          {
            ownerUserId: bob,
            assetId: nativeAsset,
            holding: "0.0000000000000001",
            referencePriceUsd: "1",
            weight: "1",
            power: "0.0000000000000001",
            blockNumber: "122037728",
          },
          // bob: 30 Cake × 2.3 × 0.5 = 34.5
          {
            ownerUserId: bob,
            assetId: cakeAsset,
            holding: "30",
            referencePriceUsd: "2.3",
            weight: "0.5",
            power: "34.5",
            blockNumber: "122037728",
          },
          // carol: zero (banned in the community, still an account)
          {
            ownerUserId: carol,
            assetId: nativeAsset,
            holding: "0",
            referencePriceUsd: "720.78",
            weight: "1",
            power: "0",
            blockNumber: "122037728",
          },
        ],
      });
      expect(
        await mining.getAccountStanding({ snapshotId, ownerUserId: alice }),
      ).toEqual({
        totalPower: "1138.67",
        position: 1,
        participantCount: 2,
      });
      expect(
        await mining.getAccountStanding({ snapshotId, ownerUserId: bob }),
      ).toEqual({
        totalPower: "34.5000000000000001",
        position: 2,
        participantCount: 2,
      });
      expect(
        await mining.getAccountStanding({ snapshotId, ownerUserId: carol }),
      ).toEqual({
        totalPower: "0",
        position: null,
        participantCount: 2,
      });
      expect(
        await mining.getAccountStanding({
          snapshotId,
          ownerUserId: randomUUID(),
        }),
      ).toBeNull();
      expect(
        await mining.listAccountPowers({ snapshotId, ownerUserId: alice }),
      ).toEqual([
        {
          ownerUserId: alice,
          assetId: cakeAsset,
          holding: "50",
          referencePriceUsd: "2.3",
          weight: "0.5",
          power: "57.5",
          blockNumber: "122037728",
        },
        {
          ownerUserId: alice,
          assetId: nativeAsset,
          holding: "1.5",
          referencePriceUsd: "720.78",
          weight: "1",
          power: "1081.17",
          blockNumber: "122037728",
        },
      ]);
      const ranking = await mining.listAccountRanking({
        snapshotId,
        limit: 10,
      });
      expect(ranking).toEqual([
        {
          ownerUserId: alice,
          totalPower: "1138.67",
          position: 1,
          publicProfileId: await profileOf(alice),
          alias: `alias_${alice.slice(0, 8)}`,
          discoverable: true,
          anonymousMode: false,
        },
        {
          ownerUserId: bob,
          totalPower: "34.5000000000000001",
          position: 2,
          publicProfileId: await profileOf(bob),
          alias: `alias_${bob.slice(0, 8)}`,
          discoverable: true,
          anonymousMode: true,
        },
      ]);
      // Community standing: only non-banned members, only the bound asset.
      // alice 57.5 + bob 34.5 = 92 (carol banned; BNB rows excluded).
      const standing = await mining.getCommunityStanding({
        snapshotId,
        configVersion: baselineVersion,
        communityId: boundCommunity,
      });
      expect(standing).toEqual({
        communityId: boundCommunity,
        communityName: "Cake Holders",
        boundAssetId: cakeAsset,
        weight: "0.5",
        power: "92",
        participantCount: 2,
        position: 1,
      });
      expect(
        await mining.getCommunityStanding({
          snapshotId,
          configVersion: baselineVersion,
          communityId: secondBoundCommunity,
        }),
      ).toBeNull();
      expect(
        await mining.getCommunityStanding({
          snapshotId,
          configVersion: "miningFormulaV1-draft",
          communityId: boundCommunity,
        }),
      ).toBeNull();
      expect(
        await mining.listCommunityRanking({
          snapshotId,
          configVersion: baselineVersion,
          limit: 10,
        }),
      ).toEqual([standing]);
      const memberPowers = await mining.listMemberPowers({
        snapshotId,
        publicProfileIds: [
          await profileOf(alice),
          await profileOf(bob),
          await profileOf(carol),
          randomUUID(),
        ],
      });
      expect(
        [...memberPowers]
          .map((row) => [row.ownerUserId, row.totalPower, row.visibleToOthers])
          .sort(),
      ).toEqual(
        [
          [alice, "1138.67", true],
          [bob, "34.5000000000000001", false],
          [carol, "0", false],
        ].sort(),
      );
      // Balance asset IDs come from the account's active wallets only.
      const wallet = await pool.query<{ wallet_id: string }>({
        text: `select wallet_id from public.account_wallets where owner_user_id = $1`,
        values: [alice],
      });
      await pool.query({
        text: `
          insert into public.wallet_balance_snapshots (wallet_id, asset_id, block_number, block_hash, raw_value)
          values ($1, $2, 122037728, $3, 0)
        `,
        values: [wallet.rows[0]?.wallet_id, cakeAsset, hash],
      });
      expect(await mining.listAccountBalanceAssetIds(alice)).toEqual([
        cakeAsset,
      ]);
      expect(await mining.listAccountBalanceAssetIds(carol)).toEqual([]);
      // Retire the baseline so later suites see no approved version.
      await pool.query({
        text: `update public.mining_formula_versions set status = 'retired' where config_version = $1`,
        values: [baselineVersion],
      });
      expect(await mining.getApprovedFormula()).toBeNull();
    });
  });

  describe("referral graph", () => {
    async function claimFor(
      invitee: string,
      inviterCode: string,
      idempotencyKey = randomUUID(),
    ) {
      const inviter = await referral.findInviterByCode(inviterCode);
      if (inviter === null) {
        throw new Error("unknown code");
      }
      const state = await referral.getAccountState(invitee);
      const edges = materializeReferralEdges({
        inviteeUserId: invitee,
        inviterUserId: inviter,
        inviterAncestors: await referral.getAncestorChain(
          inviter,
          referralMaximumDepth,
        ),
      });
      return referral.claim({
        inviteeUserId: invitee,
        idempotencyKey,
        requestSha256: referralCommandDigest("claim", [inviterCode]),
        requestId: randomUUID(),
        edges,
        validationStatus: state.hasWallet ? "pending_mining" : "pending_wallet",
      });
    }

    async function codeFor(userId: string): Promise<string> {
      const issued = await referral.issueInviteCode({
        ownerUserId: userId,
        code: generateInviteCode(),
        requestId: randomUUID(),
      });
      return issued.code;
    }

    it("issues one code per account, keeps it unique, and reports activation and wallet state", async () => {
      const a = await createUser(true, true);
      const codeA = await codeFor(a);
      expect(codeA).toMatch(/^LOOP-[0-9A-HJKMNP-TV-Z]{5}$/);
      const again = await referral.issueInviteCode({
        ownerUserId: a,
        code: generateInviteCode(),
        requestId: randomUUID(),
      });
      expect(again.code).toBe(codeA);
      expect((await referral.getInviteCode(a))?.code).toBe(codeA);
      const b = await createUser(true);
      await expect(
        referral.issueInviteCode({
          ownerUserId: b,
          code: codeA,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ReferralCodeTakenError);
      expect(await referral.getAccountState(a)).toMatchObject({
        hasWallet: true,
      });
      expect((await referral.getAccountState(a)).activatedAt).not.toBeNull();
      const pending = await createUser(false);
      expect(await referral.getAccountState(pending)).toEqual({
        activatedAt: null,
        hasWallet: false,
      });
    });

    it("materialises a six-deep chain as at most five edges and counts by depth and status", async () => {
      const users: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        users.push(await createUser(true, index % 2 === 0));
      }
      const root = users[0] ?? "";
      let inviterCode = await codeFor(root);
      for (let index = 1; index < users.length; index += 1) {
        const invitee = users[index] ?? "";
        const edge = await claimFor(invitee, inviterCode);
        expect(edge.depth).toBe(1);
        inviterCode = await codeFor(invitee);
      }
      const last = users[6] ?? "";
      const chain = await referral.getAncestorChain(last, 10);
      expect(chain).toEqual([
        users[5],
        users[4],
        users[3],
        users[2],
        users[1],
        users[0],
      ]);
      const edges = await pool.query<{
        depth: number;
        inviter_user_id: string;
      }>({
        text: `select depth, inviter_user_id from public.referral_edges where invitee_user_id = $1 order by depth`,
        values: [last],
      });
      expect(edges.rows.map((row) => row.depth)).toEqual([1, 2, 3, 4, 5]);
      expect(edges.rows.map((row) => row.inviter_user_id)).not.toContain(root);
      const rootCounts = await referral.countInvitees(root);
      expect(rootCounts.reduce((sum, row) => sum + row.count, 0)).toBe(5);
      expect(rootCounts.map((row) => row.depth)).toEqual([1, 2, 3, 4, 5]);
      const statuses = new Set(rootCounts.map((row) => row.validationStatus));
      expect(
        statuses.has("pending_wallet") || statuses.has("pending_mining"),
      ).toBe(true);
    });

    it("binds once: a second claim is already-bound, a replayed key returns the original, and edges cannot be deleted", async () => {
      const inviter = await createUser(true);
      const other = await createUser(true);
      const invitee = await createUser(true);
      const key = randomUUID();
      const first = await claimFor(invitee, await codeFor(inviter), key);
      const replay = await claimFor(
        invitee,
        (await referral.getInviteCode(inviter))?.code ?? "",
        key,
      );
      expect(replay.referralEdgeId).toBe(first.referralEdgeId);
      await expect(
        claimFor(invitee, await codeFor(other)),
      ).rejects.toBeInstanceOf(ReferralAlreadyBoundError);
      await expect(
        pool.query({
          text: `delete from public.referral_edges where invitee_user_id = $1`,
          values: [invitee],
        }),
      ).rejects.toThrow(/append-only/);
      const events = await pool.query<{ event_type: string }>({
        text: `select event_type from public.referral_events where invitee_user_id = $1`,
        values: [invitee],
      });
      expect(events.rows.map((row) => row.event_type)).toEqual(
        ["invite_code_issued", "referral_claimed"].filter(
          (type) => type !== "invite_code_issued",
        ),
      );
      await referral.recordRejectedClaim({
        inviteeUserId: invitee,
        inviterUserId: other,
        reasonCode: "referral_cycle",
        requestId: randomUUID(),
      });
      const rejected = await pool.query<{ reason_code: string }>({
        text: `select reason_code from public.referral_events where invitee_user_id = $1 and event_type = 'referral_claim_rejected'`,
        values: [invitee],
      });
      expect(rejected.rows[0]?.reason_code).toBe("referral_cycle");
    });

    it("exposes the activation clock the 7-day window is evaluated against", async () => {
      // The activation guard trigger makes activated_at immutable, so the
      // clock is set at insert time (an operator cannot backdate it later).
      const user = await createUser(true, false, 8);
      const state = await referral.getAccountState(user);
      expect(Date.parse(state.activatedAt ?? "")).toBeLessThan(
        Date.now() - 7 * 86_400_000,
      );
    });
  });
});
