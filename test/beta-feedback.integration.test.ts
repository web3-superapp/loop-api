import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresBetaFeedbackRepository } from "../src/database/beta-feedback-repository.js";
import { createPostgresMediaRepository } from "../src/database/media-repository.js";
import { createAdminFeedbackService } from "../src/features/admin/admin-beta-feedback.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import type { AdminWriteContext } from "../src/features/admin/admin-service.js";
import { feedbackReasonCodes } from "../src/features/feedback/feedback-contract.js";
import { createFeedbackService } from "../src/features/feedback/feedback-service.js";
import { createMediaService } from "../src/features/media/media-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0193 on PostgreSQL (migration 000105), in a throwaway database:
 * feedback_image upload → report → own list, idempotent create, the
 * screenshot ownership / freshness / reuse checks, the rolling daily limit,
 * the console list filters, cursor pages, triage with its audit row, the
 * table checks, and the migration's down step.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const baseUrl = "https://api.loop.test";
const t0 = new Date("2026-11-02T08:00:00.000Z");
const hour = 3_600_000;

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const consoleContext: AdminWriteContext = {
  session: {
    sessionId: "s332",
    actor: "operator",
    accountId: null,
    role: "platform_admin",
    issuedAt: t0.toISOString(),
    expiresAt: new Date(t0.getTime() + 86_400_000).toISOString(),
  } as AdminWriteContext["session"],
  requestId: randomUUID(),
};

describe("Decision 0193 beta feedback on PostgreSQL", () => {
  const databaseName = `loop_s332_test_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;
  let clock = t0;
  const now = () => clock;
  let picture: Buffer;

  async function user(alias: string | null): Promise<{
    readonly userId: string;
    readonly loopId: string | null;
    readonly principal: AuthenticatedLoopPrincipal;
  }> {
    const created = await pool.query<{ id: string; loop_id: string | null }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id, loop_id",
      [`did:privy:s332:${randomUUID()}`],
    );
    const userId = created.rows[0]!.id;
    if (alias !== null) {
      await pool.query(
        `insert into public.user_profiles (owner_user_id, alias, profile_status,
           created_at, activated_at)
         values ($1, $2, 'active', clock_timestamp(), clock_timestamp())`,
        [userId, alias],
      );
    }
    return {
      userId,
      loopId: created.rows[0]!.loop_id,
      principal: { userId, privyUserId: "did:privy:x", streamUserId: "x" },
    };
  }

  function services() {
    const repository = createPostgresBetaFeedbackRepository(pool);
    const media = createMediaService({
      storage: createPostgresMediaRepository(pool),
      quota: { consume: () => Promise.resolve() },
      publicBaseUrl: baseUrl,
    });
    return {
      repository,
      app: createFeedbackService({
        enabled: true,
        repository,
        cursorCodec: createV2CursorCodec({
          secret: new TextEncoder().encode(
            "s332-cursor-secret-0123456789abcdef",
          ),
          now,
        }),
        media,
        publicBaseUrl: baseUrl,
        now,
      }),
      console: createAdminFeedbackService({
        repository,
        publicBaseUrl: baseUrl,
        cursorSecret: "s332-console-secret-0123456789abcdef",
        now,
      }),
      media,
    };
  }

  beforeAll(async () => {
    picture = await sharp({
      create: { width: 1170, height: 2532, channels: 3, background: "#304050" },
    })
      .png()
      .toBuffer();
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

  it("uploads, submits, replays and lists the caller's report", async () => {
    const { app } = services();
    const reporter = await user("Dd");
    const image = await app.uploadImage({
      principal: reporter.principal,
      idempotencyKey: randomUUID(),
      readBytes: () => Promise.resolve(picture),
    });
    expect(image.url).toBe(`${baseUrl}/v2/media/${image.mediaId}.webp`);
    const stored = await pool.query(
      "select kind, owner_user_id::text as owner, width, height, ipfs_cid from public.media_objects where media_id = $1",
      [image.mediaId],
    );
    expect(stored.rows[0]).toEqual({
      kind: "feedback_image",
      owner: reporter.userId,
      width: Math.round((1170 * 1440) / 2532),
      height: 1440,
      ipfs_cid: null,
    });

    const key = randomUUID();
    const body = {
      category: "bug",
      body: "净值 $0\r\n无持仓",
      mediaIds: [image.mediaId],
      context: { appVersion: "1.4.0", build: 57, route: "/me", junk: "x" },
    };
    const created = await app.submit({
      principal: reporter.principal,
      idempotencyKey: key,
      body,
    });
    expect(created.replayed).toBe(false);
    expect(created.resource.feedback).toMatchObject({
      status: "open",
      createdAt: t0.toISOString(),
    });
    const row = await pool.query(
      "select category, body, context, status, admin_note from public.beta_feedback where id = $1",
      [created.resource.feedback.id],
    );
    expect(row.rows[0]).toEqual({
      category: "bug",
      body: "净值 $0\n无持仓",
      context: { appVersion: "1.4.0", build: "57", route: "/me" },
      status: "open",
      admin_note: null,
    });
    const replay = await app.submit({
      principal: reporter.principal,
      idempotencyKey: key,
      body,
    });
    expect(replay).toEqual({ replayed: true, resource: created.resource });
    const conflict = await rejection(
      app.submit({
        principal: reporter.principal,
        idempotencyKey: key,
        body: { ...body, category: "other" },
      }),
    );
    expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const mine = await app.listMine({
      principal: reporter.principal,
      cursor: undefined,
    });
    expect(mine).toEqual({
      items: [
        {
          id: created.resource.feedback.id,
          category: "bug",
          body: "净值 $0\n无持仓",
          status: "open",
          createdAt: t0.toISOString(),
          images: [image.url],
        },
      ],
      nextCursor: null,
    });
    // Another account sees nothing.
    const stranger = await user(null);
    expect(
      await app.listMine({ principal: stranger.principal, cursor: undefined }),
    ).toEqual({ items: [], nextCursor: null });
  });

  it("refuses foreign, wrong-kind, stale, reused and too many screenshots", async () => {
    const { app, media } = services();
    const reporter = await user("Eve");
    const other = await user("Mallory");
    const upload = (principal: AuthenticatedLoopPrincipal) =>
      app.uploadImage({
        principal,
        idempotencyKey: randomUUID(),
        readBytes: () => Promise.resolve(picture),
      });
    const own = await Promise.all(
      [1, 2, 3, 4, 5].map(() => upload(reporter.principal)),
    );
    const foreign = await upload(other.principal);
    const avatar = await media.upload({
      principal: reporter.principal,
      kind: "avatar",
      idempotencyKey: randomUUID(),
      bytes: picture,
    });
    const submit = (mediaIds: readonly string[]) =>
      app.submit({
        principal: reporter.principal,
        idempotencyKey: randomUUID(),
        body: { category: "bug", body: "x", mediaIds },
      });
    const reason = async (mediaIds: readonly string[]) => {
      const error = await rejection(submit(mediaIds));
      expect(error).toBeInstanceOf(V2ApiError);
      return (error as V2ApiError).detailsSafe;
    };
    expect(await reason(own.map((entry) => entry.mediaId))).toMatchObject({
      reasonCode: feedbackReasonCodes.tooManyImages,
    });
    expect(await reason([foreign.mediaId])).toMatchObject({
      reasonCode: feedbackReasonCodes.mediaNotOwned,
    });
    expect(await reason([avatar.mediaId])).toMatchObject({
      reasonCode: feedbackReasonCodes.mediaNotOwned,
    });
    expect(await reason([randomUUID()])).toMatchObject({
      reasonCode: feedbackReasonCodes.mediaNotOwned,
    });
    // Nothing was written by the refusals.
    const none = await pool.query(
      "select count(*)::integer as n from public.beta_feedback where account_id = $1",
      [reporter.userId],
    );
    expect(none.rows[0]).toEqual({ n: 0 });

    const four = own.slice(0, 4).map((entry) => entry.mediaId);
    const created = await submit(four);
    const attachments = await pool.query(
      "select media_id::text as media_id, sort from public.beta_feedback_attachments where feedback_id = $1 order by sort",
      [created.resource.feedback.id],
    );
    expect(attachments.rows).toEqual(
      four.map((mediaId, sort) => ({ media_id: mediaId, sort })),
    );
    expect(await reason([own[0]!.mediaId])).toMatchObject({
      reasonCode: feedbackReasonCodes.mediaInUse,
    });
    // A screenshot older than 24 hours is no longer accepted.
    clock = new Date(t0.getTime() + 25 * hour);
    try {
      expect(await reason([own[4]!.mediaId])).toMatchObject({
        reasonCode: feedbackReasonCodes.mediaNotOwned,
      });
    } finally {
      clock = t0;
    }
  });

  it("enforces twenty reports per rolling 24 hours", async () => {
    const { app } = services();
    const reporter = await user("Busy");
    const submit = () =>
      app.submit({
        principal: reporter.principal,
        idempotencyKey: randomUUID(),
        body: { category: "other", body: "x" },
      });
    for (let index = 0; index < 20; index += 1) {
      clock = new Date(t0.getTime() + index * 60_000);
      await submit();
    }
    const limited = await rejection(submit());
    expect(limited).toMatchObject({
      code: "RATE_LIMITED",
      detailsSafe: { reasonCode: feedbackReasonCodes.dailyLimit },
    });
    // 24 hours after the first one, a slot frees up.
    clock = new Date(t0.getTime() + 24 * hour + 1);
    await expect(submit()).resolves.toMatchObject({ replayed: false });
    clock = t0;
  });

  it("pages the own list newest first with a cursor", async () => {
    const { app } = services();
    const reporter = await user("Pager");
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      clock = new Date(t0.getTime() - (21 - index) * 25 * hour);
      const created = await app.submit({
        principal: reporter.principal,
        idempotencyKey: randomUUID(),
        body: { category: "bug", body: `#${String(index)}` },
      });
      ids.push(created.resource.feedback.id);
    }
    clock = t0;
    const first = await app.listMine({
      principal: reporter.principal,
      cursor: undefined,
    });
    expect(first.items.map((item) => item.id)).toEqual(
      [...ids].reverse().slice(0, 20),
    );
    expect(first.nextCursor).not.toBeNull();
    const second = await app.listMine({
      principal: reporter.principal,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ items: [{ id: ids[0] }], nextCursor: null });
  });

  it("lets the console filter, page and triage with an audit row", async () => {
    const { app, console } = services();
    const reporter = await user("Triage");
    clock = new Date(t0.getTime() + 30 * 24 * hour);
    const created = [];
    for (const category of ["bug", "suggestion", "other"] as const) {
      clock = new Date(clock.getTime() + 1_000);
      created.push(
        (
          await app.submit({
            principal: reporter.principal,
            idempotencyKey: randomUUID(),
            body: {
              category,
              body: category,
              context: { platform: "android" },
            },
          })
        ).resource.feedback.id,
      );
    }
    const bug = created[0]!;
    const page = await console.list({ category: "bug", limit: 100 });
    expect(page.items.find((item) => item.id === bug)).toMatchObject({
      accountId: reporter.userId,
      account: { loopId: reporter.loopId, displayName: "Triage" },
      category: "bug",
      status: "open",
      adminNote: null,
      images: [],
      context: { platform: "android" },
    });
    expect(page.items.every((item) => item.category === "bug")).toBe(true);

    const first = await console.list({ limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([created[2]]);
    const second = await console.list({ cursor: first.nextCursor });
    expect(second.items[0]?.id).toBe(created[1]);
    expect(
      await rejection(
        console.list({ status: "open", cursor: first.nextCursor }),
      ),
    ).toBeInstanceOf(AdminApiError);

    clock = new Date(t0.getTime() + 31 * 24 * hour);
    const triaged = await console.update(consoleContext, bug, {
      status: "triaged",
      adminNote: "已复现",
    });
    expect(triaged.feedback).toMatchObject({
      status: "triaged",
      adminNote: "已复现",
      updatedAt: clock.toISOString(),
    });
    const audit = await pool.query(
      `select action, target_type, target_id, before, after, seq
       from public.admin_audit_log where audit_id = $1`,
      [triaged.audit.auditId],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "beta_feedback.update",
      target_type: "beta_feedback",
      target_id: bug,
      before: { status: "open", adminNote: null },
      after: { status: "triaged", adminNote: "已复现", changed: true },
    });
    expect(Number((audit.rows[0] as { seq: unknown }).seq)).toBe(
      triaged.audit.seq,
    );
    const cleared = await console.update(consoleContext, bug, {
      adminNote: null,
    });
    expect(cleared.feedback).toMatchObject({
      status: "triaged",
      adminNote: null,
    });
    expect(
      (await console.list({ status: "triaged" })).items.map((item) => item.id),
    ).toEqual([bug]);
    expect((await console.get(bug)).feedback.id).toBe(bug);
    expect(await rejection(console.get(randomUUID()))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await rejection(
        console.update(consoleContext, randomUUID(), { status: "resolved" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    clock = t0;
  });

  it("keeps the table checks", async () => {
    const reporter = await user(null);
    const insert = (overrides: Record<string, unknown>) =>
      pool.query(
        `insert into public.beta_feedback (id, account_id, category, body,
           context, create_idempotency_key, create_request_sha256)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          randomUUID(),
          reporter.userId,
          overrides["category"] ?? "bug",
          overrides["body"] ?? "x",
          JSON.stringify(overrides["context"] ?? {}),
          randomUUID(),
          "a".repeat(64),
        ],
      );
    await expect(insert({ category: "crash" })).rejects.toThrow(
      /beta_feedback_category_check/u,
    );
    await expect(insert({ body: "x".repeat(2_001) })).rejects.toThrow(
      /beta_feedback_body_check/u,
    );
    await expect(insert({ context: { wallet: "0x1" } })).rejects.toThrow(
      /beta_feedback_context_check/u,
    );
    await expect(insert({ context: { route: "/me" } })).resolves.toBeDefined();
  });

  it("rolls back only without feedback screenshots, then re-applies", async () => {
    const steps = { count: 1 };
    // Decision 0194: 000106 sits above 000105; roll it back first.
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "down",
      count: 1,
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const refused = await rejection(
      runner({
        databaseUrl: url,
        dir: migrationsDirectory,
        direction: "down",
        count: steps.count,
        migrationsTable: "pgmigrations",
        log: () => undefined,
      }),
    );
    expect(String(refused)).toMatch(/feedback_image media exist/u);
    await pool.query("delete from public.beta_feedback_attachments");
    await pool.query("delete from public.beta_feedback");
    await pool.query("alter table public.media_objects disable trigger user");
    await pool.query(
      "delete from public.media_objects where kind = 'feedback_image'",
    );
    await pool.query("alter table public.media_objects enable trigger user");
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "down",
      count: steps.count,
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const gone = await pool.query(
      "select to_regclass('public.beta_feedback') as relation",
    );
    expect(gone.rows[0]).toEqual({ relation: null });
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const back = await pool.query(
      "select to_regclass('public.beta_feedback_attachments')::text as relation",
    );
    expect(back.rows[0]).toEqual({
      relation: "beta_feedback_attachments",
    });
  });
});
