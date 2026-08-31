import { randomUUID } from "node:crypto";

import pg, { type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GroupAliasImmutableRepositoryError,
  GroupAliasUnavailableRepositoryError,
  createPostgresAliasDirectoryRepository,
  type AliasDirectoryRepository,
} from "../src/database/alias-directory-repository.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

describe("PostgreSQL Alias directory repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;
  let repository: AliasDirectoryRepository;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("begin");
    repository = createPostgresAliasDirectoryRepository(
      client as unknown as InstanceType<typeof Pool>,
    );
  });

  afterEach(async () => {
    try {
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(label: string): Promise<string> {
    const inserted = await client.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:alias-directory:${label}:${randomUUID()}`],
    });
    const ownerUserId = inserted.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Alias directory integration owner setup failed");
    }
    return ownerUserId;
  }

  async function createPublicProfile(input: {
    readonly ownerUserId: string;
    readonly alias: string;
    readonly avatarRef?: string | null;
    readonly discoverable?: boolean;
    readonly includePrivacy?: boolean;
  }): Promise<string> {
    const profile = await client.query<{ public_profile_id: string }>({
      text: `
        insert into public.user_profiles (owner_user_id, alias, avatar_ref)
        values ($1, $2, $3)
        returning public_profile_id
      `,
      values: [input.ownerUserId, input.alias, input.avatarRef ?? null],
    });
    const publicProfileId = profile.rows[0]?.public_profile_id;
    if (publicProfileId === undefined) {
      throw new Error("Alias directory integration profile setup failed");
    }

    if (input.includePrivacy !== false) {
      await client.query({
        text: `
          insert into public.privacy_preferences (
            owner_user_id,
            discoverable,
            copy_trade_visibility
          )
          values ($1, $2, 'private')
        `,
        values: [input.ownerUserId, input.discoverable ?? true],
      });
    }

    return publicProfileId;
  }

  it("returns duplicate public aliases only for opted-in owners without leaking owner identities", async () => {
    const requesterUserId = await createOwner("public-requester");
    const duplicateOwnerA = await createOwner("public-duplicate-a");
    const duplicateOwnerB = await createOwner("public-duplicate-b");
    const hiddenOwner = await createOwner("public-hidden");
    const noPrivacyOwner = await createOwner("public-no-privacy");

    await createPublicProfile({
      ownerUserId: requesterUserId,
      alias: "Alice requester",
    });
    const publicProfileIdA = await createPublicProfile({
      ownerUserId: duplicateOwnerA,
      alias: "Alice",
      avatarRef: "avatar:alice/a",
    });
    const publicProfileIdB = await createPublicProfile({
      ownerUserId: duplicateOwnerB,
      alias: "Alice",
      avatarRef: null,
    });
    await createPublicProfile({
      ownerUserId: hiddenOwner,
      alias: "Alice hidden",
      discoverable: false,
    });
    await createPublicProfile({
      ownerUserId: noPrivacyOwner,
      alias: "Alice no privacy",
      includePrivacy: false,
    });

    const first = await repository.searchPublicAliases({
      requesterUserId,
      aliasPrefix: "AL",
      limit: 20,
    });
    const replay = await repository.searchPublicAliases({
      requesterUserId,
      aliasPrefix: "al",
      limit: 20,
    });

    expect(first).toEqual(replay);
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.publicProfileId).sort()).toEqual(
      [publicProfileIdA, publicProfileIdB].sort(),
    );
    expect(first.map((item) => item.alias)).toEqual(["Alice", "Alice"]);
    expect(new Set(first.map((item) => item.profileCode)).size).toBe(2);
    for (const item of first) {
      expect(Object.keys(item).sort()).toEqual([
        "alias",
        "avatarRef",
        "profileCode",
        "publicProfileId",
      ]);
      expect(item.profileCode).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      expect(item.publicProfileId).not.toBe(requesterUserId);
      expect(item.publicProfileId).not.toBe(duplicateOwnerA);
      expect(item.publicProfileId).not.toBe(duplicateOwnerB);
      expect(JSON.stringify(item)).not.toContain("did:privy:");
    }
  });

  it("treats percent and underscore as literal public-alias prefix characters", async () => {
    const requesterUserId = await createOwner("wildcard-requester");
    const percentOwner = await createOwner("wildcard-percent");
    const underscoreOwner = await createOwner("wildcard-underscore");
    const backslashOwner = await createOwner("wildcard-backslash");
    const oghamSpaceOwner = await createOwner("wildcard-ogham-space");
    const ordinaryOwner = await createOwner("wildcard-ordinary");

    await createPublicProfile({
      ownerUserId: percentOwner,
      alias: "A%literal",
    });
    await createPublicProfile({
      ownerUserId: underscoreOwner,
      alias: "A_literal",
    });
    await createPublicProfile({
      ownerUserId: backslashOwner,
      alias: "A\\literal",
    });
    await createPublicProfile({
      ownerUserId: oghamSpaceOwner,
      alias: "A\u1680Birch",
    });
    await createPublicProfile({ ownerUserId: ordinaryOwner, alias: "Axplain" });

    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "a%",
        limit: 20,
      }),
    ).resolves.toMatchObject([{ alias: "A%literal" }]);
    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "a_",
        limit: 20,
      }),
    ).resolves.toMatchObject([{ alias: "A_literal" }]);
    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "a\\",
        limit: 20,
      }),
    ).resolves.toMatchObject([{ alias: "A\\literal" }]);
    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "a\u1680b",
        limit: 20,
      }),
    ).resolves.toMatchObject([{ alias: "A\u1680Birch" }]);
  });

  it("bridges Node Unicode 17 NFKC to PostgreSQL 15.1 for search and uniqueness", async () => {
    const requesterUserId = await createOwner("unicode17-requester");
    const profileOwnerUserId = await createOwner("unicode17-profile");
    const spacingMarkOwnerUserId = await createOwner(
      "unicode17-spacing-mark-profile",
    );
    const groupOwnerA = await createOwner("unicode17-group-a");
    const groupOwnerB = await createOwner("unicode17-group-b");
    const publicProfileId = await createPublicProfile({
      ownerUserId: profileOwnerUserId,
      alias: "꟱am",
    });
    const spacingMarkPublicProfileId = await createPublicProfile({
      ownerUserId: spacingMarkOwnerUserId,
      alias: "¨sam",
    });

    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "꟱a",
        limit: 20,
      }),
    ).resolves.toMatchObject([
      {
        publicProfileId,
        alias: "꟱am",
        avatarRef: null,
      },
    ]);
    await expect(
      repository.searchPublicAliases({
        requesterUserId,
        aliasPrefix: "¨sam",
        limit: 20,
      }),
    ).resolves.toMatchObject([
      {
        publicProfileId: spacingMarkPublicProfileId,
        alias: "¨sam",
        avatarRef: null,
      },
    ]);

    const group = await repository.resolveCommunicationGroup(
      "alias-unicode17-room",
    );
    await repository.reserveGroupAlias({
      groupId: group.groupId,
      ownerUserId: groupOwnerA,
      alias: "꟱\u0301am",
    });
    await expect(
      repository.reserveGroupAlias({
        groupId: group.groupId,
        ownerUserId: groupOwnerB,
        alias: "Śam",
      }),
    ).rejects.toBeInstanceOf(GroupAliasUnavailableRepositoryError);
  });

  it("resolves one stable opaque group for repeated Stream channel resolution", async () => {
    const first = await repository.resolveCommunicationGroup(
      "alias-integration-room",
    );
    const replay = await repository.resolveCommunicationGroup(
      "alias-integration-room",
    );

    expect(replay).toEqual(first);
    expect(first.streamChannelId).toBe("alias-integration-room");
    await expect(
      repository.findCommunicationGroup(first.groupId),
    ).resolves.toEqual(first);
  });

  it("enforces normalized per-group uniqueness and permanent same-owner immutability", async () => {
    const ownerA = await createOwner("group-owner-a");
    const ownerB = await createOwner("group-owner-b");
    const group = await repository.resolveCommunicationGroup(
      "alias-normalization-room",
    );

    const first = await repository.reserveGroupAlias({
      groupId: group.groupId,
      ownerUserId: ownerA,
      alias: "ＡＬＩＣＥ",
    });
    await expect(
      repository.reserveGroupAlias({
        groupId: group.groupId,
        ownerUserId: ownerA,
        alias: "ＡＬＩＣＥ",
      }),
    ).resolves.toEqual(first);
    await expect(
      repository.reserveGroupAlias({
        groupId: group.groupId,
        ownerUserId: ownerA,
        alias: "alice",
      }),
    ).rejects.toBeInstanceOf(GroupAliasImmutableRepositoryError);
    await expect(
      repository.reserveGroupAlias({
        groupId: group.groupId,
        ownerUserId: ownerB,
        alias: "alice",
      }),
    ).rejects.toBeInstanceOf(GroupAliasUnavailableRepositoryError);

    await expect(
      repository.findGroupAlias(group.groupId, ownerA),
    ).resolves.toEqual(first);
    await expect(
      repository.findGroupAlias(group.groupId, ownerB),
    ).resolves.toBeNull();
  });

  it("keeps pending group aliases out of search and returns them after confirmation", async () => {
    const requesterUserId = await createOwner("group-search-requester");
    const candidateUserId = await createOwner("group-search-candidate");
    const group =
      await repository.resolveCommunicationGroup("alias-search-room");
    const pending = await repository.reserveGroupAlias({
      groupId: group.groupId,
      ownerUserId: candidateUserId,
      alias: "Moon Finch",
    });

    expect(pending).toMatchObject({
      projectionState: "pending",
      confirmedAt: null,
    });
    await expect(
      repository.searchGroupAliases({
        groupId: group.groupId,
        requesterUserId,
        aliasPrefix: "MO",
        limit: 20,
      }),
    ).resolves.toEqual([]);

    const confirmed = await repository.confirmGroupAliasProjection({
      groupAliasId: pending.groupAliasId,
      groupId: group.groupId,
      ownerUserId: candidateUserId,
    });
    expect(confirmed).toMatchObject({
      groupAliasId: pending.groupAliasId,
      projectionState: "confirmed",
    });
    expect(confirmed.confirmedAt).not.toBeNull();

    await expect(
      repository.searchGroupAliases({
        groupId: group.groupId,
        requesterUserId,
        aliasPrefix: "mo",
        limit: 20,
      }),
    ).resolves.toEqual([confirmed]);
  });

  it("keeps confirmation timestamps monotonic when a lock wait exposes a newer row timestamp", async () => {
    const ownerUserId = await createOwner("group-confirmation-clock");
    const group = await repository.resolveCommunicationGroup(
      "alias-confirmation-clock-room",
    );
    const pending = await repository.reserveGroupAlias({
      groupId: group.groupId,
      ownerUserId,
      alias: "Clock Finch",
    });

    // A concurrent updater can commit a row timestamp after another confirming
    // statement has captured its statement clock but before it acquires the row.
    const advancedPending = await client.query<{ updated_at: Date }>({
      text: `
        update public.group_alias_reservations
        set updated_at = clock_timestamp() + interval '5 minutes'
        where group_alias_id = $1
        returning updated_at
      `,
      values: [pending.groupAliasId],
    });
    const pendingUpdatedAt = advancedPending.rows[0]?.updated_at;
    if (pendingUpdatedAt === undefined) {
      throw new Error("Expected an advanced pending timestamp");
    }

    const confirmed = await repository.confirmGroupAliasProjection({
      groupAliasId: pending.groupAliasId,
      groupId: group.groupId,
      ownerUserId,
    });
    expect(confirmed.confirmedAt).toBe(pendingUpdatedAt.toISOString());

    const advancedConfirmed = await client.query<{ updated_at: Date }>({
      text: `
        update public.group_alias_reservations
        set updated_at = updated_at + interval '5 minutes'
        where group_alias_id = $1
        returning updated_at
      `,
      values: [pending.groupAliasId],
    });
    const confirmedUpdatedAt = advancedConfirmed.rows[0]?.updated_at;
    if (confirmedUpdatedAt === undefined) {
      throw new Error("Expected an advanced confirmed timestamp");
    }

    const replay = await repository.confirmGroupAliasProjection({
      groupAliasId: pending.groupAliasId,
      groupId: group.groupId,
      ownerUserId,
    });
    const finalRow = await client.query<{
      confirmed_at: Date;
      updated_at: Date;
    }>({
      text: `
        select confirmed_at, updated_at
        from public.group_alias_reservations
        where group_alias_id = $1
      `,
      values: [pending.groupAliasId],
    });

    expect(replay.confirmedAt).toBe(confirmed.confirmedAt);
    expect(finalRow.rows[0]?.confirmed_at.toISOString()).toBe(
      confirmed.confirmedAt,
    );
    expect(finalRow.rows[0]?.updated_at.toISOString()).toBe(
      confirmedUpdatedAt.toISOString(),
    );
  });
});
