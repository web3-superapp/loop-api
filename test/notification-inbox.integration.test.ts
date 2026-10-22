import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresNotificationInboxRepository } from "../src/database/notification-inbox-repository.js";
import { createPostgresNotificationRepository } from "../src/database/notification-repository.js";
import { createPostgresSocialRepository } from "../src/database/social-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0177 on PostgreSQL: migration 000098, the four inbox producers
 * (MEME v2 graduation and badge mint through the notification_inbox lane's
 * repository, friend request / acceptance inside the social transaction),
 * exactly-once rows, the emit-gated reads (feed, unread count, read-all)
 * and the at-most-once push claim. The shared test database persists, so
 * every assertion is scoped to the rows this run creates.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const inbox = createPostgresNotificationInboxRepository(pool);
const notifications = createPostgresNotificationRepository(pool);
const social = createPostgresSocialRepository(pool);
const chainId = "eip155:97";
const wad = 10n ** 18n;

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

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s286:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

interface Seeded {
  readonly instanceId: string;
  readonly poolId: string;
  readonly buybackAdapter: string;
  readonly ownerUserId: string;
}

/** An activated instance (Hooks job + approved config + registry row). */
async function instance(input: {
  readonly graduatedAt: Date | null;
  readonly listing?: "visible" | "hidden";
}): Promise<Seeded> {
  const owner = await user();
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
  const approver = await user();
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
  const request = {
    configHash: draft.configHash,
    projectOwner: hex(20),
    configVersion: 1,
    name: draft.name,
    ticker: draft.ticker,
    nftSaleStart: draft.nftSaleStartAt,
    buybackRecipient: draft.buybackRecipient,
    deadline: "1800000900",
    nonce: "7",
    memeSalt: `0x${"00".repeat(32)}`,
  };
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
    memeAddress: `${hex(18)}6666`,
    hookAddress: hex(20),
  });
  const instanceId = randomUUID();
  const poolId = hex(32);
  const buybackAdapter = hex(20);
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation, graduated_at,
       official_pool_id, price_e18, sold_supply
     ) values ($1, $2, $3, 1, $4, $5,
       '0x1111111111111111111111111111111111111111', $6, $7, $8, 'Project',
       'MEME', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       now() - interval '30 days', 1, now() - interval '20 days', true,
       $21, 'v3', $22, $23, $24, $25)`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      chainId,
      hex(32),
      draft.configHash,
      hex(20),
      `${hex(18)}6666`,
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      buybackAdapter,
      hex(20),
      hex(20),
      draft.buybackRecipient,
      input.graduatedAt === null ? "public" : "graduated",
      input.graduatedAt,
      input.graduatedAt === null ? null : poolId,
      "1000000000000",
      (1_000_000n * wad).toString(),
    ],
  );
  if (input.listing === "hidden") {
    await pool.query(
      `update public.launch2_instances set listing = 'hidden',
         listing_reason = 'test', listing_updated_at = now(),
         listing_updated_by = 'test'
       where instance_id = $1`,
      [instanceId],
    );
  }
  return { instanceId, poolId, buybackAdapter, ownerUserId: owner };
}

type Row = Record<string, unknown>;

async function wallet(ownerUserId: string): Promise<string> {
  const address = hex(20);
  await pool.query(
    `insert into public.account_wallets (owner_user_id, address, kind)
     values ($1, $2, 'external')`,
    [ownerUserId, address],
  );
  return address;
}

async function position(
  target: Seeded,
  holder: string,
  input: {
    readonly bought: bigint;
    readonly sold: bigint;
    readonly nft: number;
  },
): Promise<void> {
  await pool.query(
    `insert into public.launch2_positions (instance_id, holder_address,
       nft_held, curve_bought, curve_sold, cumulative_bought, usd1_spent,
       usd1_received, tax_usd1, buy_count, sell_count, last_activity_at)
     values ($1, $2, $3, $4, $5, $4, 0, 0, 0, 1, 0, now())`,
    [
      target.instanceId,
      holder,
      input.nft,
      input.bought.toString(),
      input.sold.toString(),
    ],
  );
}

let logIndex = 0;
async function mint(
  target: Seeded,
  payer: string,
  input: {
    readonly tokenId: number;
    readonly mintedAt: Date;
    readonly removed?: boolean;
  },
): Promise<string> {
  logIndex += 1;
  const transactionHash = hex(32);
  await pool.query(
    `insert into public.launch2_nft_mints (chain_id, transaction_hash,
       log_index, block_number, block_hash, instance_id, removed,
       payer_address, token_id, amount_usd1, minted_at)
     values ($1, $2, $3, 100, $4, $5, $6, $7, $8, $9, $10)`,
    [
      chainId,
      transactionHash,
      logIndex,
      hex(32),
      target.instanceId,
      input.removed === true,
      payer,
      input.tokenId,
      (10n * wad).toString(),
      input.mintedAt,
    ],
  );
  return transactionHash;
}

async function drain(): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const result = await inbox.produceLaunch2({
      now: new Date(),
      freshnessSeconds: 86_400,
      graduationLimit: 20,
      mintLimit: 200,
    });
    if (!result.saturated) return;
  }
  throw new Error("notification inbox did not drain");
}

async function rowsOf(dedupeKey: string): Promise<readonly Row[]> {
  const result = await pool.query<Row>(
    `select owner_user_id::text, type, event_type, entity_ref, context_route,
       context_params, payload, source, push_settled_at
     from public.notifications where dedupe_key = $1
     order by owner_user_id`,
    [dedupeKey],
  );
  return result.rows;
}

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

async function profiled(alias: string): Promise<{
  readonly ownerUserId: string;
  readonly publicProfileId: string;
}> {
  const ownerUserId = await user();
  const profile = await pool.query<{ public_profile_id: string }>(
    `insert into public.user_profiles (owner_user_id, alias)
     values ($1, $2) returning public_profile_id::text`,
    [ownerUserId, alias],
  );
  await pool.query(
    `insert into public.privacy_preferences (owner_user_id, discoverable,
       copy_trade_visibility) values ($1, true, 'private')`,
    [ownerUserId],
  );
  await pool.query(
    `insert into public.social_privacy_preferences (owner_user_id,
       friend_requests, group_invites, direct_messages)
     values ($1, 'enabled', 'friends', 'friends')`,
    [ownerUserId],
  );
  return { ownerUserId, publicProfileId: profile.rows[0]!.public_profile_id };
}

afterAll(async () => {
  await pool.end();
});

describe("Decision 0177 notification inbox on PostgreSQL", () => {
  it("applies 000098: fine event columns, lane markers and push event types", async () => {
    const applied = await pool.query<Row>(
      "select name from public.pgmigrations where name = '000098_notification_inbox_producers'",
    );
    expect(applied.rows).toHaveLength(1);
    const columns = await pool.query<Row>(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and (
         (table_name = 'notifications' and column_name in ('event_type', 'push_settled_at'))
         or (table_name = 'launch2_instances' and column_name = 'inbox_graduation_settled_at')
         or (table_name = 'launch2_nft_mints' and column_name = 'inbox_settled_at'))
       order by table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      {
        table_name: "launch2_instances",
        column_name: "inbox_graduation_settled_at",
        is_nullable: "YES",
      },
      {
        table_name: "launch2_nft_mints",
        column_name: "inbox_settled_at",
        is_nullable: "YES",
      },
      {
        table_name: "notifications",
        column_name: "event_type",
        is_nullable: "YES",
      },
      {
        table_name: "notifications",
        column_name: "push_settled_at",
        is_nullable: "YES",
      },
    ]);
    const owner = await user();
    await expect(
      pool.query(
        `insert into public.notifications (owner_user_id, type, event_type,
           entity_ref, context_route, payload, dedupe_key)
         values ($1, 'launch.graduation', 'launch.unknown', 'x:1', 'x', '{}', 'k')`,
        [owner],
      ),
    ).rejects.toMatchObject({ constraint: "notifications_event_type_check" });
    await expect(
      pool.query(
        `insert into public.notifications (owner_user_id, type, entity_ref,
           context_route, payload, dedupe_key, push_settled_at)
         values ($1, 'launch.graduation', 'x:1', 'x', '{}', 'k', now())`,
        [owner],
      ),
    ).rejects.toMatchObject({ constraint: "notifications_push_settled_check" });
    const check = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'push_deliveries_event_type_check'`,
    );
    for (const type of [
      "launch_graduated",
      "launch_badge_minted",
      "social_friend_request",
      "social_friend_accepted",
      "community_application_rejected",
    ]) {
      expect(check.rows[0]?.definition).toContain(type);
    }
    const indexes = await pool.query<Row>(
      `select indexname from pg_indexes where schemaname = 'public' and indexname in (
         'notifications_inbox_push_pending_idx',
         'launch2_instances_inbox_graduation_pending_idx',
         'launch2_nft_mints_inbox_pending_idx') order by indexname`,
    );
    expect(indexes.rows).toHaveLength(3);
  });

  it("writes one launch.graduated row per holder account and the project owner, once", async () => {
    const graduatedAt = new Date(Date.now() - 3_600_000);
    const target = await instance({ graduatedAt });
    const curveHolder = await user();
    const badgeHolder = await user();
    const soldOut = await user();
    await position(target, await wallet(curveHolder), {
      bought: 100n * wad,
      sold: 40n * wad,
      nft: 0,
    });
    await position(target, await wallet(badgeHolder), {
      bought: 0n,
      sold: 0n,
      nft: 1,
    });
    await position(target, await wallet(soldOut), {
      bought: 50n * wad,
      sold: 50n * wad,
      nft: 0,
    });
    // A wallet no LOOP account owns.
    await position(target, hex(20), { bought: wad, sold: 0n, nft: 0 });

    await drain();
    const dedupeKey = `launch.graduated:${target.instanceId}`;
    const rows = await rowsOf(dedupeKey);
    expect(rows.map((row) => row["owner_user_id"])).toEqual(
      [curveHolder, badgeHolder, target.ownerUserId].sort(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        type: "launch.graduation",
        event_type: "launch.graduated",
        entity_ref: `launch2Instance:${target.instanceId}`,
        context_route: "launch2-instance",
        context_params: { instanceId: target.instanceId },
        source: "launch2_indexer",
        push_settled_at: null,
      });
      const payload = row["payload"] as Record<string, unknown>;
      expect(payload).toMatchObject({
        event: "launch.graduated",
        title: "Project 已毕业",
        instanceId: target.instanceId,
        projectName: "Project",
        graduatedAt: graduatedAt.toISOString(),
        officialPoolId: target.poolId,
      });
      expect(payload["body"]).toContain("（北京时间）毕业");
      expect(payload["body"]).toContain("官方池 0x");
    }

    // Repeated passes and a lost marker never write a second row.
    await drain();
    await pool.query(
      `update public.launch2_instances set inbox_graduation_settled_at = null
       where instance_id = $1`,
      [target.instanceId],
    );
    await drain();
    expect(await rowsOf(dedupeKey)).toHaveLength(3);
    const marker = await pool.query<Row>(
      `select inbox_graduation_settled_at is not null as settled
       from public.launch2_instances where instance_id = $1`,
      [target.instanceId],
    );
    expect(marker.rows[0]?.["settled"]).toBe(true);
  });

  it("marks a stale or hidden graduation without writing rows", async () => {
    const stale = await instance({
      graduatedAt: new Date(Date.now() - 3 * 86_400_000),
    });
    const hidden = await instance({
      graduatedAt: new Date(Date.now() - 60_000),
      listing: "hidden",
    });
    await drain();
    for (const target of [stale, hidden]) {
      expect(await rowsOf(`launch.graduated:${target.instanceId}`)).toEqual([]);
      const marker = await pool.query<Row>(
        `select inbox_graduation_settled_at is not null as settled
         from public.launch2_instances where instance_id = $1`,
        [target.instanceId],
      );
      expect(marker.rows[0]?.["settled"]).toBe(true);
    }
  });

  it("writes one launch.badge_minted row per minted token for the minter, once", async () => {
    const target = await instance({ graduatedAt: null });
    const minter = await user();
    const payer = await wallet(minter);
    const mintedAt = new Date(Date.now() - 120_000);
    const firstHash = await mint(target, payer, { tokenId: 7, mintedAt });
    await mint(target, payer, { tokenId: 8, mintedAt });
    await mint(target, payer, { tokenId: 9, mintedAt, removed: true });
    await mint(target, payer, {
      tokenId: 10,
      mintedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await mint(target, hex(20), { tokenId: 11, mintedAt });

    await drain();
    const seven = await rowsOf(`launch.badge_minted:${target.instanceId}:7`);
    expect(seven).toHaveLength(1);
    expect(seven[0]).toMatchObject({
      owner_user_id: minter,
      type: "launch.round",
      event_type: "launch.badge_minted",
      entity_ref: `launch2Instance:${target.instanceId}`,
      context_route: "launch2-instance",
      context_params: { instanceId: target.instanceId },
      payload: {
        event: "launch.badge_minted",
        title: "Project 勋章 #7 铸造完成",
        tokenId: "7",
        projectName: "Project",
        mintedAt: mintedAt.toISOString(),
        transactionHash: firstHash,
      },
    });
    expect(
      await rowsOf(`launch.badge_minted:${target.instanceId}:8`),
    ).toHaveLength(1);
    for (const tokenId of [9, 10, 11]) {
      expect(
        await rowsOf(`launch.badge_minted:${target.instanceId}:${tokenId}`),
      ).toEqual([]);
    }
    const removed = await pool.query<Row>(
      `select token_id::text, inbox_settled_at is not null as settled
       from public.launch2_nft_mints where instance_id = $1 order by token_id::numeric`,
      [target.instanceId],
    );
    expect(removed.rows).toEqual([
      { token_id: "7", settled: true },
      { token_id: "8", settled: true },
      // A reorged-out mint stays pending: re-added, it is still notified.
      { token_id: "9", settled: false },
      { token_id: "10", settled: true },
      { token_id: "11", settled: true },
    ]);

    await pool.query(
      `update public.launch2_nft_mints set inbox_settled_at = null
       where instance_id = $1 and token_id = 7`,
      [target.instanceId],
    );
    await drain();
    expect(
      await rowsOf(`launch.badge_minted:${target.instanceId}:7`),
    ).toHaveLength(1);
  });

  it("writes social.friend_request on send and social.friend_accepted on accept, never on reject", async () => {
    const alice = await profiled(`Alice ${randomUUID().slice(0, 6)}`);
    const bob = await profiled(`Bob ${randomUUID().slice(0, 6)}`);
    const carol = await profiled(`Carol ${randomUUID().slice(0, 6)}`);
    const sendKey = randomUUID();
    const send = {
      ownerUserId: alice.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: sendKey,
      requestSha256: digest(`send:${sendKey}`),
      targetPublicProfileId: bob.publicProfileId,
    };
    const created = await social.sendFriendRequest(send);
    const friendRequestId = created.request!.friendRequestId;
    // An idempotent replay is the same command: still one row.
    await social.sendFriendRequest({ ...send, requestId: randomUUID() });
    const requestRows = await rowsOf(
      `social.friend_request:${friendRequestId}`,
    );
    expect(requestRows).toHaveLength(1);
    const aliceAlias = (
      await pool.query<{ alias: string }>(
        "select alias from public.user_profiles where owner_user_id = $1",
        [alice.ownerUserId],
      )
    ).rows[0]!.alias;
    expect(requestRows[0]).toMatchObject({
      owner_user_id: bob.ownerUserId,
      type: "community.mention",
      event_type: "social.friend_request",
      entity_ref: `friendRequest:${friendRequestId}`,
      context_route: "dm-requests",
      context_params: { friendRequestId },
      source: "social_friend_request",
      payload: {
        event: "social.friend_request",
        title: "新的好友申请",
        body: `${aliceAlias} 请求添加你为好友`,
        friendRequestId,
        publicProfileId: alice.publicProfileId,
        alias: aliceAlias,
      },
    });

    const bobAlias = (
      await pool.query<{ alias: string }>(
        "select alias from public.user_profiles where owner_user_id = $1",
        [bob.ownerUserId],
      )
    ).rows[0]!.alias;
    const acceptKey = randomUUID();
    const accept = {
      ownerUserId: bob.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: acceptKey,
      requestSha256: digest(`accept:${acceptKey}`),
      friendRequestId,
      decision: "accept" as const,
    };
    await social.decideFriendRequest(accept);
    await social.decideFriendRequest({ ...accept, requestId: randomUUID() });
    const acceptedRows = await rowsOf(
      `social.friend_accepted:${friendRequestId}`,
    );
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]).toMatchObject({
      owner_user_id: alice.ownerUserId,
      type: "community.mention",
      event_type: "social.friend_accepted",
      entity_ref: `friendRequest:${friendRequestId}`,
      context_route: "user-profile",
      context_params: { publicProfileId: bob.publicProfileId },
      payload: {
        event: "social.friend_accepted",
        title: `${bobAlias} 已接受你的好友申请`,
        publicProfileId: bob.publicProfileId,
      },
    });

    const toCarolKey = randomUUID();
    const toCarol = await social.sendFriendRequest({
      ownerUserId: alice.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: toCarolKey,
      requestSha256: digest(`send:${toCarolKey}`),
      targetPublicProfileId: carol.publicProfileId,
    });
    const rejectedId = toCarol.request!.friendRequestId;
    const rejectKey = randomUUID();
    await social.decideFriendRequest({
      ownerUserId: carol.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: rejectKey,
      requestSha256: digest(`reject:${rejectKey}`),
      friendRequestId: rejectedId,
      decision: "reject",
    });
    expect(await rowsOf(`social.friend_request:${rejectedId}`)).toHaveLength(1);
    expect(await rowsOf(`social.friend_accepted:${rejectedId}`)).toEqual([]);
    const aliceRows = await pool.query<Row>(
      `select event_type from public.notifications where owner_user_id = $1`,
      [alice.ownerUserId],
    );
    expect(aliceRows.rows).toEqual([{ event_type: "social.friend_accepted" }]);
    // The accept also queued the pair's direct channel (Decision 0172); this
    // suite runs no Stream lane, so the job must not leak into the next one.
    await pool.query(
      `delete from public.friend_direct_channel_jobs
       where owner_user_id = any($1::uuid[])`,
      [[alice.ownerUserId, bob.ownerUserId, carol.ownerUserId]],
    );
  });

  it("hides fine events from the feed, the unread count and read-all unless included", async () => {
    const owner = await user();
    const legacy = await notifications.record({
      ownerUserId: owner,
      type: "trade.priceAlert",
      entityRef: `priceAlert:${randomUUID()}`,
      contextRoute: "token",
      contextParams: {},
      payload: { event: "price" },
      dedupeKey: `legacy:${randomUUID()}`,
      source: null,
      observedAt: null,
    });
    const fine = await notifications.record({
      ownerUserId: owner,
      type: "launch.graduation",
      eventType: "launch.graduated",
      entityRef: `launch2Instance:${randomUUID()}`,
      contextRoute: "launch2-instance",
      contextParams: {},
      payload: { event: "launch.graduated" },
      dedupeKey: `launch.graduated:${randomUUID()}`,
      source: "launch2_indexer",
      observedAt: null,
    });
    expect(legacy?.eventType).toBeNull();
    expect(fine?.eventType).toBe("launch.graduated");

    const hidden = await notifications.listFeed({
      ownerUserId: owner,
      limit: 10,
    });
    expect(hidden.items.map((item) => item.notificationId)).toEqual([
      legacy!.notificationId,
    ]);
    expect(hidden.unreadCount).toBe(1);
    const shown = await notifications.listFeed({
      ownerUserId: owner,
      limit: 10,
      includeInboxEvents: true,
    });
    expect(shown.items).toHaveLength(2);
    expect(shown.unreadCount).toBe(2);
    await expect(
      notifications.countUnread({
        ownerUserId: owner,
        includeInboxEvents: false,
      }),
    ).resolves.toBe(1);
    await expect(
      notifications.markRead(owner, fine!.notificationId, false),
    ).resolves.toBeNull();

    await expect(
      notifications.markAllRead({
        ownerUserId: owner,
        includeInboxEvents: false,
      }),
    ).resolves.toBe(1);
    await expect(
      notifications.countUnread({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).resolves.toBe(1);
    await expect(
      notifications.markAllRead({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).resolves.toBe(1);
    await expect(
      notifications.markAllRead({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).resolves.toBe(0);
    await expect(
      notifications.countUnread({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).resolves.toBe(0);
  });

  it("claims each fresh fine event for push once and settles stale ones without a push", async () => {
    const owner = await user();
    const freshKey = `social.friend_request:${randomUUID()}`;
    const staleKey = `social.friend_request:${randomUUID()}`;
    for (const dedupeKey of [freshKey, staleKey]) {
      await notifications.record({
        ownerUserId: owner,
        type: "community.mention",
        eventType: "social.friend_request",
        entityRef: `friendRequest:${randomUUID()}`,
        contextRoute: "dm-requests",
        contextParams: {},
        payload: { event: "social.friend_request" },
        dedupeKey,
        source: "social_friend_request",
        observedAt: null,
      });
    }
    await pool.query(
      `update public.notifications set created_at = now() - interval '2 hours'
       where owner_user_id = $1 and dedupe_key = $2`,
      [owner, staleKey],
    );
    const settled = await inbox.settleStalePushes({
      now: new Date(),
      freshnessSeconds: 1_800,
    });
    expect(settled).toBeGreaterThanOrEqual(1);
    const claimed = [];
    for (let pass = 0; pass < 50; pass += 1) {
      const batch = await inbox.claimPushes({
        now: new Date(),
        freshnessSeconds: 1_800,
        limit: 100,
      });
      claimed.push(...batch.filter((claim) => claim.ownerUserId === owner));
      if (batch.length < 100) break;
    }
    expect(claimed).toEqual([
      expect.objectContaining({
        ownerUserId: owner,
        eventType: "social.friend_request",
        contextRoute: "dm-requests",
        dedupeKey: freshKey,
      }),
    ]);
    const again = await inbox.claimPushes({
      now: new Date(),
      freshnessSeconds: 1_800,
      limit: 100,
    });
    expect(again.filter((claim) => claim.ownerUserId === owner)).toEqual([]);
    const rows = await pool.query<Row>(
      `select dedupe_key, push_settled_at is not null as settled
       from public.notifications where owner_user_id = $1 order by dedupe_key`,
      [owner],
    );
    expect(rows.rows.every((row) => row["settled"] === true)).toBe(true);
  });
});
