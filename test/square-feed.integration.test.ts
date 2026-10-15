import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresSquareRepository } from "../src/database/square-repository.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import type { AdminWriteContext } from "../src/features/admin/admin-service.js";
import { createAdminSquarePostService } from "../src/features/admin/admin-square-posts.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { squareReasonCodes } from "../src/features/square/square-contract.js";
import { createSquareFeedIngest } from "../src/features/square/square-ingest.js";
import { createSquareService } from "../src/features/square/square-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0143 on PostgreSQL (migration 000084), in a throwaway database:
 * timeline order with pinned official posts, following / block filters,
 * cursor pages, likes, the per-minute post limit and idempotent create,
 * own delete, the console state machine with its audit rows (409s), the
 * ingest lane writing buy / claim / graduation posts once (source event
 * dedupe, privacy and wallet mapping), and the migration's down step.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const t0 = new Date("2026-10-15T12:00:00.000Z");
const minute = 60_000;
const later = (ms: number) => new Date(t0.getTime() + ms);

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

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

const consoleContext: AdminWriteContext = {
  session: {
    sessionId: "s187b",
    actor: "operator",
    accountId: null,
    role: "platform_admin",
    issuedAt: t0.toISOString(),
    expiresAt: later(86_400_000).toISOString(),
  } as AdminWriteContext["session"],
  requestId: randomUUID(),
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("Decision 0143 square timeline on PostgreSQL", () => {
  const databaseName = `loop_s187b_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;
  let clock = t0;
  const now = () => clock;

  async function user(alias: string): Promise<{
    readonly userId: string;
    readonly publicProfileId: string;
    readonly principal: AuthenticatedLoopPrincipal;
  }> {
    const created = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s187b:${randomUUID()}`],
    );
    const userId = created.rows[0]!.id;
    const profile = await pool.query<{ public_profile_id: string }>(
      `insert into public.user_profiles (owner_user_id, alias, profile_status,
         created_at, activated_at)
       values ($1, $2, 'active', clock_timestamp(), clock_timestamp())
       returning public_profile_id::text`,
      [userId, alias],
    );
    return {
      userId,
      publicProfileId: profile.rows[0]!.public_profile_id,
      principal: {
        userId,
        privyUserId: "did:privy:x",
        streamUserId: "x",
      },
    };
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
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  function services() {
    const repository = createPostgresSquareRepository(pool);
    return {
      repository,
      app: createSquareService({
        repository,
        cursorCodec: createV2CursorCodec({
          secret: new TextEncoder().encode(
            "s187b-cursor-secret-0123456789abcdef",
          ),
          now,
        }),
        publicBaseUrl: "https://api.loop.test",
        now,
      }),
      console: createAdminSquarePostService({ repository, now }),
    };
  }

  type Feed = {
    items: {
      postId: string;
      kind: string;
      text: string | null;
      pinned: boolean;
      likeCount: number;
      likedByViewer: boolean;
      author: { publicProfileId: string } | null;
      token: Record<string, unknown> | null;
      event: Record<string, unknown> | null;
    }[];
    nextCursor: string | null;
  };

  it("orders the timeline, pins official posts, filters following / blocks, pages, likes", async () => {
    const { app, console: desk, repository } = services();
    const viewer = await user("viewer");
    const followed = await user("followed");
    const stranger = await user("stranger");
    const blocked = await user("blocked");
    await pool.query(
      "insert into public.follow_edges (follower_user_id, followee_user_id) values ($1, $2)",
      [viewer.userId, followed.userId],
    );
    await pool.query(
      `insert into public.user_blocks (owner_user_id, kind, stable_id, target_user_id)
       values ($1, 'user', $2, $3)`,
      [viewer.userId, blocked.publicProfileId, blocked.userId],
    );
    const write = async (
      who: typeof viewer,
      text: string,
      offsetMs: number,
    ): Promise<string> => {
      clock = later(offsetMs);
      const created = await app.createPost({
        principal: who.principal,
        idempotencyKey: randomUUID(),
        body: { text },
      });
      return (created.resource["post"] as { postId: string }).postId;
    };
    const p1 = await write(followed, "first", 1_000);
    const p2 = await write(stranger, "second", 2_000);
    await write(blocked, "hidden", 3_000);
    const p4 = await write(followed, "fourth", 4_000);

    // A draft official post is invisible until published; then it leads.
    clock = later(5_000);
    const draft = await desk.create(
      consoleContext,
      { text: "12h 日报", pinned: true },
      null,
    );
    expect(draft.post).toMatchObject({
      kind: "system",
      status: "draft",
      author: null,
    });
    const read = (input: Partial<Parameters<typeof app.getFeed>[0]> = {}) =>
      app.getFeed({
        principal: viewer.principal,
        scope: undefined,
        cursor: undefined,
        limit: undefined,
        ...input,
      }) as Promise<Feed>;
    expect((await read()).items.map((item) => item.postId)).toEqual([
      p4,
      p2,
      p1,
    ]);
    await desk.publish(consoleContext, draft.post.postId);
    const global = await read();
    expect(global.items.map((item) => item.postId)).toEqual([
      draft.post.postId,
      p4,
      p2,
      p1,
    ]);
    expect(global.items[0]).toMatchObject({ pinned: true, author: null });
    expect(global.items[1]?.author?.publicProfileId).toBe(
      followed.publicProfileId,
    );

    const following = await read({ scope: "following" });
    expect(following.items.map((item) => item.postId)).toEqual([
      draft.post.postId,
      p4,
      p1,
    ]);

    // Pages of one: the pinned post only on the first page.
    const pageOne = await read({ limit: 1 });
    expect(pageOne.items.map((item) => item.postId)).toEqual([
      draft.post.postId,
      p4,
    ]);
    const pageTwo = await read({ cursor: pageOne.nextCursor });
    expect(pageTwo.items.map((item) => item.postId)).toEqual([p2]);
    const pageThree = await read({ cursor: pageTwo.nextCursor });
    expect(pageThree.items.map((item) => item.postId)).toEqual([p1]);
    expect(pageThree.nextCursor).toBeNull();
    // A cursor is bound to its scope.
    expect(
      await rejection(read({ scope: "following", cursor: pageOne.nextCursor })),
    ).toMatchObject({ code: "INVALID_REQUEST" });

    // Likes: idempotent, counted, the viewer's flag.
    for (const who of [viewer, stranger, viewer]) {
      await app.setLike({ principal: who.principal, postId: p4, liked: true });
    }
    let liked = (await read()).items.find((item) => item.postId === p4);
    expect(liked).toMatchObject({ likeCount: 2, likedByViewer: true });
    expect(
      await app.setLike({
        principal: viewer.principal,
        postId: p4,
        liked: false,
      }),
    ).toMatchObject({ likeCount: 1, likedByViewer: false });
    liked = (await read()).items.find((item) => item.postId === p4);
    expect(liked).toMatchObject({ likeCount: 1, likedByViewer: false });
    expect(
      await rejection(
        app.setLike({
          principal: viewer.principal,
          postId: randomUUID(),
          liked: true,
        }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });

    // Own delete: gone, repeatable; someone else's: 404.
    expect(
      await rejection(
        app.deletePost({ principal: viewer.principal, postId: p4 }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    await app.deletePost({ principal: followed.principal, postId: p4 });
    await app.deletePost({ principal: followed.principal, postId: p4 });
    expect((await read()).items.map((item) => item.postId)).not.toContain(p4);
    expect(
      await rejection(
        app.setLike({ principal: viewer.principal, postId: p4, liked: true }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await pool.query<{ status: string; archived_by: string }>(
          "select status, archived_by from public.square_posts where post_id = $1",
          [p4],
        )
      ).rows[0],
    ).toEqual({ status: "archived", archived_by: "author" });
    expect(
      await repository.tokenRefExists({ kind: "meme", id: randomUUID() }),
    ).toBe(false);
  });

  it("limits five posts a minute per author and replays an Idempotency-Key", async () => {
    const { app } = services();
    const author = await user("poster");
    clock = later(10 * minute);
    const key = randomUUID();
    const first = await app.createPost({
      principal: author.principal,
      idempotencyKey: key,
      body: { text: "one" },
    });
    expect(first.replayed).toBe(false);
    const replay = await app.createPost({
      principal: author.principal,
      idempotencyKey: key,
      body: { text: " one " },
    });
    expect(replay).toMatchObject({ replayed: true });
    expect((replay.resource["post"] as { postId: string }).postId).toBe(
      (first.resource["post"] as { postId: string }).postId,
    );
    expect(
      await rejection(
        app.createPost({
          principal: author.principal,
          idempotencyKey: key,
          body: { text: "other" },
        }),
      ),
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    for (let index = 0; index < 4; index += 1) {
      clock = later(10 * minute + (index + 1) * 1_000);
      await app.createPost({
        principal: author.principal,
        idempotencyKey: randomUUID(),
        body: { text: `post ${String(index)}` },
      });
    }
    const limited = await rejection(
      app.createPost({
        principal: author.principal,
        idempotencyKey: randomUUID(),
        body: { text: "sixth" },
      }),
    );
    expect(limited).toBeInstanceOf(V2ApiError);
    expect(limited).toMatchObject({
      code: "RATE_LIMITED",
      detailsSafe: { reasonCode: squareReasonCodes.rateLimited },
    });
    // A minute after the first post the window has room again.
    clock = later(11 * minute + 500);
    await app.createPost({
      principal: author.principal,
      idempotencyKey: randomUUID(),
      body: { text: "sixth, later" },
    });
    // An account without an activated profile cannot post.
    const pending = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s187b:${randomUUID()}`],
    );
    expect(
      await rejection(
        app.createPost({
          principal: {
            userId: pending.rows[0]!.id,
            privyUserId: "x",
            streamUserId: "x",
          },
          idempotencyKey: randomUUID(),
          body: { text: "hi" },
        }),
      ),
    ).toMatchObject({ code: "PROFILE_ACTIVATION_REQUIRED" });
  });

  it("runs the console state machine with audit rows and 409s", async () => {
    const { app, console: desk } = services();
    const author = await user("moderated");
    clock = later(20 * minute);
    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const created = await desk.create(consoleContext, { text: "公告" }, key);
    expect(created.replayed).toBe(false);
    const replayed = await desk.create(consoleContext, { text: "公告" }, key);
    expect(replayed).toMatchObject({ replayed: true, audit: created.audit });
    expect(
      await rejection(desk.create(consoleContext, { text: "另一个" }, key)),
    ).toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: { reasonCode: "ADMIN_IDEMPOTENCY_CONFLICT" },
    });
    const id = created.post.postId;
    await desk.update(consoleContext, id, { text: "公告 v2", pinned: true });
    await desk.publish(consoleContext, id);
    const conflict = await rejection(desk.publish(consoleContext, id));
    expect(conflict).toBeInstanceOf(AdminApiError);
    expect(conflict).toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: {
        reasonCode: squareReasonCodes.statusConflict,
        status: "published",
      },
    });
    await desk.update(consoleContext, id, { pinned: false });
    await desk.archive(consoleContext, id);
    for (const attempt of [
      desk.archive(consoleContext, id),
      desk.publish(consoleContext, id),
      desk.update(consoleContext, id, { text: "x" }),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        code: "ADMIN_CONFLICT",
        detailsSafe: { reasonCode: squareReasonCodes.statusConflict },
      });
    }
    expect((await desk.get(id)).post).toMatchObject({
      status: "archived",
      text: "公告 v2",
      pinned: false,
    });
    const audit = await pool.query<{ action: string }>(
      `select action from public.admin_audit_log
       where target_type = 'square_post' and target_id = $1 order by seq`,
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "square.post.create",
      "square.post.update",
      "square.post.publish",
      "square.post.update",
      "square.post.archive",
    ]);

    // A user opinion: the console may archive it, never edit or publish it.
    const opinion = await app.createPost({
      principal: author.principal,
      idempotencyKey: randomUUID(),
      body: { text: "spam" },
    });
    const opinionId = (opinion.resource["post"] as { postId: string }).postId;
    expect(
      await rejection(
        desk.update(consoleContext, opinionId, { text: "edited" }),
      ),
    ).toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: {
        reasonCode: squareReasonCodes.kindConflict,
        kind: "opinion",
      },
    });
    const archived = await desk.archive(consoleContext, opinionId);
    expect(archived.post).toMatchObject({
      kind: "opinion",
      status: "archived",
    });
    expect(
      (await desk.list({ kind: "opinion", status: "archived" })).items.map(
        (item) => item.postId,
      ),
    ).toContain(opinionId);
    expect(await rejection(desk.get(randomUUID()))).toMatchObject({
      code: "NOT_FOUND",
    });
    // The library check refuses a pinned non-system row outright.
    await expect(
      pool.query(
        "update public.square_posts set pinned = true where post_id = $1",
        [opinionId],
      ),
    ).rejects.toThrow(/square_posts_pinned_check/);
  });

  it("ingests buys, claims and graduations once, with privacy and wallet mapping", async () => {
    const { repository, app } = services();
    clock = new Date();
    const buyer = await user("buyer");
    const claimer = await user("claimer");
    const privateClaimer = await user("private");
    const creator = await user("creator");
    await pool.query(
      `insert into public.privacy_preferences_v2 (owner_user_id, trade_history_visibility)
       values ($1, 'self')`,
      [privateClaimer.userId],
    );

    // A member buy: FROG / USDT pool on BSC, 12.5 USDT paid in; one under 10.
    const chainId = "eip155:56";
    const frog = `0x${"f1".repeat(20)}`;
    const usdt = "0x55d398326f99059ff775485246999027b3197955";
    for (const [address, symbol] of [
      [frog, "FROG"],
      [usdt, "USDT"],
    ] as const) {
      await pool.query(
        `insert into public.assets (asset_id, chain_id, address, symbol, name,
           decimals, status, source_kind, source_block_number, source_verified_at)
         values ($1, $2, $3, $4, $4, 18, 'verified', 'chain_call', 1, clock_timestamp())
         on conflict do nothing`,
        [`${chainId}:${address}`, chainId, address, symbol],
      );
    }
    const poolRow = await pool.query<{ pool_id: string }>(
      `insert into public.pools (chain_id, protocol, address, token0_asset_id,
         token1_asset_id, fee, tick_spacing, source_block_number, source_verified_at)
       values ($1, 'pancakeswap_v3', $2, $3, $4, 2500, 50, 1, clock_timestamp())
       returning pool_id`,
      [chainId, hex(20), `${chainId}:${frog}`, `${chainId}:${usdt}`],
    );
    const community = await pool.query<{ community_id: string }>(
      `insert into public.communities (name, slug, verification_status,
         bound_asset_key, created_by_user_id, verified_at, reviewed_at)
       values ('Frog', $1, 'verified', $2, $3, clock_timestamp(), clock_timestamp())
       returning community_id`,
      [`frog-${randomUUID().slice(0, 8)}`, `${chainId}:${frog}`, buyer.userId],
    );
    const buys = [
      { hash: hex(32), usdt: "12500000000000000000" },
      { hash: hex(32), usdt: "9000000000000000000" },
    ];
    for (const [index, buy] of buys.entries()) {
      await pool.query(
        `insert into public.indexed_pool_events (chain_id, transaction_hash,
           log_index, block_number, block_hash, pool_id, event_kind, payload,
           block_timestamp, amount0, amount1, sqrt_price_x96, removed)
         values ($1, $2, 3, $3, $4, $5, 'swap', '{}'::jsonb, now(),
           -5000000000000000000000, $6::numeric, 79228162514264337593543950336, false)`,
        [
          chainId,
          buy.hash,
          100 + index,
          hex(32),
          poolRow.rows[0]!.pool_id,
          buy.usdt,
        ],
      );
      await pool.query(
        `insert into public.community_member_buy_events (chain_id,
           transaction_hash, log_index, community_id, buyer_user_id,
           block_number, outcome)
         values ($1, $2, 3, $3, $4, $5, 'skipped_no_channel')`,
        [
          chainId,
          buy.hash,
          community.rows[0]!.community_id,
          buyer.userId,
          100 + index,
        ],
      );
    }

    // A launch2 instance (graduated) with three RewardClaimed logs.
    const instance = await launch2Instance(pool, creator.userId);
    await pool.query(
      `update public.launch2_instances set graduated_at = now(), stage = 'graduated',
         price_e18 = 2000000000000000, pool_last_price_e18 = 3000000000000000,
         pool_last_trade_at = now(), pool_trade_count = 1, pool_buy_count = 1,
         official_pool_id = $2
       where instance_id = $1`,
      [instance, hex(32)],
    );
    const wallets = {
      claimer: `0x${"c1".repeat(20)}`,
      private: `0x${"c2".repeat(20)}`,
      unmapped: `0x${"c3".repeat(20)}`,
    };
    for (const [owner, address] of [
      [claimer.userId, wallets.claimer],
      [privateClaimer.userId, wallets.private],
    ] as const) {
      await pool.query(
        `insert into public.account_wallets (owner_user_id, address, kind, is_active)
         values ($1, $2, 'external', true)`,
        [owner, address],
      );
    }
    for (const [index, address] of [
      wallets.claimer,
      wallets.private,
      wallets.unmapped,
    ].entries()) {
      await pool.query(
        `insert into public.launch2_dynamic_claims (chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, hook_address,
           round_id, buyer_address, amount_usd1, claimed_at)
         values ('eip155:97', $1, $2, 10, $3, $4, $5, 2, $6,
           10940000000000000000, now())`,
        [hex(32), index, hex(32), instance, hex(20), address],
      );
    }

    const ingest = createSquareFeedIngest({
      repository,
      usd1Address: null,
      now: () => new Date(),
    });
    const first = await ingest.runOnce();
    expect(first).toMatchObject({
      kind: "completed",
      buyCount: 1,
      claimCount: 1,
      graduationCount: 1,
      insertedCount: 3,
    });
    const second = await ingest.runOnce();
    expect(second).toMatchObject({ insertedCount: 0, claimCount: 0 });
    // A duplicate source id written directly is skipped by the unique index.
    expect(
      await repository.insertEventPosts({
        posts: [
          {
            postId: randomUUID(),
            kind: "graduation",
            sourceEventId: `graduation:launch2:${instance}`,
            authorUserId: creator.userId,
            occurredAt: new Date().toISOString(),
            tokenRef: { kind: "launch2", id: instance },
            event: { transactionHash: null },
          },
        ],
      }),
    ).toBe(0);

    const feed = (await app.getFeed({
      principal: buyer.principal,
      scope: undefined,
      cursor: undefined,
      limit: 30,
    })) as Feed;
    const byKind = new Map(feed.items.map((item) => [item.kind, item]));
    expect(byKind.get("buy")).toMatchObject({
      author: { publicProfileId: buyer.publicProfileId },
      text: null,
      token: null,
      event: { amountUsd1: "12.5", tokenAmount: "5000" },
    });
    expect(byKind.get("claim")).toMatchObject({
      author: { publicProfileId: claimer.publicProfileId },
      event: { amountUsd1: "10.94", roundId: "2", weightPct: null },
      token: {
        kind: "launch2",
        instanceId: instance,
        symbol: "MEME",
        priceUsd1: "0.003",
        marketCapUsd1: "3000000",
      },
    });
    expect(byKind.get("graduation")).toMatchObject({
      author: { publicProfileId: creator.publicProfileId },
      token: { kind: "launch2", instanceId: instance },
    });
    const claimAuthors = await pool.query<{ author_user_id: string }>(
      "select author_user_id::text from public.square_posts where kind = 'claim'",
    );
    expect(claimAuthors.rows.map((row) => row.author_user_id)).toEqual([
      claimer.userId,
    ]);
  });

  it("rolls back through 000084 and up again", async () => {
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    // Down 000084 and every later migration, so a newer head keeps this
    // case valid (Decision 0145 added 000085).
    const stepsThrough000084 =
      migrations.length - migrations.indexOf("000084_square_feed.ts");
    expect(stepsThrough000084).toBeGreaterThanOrEqual(1);
    await pool.query("truncate public.square_post_likes, public.square_posts");
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "down",
      count: stepsThrough000084,
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const gone = await pool.query(
      "select to_regclass('public.square_posts') as relation",
    );
    expect(gone.rows[0]).toEqual({ relation: null });
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
  });
});

/** An activated MEME v2 instance (Decision 0139 integration fixture). */
async function launch2Instance(
  pool: InstanceType<typeof pg.Pool>,
  owner: string,
): Promise<string> {
  const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
  const review = createPostgresHooksLaunchReviewRepository(pool, {
    now: () => 1_800_000_000,
  });
  const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
  const draft = parseHooksLaunchDraft(
    {
      name: "Project",
      ticker: "MEME",
      logoAssetUrl: "https://example.com/logo.png",
      description: "Test",
      links: [],
      nftSaleStartAt: "1900000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
    },
    {
      nowUnixSeconds: "1800000000",
      minimumLeadSeconds: 86_400,
      nftSaleDurationSeconds: 604_800,
    },
  );
  const projectId = randomUUID();
  await pool.query(
    "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
    [projectId, owner],
  );
  await configs.saveOwnedDraft({
    projectId,
    ownerUserId: owner,
    expectedVersion: 0,
    templateVersion: draft.templateVersion,
    configHash: draft.configHash,
    config: draft,
    updatedByUserId: owner,
  });
  const approver = (
    await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s187b:${randomUUID()}`],
    )
  ).rows[0]!.id;
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Approver', true)",
    [approver],
  );
  await pool.query(
    "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
    [approver],
  );
  await review.execute(
    approver,
    hooksLaunchReviewCommandSchema.parse({
      operationId: randomUUID(),
      action: "launch.config.approve",
      target: projectId,
      reason: "Independent hash review",
      payload: { configVersion: 1, configHash: draft.configHash },
    }),
  );
  const projectOwner = hex(20);
  const request = {
    configHash: draft.configHash,
    projectOwner,
    configVersion: 1,
    name: draft.name,
    ticker: draft.ticker,
    nftSaleStart: draft.nftSaleStartAt,
    buybackRecipient: draft.buybackRecipient,
    deadline: "1800000900",
    nonce: "7",
    memeSalt: `0x${"00".repeat(32)}`,
  };
  const memeAddress = `${hex(18)}6666`;
  const job = await submissions.accept({
    ownerUserId: owner,
    projectId,
    idempotencyKey: randomUUID(),
    fingerprint: hex(32),
    factoryAddress: "0x1111111111111111111111111111111111111111",
    request,
    signedPayload: {
      walletId: "test-wallet",
      request,
      hookSalt: `0x${"22".repeat(32)}`,
      signature: `0x${"33".repeat(65)}`,
    },
    memeAddress,
    hookAddress: hex(20),
  });
  const instanceId = randomUUID();
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation
     ) values ($1, $2, $3, 1, $4, 'eip155:97', $5, $6, $7, $8, 'Project', 'MEME', $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       now() - interval '30 days', 1, now() - interval '31 days', true,
       'snapshot_pending', 'v3')`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      "0x1111111111111111111111111111111111111111",
      hex(32),
      draft.configHash,
      projectOwner,
      memeAddress,
      "0x0000000000000000000000000000000000000000",
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      draft.buybackRecipient,
    ],
  );
  return instanceId;
}
