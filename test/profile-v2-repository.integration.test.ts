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
import { createPostgresDeviceSessionRepository } from "../src/database/device-session-repository.js";
import {
  createPostgresProfileRepository,
  ProfileRepositoryVersionConflictError,
  type ProfileRepository,
} from "../src/database/profile-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import {
  generateLoopId,
  LoopIdAllocationExhaustedError,
  loopIdPatternSource,
} from "../src/features/identity/loop-id.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import {
  ProfileV2IdempotencyConflictError,
  ProfileV2RepositoryUnavailableError,
  ProfileV2VersionConflictError,
  type ProfileV2Repository,
} from "../src/features/profile/profile-v2-repository.js";

const { Client, Pool } = pg;

function requireDatabaseUrl(): string {
  const value = process.env["DATABASE_URL"];
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is required for the integration test suite");
  }
  return value;
}

const databaseUrl = requireDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const loopIdPattern = new RegExp(loopIdPatternSource);
const migrationsBeforeLoopId = 14;

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(
  targetDatabaseUrl: string,
  count?: number,
  direction: "up" | "down" = "up",
): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction,
    ...(count === undefined ? {} : { count }),
    migrationsTable: "pgmigrations",
    log: () => undefined,
  });
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  const admin = new Client({
    connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

function uniqueViolation(error: unknown): {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
} {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  return {
    code: typeof record["code"] === "string" ? record["code"] : undefined,
    constraint:
      typeof record["constraint"] === "string"
        ? record["constraint"]
        : undefined,
  };
}

describe("PostgreSQL V2 LOOP ID profile migration and repository", () => {
  const databaseName = `loop_profile_v2_${randomUUID().replaceAll("-", "")}`;
  const legacyPrivyIds = [
    "did:privy:legacy-profile-v2:a",
    "did:privy:legacy-profile-v2:b",
    "did:privy:legacy-profile-v2:c",
  ] as const;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let v1: ProfileRepository;
  let v2: ProfileV2Repository;

  beforeAll(async () => {
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
    } finally {
      await admin.end();
    }
    temporaryDatabaseUrl = databaseConnectionUrl(databaseUrl, databaseName);
    try {
      await migrate(temporaryDatabaseUrl, migrationsBeforeLoopId);
      const seed = new Client({ connectionString: temporaryDatabaseUrl });
      await seed.connect();
      try {
        for (const privyUserId of legacyPrivyIds) {
          await seed.query({
            text: `insert into public.loop_users (privy_user_id) values ($1)`,
            values: [privyUserId],
          });
        }
        await seed.query({
          text: `
            insert into public.user_profiles (owner_user_id, alias, avatar_ref)
            select id, 'Legacy', 'avatar:legacy/main'
            from public.loop_users
            where privy_user_id = $1
          `,
          values: [legacyPrivyIds[0]],
        });
      } finally {
        await seed.end();
      }
      await migrate(temporaryDatabaseUrl);
    } catch (error) {
      await dropTemporaryDatabase(databaseName);
      throw error;
    }
    pool = new Pool({ connectionString: temporaryDatabaseUrl });
    database = createPostgresDatabase(
      loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        DATABASE_URL: temporaryDatabaseUrl,
      }),
      { error: () => undefined },
    );
    v1 = createPostgresProfileRepository(pool);
    v2 = createPostgresProfileV2Repository(pool);
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createOwner(label: string): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:profile-v2:${label}:${randomUUID()}`,
    );
    return user.id;
  }

  async function readLoopId(ownerUserId: string): Promise<string> {
    const result = await pool.query<{ loop_id: string }>({
      text: `select loop_id from public.loop_users where id = $1`,
      values: [ownerUserId],
    });
    const loopId = result.rows[0]?.loop_id;
    if (loopId === undefined) {
      throw new Error("owner is missing");
    }
    return loopId;
  }

  it("backfills a unique canonical LOOP ID for every pre-existing account and keeps V1 rows intact", async () => {
    const users = await pool.query<{
      privy_user_id: string;
      loop_id: string;
    }>({
      text: `
        select privy_user_id, loop_id
        from public.loop_users
        where privy_user_id = any($1::text[])
        order by privy_user_id
      `,
      values: [[...legacyPrivyIds]],
    });
    expect(users.rows).toHaveLength(legacyPrivyIds.length);
    for (const row of users.rows) {
      expect(row.loop_id).toMatch(loopIdPattern);
    }
    expect(new Set(users.rows.map((row) => row.loop_id)).size).toBe(
      legacyPrivyIds.length,
    );

    const legacyProfile = await pool.query<{
      alias: string;
      avatar_ref: string;
      profile_status: string;
      activated_at: Date | null;
      bio: string | null;
      interests: string[];
      record_version: number;
    }>({
      text: `
        select
          profiles.alias,
          profiles.avatar_ref,
          profiles.profile_status,
          profiles.activated_at,
          profiles.bio,
          profiles.interests,
          profiles.record_version
        from public.user_profiles as profiles
        join public.loop_users as users on users.id = profiles.owner_user_id
        where users.privy_user_id = $1
      `,
      values: [legacyPrivyIds[0]],
    });
    expect(legacyProfile.rows[0]).toEqual({
      alias: "Legacy",
      avatar_ref: "avatar:legacy/main",
      profile_status: "pending",
      activated_at: null,
      bio: null,
      interests: [],
      record_version: 1,
    });

    const nullCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users where loop_id is null",
    );
    expect(nullCount.rows[0]?.count).toBe("0");
  });

  it("refuses to roll back 000015 while any account holds a LOOP ID", async () => {
    await expect(migrate(temporaryDatabaseUrl, 1, "down")).rejects.toThrow(
      /an assigned LOOP ID is immutable/,
    );
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by run_on desc, id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe("000015_v2_loop_id_profile");
    await expect(
      readLoopId(await createOwner("after-rollback")),
    ).resolves.toMatch(loopIdPattern);
  });

  it("enforces LOOP ID uniqueness, format, and immutability in PostgreSQL", async () => {
    const ownerUserId = await createOwner("constraints");
    const loopId = await readLoopId(ownerUserId);
    expect(loopId).toMatch(loopIdPattern);

    await expect(
      pool.query({
        text: `insert into public.loop_users (privy_user_id, loop_id) values ($1, $2)`,
        values: [`did:privy:profile-v2:duplicate:${randomUUID()}`, loopId],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const details = uniqueViolation(error);
      return (
        details.code === "23505" &&
        details.constraint === "loop_users_loop_id_unique"
      );
    });
    await expect(
      pool.query({
        text: `insert into public.loop_users (privy_user_id, loop_id) values ($1, $2)`,
        values: [
          `did:privy:profile-v2:lowercase:${randomUUID()}`,
          "LOOP-abcdefgh",
        ],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => uniqueViolation(error).code === "23514",
    );
    await expect(
      pool.query({
        text: `update public.loop_users set loop_id = $2 where id = $1`,
        values: [ownerUserId, "LOOP-AAAAAAAA"],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => uniqueViolation(error).code === "55000",
    );
    await expect(readLoopId(ownerUserId)).resolves.toBe(loopId);
  });

  it("assigns a LOOP ID at bootstrap and retries on a generation conflict up to the bound", async () => {
    const existingOwner = await createOwner("collision-target");
    const takenLoopId = await readLoopId(existingOwner);
    const fresh = generateLoopId();
    const candidates = [takenLoopId, takenLoopId, fresh];
    const retrying = createPostgresDeviceSessionRepository(pool, {
      generateLoopId: () => candidates.shift() ?? fresh,
    });
    const privyUserId = `did:privy:profile-v2:retry:${randomUUID()}`;
    const bootstrapped = await retrying.bootstrapVerifiedPrivyUser({
      privyUserId,
      idempotencyKey: randomUUID(),
      requestSha256: "a".repeat(64),
      requestId: randomUUID(),
      deviceId: randomUUID(),
      clientPlatform: "ios",
      clientVersion: "1.0.0",
    });
    await expect(readLoopId(bootstrapped.account.id)).resolves.toBe(fresh);
    expect(candidates).toHaveLength(0);
    const sessions = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.device_sessions where owner_user_id = $1`,
      values: [bootstrapped.account.id],
    });
    expect(sessions.rows[0]?.count).toBe("1");

    const exhausted = createPostgresDeviceSessionRepository(pool, {
      generateLoopId: () => takenLoopId,
    });
    const exhaustedPrivyUserId = `did:privy:profile-v2:exhausted:${randomUUID()}`;
    await expect(
      exhausted.bootstrapVerifiedPrivyUser({
        privyUserId: exhaustedPrivyUserId,
        idempotencyKey: randomUUID(),
        requestSha256: "b".repeat(64),
        requestId: randomUUID(),
        deviceId: randomUUID(),
        clientPlatform: "android",
        clientVersion: "1.0.0",
      }),
    ).rejects.toBeInstanceOf(LoopIdAllocationExhaustedError);
    const notCreated = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.loop_users where privy_user_id = $1`,
      values: [exhaustedPrivyUserId],
    });
    expect(notCreated.rows[0]?.count).toBe("0");
  });

  it("creates one account with one LOOP ID under concurrent first bootstrap", async () => {
    const privyUserId = `did:privy:profile-v2:concurrent:${randomUUID()}`;
    const users = await Promise.all(
      Array.from({ length: 12 }, () =>
        database.internalUsers.getOrCreateByPrivyUserId(privyUserId),
      ),
    );
    expect(new Set(users.map((user) => user.id)).size).toBe(1);
    const count = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.loop_users where privy_user_id = $1`,
      values: [privyUserId],
    });
    expect(count.rows[0]?.count).toBe("1");
    const firstUser = users[0];
    if (firstUser === undefined) {
      throw new Error("no user");
    }
    await expect(readLoopId(firstUser.id)).resolves.toMatch(loopIdPattern);
  });

  it("reads a version-0 pending default that already carries the LOOP ID", async () => {
    const ownerUserId = await createOwner("defaults");
    await expect(v2.getProfile(ownerUserId)).resolves.toEqual({
      ownerUserId,
      loopId: await readLoopId(ownerUserId),
      alias: null,
      avatarRef: null,
      bio: null,
      interests: [],
      profileStatus: "pending",
      activatedAt: null,
      version: 0,
      updatedAt: null,
    });
    await expect(v2.getPrivacy(ownerUserId)).resolves.toBeNull();
    const counts = await pool.query<{ profiles: string; privacy: string }>({
      text: `
        select
          (select count(*)::text from public.user_profiles where owner_user_id = $1) as profiles,
          (select count(*)::text from public.privacy_preferences_v2 where owner_user_id = $1) as privacy
      `,
      values: [ownerUserId],
    });
    expect(counts.rows[0]).toEqual({ profiles: "0", privacy: "0" });
  });

  it("shares alias, avatar, and the CAS version with the frozen V1 profile in both directions", async () => {
    const ownerUserId = await createOwner("shared");

    const v2Created = await v2.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: {
        alias: "  Alice  ",
        avatarRef: "avatar:preset/people-02",
        bio: " Builder ",
        interests: ["DEFI", "AI", "DEFI"],
      },
    });
    expect(v2Created).toMatchObject({
      alias: "Alice",
      avatarRef: "avatar:preset/people-02",
      bio: "Builder",
      interests: ["DEFI", "AI"],
      profileStatus: "pending",
      version: 1,
    });
    await expect(v1.getProfile(ownerUserId)).resolves.toMatchObject({
      alias: "Alice",
      avatarRef: "avatar:preset/people-02",
      version: 1,
    });

    const v1Updated = await v1.replaceProfile({
      ownerUserId,
      expectedVersion: 1,
      profile: { alias: "Bob", avatar_ref: "avatar:legacy/main" },
    });
    expect(v1Updated).toMatchObject({ alias: "Bob", version: 2 });
    await expect(v2.getProfile(ownerUserId)).resolves.toMatchObject({
      alias: "Bob",
      avatarRef: "avatar:legacy/main",
      bio: "Builder",
      interests: ["DEFI", "AI"],
      version: 2,
    });

    await expect(
      v2.replaceProfile({
        ownerUserId,
        expectedVersion: 1,
        profile: {
          alias: "Stale",
          avatarRef: null,
          bio: null,
          interests: [],
        },
      }),
    ).rejects.toBeInstanceOf(ProfileV2VersionConflictError);
    await expect(
      v1.replaceProfile({
        ownerUserId,
        expectedVersion: 1,
        profile: { alias: "Stale", avatar_ref: null },
      }),
    ).rejects.toBeInstanceOf(ProfileRepositoryVersionConflictError);

    const v2Again = await v2.replaceProfile({
      ownerUserId,
      expectedVersion: 2,
      profile: {
        alias: "Bob",
        avatarRef: "avatar:preset/monogram",
        bio: null,
        interests: ["RWA"],
      },
    });
    expect(v2Again.version).toBe(3);
    await expect(v1.getProfile(ownerUserId)).resolves.toMatchObject({
      alias: "Bob",
      avatarRef: "avatar:preset/monogram",
      version: 3,
    });
    await expect(
      v2.replaceProfile({
        ownerUserId,
        expectedVersion: 99,
        profile: {
          alias: "Bob",
          avatarRef: "avatar:preset/monogram",
          bio: null,
          interests: ["RWA"],
        },
      }),
    ).resolves.toEqual(v2Again);
  });

  it("lets a V1 first write create the row with V2 defaults", async () => {
    const ownerUserId = await createOwner("v1-first");
    await v1.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: { alias: "Legacy", avatar_ref: null },
    });
    await expect(v2.getProfile(ownerUserId)).resolves.toMatchObject({
      alias: "Legacy",
      avatarRef: null,
      bio: null,
      interests: [],
      profileStatus: "pending",
      activatedAt: null,
      version: 1,
    });
  });

  it("activates once, replays by key, conflicts on a different digest, and never reverts", async () => {
    const ownerUserId = await createOwner("activation");
    const values = {
      alias: "Alice",
      avatarRef: "avatar:preset/people-07",
      interests: ["MEME", "NFT"],
    } as const;
    const digest = profileActivationDigest(values, "2.0");
    const idempotencyKey = randomUUID();

    const activated = await v2.activateProfile({
      ownerUserId,
      idempotencyKey,
      requestSha256: digest,
      requestId: randomUUID(),
      profile: values,
    });
    expect(activated).toMatchObject({
      alias: "Alice",
      avatarRef: "avatar:preset/people-07",
      interests: ["MEME", "NFT"],
      profileStatus: "active",
      version: 1,
    });
    expect(activated.activatedAt).not.toBeNull();

    const replayed = await v2.activateProfile({
      ownerUserId,
      idempotencyKey,
      requestSha256: digest,
      requestId: randomUUID(),
      profile: values,
    });
    expect(replayed).toEqual(activated);

    await expect(
      v2.activateProfile({
        ownerUserId,
        idempotencyKey,
        requestSha256: profileActivationDigest(
          { ...values, alias: "Bob" },
          "2.0",
        ),
        requestId: randomUUID(),
        profile: { ...values, alias: "Bob" },
      }),
    ).rejects.toBeInstanceOf(ProfileV2IdempotencyConflictError);

    const otherOwner = await createOwner("activation-other");
    await expect(
      v2.activateProfile({
        ownerUserId: otherOwner,
        idempotencyKey,
        requestSha256: digest,
        requestId: randomUUID(),
        profile: values,
      }),
    ).rejects.toBeInstanceOf(ProfileV2IdempotencyConflictError);

    const secondKey = await v2.activateProfile({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(
        { ...values, alias: "Ignored" },
        "2.0",
      ),
      requestId: randomUUID(),
      profile: { ...values, alias: "Ignored" },
    });
    expect(secondKey).toEqual(activated);

    const commands = await pool.query<{
      result_status: string;
      result_record_version: number;
    }>({
      text: `
        select result_status, result_record_version
        from public.profile_activation_commands
        where owner_user_id = $1
        order by created_at
      `,
      values: [ownerUserId],
    });
    expect(commands.rows).toEqual([
      { result_status: "activated", result_record_version: 1 },
      { result_status: "already_active", result_record_version: 1 },
    ]);

    await expect(
      pool.query({
        text: `update public.user_profiles set profile_status = 'pending', activated_at = null where owner_user_id = $1`,
        values: [ownerUserId],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => uniqueViolation(error).code === "55000",
    );

    const edited = await v2.replaceProfile({
      ownerUserId,
      expectedVersion: 1,
      profile: {
        alias: "Alice",
        avatarRef: "avatar:preset/people-07",
        bio: "After activation",
        interests: ["MEME", "NFT"],
      },
    });
    expect(edited).toMatchObject({
      profileStatus: "active",
      activatedAt: activated.activatedAt,
      version: 2,
    });
  });

  it("activates a pending V1-created row in place and bumps the shared version", async () => {
    const ownerUserId = await createOwner("activate-existing");
    await v1.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: { alias: "Draft", avatar_ref: null },
    });
    const values = { alias: "Final", avatarRef: null, interests: [] } as const;
    const activated = await v2.activateProfile({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(values, "2.0"),
      requestId: randomUUID(),
      profile: values,
    });
    expect(activated).toMatchObject({
      alias: "Final",
      profileStatus: "active",
      version: 2,
    });
    await expect(v1.getProfile(ownerUserId)).resolves.toMatchObject({
      alias: "Final",
      version: 2,
    });
  });

  it("keeps V2 privacy independent from V1 privacy with its own CAS version", async () => {
    const ownerUserId = await createOwner("privacy");
    const created = await v2.replacePrivacy({
      ownerUserId,
      expectedVersion: 0,
      privacy: {
        discoverable: true,
        anonymousMode: true,
        visibility: {
          totalAssets: "self",
          miningPower: "everyone",
          communities: "everyone",
          tradeHistory: "self",
        },
      },
    });
    expect(created).toMatchObject({
      ownerUserId,
      discoverable: true,
      anonymousMode: true,
      visibility: {
        totalAssets: "self",
        miningPower: "everyone",
        communities: "everyone",
        tradeHistory: "self",
      },
      version: 1,
    });
    await expect(v1.getPrivacy(ownerUserId)).resolves.toBeNull();

    await expect(
      v2.replacePrivacy({
        ownerUserId,
        expectedVersion: 0,
        privacy: {
          discoverable: false,
          anonymousMode: false,
          visibility: {
            totalAssets: "everyone",
            miningPower: "self",
            communities: "self",
            tradeHistory: "self",
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProfileV2VersionConflictError);

    const updated = await v2.replacePrivacy({
      ownerUserId,
      expectedVersion: 1,
      privacy: {
        discoverable: false,
        anonymousMode: false,
        visibility: {
          totalAssets: "everyone",
          miningPower: "self",
          communities: "self",
          tradeHistory: "everyone",
        },
      },
    });
    expect(updated).toMatchObject({ version: 2, anonymousMode: false });
    await expect(v2.getPrivacy(ownerUserId)).resolves.toEqual(updated);

    const fresh = await createOwner("privacy-absent");
    await expect(
      v2.replacePrivacy({
        ownerUserId: fresh,
        expectedVersion: 5,
        privacy: {
          discoverable: false,
          anonymousMode: false,
          visibility: {
            totalAssets: "self",
            miningPower: "self",
            communities: "self",
            tradeHistory: "self",
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("fails closed on unsafe or malformed inputs before any SQL mutation", async () => {
    const ownerUserId = await createOwner("invalid");
    await expect(v2.getProfile("not-a-uuid")).rejects.toBeInstanceOf(
      ProfileV2RepositoryUnavailableError,
    );
    await expect(
      v2.replaceProfile({
        ownerUserId,
        expectedVersion: 0,
        profile: {
          alias: "Alice",
          avatarRef: null,
          bio: "line\nbreak",
          interests: [],
        },
      }),
    ).rejects.toBeInstanceOf(ProfileV2RepositoryUnavailableError);
    await expect(
      v2.replaceProfile({
        ownerUserId,
        expectedVersion: 0,
        profile: {
          alias: "Alice",
          avatarRef: "avatar:not/preset",
          bio: null,
          interests: [],
        },
      }),
    ).rejects.toBeInstanceOf(ProfileV2RepositoryUnavailableError);
    await expect(v2.getProfile(ownerUserId)).resolves.toMatchObject({
      version: 0,
    });
  });
});
