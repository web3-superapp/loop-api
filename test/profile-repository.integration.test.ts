import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ProfileRepositoryUnavailableError,
  ProfileRepositoryVersionConflictError,
  createPostgresProfileRepository,
  type ProfileRepository,
} from "../src/database/profile-repository.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

describe("PostgreSQL Profile repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ownedUserIds = new Set<string>();
  let repository: ProfileRepository;

  beforeAll(() => {
    repository = createPostgresProfileRepository(pool);
  });

  async function cleanupOwnedRows(): Promise<void> {
    const ownerIds = [...ownedUserIds];
    if (ownerIds.length === 0) {
      return;
    }
    await pool.query({
      text: `
        delete from public.privacy_preferences
        where owner_user_id = any($1::uuid[])
      `,
      values: [ownerIds],
    });
    await pool.query({
      text: `
        delete from public.user_profiles
        where owner_user_id = any($1::uuid[])
      `,
      values: [ownerIds],
    });
    await pool.query({
      text: `
        delete from public.loop_users
        where id = any($1::uuid[])
      `,
      values: [ownerIds],
    });
    ownedUserIds.clear();
  }

  afterEach(cleanupOwnedRows);

  afterAll(async () => {
    await cleanupOwnedRows();
    await pool.end();
  });

  async function createOwner(label: string): Promise<string> {
    const inserted = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:profile-repository:${label}:${randomUUID()}`],
    });
    const ownerUserId = inserted.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Profile integration owner setup failed");
    }
    ownedUserIds.add(ownerUserId);
    return ownerUserId;
  }

  it("returns version-0 absence without writing either table", async () => {
    const ownerUserId = await createOwner("defaults");

    await expect(repository.getProfile(ownerUserId)).resolves.toBeNull();
    await expect(repository.getPrivacy(ownerUserId)).resolves.toBeNull();
    const counts = await pool.query<{
      privacy_count: string;
      profile_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.user_profiles
            where owner_user_id = $1) as profile_count,
          (select count(*)::text from public.privacy_preferences
            where owner_user_id = $1) as privacy_count
      `,
      values: [ownerUserId],
    });
    expect(counts.rows[0]).toEqual({
      privacy_count: "0",
      profile_count: "0",
    });
  });

  it("creates, normalizes, updates, clears, and deterministically replays Profile", async () => {
    const ownerUserId = await createOwner("profile-lifecycle");

    const created = await repository.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: {
        alias: "  Alice 😀  ",
        avatar_ref: "avatar:alice/main",
      },
    });
    expect(created).toMatchObject({
      ownerUserId,
      alias: "Alice 😀",
      avatarRef: "avatar:alice/main",
      version: 1,
    });

    const replay = await repository.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: { alias: "Alice 😀", avatar_ref: "avatar:alice/main" },
    });
    expect(replay).toEqual(created);

    const updated = await repository.replaceProfile({
      ownerUserId,
      expectedVersion: 1,
      profile: { alias: "Alice", avatar_ref: null },
    });
    expect(updated).toMatchObject({
      alias: "Alice",
      avatarRef: null,
      version: 2,
    });

    await expect(
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 1,
        profile: { alias: "Different", avatar_ref: null },
      }),
    ).rejects.toBeInstanceOf(ProfileRepositoryVersionConflictError);

    const cleared = await repository.replaceProfile({
      ownerUserId,
      expectedVersion: 2,
      profile: { alias: null, avatar_ref: null },
    });
    expect(cleared).toMatchObject({ alias: null, avatarRef: null, version: 3 });
    await expect(repository.getProfile(ownerUserId)).resolves.toEqual(cleared);
  });

  it("treats an absent default as an identical stale read but creates on version 0", async () => {
    const ownerUserId = await createOwner("absent-identical");

    await expect(
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 7,
        profile: { alias: null, avatar_ref: null },
      }),
    ).resolves.toBeNull();

    await expect(
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 0,
        profile: { alias: null, avatar_ref: null },
      }),
    ).resolves.toMatchObject({ version: 1, alias: null, avatarRef: null });
  });

  it("keeps privacy fail closed while supporting versioned preference replacement", async () => {
    const ownerUserId = await createOwner("privacy-lifecycle");
    const created = await repository.replacePrivacy({
      ownerUserId,
      expectedVersion: 0,
      privacy: {
        discoverable: false,
        copy_trade_visibility: "private",
      },
    });
    expect(created).toMatchObject({
      ownerUserId,
      discoverable: false,
      copyTradeVisibility: "private",
      version: 1,
    });

    const updated = await repository.replacePrivacy({
      ownerUserId,
      expectedVersion: 1,
      privacy: {
        discoverable: true,
        copy_trade_visibility: "followers",
      },
    });
    expect(updated).toMatchObject({
      discoverable: true,
      copyTradeVisibility: "followers",
      version: 2,
    });

    await expect(
      repository.replacePrivacy({
        ownerUserId,
        expectedVersion: 0,
        privacy: {
          discoverable: true,
          copy_trade_visibility: "followers",
        },
      }),
    ).resolves.toEqual(updated);
    await expect(
      repository.replacePrivacy({
        ownerUserId,
        expectedVersion: 1,
        privacy: {
          discoverable: true,
          copy_trade_visibility: "public",
        },
      }),
    ).rejects.toBeInstanceOf(ProfileRepositoryVersionConflictError);
  });

  it("serializes concurrent first writes and permits only one different target", async () => {
    const sameOwner = await createOwner("same-concurrency");
    const sameInput = {
      ownerUserId: sameOwner,
      expectedVersion: 0,
      profile: { alias: "Same", avatar_ref: null },
    } as const;
    const sameResults = await Promise.all([
      repository.replaceProfile(sameInput),
      repository.replaceProfile(sameInput),
    ]);
    expect(sameResults[0]).toEqual(sameResults[1]);
    expect(sameResults[0]).toMatchObject({ version: 1 });

    const differentOwner = await createOwner("different-concurrency");
    const differentResults = await Promise.allSettled([
      repository.replacePrivacy({
        ownerUserId: differentOwner,
        expectedVersion: 0,
        privacy: {
          discoverable: true,
          copy_trade_visibility: "followers",
        },
      }),
      repository.replacePrivacy({
        ownerUserId: differentOwner,
        expectedVersion: 0,
        privacy: {
          discoverable: true,
          copy_trade_visibility: "public",
        },
      }),
    ]);
    expect(
      differentResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = differentResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(
      ProfileRepositoryVersionConflictError,
    );
  });

  it("serializes divergent updates from the same committed nonzero version", async () => {
    const ownerUserId = await createOwner("nonzero-concurrency");
    await repository.replaceProfile({
      ownerUserId,
      expectedVersion: 0,
      profile: { alias: "Initial", avatar_ref: null },
    });

    const results = await Promise.allSettled([
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 1,
        profile: { alias: "First", avatar_ref: null },
      }),
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 1,
        profile: { alias: "Second", avatar_ref: null },
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(
      ProfileRepositoryVersionConflictError,
    );
    await expect(repository.getProfile(ownerUserId)).resolves.toMatchObject({
      version: 2,
    });
  });

  it("keeps Profile and privacy rows isolated by owner", async () => {
    const ownerA = await createOwner("owner-a");
    const ownerB = await createOwner("owner-b");
    await repository.replaceProfile({
      ownerUserId: ownerA,
      expectedVersion: 0,
      profile: { alias: "Owner A", avatar_ref: "avatar:owner-a" },
    });
    await repository.replacePrivacy({
      ownerUserId: ownerA,
      expectedVersion: 0,
      privacy: {
        discoverable: true,
        copy_trade_visibility: "public",
      },
    });

    await expect(repository.getProfile(ownerB)).resolves.toBeNull();
    await expect(repository.getPrivacy(ownerB)).resolves.toBeNull();
    await expect(repository.getProfile(ownerA)).resolves.toMatchObject({
      alias: "Owner A",
    });
  });

  it("fails closed on invalid repository inputs before SQL mutation", async () => {
    const ownerUserId = await createOwner("invalid-input");

    await expect(repository.getProfile("not-a-uuid")).rejects.toBeInstanceOf(
      ProfileRepositoryUnavailableError,
    );
    await expect(
      repository.replaceProfile({
        ownerUserId,
        expectedVersion: 0,
        profile: { alias: "bad\nname", avatar_ref: null },
      }),
    ).rejects.toBeInstanceOf(ProfileRepositoryUnavailableError);
    await expect(repository.getProfile(ownerUserId)).resolves.toBeNull();
  });
});
