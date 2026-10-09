import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresAdminRepository } from "../src/database/admin-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMarketCategoryRepository } from "../src/database/market-category-repository.js";
import { createPostgresMemeRepository } from "../src/database/meme-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import type { AdminRepository } from "../src/features/admin/admin-repository.js";
import {
  createAdminService,
  type AdminService,
  type AdminWriteContext,
} from "../src/features/admin/admin-service.js";
import {
  createAdminSettingsReader,
  resolveIntelPromotions,
  type AdminSettingsReader,
} from "../src/features/admin/admin-settings-reader.js";
import { createCommunityReviewService } from "../src/features/community/community-review-service.js";
import { resolveMiningBaseline } from "../src/features/mining/mining-baseline.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import { createPublicProfileService } from "../src/features/profile/public-profile-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0102 against PostgreSQL: migration 000050, the append-only audit
 * log, settings compare-and-set with one audit row per write, the read
 * priority (database over constant / environment) as the `/v2` services
 * see it, community review notes, MEME `listing` filtering in every list
 * read, and formula approval switching the version in force.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const testnet = "eip155:97";
const curve = "0x00000000000000000000000000000000000000c1";
const sessionSecret = "s119-integration-session-secret-0123456789";

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

describe("Decision 0102 operator console on PostgreSQL", () => {
  const databaseName = `loop_s119_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let repository: AdminRepository;
  let reader: AdminSettingsReader;
  let service: AdminService;
  let ownerId: string;
  const context = (): AdminWriteContext => ({
    session: {
      sessionId: randomUUID(),
      actor: "operator",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    requestId: randomUUID(),
  });

  async function auditCount(): Promise<number> {
    const result = await pool.query<{ total: string }>(
      "select count(*)::text as total from public.admin_audit_log",
    );
    return Number(result.rows[0]?.total);
  }

  async function community(input: {
    readonly status: "pending" | "verified" | "rejected";
    readonly assetId?: string;
  }): Promise<string> {
    const slug = `c${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const created = await pool.query<{ community_id: string }>({
      text: `
        insert into public.communities (name, slug, created_by_user_id)
        values ($1, $1, $2) returning community_id
      `,
      values: [slug, ownerId],
    });
    const communityId = created.rows[0]?.community_id as string;
    await pool.query({
      text: `
        update public.communities
        set verification_status = $2,
            bound_asset_key = $3,
            application_submitted_at = now(),
            verified_at = case when $2 = 'verified' then now() else null end,
            reviewed_at = case when $2 = 'pending' then null else now() end
        where community_id = $1
      `,
      values: [communityId, input.status, input.assetId ?? null],
    });
    return communityId;
  }

  async function asset(address: string): Promise<string> {
    const assetId = `${testnet}:${address}`;
    await pool.query({
      text: `
        insert into public.assets (
          asset_id, chain_id, address, symbol, name, decimals, status,
          source_kind, source_block_number, source_verified_at
        ) values ($1, $2, $3, 'MEME', 'MEME Token', 18, 'pending',
          'chain_call', 1, clock_timestamp())
      `,
      values: [assetId, testnet, address],
    });
    return assetId;
  }

  async function memeToken(address: string, symbol: string): Promise<string> {
    const assetId = await asset(address);
    const memeTokenId = randomUUID();
    await pool.query({
      text: `
        insert into public.meme_tokens (
          meme_token_id, chain_id, contract_address, contract_version,
          creator_user_id, name, symbol, metadata_hash, token_address,
          asset_id, status, chain_created_at
        ) values ($1, $2, $3, '1.0.0', $4, $5, $5, $6, $7, $8, 'trading',
          clock_timestamp())
      `,
      values: [
        memeTokenId,
        testnet,
        curve,
        ownerId,
        symbol,
        `0x${"1".repeat(64)}`,
        address,
        assetId,
      ],
    });
    return memeTokenId;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    database = createPostgresDatabase(
      loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        DATABASE_URL: url,
      }),
      { error: () => undefined },
    );
    repository = createPostgresAdminRepository(pool);
    reader = createAdminSettingsReader({
      repository,
      logger: { warn: () => undefined },
    });
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s119:${randomUUID()}`,
    );
    ownerId = user.id;
    service = createAdminService({
      username: "operator",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$AAAA$AAAA",
      sessionSecret,
      repository,
      settingsReader: reader,
      environmentRecommendedCommunityIds: [],
      communityReview: createCommunityReviewService({
        repository: database.community!,
        notifications: database.notifications ?? null,
        push: null,
        logger: { warn: () => undefined },
      }),
      memePause: {
        status: "unavailable",
        reasonCode: "MEME_EXECUTOR_DISABLED",
      },
      production: false,
      logger: { warn: () => undefined },
    });
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("applies 000050 and keeps the audit log append-only", async () => {
    // Later migrations (000051+, Decision 0108) sit on top of 000050.
    const applied = await pool.query<{ name: string }>(
      "select name from public.pgmigrations where name = '000050_admin_console'",
    );
    expect(applied.rows[0]?.name).toBe("000050_admin_console");
    const row = await repository.appendAudit({
      actor: "operator",
      action: "session.login",
      targetType: "session",
      targetId: null,
      before: null,
      after: { ok: true },
      requestId: randomUUID(),
    });
    expect(row.seq).toBeGreaterThanOrEqual(1);
    for (const statement of [
      "update public.admin_audit_log set actor = 'x'",
      "delete from public.admin_audit_log",
      "truncate public.admin_audit_log",
    ]) {
      await expect(pool.query(statement)).rejects.toThrow(/append-only/u);
    }
    const listing = await pool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
       where table_name = 'meme_tokens' and column_name = 'listing'`,
    );
    expect(listing.rows[0]?.column_default).toContain("listed");
  });

  it("recommends the database list over the environment, with CAS and audit", async () => {
    const envCommunity = await community({ status: "verified" });
    const dbCommunity = await community({ status: "verified" });
    const pendingCommunity = await community({ status: "pending" });
    const profiles = createPublicProfileService({
      repository: database.publicProfiles!,
      walletReadService: null,
      assets: { getAsset: () => Promise.resolve(null) },
      cursorCodec: null,
      chainId: "eip155:56",
      usd1Address: null,
      recommendedCommunityIds: [envCommunity],
      recommendedCommunityIdsOverride: () => reader.recommendedCommunityIds(),
    });
    const principal = { userId: ownerId } as never;
    const ids = async () =>
      (await profiles.listRecommendedCommunities({ principal })).items.map(
        (item) => item.communityId,
      );
    expect(await ids()).toEqual([envCommunity]);

    await expect(
      service.putRecommendedCommunities(context(), {
        communityIds: [pendingCommunity],
        updatedAt: null,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "ADMIN_COMMUNITY_NOT_VERIFIED" },
    });
    const before = await auditCount();
    const saved = await service.putRecommendedCommunities(context(), {
      communityIds: [dbCommunity, envCommunity],
      updatedAt: null,
    });
    expect(saved["source"]).toBe("database");
    expect(await auditCount()).toBe(before + 1);
    expect(await ids()).toEqual([dbCommunity, envCommunity]);

    await expect(
      service.putRecommendedCommunities(context(), {
        communityIds: [dbCommunity],
        updatedAt: null,
      }),
    ).rejects.toMatchObject({ code: "ADMIN_CONFLICT" });
    const cleared = await service.putRecommendedCommunities(context(), {
      communityIds: null,
      updatedAt: saved["updatedAt"],
    });
    expect(cleared["source"]).toBe("environment");
    expect(await auditCount()).toBe(before + 2);
    expect(await ids()).toEqual([envCommunity]);
    const audit = await repository.listAudit({
      limit: 2,
      beforeSeq: null,
      actor: "operator",
      action: "settings.recommended_communities.update",
    });
    expect(audit[0]?.before).toMatchObject({
      value: [dbCommunity, envCommunity],
    });
    expect(audit[0]?.after).toBeNull();
  });

  it("serves the database promotion list with its db configVersion", async () => {
    const shipped = await resolveIntelPromotions(reader, new Date());
    expect(shipped.configVersion).toBe("intelPromotionsV1");
    const saved = await service.putIntelPromotions(context(), {
      items: [
        {
          title: "运营活动",
          subtitle: "限时",
          imageUrl: null,
          deeplink: "/meme",
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: "2099-01-01T00:00:00Z",
          order: 0,
        },
      ],
      updatedAt: null,
    });
    const updatedAt = saved["updatedAt"] as string;
    expect(updatedAt).toMatch(/\.[0-9]{3}Z$/u);
    const resource = await resolveIntelPromotions(reader, new Date());
    expect(resource).toMatchObject({
      configVersion: `intelPromotionsV1+db.${Date.parse(updatedAt)}`,
      effectiveAt: updatedAt,
      items: [expect.objectContaining({ title: "运营活动" })],
    });
    // The echoed updatedAt compares exactly (millisecond precision).
    const second = await service.putIntelPromotions(context(), {
      items: [],
      updatedAt,
    });
    expect(Date.parse(second["updatedAt"] as string)).toBeGreaterThan(
      Date.parse(updatedAt),
    );
    expect((await resolveIntelPromotions(reader, new Date())).items).toEqual(
      [],
    );
  });

  it("records the review note and audit row beside the existing review path", async () => {
    const pending = await community({ status: "pending" });
    const before = await auditCount();
    const result = await service.reviewCommunity(context(), pending, {
      decision: "reject",
      reasonCode: "material_mismatch",
      reasonText: "名称和介绍对不上，请修改后重新提交。",
    });
    expect(result).toMatchObject({
      changed: true,
      community: {
        verificationStatus: "rejected",
        rejectedReason: "名称和介绍对不上，请修改后重新提交。",
      },
      note: { decision: "reject", reasonCode: "material_mismatch" },
    });
    // Decision 0105: the intent row, then the decision row with the note.
    expect(await auditCount()).toBe(before + 2);
    const rows = await pool.query<{ action: string; after: unknown }>({
      text: `
        select action, after from public.admin_audit_log
        where target_id = $1 order by seq asc
      `,
      values: [pending],
    });
    expect(rows.rows.map((row) => row.action)).toEqual([
      "community.review.requested",
      "community.review.decided",
    ]);
    const stored = await pool.query<{
      verification_status: string;
      rejected_reason: string;
    }>({
      text: "select verification_status, rejected_reason from public.communities where community_id = $1",
      values: [pending],
    });
    expect(stored.rows[0]).toEqual({
      verification_status: "rejected",
      rejected_reason: "名称和介绍对不上，请修改后重新提交。",
    });
    const roleEvents = await pool.query<{ event_type: string }>({
      text: "select event_type from public.community_role_events where community_id = $1",
      values: [pending],
    });
    expect(roleEvents.rows.map((row) => row.event_type)).toContain(
      "community_rejected",
    );
    const verified = await service.reviewCommunity(context(), pending, {
      decision: "verify",
      reasonCode: "operator_manual_review",
    });
    expect(verified["community"]).toMatchObject({
      verificationStatus: "verified",
    });
    await expect(
      service.reviewCommunity(context(), pending, {
        decision: "reject",
        reasonCode: "policy_violation",
        reasonText: "不符合规则",
      }),
    ).rejects.toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: { reasonCode: "ADMIN_COMMUNITY_ALREADY_VERIFIED" },
    });
    const refused = await pool.query<{ action: string }>({
      text: `
        select action from public.admin_audit_log
        where target_id = $1 order by seq desc limit 2
      `,
      values: [pending],
    });
    expect(refused.rows.map((row) => row.action)).toEqual([
      "community.review.failed",
      "community.review.requested",
    ]);
    const detail = await service.getCommunity(pending);
    expect(
      (detail["reviewNotes"] as { decision: string }[]).map(
        (note) => note.decision,
      ),
    ).toEqual(["verify", "reject"]);
    const listed = await service.listCommunities({ status: "verified" });
    expect(
      (listed["items"] as { communityId: string }[]).some(
        (item) => item.communityId === pending,
      ),
    ).toBe(true);
  });

  it("drops hidden MEME tokens from every list read and keeps the detail", async () => {
    const meme = createPostgresMemeRepository(pool);
    const categories = createPostgresMarketCategoryRepository(pool);
    const listedId = await memeToken(
      "0x00000000000000000000000000000000000000a1",
      "LISTED",
    );
    const hiddenId = await memeToken(
      "0x00000000000000000000000000000000000000a2",
      "HIDDEN",
    );
    const listIds = async () =>
      (
        await meme.listTokens({
          chainId: testnet,
          contractAddress: curve,
          tab: "new",
          limit: 20,
          after: null,
          now: new Date().toISOString(),
        })
      ).map((row) => row.memeTokenId);
    const hotIds = async () =>
      (
        await meme.rankHotTokens({
          chainId: testnet,
          contractAddress: curve,
          since: new Date(Date.now() - 3_600_000).toISOString(),
          limit: 20,
        })
      ).map((row) => row.memeTokenId);
    const categoryAssets = async () =>
      (await categories.listMemeCandidates(100)).map((row) => row.assetId);
    expect(new Set(await listIds())).toEqual(new Set([listedId, hiddenId]));

    const before = await auditCount();
    const hidden = await service.setMemeListing(context(), hiddenId, {
      listing: "hidden",
      reasonCode: "user_reports",
      reasonText: "该代币因多次举报已被平台隐藏。",
    });
    expect(hidden).toMatchObject({
      changed: true,
      memeToken: { listing: "hidden", listingReasonCode: "user_reports" },
    });
    expect(await auditCount()).toBe(before + 1);
    expect(await listIds()).toEqual([listedId]);
    expect(await hotIds()).toEqual([listedId]);
    expect(await categoryAssets()).toEqual([
      `${testnet}:0x00000000000000000000000000000000000000a1`,
    ]);
    const detail = await meme.getToken(hiddenId);
    expect(detail).toMatchObject({
      listing: "hidden",
      listingReasonCode: "user_reports",
      listingReasonText: "该代币因多次举报已被平台隐藏。",
    });
    const adminList = await service.listMemeTokens({ listing: "hidden" });
    expect(
      (adminList["items"] as { memeTokenId: string }[]).map(
        (row) => row.memeTokenId,
      ),
    ).toEqual([hiddenId]);
    await service.setMemeListing(context(), hiddenId, {
      listing: "listed",
      reasonCode: "appeal_accepted",
    });
    expect(new Set(await listIds())).toEqual(new Set([listedId, hiddenId]));
    await expect(
      service.pauseMeme(context(), hiddenId, "pause", {
        reasonCode: "operator_incident",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "MEME_EXECUTOR_DISABLED" },
    });
  });

  it("switches the version in force on approval and applies the draft weights", async () => {
    const mining = createPostgresMiningRepository(pool);
    const assetId = await asset("0x00000000000000000000000000000000000000b1");
    const boundCommunity = await community({ status: "verified", assetId });
    const documents = buildMiningDevBaselineDocuments([assetId]);
    await mining.createFormulaVersion({
      configVersion: "s119Base",
      formula: documents.formula,
      weightRange: documents.weightRange,
      priceGuardRules: documents.priceGuardRules,
      requestId: randomUUID(),
    });
    await mining.approveFormula({
      configVersion: "s119Base",
      requestId: randomUUID(),
    });
    const range = documents.weightRange.community.range!;
    await mining.setCommunityWeight({
      communityId: boundCommunity,
      weight: range.min,
      configVersion: "s119Base",
      requestId: randomUUID(),
    });
    const before = await auditCount();
    const draft = await service.createFormulaDraft(context(), {
      configVersion: "s119Next",
      baseVersion: "s119Base",
      parameters: {
        dailyOutputBudget: "12345",
        nftWeight: "1.5",
        inviteInitialPower: "100",
        communityWeights: [{ communityId: boundCommunity, weight: range.max }],
      },
    });
    expect(draft["version"]).toMatchObject({
      status: "pending_approval",
      parameters: {
        dailyOutputBudget: "12345",
        nftWeight: "1.5",
        inviteInitialPower: "100",
        communityWeights: [{ communityId: boundCommunity, weight: range.max }],
      },
    });
    // Drafts change nothing in force.
    expect((await mining.getApprovedFormula())?.configVersion).toBe("s119Base");
    await expect(
      service.createFormulaDraft(context(), {
        configVersion: "s119Next",
        baseVersion: "s119Base",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_CONFLICT" });

    const approved = await service.approveFormula(context(), "s119Next");
    expect(approved).toMatchObject({
      version: { configVersion: "s119Next", status: "approved" },
      retiredVersion: "s119Base",
    });
    const inForce = await mining.getApprovedFormula();
    expect(inForce?.configVersion).toBe("s119Next");
    expect(inForce?.formula.dailyOutput?.budget).toBe("12345");
    const baseline = await resolveMiningBaseline(mining);
    expect(baseline.status).toBe("approved");
    const weight = await mining.getCommunityWeight(boundCommunity);
    expect(weight).toMatchObject({
      status: "approved",
      weight: range.max,
      configVersion: "s119Next",
    });
    const versions = await mining.listFormulaVersions();
    expect(
      versions.find((row) => row.configVersion === "s119Base")?.status,
    ).toBe("retired");

    await service.createFormulaDraft(context(), {
      configVersion: "s119Withdrawn",
      baseVersion: "s119Next",
    });
    const withdrawn = await service.withdrawFormula(context(), "s119Withdrawn");
    expect(withdrawn["version"]).toMatchObject({ status: "retired" });
    await expect(
      service.approveFormula(context(), "s119Withdrawn"),
    ).rejects.toBeInstanceOf(AdminApiError);
    await expect(
      service.withdrawFormula(context(), "s119Next"),
    ).rejects.toMatchObject({ code: "ADMIN_CONFLICT" });
    const actions = (
      await repository.listAudit({
        limit: 10,
        beforeSeq: null,
        actor: null,
        action: null,
      })
    )
      .filter((row) => row.action.startsWith("mining."))
      .map((row) => row.action);
    expect(actions).toEqual([
      "mining.formula.withdraw",
      "mining.formula.draft",
      "mining.formula.approve",
      "mining.formula.draft",
    ]);
    expect(await auditCount()).toBe(before + 4);
  });

  it("counts the overview from live tables", async () => {
    const overview = await service.overview();
    expect(overview["accounts"]).toBeGreaterThanOrEqual(1);
    expect(overview["communities"]).toMatchObject({
      verified: expect.any(Number) as number,
    });
    expect(
      (overview["recentAudit"] as unknown[]).length,
    ).toBeGreaterThanOrEqual(5);
    const page = await service.listAudit({ limit: 2 });
    const next = await service.listAudit({ cursor: page["nextCursor"] });
    const seqs = [
      ...(page["items"] as { seq: number }[]),
      ...(next["items"] as { seq: number }[]),
    ].map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
