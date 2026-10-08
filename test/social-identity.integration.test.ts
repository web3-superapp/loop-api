import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMediaRepository } from "../src/database/media-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { createPostgresPublicProfileRepository } from "../src/database/public-profile-repository.js";
import { createPostgresStreamUserIdentityRepository } from "../src/database/stream-user-identity-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import { CommunityLogoMediaRejectedError } from "../src/features/community/community-repository.js";
import { MediaIdempotencyConflictError } from "../src/features/media/media-storage.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import {
  PublicProfileIdempotencyConflictError,
  PublicProfileTargetNotFoundError,
} from "../src/features/profile/public-profile-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0095 against PostgreSQL: migration 000046, media storage, public
 * profile reads, friend removal, trades over the indexer tables, Stream
 * identities, recommended communities, and the community logo rule.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const chainId = "eip155:56";
const tokenAddress = "0x1111111111111111111111111111111111111111";
const usdtAddress = "0x55d398326f99059ff775485246999027b3197955";
const tokenAssetId = `${chainId}:${tokenAddress}`;
const usdtAssetId = `${chainId}:${usdtAddress}`;
const poolAddress = "0x2222222222222222222222222222222222222222";
const routerAddress = "0x3333333333333333333333333333333333333333";
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

describe("Decision 0095 social identity on PostgreSQL", () => {
  const databaseName = `loop_s107_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;

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
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function account(
    alias: string,
    avatarRef: string | null = null,
  ): Promise<{ userId: string; publicProfileId: string; loopId: string }> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s107:${randomUUID()}`,
    );
    await createPostgresProfileV2Repository(pool).activateProfile({
      ownerUserId: user.id,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(
        { alias, avatarRef, interests: [] },
        "2.0",
      ),
      requestId: randomUUID(),
      profile: { alias, avatarRef, interests: [] },
    });
    const row = await pool.query<{
      public_profile_id: string;
      loop_id: string;
    }>({
      text: `
        select profile.public_profile_id, account.loop_id
        from public.user_profiles as profile
        join public.loop_users as account on account.id = profile.owner_user_id
        where profile.owner_user_id = $1
      `,
      values: [user.id],
    });
    const found = row.rows[0];
    if (found === undefined) {
      throw new Error("profile setup failed");
    }
    return {
      userId: user.id,
      publicProfileId: found.public_profile_id,
      loopId: found.loop_id,
    };
  }

  async function befriend(
    first: string,
    second: { userId: string; publicProfileId: string },
  ): Promise<void> {
    const community = createPostgresCommunityRepository(pool);
    const sent = await community.sendMessageRequest({
      ownerUserId: first,
      targetPublicProfileId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "sendMessageRequest", [
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    await community.decideMessageRequest({
      ownerUserId: second.userId,
      messageRequestId: sent.messageRequestId,
      decision: "accept",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
        sent.messageRequestId,
        "accept",
      ]),
      requestId: randomUUID(),
    });
  }

  it("is the migration head and flips the holdings/trades defaults to everyone", async () => {
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
    expect(latestMigrationName).toBe("000046_v2_social_identity");
    const user = await account("defaults_probe");
    await pool.query({
      text: "insert into public.privacy_preferences_v2 (owner_user_id) values ($1)",
      values: [user.userId],
    });
    const stored = await pool.query({
      text: `
        select total_assets_visibility, trade_history_visibility,
               mining_power_visibility, communities_visibility
        from public.privacy_preferences_v2 where owner_user_id = $1
      `,
      values: [user.userId],
    });
    expect(stored.rows[0]).toEqual({
      total_assets_visibility: "everyone",
      trade_history_visibility: "everyone",
      mining_power_visibility: "self",
      communities_visibility: "self",
    });
  });

  it("stores immutable media objects with owner-scoped idempotency", async () => {
    const owner = await account("media_owner");
    const media = createPostgresMediaRepository(pool);
    const mediaId = randomUUID();
    const key = randomUUID();
    const input = {
      mediaId,
      ownerUserId: owner.userId,
      kind: "avatar" as const,
      bytes: Buffer.from("RIFF0000WEBPVP8 test"),
      width: 512,
      height: 512,
      sha256: "a".repeat(64),
      idempotencyKey: key,
      requestSha256: "b".repeat(64),
    };
    const stored = await media.put(input);
    expect(stored).toMatchObject({ mediaId, kind: "avatar", width: 512 });
    // Same key and payload: the first object, not a second row.
    await expect(
      media.put({ ...input, mediaId: randomUUID() }),
    ).resolves.toMatchObject({ mediaId });
    await expect(
      media.put({
        ...input,
        mediaId: randomUUID(),
        requestSha256: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(MediaIdempotencyConflictError);
    await expect(
      media.findByIdempotencyKey({
        ownerUserId: owner.userId,
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ mediaId, requestSha256: "b".repeat(64) });
    const read = await media.get(mediaId);
    expect(read?.bytes.equals(input.bytes)).toBe(true);
    await expect(media.get(randomUUID())).resolves.toBeNull();
    await expect(
      pool.query({
        text: "update public.media_objects set width = 1 where media_id = $1",
        values: [mediaId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          insert into public.media_objects (
            media_id, owner_user_id, kind, content_type, bytes, width, height,
            sha256, idempotency_key, request_sha256
          ) values ($1, $2, 'avatar', 'image/png', '\\x00', 1, 1, $3, $4, $3)
        `,
        values: [randomUUID(), owner.userId, "a".repeat(64), randomUUID()],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("reads a public profile with counts, relationship, and visibility", async () => {
    const viewer = await account("viewer_one");
    const target = await account("target_one", "avatar:preset/monogram");
    const repository = createPostgresPublicProfileRepository(pool);
    const community = createPostgresCommunityRepository(pool);
    await community
      .follow({
        ownerUserId: viewer.userId,
        targetPublicProfileId: target.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "follow", [
          target.publicProfileId,
        ]),
        requestId: randomUUID(),
      })
      .catch(() => undefined);
    await pool.query({
      text: `insert into public.follow_edges (follower_user_id, followee_user_id) values ($1, $2) on conflict do nothing`,
      values: [viewer.userId, target.userId],
    });
    await pool.query({
      text: `insert into public.privacy_preferences_v2 (owner_user_id, total_assets_visibility) values ($1, 'self')`,
      values: [target.userId],
    });

    const byId = await repository.findProfile({
      viewerUserId: viewer.userId,
      lookup: { publicProfileId: target.publicProfileId },
    });
    expect(byId).toMatchObject({
      targetUserId: target.userId,
      publicProfileId: target.publicProfileId,
      loopId: target.loopId,
      alias: "target_one",
      avatarRef: "avatar:preset/monogram",
      counts: { followers: 1, following: 0, communities: 0 },
      relationship: {
        following: true,
        followedBy: false,
        friendship: "none",
        blocked: false,
        blockedBy: false,
      },
      visibility: { totalAssets: "self", tradeHistory: "everyone" },
    });
    expect(byId?.joinedAt).toEqual(expect.any(String));
    await expect(
      repository.findProfile({
        viewerUserId: viewer.userId,
        lookup: { loopId: target.loopId },
      }),
    ).resolves.toMatchObject({ publicProfileId: target.publicProfileId });
    await expect(
      repository.findProfile({
        viewerUserId: viewer.userId,
        lookup: { publicProfileId: randomUUID() },
      }),
    ).resolves.toBeNull();

    // The target blocks the viewer: the read reports blockedBy for the 404.
    await community.blockUser({
      ownerUserId: target.userId,
      stableId: viewer.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "block", [
        "user",
        viewer.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    await expect(
      repository.findProfile({
        viewerUserId: viewer.userId,
        lookup: { publicProfileId: target.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { blockedBy: true } });
  });

  it("reports pending requests and friendships, then removes a friendship idempotently", async () => {
    const viewer = await account("friend_viewer");
    const target = await account("friend_target");
    const repository = createPostgresPublicProfileRepository(pool);
    const community = createPostgresCommunityRepository(pool);
    await community.sendMessageRequest({
      ownerUserId: viewer.userId,
      targetPublicProfileId: target.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "sendMessageRequest", [
        target.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    await expect(
      repository.findProfile({
        viewerUserId: viewer.userId,
        lookup: { publicProfileId: target.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { friendship: "pending_out" } });
    await expect(
      repository.findProfile({
        viewerUserId: target.userId,
        lookup: { publicProfileId: viewer.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { friendship: "pending_in" } });

    const other = await account("friend_other");
    await befriend(other.userId, target);
    await expect(
      repository.findProfile({
        viewerUserId: other.userId,
        lookup: { publicProfileId: target.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { friendship: "friends" } });

    const key = randomUUID();
    const command = {
      ownerUserId: other.userId,
      targetPublicProfileId: target.publicProfileId,
      idempotencyKey: key,
      requestSha256: commandDigest("socialGraph", "removeFriend", [
        target.publicProfileId,
      ]),
      requestId: randomUUID(),
    };
    await expect(repository.removeFriend(command)).resolves.toEqual({
      publicProfileId: target.publicProfileId,
      removed: true,
    });
    // Replay returns the first result even though nothing is left to delete.
    await expect(
      repository.removeFriend({ ...command, requestId: randomUUID() }),
    ).resolves.toEqual({
      publicProfileId: target.publicProfileId,
      removed: true,
    });
    await expect(
      repository.removeFriend({
        ...command,
        targetPublicProfileId: viewer.publicProfileId,
        requestSha256: commandDigest("socialGraph", "removeFriend", [
          viewer.publicProfileId,
        ]),
      }),
    ).rejects.toBeInstanceOf(PublicProfileIdempotencyConflictError);
    await expect(
      repository.removeFriend({
        ...command,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).resolves.toEqual({
      publicProfileId: target.publicProfileId,
      removed: false,
    });
    await expect(
      repository.removeFriend({
        ...command,
        targetPublicProfileId: other.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "removeFriend", [
          other.publicProfileId,
        ]),
      }),
    ).rejects.toBeInstanceOf(PublicProfileTargetNotFoundError);

    const audit = await pool.query<{ result_status: string }>({
      text: `
        select result_status from public.social_graph_events
        where actor_user_id = $1 and event_type = 'friendship_removed'
        order by occurred_at
      `,
      values: [other.userId],
    });
    expect(audit.rows.map((row) => row.result_status)).toEqual([
      "removed",
      "absent",
    ]);
    await expect(
      repository.findProfile({
        viewerUserId: other.userId,
        lookup: { publicProfileId: target.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { friendship: "none" } });
    // A new request between the pair is accepted into a new friendship.
    await befriend(other.userId, target);
    await expect(
      repository.findProfile({
        viewerUserId: other.userId,
        lookup: { publicProfileId: target.publicProfileId },
      }),
    ).resolves.toMatchObject({ relationship: { friendship: "friends" } });
    await expect(
      pool.query({
        text: "update public.friendships set accepted_at = accepted_at",
      }),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("lists swaps and transfers of the active wallet newest first with keyset paging", async () => {
    const owner = await account("trader");
    const repository = createPostgresPublicProfileRepository(pool);
    const wallet = `0x${"a".repeat(40)}`;
    await pool.query({
      text: `insert into public.account_wallets (owner_user_id, address, kind, is_active) values ($1, $2, 'external', true)`,
      values: [owner.userId, wallet],
    });
    await expect(
      repository.getActiveWallet(owner.userId),
    ).resolves.toMatchObject({ address: wallet });
    await expect(repository.hasTransferCheckpoint(chainId)).resolves.toBe(
      false,
    );
    for (const [assetId, address, symbol] of [
      [tokenAssetId, tokenAddress, "FROG"],
      [usdtAssetId, usdtAddress, "USDT"],
    ] as const) {
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          ) values ($1, $2, $3, $4, $4, 18, 'verified', 'chain_call', 1, clock_timestamp())
          on conflict (asset_id) do nothing
        `,
        values: [assetId, chainId, address, symbol],
      });
    }
    const poolRow = await pool.query<{ pool_id: string }>({
      text: `
        insert into public.pools (
          chain_id, protocol, address, token0_asset_id, token1_asset_id, fee,
          tick_spacing, source_block_number, source_verified_at
        ) values ($1, 'pancakeswap_v3', $2, $3, $4, 2500, 50, 1, clock_timestamp())
        returning pool_id
      `,
      values: [chainId, poolAddress, tokenAssetId, usdtAssetId],
    });
    const poolId = poolRow.rows[0]?.pool_id;
    const swap = (
      hash: string,
      block: number,
      recipientOrSender: Record<string, string>,
    ) =>
      pool.query({
        text: `
          insert into public.indexed_pool_events (
            chain_id, transaction_hash, log_index, block_number, block_hash,
            pool_id, event_kind, payload, block_timestamp, amount0, amount1,
            sqrt_price_x96
          ) values ($1, $2, 3, $3::bigint, $4, $5, 'swap', $6::jsonb,
                    '2026-10-01T00:00:00Z'::timestamptz + make_interval(secs => $3::bigint::double precision),
                    -5000000000000000000, 2000000000000000000, 79228162514264337593543950336)
        `,
        values: [
          chainId,
          hash,
          block,
          blockHash,
          poolId,
          JSON.stringify(recipientOrSender),
        ],
      });
    await swap(tx("1"), 100, { sender: routerAddress, recipient: wallet });
    await swap(tx("2"), 200, { sender: wallet, recipient: routerAddress });
    await swap(tx("3"), 300, {
      sender: routerAddress,
      recipient: routerAddress,
    });
    const transfer = (hash: string, block: number, from: string, to: string) =>
      pool.query({
        text: `
          insert into public.indexed_transfers (
            chain_id, transaction_hash, log_index, block_number, block_hash,
            asset_id, from_address, to_address, raw_value
          ) values ($1, $2, 1, $3, $4, $5, $6, $7, 1500000000000000000)
        `,
        values: [chainId, hash, block, blockHash, usdtAssetId, from, to],
      });
    // A transfer leg of a matched swap is not listed separately.
    await transfer(tx("1"), 100, poolAddress, wallet);
    await transfer(tx("4"), 150, routerAddress, wallet);
    await transfer(tx("5"), 400, wallet, routerAddress);
    await transfer(tx("6"), 500, wallet, wallet);
    await pool.query({
      text: `
        insert into public.indexer_checkpoints (lane, chain_id, last_block_number, last_block_hash, started_from_block_number)
        values ('erc20_transfer', $1, 1000, $2, 1)
        on conflict do nothing
      `,
      values: [chainId, blockHash],
    });
    await expect(repository.hasTransferCheckpoint(chainId)).resolves.toBe(true);

    const first = await repository.listTrades({
      chainId,
      address: wallet,
      limit: 2,
    });
    expect(first.hasMore).toBe(true);
    expect(first.items).toEqual([
      expect.objectContaining({
        source: "transfer",
        transactionHash: tx("5"),
        direction: "out",
        blockNumber: "400",
        blockTimestamp: null,
      }),
      expect.objectContaining({
        source: "swap",
        transactionHash: tx("2"),
        token0AssetId: tokenAssetId,
        token1AssetId: usdtAssetId,
        amount0: "-5000000000000000000",
        amount1: "2000000000000000000",
      }),
    ]);
    const last = first.items.at(-1);
    const second = await repository.listTrades({
      chainId,
      address: wallet,
      limit: 2,
      before: {
        blockNumber: last?.blockNumber ?? "0",
        logIndex: last?.logIndex ?? 0,
      },
    });
    expect(second.hasMore).toBe(false);
    expect(
      second.items.map((item) => [item.source, item.transactionHash]),
    ).toEqual([
      ["transfer", tx("4")],
      ["swap", tx("1")],
    ]);
    // A transfer in a block with an indexed pool event takes its time.
    await transfer(tx("7"), 300, routerAddress, wallet);
    const timed = await repository.listTrades({
      chainId,
      address: wallet,
      limit: 10,
    });
    expect(
      timed.items.find((item) => item.transactionHash === tx("7"))
        ?.blockTimestamp,
    ).toBe("2026-10-01T00:05:00.000Z");
  });

  it("projects Stream identities and lists activated accounts in order", async () => {
    const user = await account("stream_named", "avatar:preset/people-01");
    const pending = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s107:${randomUUID()}`,
    );
    await pool.query({
      text: `insert into public.user_profiles (owner_user_id) values ($1)`,
      values: [pending.id],
    });
    const identities = createPostgresStreamUserIdentityRepository(pool);
    await expect(
      identities.listIdentities([user.userId, randomUUID()]),
    ).resolves.toEqual([
      {
        userId: user.userId,
        alias: "stream_named",
        avatarRef: "avatar:preset/people-01",
        publicProfileId: user.publicProfileId,
      },
    ]);
    // A profile that is not active never publishes its public profile ID.
    await expect(identities.listIdentities([pending.id])).resolves.toEqual([
      {
        userId: pending.id,
        alias: null,
        avatarRef: null,
        publicProfileId: null,
      },
    ]);
    const all: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await identities.listActivatedUserIds({
        afterUserId: after,
        limit: 2,
      });
      if (page.length === 0) {
        break;
      }
      all.push(...page);
      after = page.at(-1) ?? null;
    }
    expect(all).toContain(user.userId);
    expect(all).not.toContain(pending.id);
    expect([...all].sort()).toEqual(all);
  });

  it("authorizes uploaded community logos and lists verified recommendations in order", async () => {
    const owner = await account("logo_owner");
    const stranger = await account("logo_stranger");
    const media = createPostgresMediaRepository(pool);
    const community = createPostgresCommunityRepository(pool);
    const upload = async (
      ownerUserId: string,
      kind: "avatar" | "community_logo",
    ) => {
      const stored = await media.put({
        mediaId: randomUUID(),
        ownerUserId,
        kind,
        bytes: Buffer.from("webp"),
        width: 512,
        height: 512,
        sha256: "d".repeat(64),
        idempotencyKey: randomUUID(),
        requestSha256: "e".repeat(64),
      });
      return `logo:media/${stored.mediaId}`;
    };
    const create = (
      ownerUserId: string,
      slug: string,
      logoRef: string | null,
    ) =>
      community.createCommunity({
        ownerUserId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "createCommunity", [
          slug,
          logoRef ?? "",
        ]),
        requestId: randomUUID(),
        name: slug,
        slug,
        description: null,
        logoRef,
        boundAssetKey: null,
      });
    const ownLogo = await upload(owner.userId, "community_logo");
    const created = await create(owner.userId, "logo-owned", ownLogo);
    expect(created.community.logoRef).toBe(ownLogo);
    await expect(
      create(
        owner.userId,
        "logo-foreign",
        await upload(stranger.userId, "community_logo"),
      ),
    ).rejects.toBeInstanceOf(CommunityLogoMediaRejectedError);
    await expect(
      create(owner.userId, "logo-avatar", await upload(owner.userId, "avatar")),
    ).rejects.toBeInstanceOf(CommunityLogoMediaRejectedError);

    const communityId = created.community.communityId;
    const strangerLogo = await upload(stranger.userId, "community_logo");
    const update = (logoRef: string) =>
      community.updateCommunity({
        ownerUserId: owner.userId,
        communityId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "updateCommunity", [
          communityId,
          logoRef,
        ]),
        requestId: randomUUID(),
        values: { logoRef },
      });
    await expect(update(strangerLogo)).rejects.toBeInstanceOf(
      CommunityLogoMediaRejectedError,
    );
    // Once the uploader is an admin of the community, the owner may use it.
    await pool.query({
      text: `insert into public.community_memberships (community_id, owner_user_id, role, status) values ($1, $2, 'admin', 'active')`,
      values: [communityId, stranger.userId],
    });
    await expect(update(strangerLogo)).resolves.toMatchObject({
      community: { logoRef: strangerLogo },
    });

    const pending = await create(owner.userId, "logo-pending", null);
    await community.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    const recommendations = await createPostgresPublicProfileRepository(
      pool,
    ).listVerifiedCommunitiesByIds([
      pending.community.communityId,
      randomUUID(),
      communityId,
    ]);
    expect(recommendations.map((item) => item.communityId)).toEqual([
      communityId,
    ]);
    expect(recommendations[0]).toMatchObject({
      verificationStatus: "verified",
      logoRef: strangerLogo,
      configVersion: "communityV1",
    });
  });
});
