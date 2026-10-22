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
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import {
  createAdminService,
  type AdminService,
  type AdminWriteContext,
} from "../src/features/admin/admin-service.js";
import { createAdminSettingsReader } from "../src/features/admin/admin-settings-reader.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0175 against PostgreSQL: migration 000097 (`communities.label`
 * and its check), the console write path (trim, clear, 12-character limit,
 * one `community.label.update` audit row per change, none when unchanged),
 * and every /v2 community reader carrying the label while the review state
 * and its visibility gating stay untouched.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

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

describe("Decision 0175 custom community label on PostgreSQL", () => {
  const databaseName = `s282_label_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let service: AdminService;
  let ownerId: string;
  let strangerId: string;
  const context = (): AdminWriteContext => ({
    session: {
      sessionId: randomUUID(),
      actor: "operator",
      accountId: null,
      role: "platform_admin",
      credentialsVersion: null,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    requestId: randomUUID(),
  });

  async function community(
    status: "pending" | "verified",
    name: string,
  ): Promise<string> {
    const created = await pool.query<{ community_id: string }>({
      text: `
        insert into public.communities (name, slug, created_by_user_id)
        values ($1, $2, $3) returning community_id
      `,
      values: [
        name,
        `c${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        ownerId,
      ],
    });
    const communityId = created.rows[0]?.community_id as string;
    await pool.query({
      text: `
        update public.communities
        set verification_status = $2,
            application_submitted_at = now(),
            verified_at = case when $2 = 'verified' then now() else null end,
            reviewed_at = case when $2 = 'pending' then null else now() end
        where community_id = $1
      `,
      values: [communityId, status],
    });
    await pool.query({
      text: `
        insert into public.community_memberships (community_id, owner_user_id, role)
        values ($1, $2, 'owner')
        on conflict do nothing
      `,
      values: [communityId, ownerId],
    });
    return communityId;
  }

  async function labelAudits(communityId: string) {
    const result = await pool.query<{ before: unknown; after: unknown }>({
      text: `
        select before, after from public.admin_audit_log
        where action = 'community.label.update' and target_id = $1
        order by seq
      `,
      values: [communityId],
    });
    return result.rows;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
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
    const repository = createPostgresAdminRepository(pool);
    ownerId = (
      await database.internalUsers.getOrCreateByPrivyUserId(
        `did:privy:s282:${randomUUID()}`,
      )
    ).id;
    strangerId = (
      await database.internalUsers.getOrCreateByPrivyUserId(
        `did:privy:s282:${randomUUID()}`,
      )
    ).id;
    service = createAdminService({
      username: "operator",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$AAAA$AAAA",
      sessionSecret: "s282-integration-session-secret-0123456789",
      repository,
      settingsReader: createAdminSettingsReader({
        repository,
        logger: { warn: () => undefined },
      }),
      environmentRecommendedCommunityIds: [],
      communityReview: null,
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

  it("applies 000097: a nullable label column whose check backs the 1-12 trimmed rule", async () => {
    const applied = await pool.query<{ name: string }>(
      "select name from public.pgmigrations where name = '000097_community_label'",
    );
    expect(applied.rows[0]?.name).toBe("000097_community_label");
    const communityId = await community("verified", "Check Club");
    const read = await pool.query<{ label: string | null }>({
      text: "select label from public.communities where community_id = $1",
      values: [communityId],
    });
    expect(read.rows[0]?.label).toBeNull();
    for (const bad of [
      "",
      " padded",
      "padded ",
      "一二三四五六七八九十甲乙丙",
    ]) {
      await expect(
        pool.query({
          text: "update public.communities set label = $2 where community_id = $1",
          values: [communityId, bad],
        }),
        bad,
      ).rejects.toMatchObject({ constraint: "communities_label_check" });
    }
    await pool.query({
      text: "update public.communities set label = $2 where community_id = $1",
      values: [communityId, "一二三四五六七八九十甲乙"],
    });
  });

  it("sets, keeps, refuses and clears a label with one audit row per change", async () => {
    const communityId = await community("pending", "Label Club");
    const set = (await service.setCommunityLabel(context(), communityId, {
      label: "  算力社区  ",
    })) as {
      community: { label: string | null; verificationStatus: string };
      changed: boolean;
      audit: { auditId: string } | null;
    };
    expect(set.changed).toBe(true);
    expect(set.community).toMatchObject({
      label: "算力社区",
      verificationStatus: "pending",
    });
    expect(set.audit).not.toBeNull();
    expect(await labelAudits(communityId)).toEqual([
      { before: { label: null }, after: { label: "算力社区" } },
    ]);

    const same = (await service.setCommunityLabel(context(), communityId, {
      label: "算力社区",
    })) as { changed: boolean; audit: unknown };
    expect(same).toMatchObject({ changed: false, audit: null });
    expect(await labelAudits(communityId)).toHaveLength(1);

    await expect(
      service.setCommunityLabel(context(), communityId, {
        label: "一二三四五六七八九十甲乙丙",
      }),
    ).rejects.toBeInstanceOf(AdminApiError);
    await expect(
      service.setCommunityLabel(context(), randomUUID(), { label: "精选社区" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const cleared = (await service.setCommunityLabel(context(), communityId, {
      label: "",
    })) as { community: { label: string | null }; changed: boolean };
    expect(cleared).toMatchObject({
      changed: true,
      community: { label: null },
    });
    expect(await labelAudits(communityId)).toEqual([
      { before: { label: null }, after: { label: "算力社区" } },
      { before: { label: "算力社区" }, after: { label: null } },
    ]);
    const status = await pool.query<{ verification_status: string }>({
      text: "select verification_status from public.communities where community_id = $1",
      values: [communityId],
    });
    expect(status.rows[0]?.verification_status).toBe("pending");
  });

  it("carries the label through every /v2 community reader without changing visibility", async () => {
    const verified = await community("verified", "Labelfrog Verified");
    const pending = await community("pending", "Labelfrog Pending");
    await service.setCommunityLabel(context(), verified, { label: "共识社区" });
    await service.setCommunityLabel(context(), pending, { label: "精选社区" });
    const repository = database.community!;

    const detail = await repository.getCommunity({
      viewerUserId: ownerId,
      communityId: verified,
    });
    expect(detail.community).toMatchObject({
      label: "共识社区",
      verificationStatus: "verified",
    });

    const listed = await repository.listCommunities({
      viewerUserId: ownerId,
      sort: "newest",
      verification: "all",
      membership: "all",
      limit: 50,
    });
    expect(listed.find((row) => row.communityId === verified)?.label).toBe(
      "共识社区",
    );

    // A stranger still finds only the verified one: the label is not a
    // visibility switch.
    const strangerSearch = await repository.searchCommunities({
      viewerUserId: strangerId,
      prefix: "labelfrog",
      verification: "all",
      limit: 10,
    });
    expect(
      strangerSearch.map((row) => [
        row.community.communityId,
        row.community.label,
      ]),
    ).toEqual([[verified, "共识社区"]]);

    const profiles = database.publicProfiles!;
    const joined = await profiles.listProfileCommunities({
      ownerUserId: ownerId,
      limit: 50,
    });
    expect(
      joined.items.find((row) => row.communityId === verified)?.label,
    ).toBe("共识社区");
    expect(joined.items.some((row) => row.communityId === pending)).toBe(false);
    const recommended = await profiles.listVerifiedCommunitiesByIds([
      verified,
      pending,
    ]);
    expect(recommended.map((row) => [row.communityId, row.label])).toEqual([
      [verified, "共识社区"],
    ]);
  });
});
