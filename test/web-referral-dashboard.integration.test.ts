import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { miningDefaultParameterDocument } from "../src/features/mining/hourly-settlement-contract.js";
import type {
  CommitMiningEpochInput,
  MiningEpochRewardLevel,
} from "../src/features/mining/hourly-settlement-ports.js";
import { InvalidAccessTokenError } from "../src/integrations/privy/access-token-verifier.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0180 against PostgreSQL: `GET /v2/web/referral/me` through the
 * real routes and repositories — the code of an account without a username,
 * one inviter with a valid and a pending invitee (validity from the newest
 * settled hour), depth 2..5 counts, the invitee's inviter, and the block rule.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const origin = "https://loop.example";

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

function reward(userId: string, nftSelfPower: string): RewardRow {
  return {
    userId,
    nftSelfPower,
    assetSelfPower: "0",
    nftReferralPower: "0",
    assetReferralPower: "0",
    nftTotalPower: nftSelfPower,
    assetTotalPower: "0",
    levels: zeroLevels,
    nftHoldings: [],
    assetHoldings: [],
    nftRewardRaw: "0",
    assetRewardRaw: "0",
    totalRewardRaw: "0",
  };
}

interface Dashboard {
  readonly code: string;
  readonly inviteLink: string;
  readonly stats: {
    readonly direct: number;
    readonly valid: number;
    readonly deeper: number;
    readonly pendingVerification: number;
    readonly validAsOf: string;
  } | null;
  readonly invitees: readonly {
    readonly loopId: string | null;
    readonly username: string | null;
    readonly depth: number;
    readonly status: string;
    readonly joinedAt: string;
  }[];
  readonly nextCursor: string | null;
  readonly inviter: {
    readonly loopId: string;
    readonly username: string | null;
  } | null;
  readonly binding: {
    readonly bound: boolean;
    readonly windowEndsAt: string | null;
    readonly canClaim: boolean;
  };
  readonly observedAt: string;
}

describe("Decision 0180 web referral dashboard (PostgreSQL)", () => {
  const databaseName = `s297_web_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let app: FastifyInstance;
  let versionId = "";

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
    versionId = randomUUID();
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, 's297-version', 'approved', $2::jsonb, '2026-10-01T00:00:00Z',
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
    const config = loadConfig({
      NODE_ENV: "test",
      API_DOCS_ENABLED: "false",
      LOG_LEVEL: "silent",
      V2_MODULES_ENABLED: "profile,referral",
      V2_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
      PRIVY_APP_ID: "app_test",
      PRIVY_APP_SECRET: "secret_test",
      DATABASE_URL: url,
      WEB_ORIGINS: origin,
      PUBLIC_BASE_URL: "https://api.loop.example",
    });
    database = createPostgresDatabase(config, { error: () => undefined });
    app = await buildApp({
      config,
      contractSurface: "runtime",
      database,
      privyAccessTokenVerifier: {
        verifyAccessToken: (token: string) => {
          const name = token.split(".")[1];
          if (name === undefined || !/^[a-z0-9]+$/u.test(name)) {
            return Promise.reject(new InvalidAccessTokenError());
          }
          return Promise.resolve({ privyUserId: `did:privy:s297:${name}` });
        },
      },
      logger: false,
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  function writeHeaders(name: string) {
    return {
      authorization: `Bearer header.${name}.signature`,
      "x-loop-contract-version": "2.0",
      "idempotency-key": randomUUID(),
      origin,
    };
  }

  async function session(name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v2/web/session",
      headers: writeHeaders(name),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ loopId: string }>().loopId;
  }

  async function setUsername(name: string, username: string): Promise<void> {
    const response = await app.inject({
      method: "PUT",
      url: "/v2/web/profile/username",
      headers: writeHeaders(name),
      payload: { username },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function claim(name: string, code: string): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/v2/web/referral/claim",
      headers: writeHeaders(name),
      payload: { code },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "bound" });
  }

  async function me(name: string): Promise<Dashboard> {
    const response = await app.inject({
      method: "GET",
      url: "/v2/web/referral/me",
      headers: { authorization: `Bearer header.${name}.signature`, origin },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    return response.json<Dashboard>();
  }

  async function userIdOf(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "select id from public.loop_users where privy_user_id = $1",
      [`did:privy:s297:${name}`],
    );
    return result.rows[0]!.id;
  }

  async function settle(hourStart: string, rewards: readonly RewardRow[]) {
    await createPostgresMiningSettlementRepository(pool).commitEpoch({
      hourStart,
      hourEnd: new Date(Date.parse(hourStart) + 3_600_000).toISOString(),
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

  it("gives an account without a username its code (issued on first read, stable)", async () => {
    await session("carol");
    const first = await me("carol");
    expect(first).toMatchObject({
      code: expect.stringMatching(/^LOOP-[0-9A-HJKMNP-TV-Z]{5}$/u) as string,
      stats: null,
      invitees: [],
      nextCursor: null,
      inviter: null,
      binding: { bound: false, windowEndsAt: null, canClaim: true },
    });
    expect(first.inviteLink).toBe(`https://api.loop.example/i/${first.code}`);
    const again = await me("carol");
    expect(again.code).toBe(first.code);
    const stored = await pool.query<{ code: string }>(
      "select code from public.invite_codes where owner_user_id = $1",
      [await userIdOf("carol")],
    );
    expect(stored.rows).toEqual([{ code: first.code }]);
    // The code works for others while its owner still has no username.
    const preview = await app.inject({
      method: "GET",
      url: `/v2/web/referral/preview?code=${first.code}`,
    });
    expect(preview.json()).toMatchObject({
      valid: true,
      inviter: { username: null },
    });
  });

  it("projects one inviter with a valid and a pending invitee", async () => {
    const aliceLoopId = await session("alice");
    await setUsername("alice", "Alice");
    const aliceCode = (await me("alice")).code;

    const bobLoopId = await session("bob");
    await setUsername("bob", "Bob");
    await claim("bob", aliceCode);
    const daveLoopId = await session("dave");
    await setUsername("dave", "Dave");
    await claim("dave", aliceCode);
    // Eve under Bob: depth 2 for Alice.
    await session("eve");
    await setUsername("eve", "Eve");
    await claim("eve", (await me("bob")).code);

    // Before the first settled hour validity is unknown: stats null.
    const before = await me("alice");
    expect(before.stats).toBeNull();
    expect(before.invitees.map((row) => [row.username, row.status])).toEqual([
      ["Dave", "pending"],
      ["Bob", "pending"],
    ]);

    // Bob had own power in the newest settled hour, Dave none.
    await settle("2026-10-20T01:00:00.000Z", [
      reward(await userIdOf("bob"), "5"),
    ]);
    const after = await me("alice");
    expect(after.code).toBe(aliceCode);
    expect(after.stats).toEqual({
      direct: 2,
      valid: 1,
      deeper: 1,
      pendingVerification: 1,
      validAsOf: "2026-10-20T02:00:00.000Z",
    });
    expect(after.invitees).toEqual([
      {
        loopId: daveLoopId,
        username: "Dave",
        depth: 1,
        status: "pending",
        joinedAt: expect.any(String) as string,
      },
      {
        loopId: bobLoopId,
        username: "Bob",
        depth: 1,
        status: "valid",
        joinedAt: expect.any(String) as string,
      },
    ]);
    expect(
      Date.parse(after.invitees[0]!.joinedAt) >=
        Date.parse(after.invitees[1]!.joinedAt),
    ).toBe(true);
    expect(after.inviter).toBeNull();
    expect(after.binding.bound).toBe(false);

    const bob = await me("bob");
    expect(bob.inviter).toEqual({ loopId: aliceLoopId, username: "Alice" });
    expect(bob.binding).toMatchObject({ bound: true, canClaim: false });
    expect(bob.binding.windowEndsAt).toEqual(expect.any(String));
    expect(bob.stats).toMatchObject({ direct: 1, valid: 0, deeper: 0 });

    // An invitee who blocked the inviter is listed without identity.
    const aliceProfile = await pool.query<{ public_profile_id: string }>(
      "select public_profile_id from public.user_profiles where owner_user_id = $1",
      [await userIdOf("alice")],
    );
    await pool.query(
      `insert into public.user_blocks (owner_user_id, kind, stable_id, target_user_id)
       values ($1, 'user', $2, $3)`,
      [
        await userIdOf("dave"),
        aliceProfile.rows[0]!.public_profile_id,
        await userIdOf("alice"),
      ],
    );
    const blocked = await me("alice");
    expect(blocked.invitees[0]).toMatchObject({
      loopId: null,
      username: null,
      status: "pending",
    });
    expect(JSON.stringify(blocked)).not.toContain(daveLoopId);
  });
});
