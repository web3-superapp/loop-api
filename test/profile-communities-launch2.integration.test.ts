import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { createPostgresPublicProfileRepository } from "../src/database/public-profile-repository.js";
import { createPostgresWalletActivityMergeRepository } from "../src/database/wallet-activity-merge-repository.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import type { Launch2Chain } from "../src/features/launch2/launch2-ports.js";
import { createLaunch2Service } from "../src/features/launch2/launch2-service.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import { createPublicProfileService } from "../src/features/profile/public-profile-service.js";
import type { WalletReadService } from "../src/features/wallet/wallet-read-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0169 (S260) on a real PostgreSQL: the joined-communities list
 * (order, keyset pages, banned / pending / rejected excluded, the missing-row
 * `everyone` default and an explicit `self`), and a 晚风-style owner — two
 * MEME v2 instances (one on the curve with an NFT, one graduated), curve
 * and pool buys / sells, an NFT mint, primary-chain swaps and a transfer —
 * read through the public profile service with PROFILE_LAUNCH2_EMIT on.
 * Every row is random per run, so the shared database needs no cleanup.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const profiles = createPostgresProfileV2Repository(pool);
const publicProfiles = createPostgresPublicProfileRepository(pool);
const merge = createPostgresWalletActivityMergeRepository(pool);
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launchChainId = "eip155:97";
const primaryChainId = "eip155:56";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const wad = 10n ** 18n;
const cursorCodec = createV2CursorCodec({ secret: randomBytes(32) });

afterAll(async () => {
  await pool.end();
});

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

async function account(): Promise<{
  readonly userId: string;
  readonly publicProfileId: string;
}> {
  const inserted = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s260:${randomUUID()}`],
  );
  const user = { id: inserted.rows[0]!.id };
  const alias = `s260_${suffix()}`;
  await profiles.activateProfile({
    ownerUserId: user.id,
    idempotencyKey: randomUUID(),
    requestSha256: profileActivationDigest(
      { alias, avatarRef: null, interests: [] },
      "2.0",
    ),
    requestId: randomUUID(),
    profile: { alias, avatarRef: null, interests: [] },
  });
  const row = await pool.query<{ public_profile_id: string }>(
    "select public_profile_id from public.user_profiles where owner_user_id = $1",
    [user.id],
  );
  return { userId: user.id, publicProfileId: row.rows[0]!.public_profile_id };
}

async function befriend(
  first: string,
  second: { readonly userId: string; readonly publicProfileId: string },
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

async function community(
  creator: string,
  status: "verified" | "pending" | "rejected",
  logoRef: string | null = null,
): Promise<string> {
  const slug = `s260-${suffix()}`;
  const result = await pool.query<{ community_id: string }>(
    `insert into public.communities (name, slug, created_by_user_id, logo_ref,
       verification_status, verified_at, reviewed_at, rejected_reason)
     values ($1, $2, $3, $4, $5,
       case when $5 = 'verified' then clock_timestamp() end,
       case when $5 = 'pending' then null else clock_timestamp() end,
       case when $5 = 'rejected' then 'Taken down' end)
     returning community_id`,
    [`Club ${slug.slice(5)}`, slug, creator, logoRef, status],
  );
  return result.rows[0]!.community_id;
}

async function join(
  communityId: string,
  ownerUserId: string,
  joinedAt: Date,
  status: "active" | "muted" | "banned" = "active",
): Promise<void> {
  await pool.query(
    `insert into public.community_memberships (community_id, owner_user_id,
       role, status, joined_at, updated_at)
     values ($1, $2, 'member', $3, $4, $4)`,
    [communityId, ownerUserId, status, joinedAt],
  );
}

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

/** An activated MEME v2 instance on the Launch chain (as Decision 0167's suite). */
async function instance(ticker: string, name: string): Promise<string> {
  const owner = (await account()).userId;
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
  const approver = (await account()).userId;
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
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       now() - interval '30 days', 1, now() - interval '31 days', true,
       'snapshot_pending', 'v3')`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      launchChainId,
      "0x1111111111111111111111111111111111111111",
      hex(32),
      draft.configHash,
      projectOwner,
      name,
      ticker,
      `${hex(18)}6666`,
      zeroAddress,
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

describe("Decision 0169: public profile communities on PostgreSQL", () => {
  it("lists current memberships of verified communities, newest first, in keyset pages", async () => {
    const owner = await account();
    const creator = (await account()).userId;
    const base = Date.UTC(2026, 9, 1, 0, 0, 0);
    const at = (days: number, micros = 0) =>
      new Date(base + days * 86_400_000 + micros / 1000);
    const oldest = await community(creator, "verified");
    const middle = await community(
      creator,
      "verified",
      "avatar:preset/community-03",
    );
    const muted = await community(creator, "verified");
    const newest = await community(creator, "verified");
    const banned = await community(creator, "verified");
    const pending = await community(creator, "pending");
    const rejected = await community(creator, "rejected");
    await join(oldest, owner.userId, at(1));
    await join(middle, owner.userId, at(2));
    await join(muted, owner.userId, at(2), "muted");
    await join(newest, owner.userId, at(3));
    await join(banned, owner.userId, at(4), "banned");
    await join(pending, owner.userId, at(5));
    await join(rejected, owner.userId, at(6));
    // Another account's memberships are not this profile's.
    await join(newest, creator, at(7));

    const expected = [newest, ...[middle, muted].sort().reverse(), oldest];
    const everything = await publicProfiles.listProfileCommunities({
      ownerUserId: owner.userId,
      limit: 50,
    });
    expect(everything.hasMore).toBe(false);
    expect(everything.items.map((item) => item.communityId)).toEqual(expected);
    expect(typeof everything.items[0]?.memberCount).toBe("number");
    expect(everything.items[0]).toMatchObject({
      verificationStatus: "verified",
      joinedAt: at(3).toISOString(),
      joinedAtMicros: (BigInt(at(3).getTime()) * 1000n).toString(),
    });
    expect(
      everything.items.find((item) => item.communityId === middle),
    ).toMatchObject({ logoRef: "avatar:preset/community-03" });

    // The count on the profile is the same set.
    const viewer = await account();
    const found = await publicProfiles.findProfile({
      viewerUserId: viewer.userId,
      lookup: { publicProfileId: owner.publicProfileId },
    });
    expect(found?.counts.communities).toBe(expected.length);

    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let before: { joinedAtMicros: string; communityId: string } | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await publicProfiles.listProfileCommunities({
          ownerUserId: owner.userId,
          limit: size,
          before,
        });
        seen.push(...result.items.map((item) => item.communityId));
        const last = result.items.at(-1);
        if (!result.hasMore || last === undefined) break;
        before = {
          joinedAtMicros: last.joinedAtMicros,
          communityId: last.communityId,
        };
      }
      expect(seen, `limit=${size}`).toEqual(expected);
    }
  });

  it("defaults a missing privacy row to everyone, keeps an explicit self, and serves friends and strangers alike", async () => {
    const owner = await account();
    const creator = (await account()).userId;
    const club = await community(creator, "verified");
    await join(club, owner.userId, new Date());
    const friend = await account();
    const stranger = await account();
    await befriend(friend.userId, owner);

    const service = createPublicProfileService({
      repository: publicProfiles,
      walletReadService: null,
      assets: { getAsset: () => Promise.resolve(null) },
      cursorCodec,
      chainId: primaryChainId,
      usd1Address: null,
      recommendedCommunityIds: [],
    });
    const read = (viewer: string) =>
      service.getCommunities({
        principal: { userId: viewer } as never,
        publicProfileId: owner.publicProfileId,
      });

    // No privacy row: the Decision 0169 default.
    await expect(
      publicProfiles.findProfile({
        viewerUserId: stranger.userId,
        lookup: { publicProfileId: owner.publicProfileId },
      }),
    ).resolves.toMatchObject({
      visibility: { communities: "everyone" },
      relationship: { friendship: "none" },
    });
    for (const viewer of [friend.userId, stranger.userId, owner.userId]) {
      await expect(read(viewer)).resolves.toMatchObject({
        status: "available",
        items: [{ communityId: club }],
        nextCursor: null,
      });
    }
    await expect(profiles.getPrivacy(owner.userId)).resolves.toBeNull();

    // An explicit self row is kept: hidden from friends and strangers.
    await profiles.replacePrivacy({
      ownerUserId: owner.userId,
      expectedVersion: 0,
      privacy: {
        discoverable: false,
        anonymousMode: false,
        visibility: {
          totalAssets: "everyone",
          miningPower: "everyone",
          communities: "self",
          tradeHistory: "everyone",
        },
        friendRequests: "enabled",
        groupInvites: "friends",
        directMessages: "friends",
      },
    });
    await expect(
      publicProfiles.findProfile({
        viewerUserId: friend.userId,
        lookup: { publicProfileId: owner.publicProfileId },
      }),
    ).resolves.toMatchObject({
      visibility: { communities: "self" },
      relationship: { friendship: "friends" },
    });
    for (const viewer of [friend.userId, stranger.userId]) {
      await expect(read(viewer)).resolves.toEqual({
        status: "unavailable",
        reasonCode: "PROFILE_COMMUNITIES_HIDDEN",
        contractVersion: "2.0",
      });
    }
    await expect(read(owner.userId)).resolves.toMatchObject({
      status: "available",
    });
  });
});

describe("Decision 0169: 晚风-style holdings and trades with PROFILE_LAUNCH2_EMIT on", () => {
  it("merges two instances' holdings and the launch2 activity with the primary chain", async () => {
    const owner = await account();
    const viewer = await account();
    const wallet = hex(20);
    await pool.query(
      // Decision 0185: another viewer reads the owner's embedded wallet.
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address, kind, is_active)
       values ($1, 'fixture-' || gen_random_uuid()::text, $2, 'embedded', true)`,
      [owner.userId, wallet],
    );
    const wind = await instance("WIND", "Evening Wind");
    const moon = await instance("MOON", "Moon");
    // MOON graduated: pool price 0.05 USD1.
    await pool.query(
      `update public.launch2_instances
       set graduated_at = now() - interval '1 day', official_pool_id = $2,
         pool_last_price_e18 = $3, price_e18 = $4, pool_trade_count = 2,
         pool_buy_count = 1, pool_sell_count = 1,
         pool_last_trade_at = now() - interval '1 hour'
       where instance_id = $1`,
      [moon, hex(32), ((5n * wad) / 100n).toString(), wad.toString()],
    );
    await pool.query(
      "update public.launch2_instances set price_e18 = $2, logo_url = 'https://example.com/wind.png' where instance_id = $1",
      [wind, ((102n * wad) / 10_000n).toString()],
    );
    await pool.query(
      `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
         last_block_hash, started_from_block_number)
       values ('launch2_event', $1, 5000, $2, 1), ('erc20_transfer', $3, 900, $2, 1)
       on conflict (lane, chain_id) do nothing`,
      [launchChainId, hex(32), primaryChainId],
    );
    const base = Date.UTC(2026, 9, 19, 12, 0, 0);
    const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000);

    // Positions (the lane's projection): WIND 1,000 bought, 100 sold, 1 NFT;
    // MOON only pool trades (balance read live once graduated).
    await pool.query(
      `insert into public.launch2_positions (instance_id, holder_address,
         nft_minted_token_id, nft_held, curve_bought, curve_sold,
         cumulative_bought, usd1_spent, usd1_received, tax_usd1, buy_count,
         sell_count, snapshot_member, last_activity_at)
       values ($1, $3, 1, 1, $4, $5, $4, 0, 0, 0, 1, 1, false, $6),
         ($2, $3, null, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, $7)`,
      [
        wind,
        moon,
        wallet,
        (1000n * wad).toString(),
        (100n * wad).toString(),
        at(80),
        at(60),
      ],
    );

    // Launch-chain facts: WIND mint (-100), curve buy (-90), curve sell
    // (-80); MOON router buy (-70) and sell (-60); another wallet's buy.
    const tx: Record<string, string> = {};
    const fact = (name: string) => (tx[name] = hex(32));
    await pool.query(
      `insert into public.launch2_nft_mints (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, payer_address,
         token_id, amount_usd1, minted_at)
       values ($1, $2, 0, 1000, $3, $4, $5, 1, $6, $7)`,
      [
        launchChainId,
        fact("mint"),
        hex(32),
        wind,
        wallet,
        (100n * wad).toString(),
        at(100),
      ],
    );
    for (const [name, side, minutes, block, trader] of [
      ["curveBuy", "buy", 90, 1010, wallet],
      ["curveSell", "sell", 80, 1020, wallet],
      ["otherBuy", "buy", 85, 1015, hex(20)],
    ] as const) {
      await pool.query(
        `insert into public.launch2_trades (trade_id, chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, side, trader_address,
           meme_amount, usd1_gross, usd1_net, tax_usd1, refund_usd1,
           cumulative_bought, sold_after, traded_at)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0,
           $13, $14, $15)`,
        [
          randomUUID(),
          launchChainId,
          fact(name),
          block,
          hex(32),
          wind,
          side,
          trader,
          (side === "buy" ? 1000n * wad : 100n * wad).toString(),
          (side === "buy" ? (102n * wad) / 10n : wad).toString(),
          (side === "buy" ? 10n * wad : (98n * wad) / 100n).toString(),
          (side === "buy" ? (2n * wad) / 10n : (2n * wad) / 100n).toString(),
          side === "buy" ? (1000n * wad).toString() : null,
          side === "sell" ? "0" : null,
          at(minutes),
        ],
      );
    }
    const poolId = hex(32);
    for (const [name, side, minutes, block] of [
      ["poolBuy", "buy", 70, 2000],
      ["poolSell", "sell", 60, 2010],
    ] as const) {
      await pool.query(
        `insert into public.launch2_pool_swaps (chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, pool_id,
           caller_address, side, usd1_amount, meme_amount, tax_amount,
           tax_token, sqrt_price_x96, price_e18, swapped_at, wallet_address,
           recipient_address, router_amount_in, router_amount_out,
           router_log_index, attribution_source)
         values ($1, $2, 2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'usd1', 1, 1,
           $12, $13, $13, $14, $15, 3, 'router_swap')`,
        [
          launchChainId,
          fact(name),
          block,
          hex(32),
          moon,
          poolId,
          hex(20),
          side,
          (20n * wad).toString(),
          (400n * wad).toString(),
          (4n * wad) / 10n + "",
          at(minutes),
          wallet,
          (side === "buy" ? 20n * wad : 108n * wad).toString(),
          (side === "buy" ? 400n * wad : (196n * wad) / 10n).toString(),
        ],
      );
    }

    // Primary chain (eip155:56): a swap at -75 min and a transfer at -50
    // whose block has no pool event (ordered by its observation time).
    // Random addresses and odd symbols: the shared database also serves the
    // asset search suite.
    const token = hex(20);
    const usdt = hex(20);
    for (const [address, symbol] of [
      [token, "S260FROG"],
      [usdt, "S260USD"],
    ] as const) {
      await pool.query(
        `insert into public.assets (asset_id, chain_id, address, symbol, name,
           decimals, status, source_kind, source_block_number, source_verified_at)
         values ($1, $2, $3, $4, $4, 18, 'verified', 'chain_call', 1, clock_timestamp())
         on conflict (asset_id) do nothing`,
        [`${primaryChainId}:${address}`, primaryChainId, address, symbol],
      );
    }
    const pair = await pool.query<{ pool_id: string }>(
      `insert into public.pools (chain_id, protocol, address, token0_asset_id,
         token1_asset_id, fee, tick_spacing, source_block_number, source_verified_at)
       values ($1, 'pancakeswap_v3', $2, $3, $4, 2500, 50, 1, clock_timestamp())
       returning pool_id`,
      [
        primaryChainId,
        hex(20),
        `${primaryChainId}:${token}`,
        `${primaryChainId}:${usdt}`,
      ],
    );
    await pool.query(
      `insert into public.indexed_pool_events (chain_id, transaction_hash,
         log_index, block_number, block_hash, pool_id, event_kind, payload,
         block_timestamp, amount0, amount1, sqrt_price_x96)
       values ($1, $2, 3, 300, $3, $4, 'swap', $5::jsonb, $6,
         -5000000000000000000, 2000000000000000000, 79228162514264337593543950336)`,
      [
        primaryChainId,
        fact("primarySwap"),
        hex(32),
        pair.rows[0]!.pool_id,
        JSON.stringify({ sender: hex(20), recipient: wallet }),
        at(75),
      ],
    );
    await pool.query(
      `insert into public.indexed_transfers (chain_id, transaction_hash,
         log_index, block_number, block_hash, asset_id, from_address,
         to_address, raw_value, observed_at)
       values ($1, $2, 1, 999999, $3, $4, $5, $6, 1500000000000000000, $7)`,
      [
        primaryChainId,
        fact("primaryTransfer"),
        hex(32),
        `${primaryChainId}:${usdt}`,
        hex(20),
        wallet,
        at(50),
      ],
    );

    const readWalletBalances = vi.fn<Launch2Chain["readWalletBalances"]>(() =>
      Promise.resolve({
        blockNumber: 5001n,
        memeBalance: 292n * wad,
        usd1Balance: 0n,
      }),
    );
    const launch2Service = createLaunch2Service({
      repository: createPostgresLaunch2Repository(pool),
      chain: { readWalletBalances } as unknown as Launch2Chain,
      readClient: null,
      wallets: null,
      writes: null,
      cursorCodec: null,
      chainId: launchChainId,
      unavailableReason: null,
      quoteTtlSeconds: 30,
      defaultSlippageBps: 100,
    });
    const getBalances = vi.fn(() =>
      Promise.resolve({
        balances: [],
        snapshot: { observedAt: "2026-10-19T12:00:00.000Z" },
      }),
    );
    const service = createPublicProfileService({
      repository: publicProfiles,
      walletReadService: {
        getBalances,
      } as unknown as Pick<WalletReadService, "getBalances">,
      assets: {
        getAsset: async (assetId: string) => {
          const result = await pool.query<{ symbol: string }>(
            "select symbol from public.assets where asset_id = $1",
            [assetId],
          );
          const row = result.rows[0];
          return row === undefined
            ? null
            : ({
                assetId,
                symbol: row.symbol,
                decimals: 18,
              } as never);
        },
      },
      cursorCodec,
      chainId: primaryChainId,
      usd1Address: usdt,
      recommendedCommunityIds: [],
      launch2: {
        chainId: launchChainId,
        activity: merge,
        holdings: launch2Service,
        readHead: () => Promise.resolve(5100n),
      },
    });
    const principal = { userId: viewer.userId } as never;

    const holdings = await service.getHoldings({
      principal,
      publicProfileId: owner.publicProfileId,
      signal: new AbortController().signal,
    });
    expect(holdings).toMatchObject({
      status: "available",
      totalUsd: "0",
      launch2: {
        status: "available",
        chainId: launchChainId,
        indexerBlockNumber: await merge.getLaunch2Checkpoint(launchChainId),
        headBlockNumber: "5100",
      },
    });
    // Newest activity first (the positions order): MOON, then WIND.
    expect(holdings.items).toEqual([
      {
        kind: "launch2_meme",
        chainId: launchChainId,
        instanceId: moon,
        ticker: "MOON",
        name: "Moon",
        logoUrl: null,
        amountMeme: "292",
        nftCount: null,
        stage: "graduated",
        valueUsd1: "14.6",
      },
      {
        kind: "launch2_meme",
        chainId: launchChainId,
        instanceId: wind,
        ticker: "WIND",
        name: "Evening Wind",
        logoUrl: "https://example.com/wind.png",
        amountMeme: "900",
        nftCount: null,
        stage: "snapshot_pending",
        valueUsd1: "9.18",
      },
      {
        kind: "launch2_nft",
        chainId: launchChainId,
        instanceId: wind,
        ticker: "WIND",
        name: "Evening Wind",
        logoUrl: "https://example.com/wind.png",
        amountMeme: null,
        nftCount: 1,
        stage: "snapshot_pending",
        valueUsd1: null,
      },
    ]);
    expect(readWalletBalances).toHaveBeenCalledOnce();
    expect(JSON.stringify(holdings)).not.toContain(wallet);

    // The transfer has no block time: its observation time (-50 min) orders it.
    const expected = [
      ["transfer_in", tx["primaryTransfer"]],
      ["launch2_pool_sell", tx["poolSell"]],
      ["launch2_pool_buy", tx["poolBuy"]],
      ["buy", tx["primarySwap"]],
      ["launch2_curve_sell", tx["curveSell"]],
      ["launch2_curve_buy", tx["curveBuy"]],
      ["launch2_nft_mint", tx["mint"]],
    ];
    for (const size of [1, 2, 3, 7, 50]) {
      const seen: unknown[][] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await service.getTrades({
          principal,
          publicProfileId: owner.publicProfileId,
          limit: size,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(result.status).toBe("available");
        expect(result.launch2).toMatchObject({ status: "available" });
        seen.push(
          ...result.items.map((item) => [
            item.kind,
            "txHash" in item ? item.txHash : item.transactionHash,
          ]),
        );
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(seen, `limit=${size}`).toEqual(expected);
    }
    const first = await service.getTrades({
      principal,
      publicProfileId: owner.publicProfileId,
      limit: 50,
    });
    expect(first.items[1]).toEqual({
      kind: "launch2_pool_sell",
      chainId: launchChainId,
      instanceId: moon,
      ticker: "MOON",
      name: "Moon",
      logoUrl: null,
      amountMeme: "108",
      amountUsd1: "19.6",
      taxUsd1: "0.4",
      transactionHash: tx["poolSell"],
      logIndex: 2,
      blockNumber: "2010",
      occurredAt: at(60).toISOString(),
      confirmations: 5100 + 1 - 2010,
    });

    // tradeHistory self hides the merged list from the viewer, not the owner.
    await profiles.replacePrivacy({
      ownerUserId: owner.userId,
      expectedVersion: 0,
      privacy: {
        discoverable: false,
        anonymousMode: false,
        visibility: {
          totalAssets: "self",
          miningPower: "everyone",
          communities: "everyone",
          tradeHistory: "self",
        },
        friendRequests: "enabled",
        groupInvites: "friends",
        directMessages: "friends",
      },
    });
    await expect(
      service.getTrades({ principal, publicProfileId: owner.publicProfileId }),
    ).resolves.toEqual({
      status: "hidden",
      reasonCode: null,
      items: [],
      nextCursor: null,
      contractVersion: "2.0",
    });
    await expect(
      service.getHoldings({
        principal,
        publicProfileId: owner.publicProfileId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "hidden", items: [] });
    const own = await service.getTrades({
      principal: { userId: owner.userId } as never,
      publicProfileId: owner.publicProfileId,
    });
    expect(own.items).toHaveLength(expected.length);
  });
});
