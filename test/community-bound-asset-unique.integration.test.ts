import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MigrationBuilder } from "node-pg-migrate";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { up } from "../migrations/000100_community_bound_asset_unique.js";
import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import {
  CommunityBoundAssetTakenError,
  type CommunityRepository,
} from "../src/features/community/community-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0182 (S299) on PostgreSQL: migration 000100 releases the
 * existing duplicate bindings (verified-first-then-oldest keeper, rejected
 * rows untouched, one NOTICE per release) and adds the partial unique
 * index; the community write paths refuse a taken token with
 * CommunityBoundAssetTakenError naming the holder, and a rejected community
 * does not occupy its token.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const migrationName = "000100_community_bound_asset_unique";
const chainId = "eip155:56";

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

function assetKey(digit: string): string {
  return `${chainId}:0x${digit.repeat(40)}`;
}

describe("Decision 0182 one token, one community on PostgreSQL", () => {
  const databaseName = `s299_bound_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let repository: CommunityRepository;
  const notices: string[] = [];
  const seeded: Record<string, string> = {};
  let seedOwner: string;

  async function rawCommunity(input: {
    readonly label: string;
    readonly boundAssetKey: string | null;
    readonly status: "pending" | "verified" | "rejected";
    readonly createdAt: string;
  }): Promise<string> {
    const created = await pool.query<{ community_id: string }>({
      text: `
        insert into public.communities (
          name, slug, bound_asset_key, created_by_user_id, verification_status,
          verified_at, reviewed_at, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5,
          case when $5 = 'verified' then $6::timestamptz end,
          case when $5 <> 'pending' then $6::timestamptz end,
          $6::timestamptz, $6::timestamptz)
        returning community_id
      `,
      values: [
        `Seed ${input.label}`,
        `s299-${input.label}-${randomUUID().slice(0, 6)}`,
        input.boundAssetKey,
        seedOwner,
        input.status,
        input.createdAt,
      ],
    });
    return created.rows[0]!.community_id;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    // Everything before 000100, so duplicates can still be written.
    const before = readdirSync(migrationsDirectory).filter(
      (name) => name.endsWith(".ts") && name < migrationName,
    ).length;
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      count: before,
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
    repository = createPostgresCommunityRepository(pool);
    seedOwner = (
      await database.internalUsers.getOrCreateByPrivyUserId(
        `did:privy:s299:${randomUUID()}`,
      )
    ).id;

    // Asset A: an older rejected row, an older pending row, and two
    // verified rows — the first verified one keeps A.
    seeded["aRejected"] = await rawCommunity({
      label: "a-rejected",
      boundAssetKey: assetKey("a"),
      status: "rejected",
      createdAt: "2026-01-01T00:00:00Z",
    });
    seeded["aPending"] = await rawCommunity({
      label: "a-pending",
      boundAssetKey: assetKey("a"),
      status: "pending",
      createdAt: "2026-01-02T00:00:00Z",
    });
    seeded["aVerified"] = await rawCommunity({
      label: "a-verified",
      boundAssetKey: assetKey("a"),
      status: "verified",
      createdAt: "2026-01-03T00:00:00Z",
    });
    seeded["aVerifiedLater"] = await rawCommunity({
      label: "a-verified2",
      boundAssetKey: assetKey("a"),
      status: "verified",
      createdAt: "2026-01-04T00:00:00Z",
    });
    // Asset B: two pending rows — the oldest keeps B.
    seeded["bOld"] = await rawCommunity({
      label: "b-old",
      boundAssetKey: assetKey("b"),
      status: "pending",
      createdAt: "2026-02-01T00:00:00Z",
    });
    seeded["bNew"] = await rawCommunity({
      label: "b-new",
      boundAssetKey: assetKey("b"),
      status: "pending",
      createdAt: "2026-02-02T00:00:00Z",
    });
    // Asset C: one holder, untouched.
    seeded["cOnly"] = await rawCommunity({
      label: "c-only",
      boundAssetKey: assetKey("c"),
      status: "verified",
      createdAt: "2026-03-01T00:00:00Z",
    });

    // Run 000100 itself on a client that records its NOTICEs, then record
    // it and apply anything newer through the runner.
    const statements: string[] = [];
    up({
      sql: (statement: string) => statements.push(statement),
    } as unknown as MigrationBuilder);
    const client = new Client({ connectionString: url });
    await client.connect();
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    try {
      await client.query("begin");
      for (const statement of statements) await client.query(statement);
      await client.query(
        "insert into public.pgmigrations (name, run_on) values ($1, now())",
        [migrationName],
      );
      await client.query("commit");
    } finally {
      await client.end();
    }
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });

    for (const [assetId, symbol] of [
      [assetKey("1"), "ONE"],
      [assetKey("2"), "TWO"],
      [assetKey("3"), "THREE"],
    ] as const) {
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          ) values ($1, $2, $3, $4, $4, 18, 'verified', 'chain_call', 1, clock_timestamp())
        `,
        values: [assetId, chainId, assetId.slice(chainId.length + 1), symbol],
      });
    }
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function boundOf(communityId: string) {
    const result = await pool.query<{
      bound_asset_key: string | null;
      record_version: number;
    }>({
      text: `select bound_asset_key, record_version from public.communities where community_id = $1`,
      values: [communityId],
    });
    return result.rows[0];
  }

  it("migration 000100 keeps one holder per token, releases the rest with a NOTICE each, and leaves rejected rows alone", async () => {
    expect(await boundOf(seeded["aVerified"]!)).toEqual({
      bound_asset_key: assetKey("a"),
      record_version: 1,
    });
    expect(await boundOf(seeded["bOld"]!)).toEqual({
      bound_asset_key: assetKey("b"),
      record_version: 1,
    });
    expect(await boundOf(seeded["cOnly"]!)).toEqual({
      bound_asset_key: assetKey("c"),
      record_version: 1,
    });
    // A rejected community does not occupy its token: kept as it was.
    expect(await boundOf(seeded["aRejected"]!)).toEqual({
      bound_asset_key: assetKey("a"),
      record_version: 1,
    });
    for (const released of ["aPending", "aVerifiedLater", "bNew"]) {
      expect(await boundOf(seeded[released]!), released).toEqual({
        bound_asset_key: null,
        record_version: 2,
      });
    }

    // In keeper order: verified rows first, then by age.
    expect(notices).toEqual([
      `Decision 0182: community ${seeded["aVerifiedLater"]} released bound asset ${assetKey("a")} (kept by community ${seeded["aVerified"]})`,
      `Decision 0182: community ${seeded["aPending"]} released bound asset ${assetKey("a")} (kept by community ${seeded["aVerified"]})`,
      `Decision 0182: community ${seeded["bNew"]} released bound asset ${assetKey("b")} (kept by community ${seeded["bOld"]})`,
      "Decision 0182: 3 duplicate community binding(s) released",
    ]);

    const audits = await pool.query<{ community_id: string }>({
      text: `
        select community_id::text from public.community_role_events
        where reason_code = 'bound_asset_dedup_0182'
          and actor_type = 'operator' and actor_user_id is null
          and event_type = 'community_profile_updated'
        order by community_id
      `,
    });
    expect(audits.rows.map((row) => row.community_id)).toEqual(
      [seeded["aPending"]!, seeded["aVerifiedLater"]!, seeded["bNew"]!].sort(),
    );
  });

  it("the partial unique index refuses a second live holder but not a rejected one", async () => {
    await expect(
      rawCommunity({
        label: "dup",
        boundAssetKey: assetKey("c"),
        status: "pending",
        createdAt: "2026-04-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "communities_bound_asset_key_unique",
    });
    await expect(
      rawCommunity({
        label: "dup-rejected",
        boundAssetKey: assetKey("c"),
        status: "rejected",
        createdAt: "2026-04-01T00:00:00Z",
      }),
    ).resolves.toEqual(expect.any(String));
  });

  async function account(alias: string): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s299:${randomUUID()}`,
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
    return user.id;
  }

  function create(ownerUserId: string, slug: string, boundAssetKey: string) {
    return repository.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        slug,
        boundAssetKey,
      ]),
      requestId: randomUUID(),
      name: slug,
      slug,
      description: null,
      logoRef: null,
      boundAssetKey,
    });
  }

  function rebind(
    ownerUserId: string,
    communityId: string,
    boundAssetKey: string | null,
  ) {
    return repository.updateCommunity({
      ownerUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "updateCommunity", [
        communityId,
        boundAssetKey ?? "",
      ]),
      requestId: randomUUID(),
      values: { boundAssetKey },
    });
  }

  function resubmit(ownerUserId: string, communityId: string) {
    return repository.resubmitCommunity({
      ownerUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "resubmitCommunity", [
        communityId,
      ]),
      requestId: randomUUID(),
    });
  }

  async function takenBy(promise: Promise<unknown>): Promise<string | null> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(CommunityBoundAssetTakenError);
      return (error as CommunityBoundAssetTakenError).holderCommunityId;
    }
    throw new Error("expected CommunityBoundAssetTakenError");
  }

  it("refuses a taken token on create and on rebind, naming the holder; a rejected holder frees it", async () => {
    const alice = await account("s299_alice");
    const bob = await account("s299_bob");
    const first = await create(alice, "s299-first", assetKey("1"));
    const firstId = first.community.communityId;

    // Create: the same token again (another owner) is refused.
    expect(await takenBy(create(bob, "s299-second", assetKey("1")))).toBe(
      firstId,
    );
    const slugs = await pool.query({
      text: "select 1 from public.communities where slug = 's299-second'",
    });
    expect(slugs.rowCount).toBe(0);

    // Rebind: Bob's community on token 2 may not move to token 1.
    const second = await create(bob, "s299-second", assetKey("2"));
    const secondId = second.community.communityId;
    expect(await takenBy(rebind(bob, secondId, assetKey("1")))).toBe(firstId);
    expect(await boundOf(secondId)).toMatchObject({
      bound_asset_key: assetKey("2"),
    });
    // Re-sending its own token, or clearing it, is not a conflict.
    await expect(rebind(bob, secondId, assetKey("2"))).resolves.toBeDefined();

    // Alice's community is rejected: token 1 is free for Bob.
    await repository.rejectCommunity({
      communityId: firstId,
      requestId: randomUUID(),
      reasonCode: "s299_test",
      reason: "Rejected for the test",
    });
    const rebound = await rebind(bob, secondId, assetKey("1"));
    expect(rebound.community.boundAssetKey).toBe(assetKey("1"));

    // Back to pending (resubmit) or reconsidered (verify), Alice's
    // community would hold token 1 again: both refused, naming Bob's.
    expect(await takenBy(resubmit(alice, firstId))).toBe(secondId);
    expect(
      await takenBy(
        repository.verifyCommunity({
          communityId: firstId,
          requestId: randomUUID(),
          reasonCode: "s299_test",
        }),
      ),
    ).toBe(secondId);
    const state = await pool.query<{ verification_status: string }>({
      text: "select verification_status from public.communities where community_id = $1",
      values: [firstId],
    });
    expect(state.rows[0]?.verification_status).toBe("rejected");

    // A rejected community may not park a taken token either: once it
    // let go of token 1 it cannot take it back while Bob holds it.
    await rebind(alice, firstId, null);
    expect(await takenBy(rebind(alice, firstId, assetKey("1")))).toBe(secondId);
    // After Alice moves to a free token, resubmission goes through.
    await rebind(alice, firstId, assetKey("3"));
    const back = await resubmit(alice, firstId);
    expect(back.community.verificationStatus).toBe("pending");
  });

  it("serialises two concurrent binders of one token: exactly one wins", async () => {
    const carol = await account("s299_carol");
    const dave = await account("s299_dave");
    const key = `${chainId}:0x${"4".repeat(40)}`;
    await pool.query({
      text: `
        insert into public.assets (
          asset_id, chain_id, address, symbol, name, decimals, status,
          source_kind, source_block_number, source_verified_at
        ) values ($1, $2, $3, 'FOUR', 'FOUR', 18, 'verified', 'chain_call', 1, clock_timestamp())
      `,
      values: [key, chainId, `0x${"4".repeat(40)}`],
    });
    const results = await Promise.allSettled([
      create(carol, "s299-race-c", key),
      create(dave, "s299-race-d", key),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(CommunityBoundAssetTakenError);
  });
});
