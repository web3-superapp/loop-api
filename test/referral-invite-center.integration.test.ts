import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { createPostgresReferralRepository } from "../src/database/referral-repository.js";
import { createPostgresWalletAccountLookup } from "../src/database/wallet-account-directory-repository.js";
import { miningDefaultParameterDocument } from "../src/features/mining/hourly-settlement-contract.js";
import type {
  CommitMiningEpochInput,
  MiningEpochRewardLevel,
} from "../src/features/mining/hourly-settlement-ports.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ReferralRepository } from "../src/features/referral/referral-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0162 against PostgreSQL: the direct-invitee list (validity from
 * the newest settled hour, blocks, keyset paging), the invite stats, the
 * referral boost, and the batched wallet → account lookup.
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

const zeroLevels: readonly MiningEpochRewardLevel[] = [1, 2, 3, 4, 5].map(
  (level) => ({
    level,
    ratioBps: [1000, 500, 300, 200, 100][level - 1] as number,
    effectiveMembers: 0,
    nftPower: "0",
    assetPower: "0",
    nftUnitsByCommunity: [],
  }),
);

type RewardRow = CommitMiningEpochInput["rewards"][number];

function reward(
  userId: string,
  input: Partial<Omit<RewardRow, "userId">> = {},
): RewardRow {
  return {
    userId,
    nftSelfPower: "0",
    assetSelfPower: "0",
    nftReferralPower: "0",
    assetReferralPower: "0",
    nftTotalPower: "0",
    assetTotalPower: "0",
    levels: zeroLevels,
    nftHoldings: [],
    assetHoldings: [],
    nftRewardRaw: "0",
    assetRewardRaw: "0",
    totalRewardRaw: "0",
    ...input,
  };
}

describe("Decision 0162 invite center and trader accounts (PostgreSQL)", () => {
  const databaseName = `loop_s239_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let referral: ReferralRepository;
  let versionId = "";

  async function account(alias: string | null): Promise<{
    readonly id: string;
    readonly publicProfileId: string | null;
  }> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s239:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    if (alias === null) return { id, publicProfileId: null };
    const profile = { alias, avatarRef: null, interests: [] };
    await createPostgresProfileV2Repository(pool).activateProfile({
      ownerUserId: id,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(profile, "2.0"),
      requestId: randomUUID(),
      profile,
    });
    const profileRow = await pool.query<{ public_profile_id: string }>(
      "select public_profile_id::text from public.user_profiles where owner_user_id = $1",
      [id],
    );
    return { id, publicProfileId: profileRow.rows[0]!.public_profile_id };
  }

  async function edge(
    inviter: string,
    invitee: string,
    depth: number,
    lockedAt: string,
    invalidated = false,
  ) {
    await pool.query(
      `insert into public.referral_edges (inviter_user_id, invitee_user_id, depth,
         validation_status, locked_at, effective_from, effective_to)
       values ($1, $2, $3, $4, $5, $5, $6)`,
      [
        inviter,
        invitee,
        depth,
        invalidated ? "invalidated" : "pending_mining",
        lockedAt,
        invalidated ? lockedAt : null,
      ],
    );
  }

  async function settle(hourStart: string, rewards: readonly RewardRow[]) {
    const hourEnd = new Date(Date.parse(hourStart) + 3_600_000).toISOString();
    await createPostgresMiningSettlementRepository(pool).commitEpoch({
      hourStart,
      hourEnd,
      versionId,
      trigger: "test_trigger",
      budgetNftRaw: "0",
      budgetAssetRaw: "0",
      denominatorNftPower: "0",
      denominatorAssetPower: "0",
      allocatedNftRaw: "0",
      allocatedAssetRaw: "0",
      unallocatedNftRaw: "0",
      unallocatedAssetRaw: "0",
      inputDigest: "3".repeat(64),
      inputSummary: {},
      rewards,
    });
  }

  async function wallet(
    owner: string,
    address: string,
    firstSeenAt: string,
    status: "active" | "archived" = "active",
  ) {
    await pool.query(
      `insert into public.account_wallets (owner_user_id, address, kind, status,
         first_seen_at, last_seen_at)
       values ($1, $2, 'external', $3, $4, $4)`,
      [owner, address, status, firstSeenAt],
    );
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
    referral = createPostgresReferralRepository(pool);
    versionId = randomUUID();
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, 's239-version', 'approved', $2::jsonb, '2026-10-01T00:00:00Z',
         'seed', 'seed-reviewer', clock_timestamp())`,
      [
        versionId,
        JSON.stringify({
          ...miningDefaultParameterDocument,
          releaseStartAt: "2026-10-01T00:00:00.000Z",
          assetWeights: [],
          communityCoefficients: [],
        }),
      ],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("lists invitees, counts and the boost from the newest settled hour only", async () => {
    const inviter = await account("s239inviter");
    const active = await account("s239active");
    const idle = await account("s239idle");
    const blocker = await account("s239blocker");
    const dropped = await account("s239dropped");
    const grandchild = await account("s239grand");
    const sameSecond = "2026-10-16T01:00:00.123456Z";
    await edge(inviter.id, active.id, 1, "2026-10-16T01:00:05Z");
    await edge(inviter.id, idle.id, 1, sameSecond);
    await edge(inviter.id, blocker.id, 1, sameSecond);
    await edge(inviter.id, dropped.id, 1, "2026-10-16T00:59:00Z", true);
    await edge(active.id, grandchild.id, 1, "2026-10-16T01:00:06Z");
    await edge(inviter.id, grandchild.id, 2, "2026-10-16T01:00:06Z");
    await pool.query(
      `insert into public.user_blocks (owner_user_id, kind, stable_id, target_user_id)
       values ($1, 'user', $2, $3)`,
      [blocker.id, inviter.publicProfileId, inviter.id],
    );

    // Before the first settled hour: no boost, nobody valid yet.
    expect(await referral.getReferralBoost(inviter.id)).toBeNull();
    expect(await referral.getInviteeStats(inviter.id)).toEqual({
      directCount: 3,
      validCount: 0,
      level2to5Count: 1,
      validAsOf: null,
    });
    const before = await referral.listDirectInvitees({
      inviterUserId: inviter.id,
      after: null,
      limit: 10,
    });
    expect(before.map((row) => row.validationStatus)).toEqual([
      "pending",
      "pending",
      "pending",
      "invalid",
    ]);

    // An older hour where idle had power is never read.
    await settle("2026-10-16T01:00:00.000Z", [
      reward(idle.id, { nftSelfPower: "9", nftTotalPower: "9" }),
    ]);
    await settle("2026-10-16T02:00:00.000Z", [
      reward(active.id, { assetSelfPower: "2", assetTotalPower: "2" }),
      reward(inviter.id, {
        nftReferralPower: "0.5",
        assetReferralPower: "0.25",
        nftTotalPower: "0.5",
        assetTotalPower: "0.25",
        levels: zeroLevels.map((level) =>
          level.level === 1
            ? {
                ...level,
                effectiveMembers: 1,
                nftPower: "0.5",
                assetPower: "0.25",
              }
            : level,
        ),
      }),
      reward(idle.id),
    ]);

    const boost = await referral.getReferralBoost(inviter.id);
    expect(boost).toMatchObject({
      hourStart: "2026-10-16T02:00:00.000Z",
      hourEnd: "2026-10-16T03:00:00.000Z",
      referralPower: "0.75",
      nftReferralPower: "0.5",
      assetReferralPower: "0.25",
    });
    expect(boost?.levels).toEqual([
      { level: 1, effectiveMembers: 1, nftPower: "0.5", assetPower: "0.25" },
      { level: 2, effectiveMembers: 0, nftPower: "0", assetPower: "0" },
      { level: 3, effectiveMembers: 0, nftPower: "0", assetPower: "0" },
      { level: 4, effectiveMembers: 0, nftPower: "0", assetPower: "0" },
      { level: 5, effectiveMembers: 0, nftPower: "0", assetPower: "0" },
    ]);
    // No row in the settled hour = no power.
    expect(await referral.getReferralBoost(grandchild.id)).toMatchObject({
      referralPower: "0",
      levels: expect.arrayContaining([
        { level: 1, effectiveMembers: 0, nftPower: "0", assetPower: "0" },
      ]) as unknown,
    });
    expect(await referral.getInviteeStats(inviter.id)).toEqual({
      directCount: 3,
      validCount: 1,
      level2to5Count: 1,
      validAsOf: "2026-10-16T03:00:00.000Z",
    });

    const all = await referral.listDirectInvitees({
      inviterUserId: inviter.id,
      after: null,
      limit: 10,
    });
    const view = all.map((row) => [
      row.publicProfileId,
      row.alias,
      row.validationStatus,
      row.boundAt,
    ]);
    expect(view).toHaveLength(4);
    expect(view[0]).toEqual([
      active.publicProfileId,
      "s239active",
      "valid",
      "2026-10-16T01:00:05.000Z",
    ]);
    // Same locked_at: both listed (tie broken by edge id); the blocker's
    // profile is withheld.
    expect([view[1], view[2]]).toEqual(
      expect.arrayContaining([
        [
          idle.publicProfileId,
          "s239idle",
          "pending",
          "2026-10-16T01:00:00.123Z",
        ],
        [null, null, "pending", "2026-10-16T01:00:00.123Z"],
      ]),
    );
    expect(view[3]).toEqual([
      dropped.publicProfileId,
      "s239dropped",
      "invalid",
      "2026-10-16T00:59:00.000Z",
    ]);
    expect(all[1]?.boundAtKey).toBe(sameSecond);

    // Keyset pages walk the same order, ties broken by the edge id.
    const pages: string[] = [];
    let after: { boundAtKey: string; referralEdgeId: string } | null = null;
    for (;;) {
      const page = await referral.listDirectInvitees({
        inviterUserId: inviter.id,
        after,
        limit: 1,
      });
      if (page.length === 0) break;
      const row = page[0]!;
      pages.push(row.referralEdgeId);
      after = {
        boundAtKey: row.boundAtKey,
        referralEdgeId: row.referralEdgeId,
      };
    }
    expect(pages).toEqual(all.map((row) => row.referralEdgeId));
  });

  it("maps wallets to accounts in one batch: earliest active wallet, active profile, trade visibility", async () => {
    const lookup = createPostgresWalletAccountLookup(pool);
    const first = await account("s239first");
    const second = await account("s239second");
    const hiddenOwner = await account("s239hidden");
    const pendingOwner = await account(null);
    const shared = `0x${"a1".repeat(20)}`;
    const hidden = `0x${"b2".repeat(20)}`;
    const pending = `0x${"c3".repeat(20)}`;
    const archived = `0x${"d4".repeat(20)}`;
    await wallet(second.id, shared, "2026-10-02T00:00:00Z");
    await wallet(first.id, shared, "2026-10-01T00:00:00Z");
    await wallet(hiddenOwner.id, hidden, "2026-10-01T00:00:00Z");
    await wallet(pendingOwner.id, pending, "2026-10-01T00:00:00Z");
    await wallet(first.id, archived, "2026-10-01T00:00:00Z", "archived");
    await pool.query(
      `insert into public.privacy_preferences_v2 (owner_user_id, trade_history_visibility)
       values ($1, 'self')`,
      [hiddenOwner.id],
    );
    const rows = await lookup.findByAddresses([
      shared.toUpperCase().replace("0X", "0x"),
      hidden,
      pending,
      archived,
      `0x${"ee".repeat(20)}`,
      "not-an-address",
    ]);
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    expect(rows).toHaveLength(3);
    expect(byAddress.get(shared)).toEqual({
      address: shared,
      ownerUserId: first.id,
      publicProfileId: first.publicProfileId,
      alias: "s239first",
      avatarRef: null,
      tradeVisibility: "everyone",
    });
    expect(byAddress.get(hidden)).toMatchObject({
      ownerUserId: hiddenOwner.id,
      tradeVisibility: "self",
    });
    expect(byAddress.get(pending)).toMatchObject({
      ownerUserId: pendingOwner.id,
      publicProfileId: null,
      alias: null,
    });
    expect(await lookup.findByAddresses([])).toEqual([]);
  });
});
