import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { miningDefaultParameterDocument } from "../src/features/mining/hourly-settlement-contract.js";
import type {
  CommitMiningEpochInput,
  MiningEpochRewardLevel,
} from "../src/features/mining/hourly-settlement-ports.js";
import type { MiningRepository } from "../src/features/mining/mining-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0148 on PostgreSQL: the users and communities power ranks read
 * the newest settled hour (`mining_epochs` / `mining_epoch_rewards`), with
 * exact numeric totals of both tracks, shared positions on ties, zero power
 * after the ranked rows, keyset pages, the community split of the hour's
 * power (NFT holdings of the community's instances, the referral NFT units
 * received from them × the coefficient — both from any account, member or
 * not (S208 revision) — and its members' holdings of its bound asset;
 * accounts the community banned excluded; asset referral power not
 * attributed; `participantCount` = contributing accounts),
 * the hour's community coefficient as `weight`, and the `everyone` default
 * of a missing privacy row.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const CHAIN = "eip155:97";
const assetA = `${CHAIN}:0x00000000000000000000000000000000000000a1`;
const assetB = `${CHAIN}:0x00000000000000000000000000000000000000b2`;
const assetC = `${CHAIN}:0x00000000000000000000000000000000000000c3`;

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

describe("Decision 0148 power ranks on the settled hour (PostgreSQL)", () => {
  const databaseName = `loop_s205_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let mining: MiningRepository;
  let versionId = "";
  const users: string[] = [];
  let outsider = "";
  let communityA = "";
  let communityB = "";
  let communityC = "";
  let newestEpochId = "";

  async function account(alias: string | null): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s205:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    if (alias !== null) {
      const profile = { alias, avatarRef: null, interests: [] };
      await createPostgresProfileV2Repository(pool).activateProfile({
        ownerUserId: id,
        idempotencyKey: randomUUID(),
        requestSha256: profileActivationDigest(profile, "2.0"),
        requestId: randomUUID(),
        profile,
      });
    }
    return id;
  }

  async function community(
    name: string,
    assetId: string | null,
  ): Promise<string> {
    const result = await pool.query<{ community_id: string }>(
      // Decision 0188: only verified communities are on the power list.
      `insert into public.communities (name, slug, bound_asset_key, created_by_user_id,
         verification_status, verified_at, reviewed_at)
       values ($1, $2, $3, $4, 'verified', '2026-10-01', '2026-10-01')
       returning community_id`,
      [name, `s205-${randomUUID().slice(0, 8)}`, assetId, users[0]],
    );
    return result.rows[0]!.community_id;
  }

  async function join(communityId: string, member: string, status = "active") {
    await pool.query(
      `insert into public.community_memberships (community_id, owner_user_id, role, status)
       values ($1, $2, 'member', $3)`,
      [communityId, member, status],
    );
  }

  async function settle(
    hourStart: string,
    rewards: readonly RewardRow[],
    digest: string,
  ): Promise<string> {
    const hourEnd = new Date(Date.parse(hourStart) + 3_600_000).toISOString();
    const outcome = await createPostgresMiningSettlementRepository(
      pool,
    ).commitEpoch({
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
      inputDigest: digest,
      inputSummary: {},
      rewards,
    });
    return outcome.epoch.epochId;
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
    mining = createPostgresMiningRepository(pool);
    for (const alias of ["s205one", "s205two", "s205three", "s205zero"]) {
      users.push(await account(alias));
    }
    outsider = await account(null);
    communityA = await community("Alpha Hourly", assetA);
    communityB = await community("Beta Hourly", assetB);
    communityC = await community("Gamma Hourly", assetC);
    await community("Unbound Hourly", null);
    const id = randomUUID();
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, 's205-rank-version', 'approved', $2::jsonb, '2026-10-01T00:00:00Z',
         'seed', 'seed-reviewer', clock_timestamp())`,
      [
        id,
        JSON.stringify({
          ...miningDefaultParameterDocument,
          releaseStartAt: "2026-10-01T00:00:00.000Z",
          // Decision 0188: the bound tokens are external (no launch2
          // instance), so the power list lets them in; the rank's `weight`
          // is the token weight (A pinned at 1.5, B and C default 1).
          assetWeights: [{ assetId: assetA, weight: "1.5" }],
          includedAssets: [assetA, assetB, assetC].sort(),
          // A is listed; B and C fall back to the version default (1).
          communityCoefficients: [
            { communityId: communityA, coefficient: "1.50" },
          ],
        }),
      ],
    );
    versionId = id;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("has no rank epoch before the first settled hour", async () => {
    expect(await mining.getLatestRankEpoch()).toBeNull();
  });

  it("ranks accounts by the newest settled hour's total power with ties, zero last, and keyset pages", async () => {
    const [one, two, three, zero] = users as [string, string, string, string];
    const fifth = await account(null);
    // An older settled hour where only `fifth` has power: never read.
    await settle(
      "2026-10-16T02:00:00.000Z",
      [reward(fifth, { nftSelfPower: "1000", nftTotalPower: "1000" })],
      "1".repeat(64),
    );
    newestEpochId = await settle(
      "2026-10-16T03:00:00.000Z",
      [
        // one: NFT self 1.5 (A) + referral 0.225, asset 0.275 on A's asset
        // → 1.725 + 0.275 = 2 exactly.
        reward(one, {
          nftSelfPower: "1.5",
          nftReferralPower: "0.225",
          nftTotalPower: "1.725",
          assetSelfPower: "0.275",
          assetReferralPower: "0",
          assetTotalPower: "0.275",
          // 0.225 = 0.15 units of A's NFTs × 1.5; units of an unbound
          // instance (coefficient 0) carry no power.
          levels: zeroLevels.map((level) =>
            level.level === 1
              ? {
                  ...level,
                  effectiveMembers: 1,
                  nftPower: "0.225",
                  nftUnitsByCommunity: [
                    { communityId: communityA, units: "0.15" },
                    { communityId: null, units: "0.4" },
                  ],
                }
              : level,
          ),
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityA,
              countAtEnd: "1",
              power: "1.5",
            },
            {
              instanceId: randomUUID(),
              communityId: null,
              countAtEnd: "1",
              power: "0",
            },
          ],
          assetHoldings: [
            { assetId: assetA, balanceAtEndRaw: "275", power: "0.275" },
          ],
        }),
        // two: NFT self 2 on B → ties with one at position 1.
        reward(two, {
          nftSelfPower: "2",
          nftTotalPower: "2",
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityB,
              countAtEnd: "2",
              power: "2",
            },
          ],
        }),
        // three: 0.5 of A's NFT, but banned in A.
        reward(three, {
          nftSelfPower: "0.5",
          nftTotalPower: "0.5",
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityA,
              countAtEnd: "1",
              power: "0.5",
            },
          ],
        }),
        reward(zero),
      ],
      "2".repeat(64),
    );
    // A newer hour that failed is not settled and is never read.
    await pool.query(
      `insert into public.mining_epochs (epoch_id, hour_start, hour_end, idempotency_key, status)
       values ($1, '2026-10-16T04:00:00Z', '2026-10-16T05:00:00Z',
         'mining_hourly:2026-10-16T04:00:00.000Z', 'failed')`,
      [randomUUID()],
    );
    // two keeps power visibility `self`; one has no privacy row.
    await pool.query(
      `insert into public.privacy_preferences_v2 (owner_user_id, mining_power_visibility)
       values ($1, 'self')`,
      [two],
    );

    expect(await mining.getLatestRankEpoch()).toEqual({
      epochId: newestEpochId,
      hourStart: "2026-10-16T03:00:00.000Z",
      hourEnd: "2026-10-16T04:00:00.000Z",
      settledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
      inputDigest: "2".repeat(64),
      configVersion: "s205-rank-version",
    });

    const full = await mining.listAccountRanking({
      epochId: newestEpochId,
      limit: 10,
    });
    const tied = [one, two].sort();
    expect(
      full.map((row) => [
        row.ownerUserId,
        row.totalPower,
        row.position,
        row.powerVisibleToOthers,
      ]),
    ).toEqual([
      [tied[0], "2", 1, tied[0] !== two],
      [tied[1], "2", 1, tied[1] !== two],
      [three, "0.5", 3, true],
      [zero, "0", null, true],
    ]);
    expect(full.find((row) => row.ownerUserId === one)).toMatchObject({
      alias: "s205one",
      anonymousMode: false,
      avatarRef: null,
    });
    const page1 = await mining.listAccountRanking({
      epochId: newestEpochId,
      limit: 2,
    });
    const page2 = await mining.listAccountRanking({
      epochId: newestEpochId,
      limit: 2,
      after: {
        totalPower: page1.at(-1)!.totalPower,
        ownerUserId: page1.at(-1)!.ownerUserId,
      },
    });
    expect([...page1, ...page2].map((row) => row.ownerUserId)).toEqual(
      full.map((row) => row.ownerUserId),
    );

    expect(
      await mining.getEpochAccountStanding({
        epochId: newestEpochId,
        ownerUserId: one,
      }),
    ).toEqual({ totalPower: "2", position: 1, participantCount: 3 });
    expect(
      await mining.getEpochAccountStanding({
        epochId: newestEpochId,
        ownerUserId: zero,
      }),
    ).toEqual({ totalPower: "0", position: null, participantCount: 3 });
    // `fifth` is only in the older hour: no place, the count still answered.
    expect(
      await mining.getEpochAccountStanding({
        epochId: newestEpochId,
        ownerUserId: fifth,
      }),
    ).toEqual({ totalPower: null, position: null, participantCount: 3 });
  });

  it("splits the hour's self power by community, excludes banned members, and publishes the hour's coefficient", async () => {
    const [one, two, three, zero] = users as [string, string, string, string];
    await join(communityA, one);
    await join(communityA, zero);
    await join(communityA, three, "banned");
    await join(communityB, two);
    await join(communityB, three);

    const communities = await mining.listCommunityRanking({
      epochId: newestEpochId,
      limit: 10,
    });
    expect(communities).toEqual([
      // A: one's NFT self 1.5 + referral 0.15 units × 1.5 + 0.275 on A's
      // asset = 2; three is banned; zero has nothing. Ties with B.
      {
        communityId: communityA,
        communityName: "Alpha Hourly",
        boundAssetId: assetA,
        weight: "1.5",
        avatarRef: null,
        power: "2",
        participantCount: 1,
        position: 1,
      },
      // B: two's 2 on B's instances; three (member) holds nothing of B.
      {
        communityId: communityB,
        communityName: "Beta Hourly",
        boundAssetId: assetB,
        weight: "1",
        avatarRef: null,
        power: "2",
        participantCount: 1,
        position: 1,
      },
      // C: bound, no members — listed, not ranked. Unbound is absent.
      {
        communityId: communityC,
        communityName: "Gamma Hourly",
        boundAssetId: assetC,
        weight: "1",
        avatarRef: null,
        power: "0",
        participantCount: 0,
        position: null,
      },
    ]);
    const afterFirst = await mining.listCommunityRanking({
      epochId: newestEpochId,
      limit: 10,
      after: {
        power: "2",
        communityName: "Alpha Hourly",
        communityId: communityA,
      },
    });
    expect(afterFirst.map((row) => row.communityId)).toEqual([
      communityB,
      communityC,
    ]);

    expect(
      await mining.getMemberBestCommunityStanding({
        epochId: newestEpochId,
        ownerUserId: three,
      }),
    ).toMatchObject({ communityId: communityB, position: 1, power: "2" });
    expect(
      await mining.getMemberBestCommunityStanding({
        epochId: newestEpochId,
        ownerUserId: zero,
      }),
    ).toMatchObject({ communityId: communityA, position: 1, power: "2" });
    expect(
      await mining.getMemberBestCommunityStanding({
        epochId: newestEpochId,
        ownerUserId: outsider,
      }),
    ).toBeNull();
  });

  it("counts the community's NFT power of non-member holders and inviters, not their bound-asset holdings, and never a banned account (S208)", async () => {
    const [one] = users as [string, string, string, string];
    const holder = await account(null);
    const inviter = await account(null);
    const coinOnly = await account(null);
    const bannedHolder = await account(null);
    const member = await account(null);
    await join(communityC, member);
    await join(communityC, bannedHolder, "banned");
    const epochId = await settle(
      "2026-10-16T05:00:00.000Z",
      [
        // Non-member NFT holder of C: counts (C's coefficient 1).
        reward(holder, {
          nftSelfPower: "0.5",
          nftTotalPower: "0.5",
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityC,
              countAtEnd: "1",
              power: "0.5",
            },
          ],
        }),
        // Non-member inviter with 0.2 units of C's NFTs: 0.2 × 1 counts.
        reward(inviter, {
          nftReferralPower: "0.2",
          nftTotalPower: "0.2",
          levels: zeroLevels.map((level) =>
            level.level === 1
              ? {
                  ...level,
                  effectiveMembers: 1,
                  nftPower: "0.2",
                  nftUnitsByCommunity: [
                    { communityId: communityC, units: "0.2" },
                  ],
                }
              : level,
          ),
        }),
        // Non-member holding only C's bound asset: the coin track needs
        // membership, so 0 for C.
        reward(coinOnly, {
          assetSelfPower: "1",
          assetTotalPower: "1",
          assetHoldings: [
            { assetId: assetC, balanceAtEndRaw: "1", power: "1" },
          ],
        }),
        // Banned in C: neither its NFT nor its asset counts.
        reward(bannedHolder, {
          nftSelfPower: "3",
          nftTotalPower: "3",
          assetSelfPower: "1",
          assetTotalPower: "1",
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityC,
              countAtEnd: "3",
              power: "3",
            },
          ],
          assetHoldings: [
            { assetId: assetC, balanceAtEndRaw: "1", power: "1" },
          ],
        }),
        // Member of C on its bound asset: counts.
        reward(member, {
          assetSelfPower: "0.3",
          assetTotalPower: "0.3",
          assetHoldings: [
            { assetId: assetC, balanceAtEndRaw: "3", power: "0.3" },
          ],
        }),
        // one (member of A) holds a C instance as a non-member of C, and
        // keeps its A power.
        reward(one, {
          nftSelfPower: "1.5",
          nftTotalPower: "1.5",
          nftHoldings: [
            {
              instanceId: randomUUID(),
              communityId: communityA,
              countAtEnd: "1",
              power: "1.5",
            },
            {
              instanceId: randomUUID(),
              communityId: communityC,
              countAtEnd: "1",
              power: "1",
            },
          ],
        }),
      ],
      "3".repeat(64),
    );
    expect((await mining.getLatestRankEpoch())?.epochId).toBe(epochId);

    const communities = await mining.listCommunityRanking({
      epochId,
      limit: 10,
    });
    expect(
      communities.map((row) => [
        row.communityId,
        row.power,
        row.participantCount,
        row.position,
      ]),
    ).toEqual([
      // C: holder 0.5 + inviter 0.2 + member 0.3 + one 1 = 2; four
      // contributors (coinOnly and bannedHolder are not).
      [communityC, "2", 4, 1],
      // A: one's 1.5 (three is banned in A and holds nothing this hour).
      [communityA, "1.5", 1, 2],
      [communityB, "0", 0, null],
    ]);
    // `me` stays a membership: a non-member contributor has none.
    expect(
      await mining.getMemberBestCommunityStanding({
        epochId,
        ownerUserId: holder,
      }),
    ).toBeNull();
    expect(
      await mining.getMemberBestCommunityStanding({
        epochId,
        ownerUserId: member,
      }),
    ).toMatchObject({ communityId: communityC, position: 1, power: "2" });
    expect(
      await mining.getMemberBestCommunityStanding({
        epochId,
        ownerUserId: bannedHolder,
      }),
    ).toBeNull();
  });
});
