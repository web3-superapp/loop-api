import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMarketCategoryRepository } from "../src/database/market-category-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0100 against PostgreSQL: the meme / community candidate sets of
 * the categorised market list and the referral rank. The users /
 * communities rank keysets and the best community standing moved to the
 * settled hour in Decision 0148 (test/mining-rank-hourly.integration.test.ts).
 * No migration: every query reads tables other modules already write.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const mainnet = "eip155:56";
const testnet = "eip155:97";
const alphaAddress = "0x00000000000000000000000000000000000000a1";
const betaAddress = "0x00000000000000000000000000000000000000b2";
const blockedAddress = "0x00000000000000000000000000000000000000c3";
const memeAddress = "0x00000000000000000000000000000000000000d4";
const alphaAssetId = `${mainnet}:${alphaAddress}`;
const betaAssetId = `${mainnet}:${betaAddress}`;
const blockedAssetId = `${mainnet}:${blockedAddress}`;
const memeAssetId = `${testnet}:${memeAddress}`;

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

describe("Decision 0100 market categories and rank pages on PostgreSQL", () => {
  const databaseName = `loop_s112_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;

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
    for (const [assetId, chainId, address, symbol, status] of [
      [alphaAssetId, mainnet, alphaAddress, "ALPHA", "verified"],
      [betaAssetId, mainnet, betaAddress, "BETA", "pending"],
      [blockedAssetId, mainnet, blockedAddress, "BLOCK", "blocked"],
      [memeAssetId, testnet, memeAddress, "MEME", "pending"],
    ] as const) {
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          ) values ($1, $2, $3, $4, $4 || ' Token', 18, $5,
            case when $5 = 'blocked' then 'operator_block' else 'chain_call' end,
            case when $5 = 'blocked' then null else 1 end,
            case when $5 = 'blocked' then null else clock_timestamp() end)
        `,
        values: [assetId, chainId, address, symbol, status],
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

  async function account(
    alias: string | null,
    options: { readonly anonymous?: boolean; readonly avatar?: string } = {},
  ): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s112:${randomUUID()}`,
    );
    if (alias !== null) {
      const profile = {
        alias,
        avatarRef: options.avatar ?? null,
        interests: [],
      };
      await createPostgresProfileV2Repository(pool).activateProfile({
        ownerUserId: user.id,
        idempotencyKey: randomUUID(),
        requestSha256: profileActivationDigest(profile, "2.0"),
        requestId: randomUUID(),
        profile,
      });
    }
    if (options.anonymous === true) {
      await pool.query({
        text: `insert into public.privacy_preferences_v2 (owner_user_id, anonymous_mode) values ($1, true)`,
        values: [user.id],
      });
    }
    return user.id;
  }

  async function launchWith(projectAssetId: string, owner: string) {
    const projectId = randomUUID();
    await pool.query({
      text: `
        insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at)
        values ($1, $2, 'MoonCat', 'MCAT', 'approved', now(), now())
      `,
      values: [projectId, owner],
    });
    await pool.query({
      text: `insert into public.launches (launch_id, project_id, chain_id, project_asset_id) values ($1, $2, $3, $4)`,
      values: [
        randomUUID(),
        projectId,
        projectAssetId.startsWith(testnet) ? testnet : mainnet,
        projectAssetId,
      ],
    });
  }

  async function community(input: {
    readonly owner: string;
    readonly name: string;
    readonly assetId: string | null;
    readonly verified: boolean;
    readonly logoRef?: string;
  }): Promise<string> {
    const slug = `s112-${randomUUID().slice(0, 8)}`;
    const result = await pool.query<{ community_id: string }>({
      text: `
        insert into public.communities (name, slug, created_by_user_id)
        values ($1, $2, $3) returning community_id
      `,
      values: [input.name, slug, input.owner],
    });
    const communityId = result.rows[0]!.community_id;
    await pool.query({
      text: `
        update public.communities
        set bound_asset_key = $2,
            logo_ref = $3,
            verification_status = $4,
            verified_at = case when $4 = 'verified' then now() else null end,
            reviewed_at = case when $4 = 'verified' then now() else null end
        where community_id = $1
      `,
      values: [
        communityId,
        input.assetId,
        input.logoRef ?? null,
        input.verified ? "verified" : "pending",
      ],
    });
    return communityId;
  }

  it("lists each Launch project token once, testnet included, and never a blocked asset", async () => {
    const owner = await account(null);
    await launchWith(memeAssetId, owner);
    await launchWith(memeAssetId, owner);
    await launchWith(blockedAssetId, owner);
    const repository = createPostgresMarketCategoryRepository(pool);
    expect(await repository.listLaunchProjectAssetIds(100)).toEqual([
      memeAssetId,
    ]);
    // The composed database exposes the same repository.
    expect(
      await database.marketCategories?.listLaunchProjectAssetIds(1),
    ).toEqual([memeAssetId]);
  });

  it("lists one verified community per bound, non-blocked asset", async () => {
    const owner = await account(null);
    const alpha = await community({
      owner,
      name: "Alpha Club",
      assetId: alphaAssetId,
      verified: true,
      logoRef: `logo:media/${randomUUID()}`,
    });
    // Pending, blocked-asset, and unbound communities are not candidates.
    await community({
      owner,
      name: "Beta Pending",
      assetId: betaAssetId,
      verified: false,
    });
    await community({
      owner,
      name: "Blocked Club",
      assetId: blockedAssetId,
      verified: true,
    });
    await community({ owner, name: "Unbound", assetId: null, verified: true });
    const rows =
      await createPostgresMarketCategoryRepository(
        pool,
      ).listVerifiedCommunityAssets(100);
    expect(rows).toEqual([
      {
        assetId: alphaAssetId,
        communityId: alpha,
        name: "Alpha Club",
        logoRef: expect.stringMatching(/^logo:media\//) as unknown,
      },
    ]);
  });

  it("ranks inviters by direct invitees in force, any validation status, with keyset pages", async () => {
    const mining = createPostgresMiningRepository(pool);
    const top = await account("toprefer");
    const second = await account("secondref", {
      anonymous: true,
      avatar: `avatar:media/${randomUUID()}`,
    });
    const tied = await account(null);
    const loner = await account("loner");
    const edge = async (
      inviter: string,
      invitee: string,
      depth: number,
      options: { readonly status?: string; readonly ended?: boolean } = {},
    ) => {
      await pool.query({
        text: `
          insert into public.referral_edges (
            inviter_user_id, invitee_user_id, depth, validation_status, effective_to
          ) values ($1, $2, $3, $4, case when $5 then clock_timestamp() else null end)
        `,
        values: [
          inviter,
          invitee,
          depth,
          options.status ?? "pending_activation",
          options.ended === true,
        ],
      });
    };
    // top: three direct invitees (one valid, two pending) and a depth-2 row.
    await edge(top, await account(null), 1, { status: "valid" });
    await edge(top, await account(null), 1);
    await edge(top, await account(null), 1, { status: "pending_wallet" });
    await edge(top, await account(null), 2);
    // second: two in force, one ended (invalidated) that does not count.
    await edge(second, await account(null), 1);
    await edge(second, await account(null), 1);
    await edge(second, await account(null), 1, {
      status: "invalidated",
      ended: true,
    });
    // tied: two, sharing position 2 with second.
    await edge(tied, await account(null), 1);
    await edge(tied, await account(null), 1);

    const all = await mining.listReferralRanking({ limit: 50 });
    const [secondFirst] = [second, tied].sort();
    const [, secondLast] = [second, tied].sort();
    expect(
      all.map((row) => [row.ownerUserId, row.invitedCount, row.position]),
    ).toEqual([
      [top, 3, 1],
      [secondFirst, 2, 2],
      [secondLast, 2, 2],
    ]);
    const secondRow = all.find((row) => row.ownerUserId === second);
    expect(secondRow).toMatchObject({
      alias: "secondref",
      anonymousMode: true,
      avatarRef: expect.stringMatching(/^avatar:media\//) as unknown,
    });
    const firstPage = await mining.listReferralRanking({ limit: 2 });
    const last = firstPage.at(-1)!;
    const nextPage = await mining.listReferralRanking({
      limit: 2,
      after: { invitedCount: last.invitedCount, ownerUserId: last.ownerUserId },
    });
    expect([...firstPage, ...nextPage].map((row) => row.ownerUserId)).toEqual(
      all.map((row) => row.ownerUserId),
    );
    expect(await mining.getReferralStanding({ ownerUserId: second })).toEqual({
      invitedCount: 2,
      position: 2,
      participantCount: 3,
    });
    expect(await mining.getReferralStanding({ ownerUserId: loner })).toEqual({
      invitedCount: null,
      position: null,
      participantCount: 3,
    });
  });
});
