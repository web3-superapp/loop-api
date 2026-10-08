import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMemberBuyFeedRepository } from "../src/database/member-buy-feed-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import { CommunityBoundAssetNotRegisteredError } from "../src/features/community/community-repository.js";
import { feedCursorWholeBlockLogIndex } from "../src/features/community/member-buy-feed-repository.js";
import {
  createMemberBuyFeedService,
  memberBuyMessageId,
  type MemberBuyFeedSender,
} from "../src/features/community/member-buy-feed-service.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0097 against PostgreSQL: migration 000047, the bound-asset rule
 * and projection, and the `community_member_buy_feed` lane over the indexer
 * tables.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const chainId = "eip155:56";
const frogAddress = "0x1111111111111111111111111111111111111111";
const usdtAddress = "0x55d398326f99059ff775485246999027b3197955";
const frogAssetId = `${chainId}:${frogAddress}`;
const usdtAssetId = `${chainId}:${usdtAddress}`;
const unregisteredAssetId = `${chainId}:0x9999999999999999999999999999999999999999`;
const poolAddress = "0x2222222222222222222222222222222222222222";
const routerAddress = "0x3333333333333333333333333333333333333333";
const publicWallet = "0x4444444444444444444444444444444444444444";
const privateWallet = "0x5555555555555555555555555555555555555555";
const blockHash = `0x${"e".repeat(64)}`;

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

function tx(seed: string): string {
  return `0x${seed.repeat(64).slice(0, 64)}`;
}

describe("Decision 0097 community member buy feed on PostgreSQL", () => {
  const databaseName = `loop_s108_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let poolId: string;

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
    for (const [assetId, address, symbol] of [
      [frogAssetId, frogAddress, "FROG"],
      [usdtAssetId, usdtAddress, "USDT"],
    ] as const) {
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          ) values ($1, $2, $3, $4, $4 || ' Token', 18, 'verified', 'chain_call', 1, clock_timestamp())
        `,
        values: [assetId, chainId, address, symbol],
      });
    }
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function account(alias: string): Promise<{
    userId: string;
    publicProfileId: string;
  }> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s108:${randomUUID()}`,
    );
    await createPostgresProfileV2Repository(pool).activateProfile({
      ownerUserId: user.id,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(
        { alias, avatarRef: null, interests: [] },
        "2.0",
      ),
      requestId: randomUUID(),
      profile: { alias, avatarRef: null, interests: [] },
    });
    const row = await pool.query<{ public_profile_id: string }>({
      text: `select public_profile_id from public.user_profiles where owner_user_id = $1`,
      values: [user.id],
    });
    return {
      userId: user.id,
      publicProfileId: row.rows[0]?.public_profile_id ?? "",
    };
  }

  async function swap(input: {
    readonly hash: string;
    readonly block: number;
    readonly logIndex?: number;
    readonly buy: boolean;
    readonly recipient: string;
    readonly removed?: boolean;
  }): Promise<void> {
    await pool.query({
      text: `
        insert into public.indexed_pool_events (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          pool_id, event_kind, payload, block_timestamp, amount0, amount1,
          sqrt_price_x96, removed
        ) values ($1, $2, $3, $4::bigint, $5, $6, 'swap', $7::jsonb,
                  '2026-10-08T00:00:00Z'::timestamptz, $8::numeric, $9::numeric,
                  79228162514264337593543950336, $10)
      `,
      values: [
        chainId,
        input.hash,
        input.logIndex ?? 7,
        input.block,
        blockHash,
        poolId,
        JSON.stringify({ sender: routerAddress, recipient: input.recipient }),
        input.buy ? "-5000000000000000000" : "5000000000000000000",
        input.buy ? "2000000000000000000" : "-2000000000000000000",
        input.removed ?? false,
      ],
    });
  }

  async function checkpoint(block: number): Promise<void> {
    await pool.query({
      text: `
        insert into public.indexer_checkpoints (
          lane, chain_id, last_block_number, last_block_hash, started_from_block_number
        ) values ('pool_event', $1, $2, $3, 1)
        on conflict (lane, chain_id) do update set
          last_block_number = excluded.last_block_number,
          updated_at = clock_timestamp()
      `,
      values: [chainId, block, blockHash],
    });
  }

  it("is the migration head with both lane tables", async () => {
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
    expect(Number(latestMigrationName.slice(0, 6)) >= 47).toBe(true);
    await expect(
      pool.query({
        text: `
          insert into public.community_feed_cursors (lane, chain_id, last_block_number, last_log_index)
          values ('somebody_else', $1, 1, 0)
        `,
        values: [chainId],
      }),
    ).rejects.toThrow(/community_feed_cursors_lane_check/);
  });

  it("posts one public member buy, records the rest, never re-sends, and never passes the checkpoint", async () => {
    const community = createPostgresCommunityRepository(pool);
    const owner = await account("feed_owner");
    const publicMember = await account("feed_public");
    const privateMember = await account("feed_private");

    // Decision 0097 §1.3: an unknown asset is refused; a registered one is
    // accepted even before it has a pool.
    const create = (slug: string, boundAssetKey: string | null) =>
      community.createCommunity({
        ownerUserId: owner.userId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "createCommunity", [
          slug,
          boundAssetKey ?? "",
        ]),
        requestId: randomUUID(),
        name: slug,
        slug,
        description: null,
        logoRef: null,
        boundAssetKey,
      });
    await expect(
      create("feed-unknown", unregisteredAssetId),
    ).rejects.toBeInstanceOf(CommunityBoundAssetNotRegisteredError);
    const created = await create("feed-frogs", frogAssetId);
    expect(created.community.boundAsset).toEqual({
      assetId: frogAssetId,
      symbol: "FROG",
      name: "FROG Token",
      hasRegisteredPool: false,
    });
    const communityId = created.community.communityId;

    const poolRow = await pool.query<{ pool_id: string }>({
      text: `
        insert into public.pools (
          chain_id, protocol, address, token0_asset_id, token1_asset_id, fee,
          tick_spacing, source_block_number, source_verified_at
        ) values ($1, 'pancakeswap_v3', $2, $3, $4, 2500, 50, 1, clock_timestamp())
        returning pool_id
      `,
      values: [chainId, poolAddress, frogAssetId, usdtAssetId],
    });
    poolId = poolRow.rows[0]?.pool_id ?? "";

    await community.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    const detail = await community.getCommunity({
      viewerUserId: owner.userId,
      communityId,
    });
    expect(detail.community.boundAsset).toMatchObject({
      hasRegisteredPool: true,
    });
    const channel = await pool.query<{ stream_channel_id: string }>({
      text: `
        update public.community_channels
        set provisioned_at = clock_timestamp()
        where community_id = $1
        returning stream_channel_id
      `,
      values: [communityId],
    });
    const streamChannelId = channel.rows[0]?.stream_channel_id ?? "";
    expect(streamChannelId).toMatch(/^loop_community_[0-9a-f]{32}$/);

    for (const [member, wallet] of [
      [publicMember, publicWallet],
      [privateMember, privateWallet],
    ] as const) {
      await pool.query({
        text: `insert into public.community_memberships (community_id, owner_user_id, role, status) values ($1, $2, 'member', 'active')`,
        values: [communityId, member.userId],
      });
      await pool.query({
        text: `insert into public.account_wallets (owner_user_id, address, kind, is_active) values ($1, $2, 'external', true)`,
        values: [member.userId, wallet],
      });
    }
    await pool.query({
      text: `insert into public.privacy_preferences_v2 (owner_user_id, trade_history_visibility) values ($1, 'self')`,
      values: [privateMember.userId],
    });

    const sendCommunityFeedMessage = vi.fn<
      MemberBuyFeedSender["sendCommunityFeedMessage"]
    >((input) =>
      Promise.resolve({ status: "sent" as const, messageId: input.messageId }),
    );
    const repository = createPostgresMemberBuyFeedRepository(pool);
    const service = createMemberBuyFeedService({
      repository,
      sender: { sendCommunityFeedMessage },
      chainId,
      usd1Address: null,
    });
    const signal = new AbortController().signal;

    // Before the indexer has a checkpoint the lane idles.
    await expect(service.runOnce(signal)).resolves.toMatchObject({
      kind: "indexer_not_started",
    });

    // History below the first checkpoint is never replayed.
    await swap({
      hash: tx("0"),
      block: 900,
      buy: true,
      recipient: publicWallet,
    });
    await checkpoint(1_000);
    await expect(service.runOnce(signal)).resolves.toMatchObject({
      kind: "cursor_initialized",
    });
    await expect(repository.readCursor(chainId)).resolves.toEqual({
      blockNumber: "1000",
      logIndex: feedCursorWholeBlockLogIndex,
    });

    await swap({
      hash: tx("1"),
      block: 1_001,
      buy: true,
      recipient: publicWallet,
    });
    await swap({
      hash: tx("2"),
      block: 1_001,
      logIndex: 9,
      buy: false,
      recipient: publicWallet,
    });
    await swap({
      hash: tx("3"),
      block: 1_002,
      buy: true,
      recipient: privateWallet,
    });
    await swap({
      hash: tx("4"),
      block: 1_002,
      logIndex: 8,
      buy: true,
      recipient: publicWallet,
      removed: true,
    });
    // Above the checkpoint: the indexer has not committed it yet.
    await swap({
      hash: tx("5"),
      block: 1_003,
      buy: true,
      recipient: publicWallet,
    });
    await checkpoint(1_002);

    await expect(service.runOnce(signal)).resolves.toMatchObject({
      kind: "completed",
      examinedSwapCount: 3,
      sentCount: 1,
      skippedCount: 2,
    });
    expect(sendCommunityFeedMessage).toHaveBeenCalledOnce();
    const sent = sendCommunityFeedMessage.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      streamChannelId,
      messageId: memberBuyMessageId({
        chainId,
        transactionHash: tx("1"),
        logIndex: 7,
        communityId,
      }),
      text: "群友买入 · FROG",
      custom: {
        loop_schema: "member_buy.v1",
        loop_event_kind: "memberBuy",
        publicProfileId: publicMember.publicProfileId,
        assetId: frogAssetId,
        symbol: "FROG",
        decimals: 18,
        quoteSymbol: "USDT",
        quoteDecimals: 18,
        chainId,
        amountRaw: "5000000000000000000",
        quoteAssetId: usdtAssetId,
        quoteAmountRaw: "2000000000000000000",
        quoteIsStable: true,
        txHash: tx("1"),
        logIndex: 7,
        blockNumber: "1001",
        blockTimestamp: "2026-10-08T00:00:00.000Z",
      },
    });
    // blockTimestamp is always an ISO-8601 UTC string, never seconds.
    expect(sent?.custom["blockTimestamp"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    const rows = await pool.query<{
      transaction_hash: string;
      buyer_user_id: string;
      outcome: string;
      stream_message_id: string | null;
    }>({
      text: `
        select transaction_hash, buyer_user_id, outcome, stream_message_id
        from public.community_member_buy_events
        order by block_number, log_index
      `,
    });
    expect(rows.rows).toEqual([
      {
        transaction_hash: tx("1"),
        buyer_user_id: publicMember.userId,
        outcome: "sent",
        stream_message_id: sent?.messageId,
      },
      {
        transaction_hash: tx("2"),
        buyer_user_id: publicMember.userId,
        outcome: "skipped_not_buy",
        stream_message_id: null,
      },
      {
        transaction_hash: tx("3"),
        buyer_user_id: privateMember.userId,
        outcome: "skipped_private",
        stream_message_id: null,
      },
    ]);
    await expect(repository.readCursor(chainId)).resolves.toEqual({
      blockNumber: "1002",
      logIndex: feedCursorWholeBlockLogIndex,
    });

    // A repeated pass with no new checkpoint reads nothing and sends nothing.
    await expect(service.runOnce(signal)).resolves.toMatchObject({
      kind: "waiting_for_indexer",
    });
    // Even a forced re-read of the same window sends nothing again.
    await pool.query(
      `update public.community_feed_cursors set last_block_number = 1000`,
    );
    await service.runOnce(signal);
    expect(sendCommunityFeedMessage).toHaveBeenCalledOnce();

    // The indexer commits block 1003: the held swap is posted.
    await checkpoint(1_003);
    await expect(service.runOnce(signal)).resolves.toMatchObject({
      sentCount: 1,
    });
    expect(sendCommunityFeedMessage).toHaveBeenCalledTimes(2);
    expect(sendCommunityFeedMessage.mock.calls[1]?.[0].custom).toMatchObject({
      txHash: tx("5"),
    });

    // The bound key that is not changing is not re-validated (a pre-0097
    // community keeps editing), but a new unknown key is refused.
    await pool.query({
      text: `update public.communities set bound_asset_key = $2 where community_id = $1`,
      values: [communityId, unregisteredAssetId],
    });
    const update = (values: Record<string, string | null>) =>
      community.updateCommunity({
        ownerUserId: owner.userId,
        communityId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "updateCommunity", [
          communityId,
          JSON.stringify(values),
        ]),
        requestId: randomUUID(),
        values,
      });
    await expect(
      update({ description: "frogs", boundAssetKey: unregisteredAssetId }),
    ).resolves.toMatchObject({
      community: { description: "frogs", boundAsset: null },
    });
    await expect(
      update({
        boundAssetKey: `${chainId}:0x8888888888888888888888888888888888888888`,
      }),
    ).rejects.toBeInstanceOf(CommunityBoundAssetNotRegisteredError);
    await expect(update({ boundAssetKey: frogAssetId })).resolves.toMatchObject(
      { community: { boundAssetKey: frogAssetId } },
    );
  });

  it("rolls 000047 back and forward", async () => {
    const migrate = (direction: "up" | "down", count?: number) =>
      runner({
        databaseUrl: url,
        dir: migrationsDirectory,
        direction,
        migrationsTable: "pgmigrations",
        log: () => undefined,
        ...(count === undefined ? {} : { count }),
      });
    const above = (
      await pool.query<{ count: string }>(
        `select count(*)::text as count from public.pgmigrations where name > '000047_v2_community_member_buy_feed'`,
      )
    ).rows[0]?.count;
    await migrate("down", Number(above ?? "0") + 1);
    const gone = await pool.query<{ exists: boolean }>(
      `select to_regclass('public.community_member_buy_events') is not null as exists`,
    );
    expect(gone.rows[0]?.exists).toBe(false);
    await migrate("up");
    const back = await pool.query<{ exists: boolean }>(
      `select to_regclass('public.community_member_buy_events') is not null as exists`,
    );
    expect(back.rows[0]?.exists).toBe(true);
  });
});
