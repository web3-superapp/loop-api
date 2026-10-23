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
import { createPostgresReferralRepository } from "../src/database/referral-repository.js";
import { createPostgresWebRegistrationRepository } from "../src/database/web-registration-repository.js";
import {
  generateInviteCode,
  inviteCodeCheckSymbol,
} from "../src/features/referral/invite-code.js";
import { InvalidAccessTokenError } from "../src/integrations/privy/access-token-verifier.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0179 against PostgreSQL: the whole website registration flow
 * through the real routes and repositories — get-or-create account (one
 * LOOP ID per Privy user, shared with the App), username activation and
 * replacement, invite preview, claim (bound / replay / already bound / self
 * / cycle / window closed / not activated), and the session projection.
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

/** `Bearer header.<name>.signature` → Privy user `did:privy:s295:<name>`. */
function tokenOf(name: string): string {
  return `header.${name}.signature`;
}

describe("Decision 0179 web registration (PostgreSQL)", () => {
  const databaseName = `s295_web_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let app: FastifyInstance;

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
          return Promise.resolve({ privyUserId: `did:privy:s295:${name}` });
        },
      },
      logger: false,
    });
  }, 120_000);

  afterAll(async () => {
    // app.close() closes the composed database (its pool) as well.
    await app.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  function headers(name: string, key: string = randomUUID()) {
    return {
      authorization: `Bearer ${tokenOf(name)}`,
      "x-loop-contract-version": "2.0",
      "idempotency-key": key,
      origin,
    };
  }

  async function session(name: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v2/web/session",
      headers: headers(name),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    return response.json<{
      loopId: string;
      username: string | null;
      usernameRequired: boolean;
      walletAddress: string | null;
      invite: {
        bound: boolean;
        windowEndsAt: string | null;
        canClaim: boolean;
      };
    }>();
  }

  function setUsername(name: string, username: string, key?: string) {
    return app.inject({
      method: "PUT",
      url: "/v2/web/profile/username",
      headers: headers(name, key),
      payload: { username },
    });
  }

  function claim(name: string, code: string, key?: string) {
    return app.inject({
      method: "POST",
      url: "/v2/web/referral/claim",
      headers: headers(name, key),
      payload: { code },
    });
  }

  async function userIdOf(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "select id from public.loop_users where privy_user_id = $1",
      [`did:privy:s295:${name}`],
    );
    return result.rows[0]!.id;
  }

  async function inviteCodeOf(name: string): Promise<string> {
    return (
      await createPostgresReferralRepository(pool).issueInviteCode({
        ownerUserId: await userIdOf(name),
        code: generateInviteCode(),
        requestId: randomUUID(),
      })
    ).code;
  }

  it("creates the account once and returns the same LOOP ID afterwards", async () => {
    const first = await session("alice");
    expect(first).toMatchObject({
      loopId: expect.stringMatching(/^LOOP-[0-9A-HJKMNP-TV-Z]{8}$/u) as string,
      username: null,
      usernameRequired: true,
      walletAddress: null,
      invite: { bound: false, windowEndsAt: null, canClaim: true },
    });
    const second = await session("alice");
    expect(second.loopId).toBe(first.loopId);
    const rows = await pool.query<{ count: string; loop_id: string }>(
      `select count(*)::text as count, max(loop_id) as loop_id
       from public.loop_users where privy_user_id = 'did:privy:s295:alice'`,
    );
    expect(rows.rows[0]).toEqual({ count: "1", loop_id: first.loopId });
    // The App's bootstrap path reads the same row (same Privy subject).
    expect(
      await database.internalUsers.getOrCreateByPrivyUserId(
        "did:privy:s295:alice",
      ),
    ).toEqual({ id: await userIdOf("alice") });
    const sessions = await pool.query(
      "select 1 from public.device_sessions where owner_user_id = $1",
      [await userIdOf("alice")],
    );
    expect(sessions.rowCount).toBe(0);
  });

  it("activates with the username, starts the claim window, and replaces it later", async () => {
    const key = randomUUID();
    const activated = await setUsername("alice", " Alice ", key);
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toEqual({ username: "Alice" });
    // Same key, same name: the activation command replays.
    expect((await setUsername("alice", "Alice", key)).json()).toEqual({
      username: "Alice",
    });
    const state = await session("alice");
    expect(state.username).toBe("Alice");
    expect(state.usernameRequired).toBe(false);
    const profile = await pool.query<{ activated_at: Date; status: string }>(
      `select activated_at, profile_status as status from public.user_profiles
       where owner_user_id = $1`,
      [await userIdOf("alice")],
    );
    expect(profile.rows[0]!.status).toBe("active");
    expect(state.invite.windowEndsAt).toBe(
      new Date(
        profile.rows[0]!.activated_at.getTime() + 7 * 86_400_000,
      ).toISOString(),
    );

    const renamed = await setUsername("alice", "Alice Two");
    expect(renamed.json()).toEqual({ username: "Alice Two" });
    expect((await setUsername("alice", "x".repeat(41))).json()).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect((await setUsername("alice", "Support")).json()).toMatchObject({
      code: "ALIAS_RESERVED",
    });
    // Usernames are not unique.
    await session("dave");
    expect((await setUsername("dave", "Alice Two")).statusCode).toBe(200);
    const unknown = await setUsername("nobody", "Ghost");
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({
      code: "ACCOUNT_BOOTSTRAP_REQUIRED",
    });
  });

  it("previews an invite code with the owner's LOOP ID and username only", async () => {
    const aliceCode = await inviteCodeOf("alice");
    const alice = await session("alice");
    const preview = await app.inject({
      method: "GET",
      url: `/v2/web/referral/preview?code=${aliceCode.toLowerCase()}`,
    });
    expect(preview.json()).toEqual({
      valid: true,
      inviter: { username: "Alice Two", loopId: alice.loopId },
    });
    const unknown = `LOOP-ZZZZ${inviteCodeCheckSymbol("ZZZZ")}`;
    for (const code of [unknown, "garbage"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/web/referral/preview?code=${code}`,
      });
      expect(response.json()).toEqual({ valid: false, inviter: null });
    }
    // An owner without an active profile has no username.
    await session("erin");
    const erinCode = await inviteCodeOf("erin");
    const erin = await app.inject({
      method: "GET",
      url: `/v2/web/referral/preview?code=${erinCode}`,
    });
    expect(erin.json()).toMatchObject({
      valid: true,
      inviter: { username: null },
    });
  });

  it("claims, replays, reports already_bound, and refuses self and cycles", async () => {
    const aliceCode = await inviteCodeOf("alice");
    const alice = await session("alice");
    await session("bob");

    const early = await claim("bob", aliceCode);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      code: "PROFILE_ACTIVATION_REQUIRED",
      detailsSafe: { reasonCode: "PROFILE_ACTIVATION_REQUIRED" },
    });

    expect((await setUsername("bob", "Bob")).statusCode).toBe(200);
    const key = randomUUID();
    const bound = await claim("bob", aliceCode, key);
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json()).toEqual({
      status: "bound",
      inviterLoopId: alice.loopId,
    });
    expect((await claim("bob", aliceCode, key)).json()).toEqual({
      status: "bound",
      inviterLoopId: alice.loopId,
    });
    expect((await claim("bob", aliceCode)).json()).toEqual({
      status: "already_bound",
      inviterLoopId: alice.loopId,
    });
    const edges = await pool.query(
      "select 1 from public.referral_edges where invitee_user_id = $1",
      [await userIdOf("bob")],
    );
    expect(edges.rowCount).toBe(1);
    const bobState = await session("bob");
    expect(bobState.invite).toMatchObject({ bound: true, canClaim: false });

    // Bob is bound to Alice: Bob's code names a different inviter than his.
    await session("frank");
    await setUsername("frank", "Frank");
    const frankCode = await inviteCodeOf("frank");
    expect((await claim("bob", frankCode)).json()).toEqual({
      status: "already_bound",
    });

    const own = await claim("alice", aliceCode);
    expect(own.statusCode).toBe(422);
    expect(own.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "REFERRAL_SELF_INVITE" },
    });
    const bobCode = await inviteCodeOf("bob");
    const cycle = await claim("alice", bobCode);
    expect(cycle.statusCode).toBe(422);
    expect(cycle.json()).toMatchObject({
      detailsSafe: { reasonCode: "REFERRAL_CYCLE" },
    });
  });

  it("refuses after the 7-day window and reports it in the session", async () => {
    const aliceCode = await inviteCodeOf("alice");
    await session("carol");
    await setUsername("carol", "Carol");
    // Activation is irreversible by trigger; move it back with triggers off
    // (same technique as mining-settlement.integration.test.ts).
    const carolId = await userIdOf("carol");
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(
        `update public.user_profiles
         set created_at = now() - interval '9 days',
           activated_at = now() - interval '8 days'
         where owner_user_id = $1`,
        [carolId],
      );
      await client.query("set session_replication_role = origin");
    } finally {
      client.release();
    }
    const closed = await claim("carol", aliceCode);
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "REFERRAL_CLAIM_WINDOW_CLOSED" },
    });
    expect((await session("carol")).invite).toMatchObject({
      bound: false,
      canClaim: false,
    });
  });

  it("projects the account's known wallet", async () => {
    const bobId = await userIdOf("bob");
    await pool.query(
      `insert into public.account_wallets (owner_user_id, address, kind, status,
         first_seen_at, last_seen_at)
       values ($1, '0x00000000000000000000000000000000000000b0', 'external',
         'active', now(), now()),
       ($1, '0x00000000000000000000000000000000000000a0', 'external',
         'archived', now() - interval '1 day', now())`,
      [bobId],
    );
    expect((await session("bob")).walletAddress).toBe(
      "0x00000000000000000000000000000000000000b0",
    );
    const repository = createPostgresWebRegistrationRepository(pool);
    expect(await repository.getAccountSummary(randomUUID())).toBeNull();
    expect(
      await repository.findInviterByCode(
        `LOOP-YYYY${inviteCodeCheckSymbol("YYYY")}`,
      ),
    ).toBeNull();
    expect(await repository.getDirectInviter(await userIdOf("alice"))).toBe(
      null,
    );
  });
});
