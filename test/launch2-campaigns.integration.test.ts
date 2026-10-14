import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresLaunch2CampaignRepository } from "../src/database/launch2-campaign-repository.js";
import { createPostgresMediaRepository } from "../src/database/media-repository.js";
import { createAdminLaunch2CampaignService } from "../src/features/admin/admin-launch2-campaigns.js";
import type { AdminWriteContext } from "../src/features/admin/admin-service.js";
import { createLaunch2CampaignPublicService } from "../src/features/launch2/launch2-campaigns.js";
import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0140 on PostgreSQL (migration 000081), in a throwaway database:
 * create → publish → the public read sees it → archive → it is gone, with
 * the four `admin_audit_log` rows; the SQL filter / order; the cover upload
 * as a `campaign_cover` media object (readable by the media route's store,
 * replayed under its key); and the migration's down step.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const now = new Date("2026-10-14T12:00:00.000Z");
const day = 86_400_000;
const at = (offsetMs: number) =>
  new Date(now.getTime() + offsetMs).toISOString();

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

const context: AdminWriteContext = {
  session: {
    sessionId: "s183",
    actor: "operator",
    accountId: null,
    role: "platform_admin",
    issuedAt: now.toISOString(),
    expiresAt: at(day),
  } as AdminWriteContext["session"],
  requestId: randomUUID(),
};
const principal = {} as AuthenticatedLoopPrincipal;

describe("Decision 0140 launch desk campaigns on PostgreSQL", () => {
  const databaseName = `loop_s183_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;

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
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("create → publish → public read → archive → gone, audited", async () => {
    const repository = createPostgresLaunch2CampaignRepository(pool);
    const consoleService = createAdminLaunch2CampaignService({
      repository,
      publicBaseUrl: "https://api.loop.test",
      now: () => now,
    });
    const publicService = createLaunch2CampaignPublicService({
      repository,
      publicBaseUrl: "https://api.loop.test",
      now: () => now,
    });

    const cover = await consoleService.uploadCover(
      context,
      await sharp({
        create: { width: 1400, height: 700, channels: 3, background: "#222" },
      })
        .png()
        .toBuffer(),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    const stored = await createPostgresMediaRepository(pool).get(cover.mediaId);
    expect(stored).toMatchObject({
      kind: "campaign_cover",
      ownerUserId: null,
      width: 1200,
      height: 600,
    });

    const created = await consoleService.create(
      context,
      {
        title: "交易赛",
        startsAt: at(-day),
        endsAt: at(2 * day),
        link: { kind: "url", value: "https://loop.test/race" },
        coverMediaId: cover.mediaId,
      },
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    expect(created.campaign).toMatchObject({
      status: "draft",
      ctaLabel: "查看",
      createdBy: null,
      coverUrl: cover.coverUrl,
    });
    const id = created.campaign.campaignId;
    const replay = await consoleService.create(
      context,
      {
        title: "交易赛",
        startsAt: at(-day),
        endsAt: at(2 * day),
        link: { kind: "url", value: "https://loop.test/race" },
        coverMediaId: cover.mediaId,
      },
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.campaign.campaignId).toBe(id);
    expect(replay.audit).toEqual(created.audit);

    expect((await publicService.listCampaigns({ principal }))["items"]).toEqual(
      [],
    );
    await consoleService.publish(context, id);
    const visible = await publicService.listCampaigns({ principal });
    expect(visible["items"]).toEqual([
      expect.objectContaining({
        campaignId: id,
        state: "live",
        coverUrl: cover.coverUrl,
        link: { kind: "url", value: "https://loop.test/race" },
      }),
    ]);
    await consoleService.update(context, id, { pinned: true, sortOrder: 2 });
    await consoleService.archive(context, id);
    expect((await publicService.listCampaigns({ principal }))["items"]).toEqual(
      [],
    );
    await expect(consoleService.publish(context, id)).rejects.toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: { reasonCode: "CAMPAIGN_STATUS_CONFLICT" },
    });

    const audit = await pool.query<{
      action: string;
      target_type: string;
      before: unknown;
      after: { status: string };
    }>(
      `select action, target_type, before, after from public.admin_audit_log
       where target_id = $1 order by seq`,
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "launch2.campaign.create",
      "launch2.campaign.publish",
      "launch2.campaign.update",
      "launch2.campaign.archive",
    ]);
    expect(
      audit.rows.every((row) => row.target_type === "launch2_campaign"),
    ).toBe(true);
    expect(audit.rows[0]?.before).toBeNull();
    expect(audit.rows.map((row) => row.after.status)).toEqual([
      "draft",
      "published",
      "published",
      "archived",
    ]);
  });

  it("filters and orders in SQL", async () => {
    await pool.query(`delete from public.launch2_campaigns`);
    const repository = createPostgresLaunch2CampaignRepository(pool);
    const insert = async (
      title: string,
      startsAt: string,
      endsAt: string,
      status: string,
      pinned = false,
      sortOrder = 0,
    ) =>
      pool.query(
        `insert into public.launch2_campaigns (campaign_id, title, starts_at,
           ends_at, link_kind, link_value, status, pinned, sort_order,
           created_by_actor)
         values ($1, $2, $3, $4, 'route', '/launch2', $5, $6, $7, 'operator')`,
        [randomUUID(), title, startsAt, endsAt, status, pinned, sortOrder],
      );
    await insert("b", at(-day), at(day), "published", false, 1);
    await insert("a", at(-day), at(day), "published", false, 0);
    await insert("pin", at(-day), at(day), "published", true, 9);
    await insert("soon", at(7 * day), at(8 * day), "published");
    await insert("far", at(7 * day + 1000), at(8 * day), "published");
    await insert("ended", at(-2 * day), now.toISOString(), "published");
    await insert("draft", at(-day), at(day), "draft");
    await insert("archived", at(-day), at(day), "archived");
    const rows = await repository.listPublic({
      now,
      horizon: new Date(now.getTime() + 7 * day),
      limit: 10,
    });
    expect(rows.map((row) => row.title)).toEqual(["pin", "a", "soon", "b"]);
    expect(
      (await repository.listAll({ status: "draft", limit: 200 })).map(
        (row) => row.title,
      ),
    ).toEqual(["draft"]);
    await expect(
      insert("bad window", at(day), at(-day), "draft"),
    ).rejects.toThrow();
  });

  it("migrates down one step and up again", async () => {
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "down",
      count: 1,
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const table = await pool.query<{ name: string | null }>(
      `select to_regclass('public.launch2_campaigns')::text as name`,
    );
    expect(table.rows[0]?.name).toBeNull();
    const covers = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.media_objects`,
    );
    expect(covers.rows[0]?.count).toBe("0");
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
  });
});
