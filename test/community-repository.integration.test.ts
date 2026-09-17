import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createPostgresCommunityRepository,
  listVerifiedCommunitiesWithoutChannel,
} from "../src/database/community-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import {
  commandDigest,
  updateCommunityDigestParts,
  type CreateCommunityValues,
} from "../src/features/community/community-contract.js";
import {
  CommunityDataStaleError,
  CommunityIdempotencyConflictError,
  CommunityNotFoundError,
  CommunityPermissionDeniedError,
  CommunityProfileRequiredError,
  CommunitySlugTakenError,
  CommunityTargetUnavailableError,
  type CommunityRepository,
} from "../src/features/community/community-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Client, Pool } = pg;

const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(targetDatabaseUrl: string): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction: "up",
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

function postgresError(error: unknown): {
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

function communityValues(slug: string, name: string): CreateCommunityValues {
  return Object.freeze({
    name,
    slug,
    description: null,
    logoRef: null,
    boundAssetKey: null,
  });
}

describe("PostgreSQL V2 community and social graph repository", () => {
  const databaseName = `loop_community_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let repository: CommunityRepository;
  let profiles: ProfileV2Repository;

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
    repository = createPostgresCommunityRepository(pool);
    profiles = createPostgresProfileV2Repository(pool);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createAccount(
    label: string,
    aliasOverride?: string,
  ): Promise<{
    readonly userId: string;
    readonly publicProfileId: string;
  }> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:community:${label}:${randomUUID()}`,
    );
    const alias = aliasOverride ?? `member_${randomUUID().slice(0, 8)}`;
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
    const result = await pool.query<{ public_profile_id: string }>({
      text: `
        select public_profile_id
        from public.user_profiles
        where owner_user_id = $1
      `,
      values: [user.id],
    });
    const publicProfileId = result.rows[0]?.public_profile_id;
    if (publicProfileId === undefined) {
      throw new Error("The activated profile has no public profile ID");
    }
    await pool.query({
      text: `
        insert into public.privacy_preferences_v2 (owner_user_id, discoverable)
        values ($1, true)
        on conflict (owner_user_id) do update set discoverable = true
      `,
      values: [user.id],
    });
    return { userId: user.id, publicProfileId };
  }

  async function createCommunity(
    ownerUserId: string,
    slug: string,
    name = "Frog Holders",
  ): Promise<string> {
    const values = communityValues(slug, name);
    const detail = await repository.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        values.name,
        values.slug,
        "",
        "",
        "",
      ]),
      requestId: randomUUID(),
      ...values,
    });
    return detail.community.communityId;
  }

  function join(ownerUserId: string, communityId: string): Promise<unknown> {
    return repository.joinCommunity({
      ownerUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "joinCommunity", [communityId]),
      requestId: randomUUID(),
    });
  }

  function follow(
    ownerUserId: string,
    targetPublicProfileId: string,
  ): Promise<unknown> {
    return repository.follow({
      ownerUserId,
      targetPublicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "follow", [
        targetPublicProfileId,
      ]),
      requestId: randomUUID(),
    });
  }

  async function memberCount(communityId: string): Promise<number> {
    const result = await pool.query<{ member_count: number }>({
      text: `select member_count from public.communities where community_id = $1`,
      values: [communityId],
    });
    return result.rows[0]?.member_count ?? -1;
  }

  it("creates a pending community with the applicant as its only owner", async () => {
    const owner = await createAccount("owner");
    const communityId = await createCommunity(owner.userId, "frog-holders");
    const detail = await repository.getCommunity({
      viewerUserId: owner.userId,
      communityId,
    });

    expect(detail.community.verificationStatus).toBe("pending");
    expect(detail.community.memberCount).toBe(1);
    expect(detail.viewerMembership).toMatchObject({
      role: "owner",
      status: "active",
    });

    const audit = await pool.query<{ event_type: string; to_role: string }>({
      text: `
        select event_type, to_role
        from public.community_role_events
        where community_id = $1
      `,
      values: [communityId],
    });
    expect(audit.rows).toEqual([
      { event_type: "community_created", to_role: "owner" },
    ]);
  });

  it("refuses a community application from an account without an activated profile", async () => {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:community:no-profile:${randomUUID()}`,
    );
    await expect(
      createCommunity(user.id, "no-profile-community"),
    ).rejects.toBeInstanceOf(CommunityProfileRequiredError);
  });

  it("enforces the unique slug", async () => {
    const owner = await createAccount("slug-owner");
    await createCommunity(owner.userId, "unique-slug");
    const second = await createAccount("slug-owner-2");
    await expect(
      createCommunity(second.userId, "unique-slug"),
    ).rejects.toBeInstanceOf(CommunitySlugTakenError);
  });

  it("rejects a second owner row and a self-follow at the database level", async () => {
    const owner = await createAccount("constraint-owner");
    const other = await createAccount("constraint-other");
    const communityId = await createCommunity(owner.userId, "constraints");

    const secondOwner = await pool
      .query({
        text: `
          insert into public.community_memberships (
            community_id, owner_user_id, role, status
          ) values ($1, $2, 'owner', 'active')
        `,
        values: [communityId, other.userId],
      })
      .then(
        () => null,
        (error: unknown) => postgresError(error),
      );
    expect(secondOwner?.code).toBe("23505");
    expect(secondOwner?.constraint).toBe("community_memberships_one_owner_idx");

    const selfFollow = await pool
      .query({
        text: `
          insert into public.follow_edges (follower_user_id, followee_user_id)
          values ($1, $1)
        `,
        values: [owner.userId],
      })
      .then(
        () => null,
        (error: unknown) => postgresError(error),
      );
    expect(selfFollow?.code).toBe("23514");
  });

  it("maintains member_count inside the transaction under concurrent joins", async () => {
    const owner = await createAccount("count-owner");
    const communityId = await createCommunity(owner.userId, "count-community");
    const joiners = await Promise.all(
      Array.from({ length: 8 }, async (_value, index) =>
        createAccount(`count-joiner-${String(index)}`),
      ),
    );

    await Promise.all(
      joiners.map(async (joiner) => join(joiner.userId, communityId)),
    );
    expect(await memberCount(communityId)).toBe(9);

    const page = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
    });
    expect(page.counts.all).toBe(9);
    expect(page.counts.owner).toBe(1);
    expect(page.items[0]?.role).toBe("owner");
  });

  it("never repeats a member across keyset pages", async () => {
    const owner = await createAccount("keyset-owner");
    const communityId = await createCommunity(owner.userId, "keyset-members");
    for (let index = 0; index < 4; index += 1) {
      const joiner = await createAccount(`keyset-joiner-${String(index)}`);
      await join(joiner.userId, communityId);
    }

    const seen: string[] = [];
    let after:
      | {
          readonly lastRoleRank: number;
          readonly lastJoinedAt: string;
          readonly lastMembershipId: string;
        }
      | undefined;
    for (let request = 0; request < 5; request += 1) {
      const pageRecord = await repository.listMembers({
        viewerUserId: owner.userId,
        communityId,
        role: "all",
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      if (pageRecord.items.length === 0) {
        break;
      }
      seen.push(...pageRecord.items.map((item) => item.membershipId));
      const last = pageRecord.items.at(-1);
      if (last === undefined) {
        break;
      }
      after = {
        lastRoleRank: last.role === "owner" ? 0 : last.role === "admin" ? 1 : 2,
        lastJoinedAt: last.joinedAt,
        lastMembershipId: last.membershipId,
      };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("narrows the member directory to an alias prefix without changing the counts", async () => {
    const owner = await createAccount("prefix-owner", "Frogger");
    const communityId = await createCommunity(owner.userId, "prefix-community");
    const maxi = await createAccount("prefix-maxi", "frog maxi");
    const fullwidth = await createAccount(
      "prefix-fullwidth",
      "\uFF26\uFF32\uFF2F\uFF27\uFF39",
    );
    const toad = await createAccount("prefix-toad", "Toad Only");
    for (const account of [maxi, fullwidth, toad]) {
      await join(account.userId, communityId);
    }

    const hit = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
      aliasPrefix: "fro",
    });
    expect(
      hit.items.map((item) => item.profile.publicProfileId).sort(),
    ).toEqual(
      [owner.publicProfileId, maxi.publicProfileId, fullwidth.publicProfileId]
        .slice()
        .sort(),
    );
    // The owner still sorts first inside the narrowed page.
    expect(hit.items[0]?.role).toBe("owner");
    // The segment counts describe the whole directory, not the query.
    expect(hit.counts.all).toBe(4);

    const miss = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
      aliasPrefix: "zzz",
    });
    expect(miss.items).toEqual([]);
    expect(miss.counts.all).toBe(4);

    // The prefix is normalized exactly like the stored key, so a fullwidth or
    // upper-case query reaches the same rows.
    for (const prefix of ["FRO", "\uFF26\uFF32\uFF2F", "  fro  "]) {
      const equivalent = await repository.listMembers({
        viewerUserId: owner.userId,
        communityId,
        role: "all",
        limit: 50,
        aliasPrefix: prefix,
      });
      expect(equivalent.items.length, prefix).toBe(3);
    }
  });

  it("matches a member alias prefix literally and never as a pattern", async () => {
    const owner = await createAccount("wildcard-owner", "Wildcard Owner");
    const communityId = await createCommunity(owner.userId, "wildcard-members");
    const percent = await createAccount("wildcard-percent", "100%_pure");
    await join(percent.userId, communityId);

    const literal = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
      aliasPrefix: "100%_",
    });
    expect(literal.items.map((item) => item.profile.alias)).toEqual([
      "100%_pure",
    ]);

    for (const pattern of ["%", "_", "\\"]) {
      const wildcard = await repository.listMembers({
        viewerUserId: owner.userId,
        communityId,
        role: "all",
        limit: 50,
        aliasPrefix: pattern,
      });
      expect(wildcard.items, pattern).toEqual([]);
    }
  });

  it("keyset pages a narrowed member directory", async () => {
    const owner = await createAccount("paged-owner", "Owner Only");
    const communityId = await createCommunity(owner.userId, "paged-members");
    const joiners = [];
    for (let index = 0; index < 3; index += 1) {
      const joiner = await createAccount(
        `paged-joiner-${String(index)}`,
        `Frog ${String(index)}`,
      );
      await join(joiner.userId, communityId);
      joiners.push(joiner);
    }

    const first = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 2,
      aliasPrefix: "frog",
    });
    expect(first.items).toHaveLength(2);
    const last = first.items[1];
    if (last === undefined) {
      throw new Error("The narrowed page is missing its second row");
    }
    const second = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 2,
      aliasPrefix: "frog",
      after: {
        lastRoleRank: 2,
        lastJoinedAt: last.joinedAt,
        lastMembershipId: last.membershipId,
      },
    });
    expect(second.items).toHaveLength(1);
    expect(
      [...first.items, ...second.items].map(
        (item) => item.profile.publicProfileId,
      ),
    ).toEqual(joiners.map((joiner) => joiner.publicProfileId));
  });

  it("replays an identical join and conflicts on a different digest", async () => {
    const owner = await createAccount("replay-owner");
    const joiner = await createAccount("replay-joiner");
    const communityId = await createCommunity(owner.userId, "replay-community");
    const key = randomUUID();
    const digest = commandDigest("community", "joinCommunity", [communityId]);

    await repository.joinCommunity({
      ownerUserId: joiner.userId,
      communityId,
      idempotencyKey: key,
      requestSha256: digest,
      requestId: randomUUID(),
    });
    await repository.joinCommunity({
      ownerUserId: joiner.userId,
      communityId,
      idempotencyKey: key,
      requestSha256: digest,
      requestId: randomUUID(),
    });
    expect(await memberCount(communityId)).toBe(2);

    await expect(
      repository.joinCommunity({
        ownerUserId: joiner.userId,
        communityId,
        idempotencyKey: key,
        requestSha256: commandDigest("community", "joinCommunity", [
          "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityIdempotencyConflictError);
  });

  it("applies the permission matrix and refuses an owner as a target", async () => {
    const owner = await createAccount("gov-owner");
    const admin = await createAccount("gov-admin");
    const member = await createAccount("gov-member");
    const communityId = await createCommunity(owner.userId, "governance");
    await join(admin.userId, communityId);
    await join(member.userId, communityId);

    const govern = (
      actorUserId: string,
      targetPublicProfileId: string,
      action:
        | "assignAdmin"
        | "revokeAdmin"
        | "transferOwnership"
        | "mute"
        | "unmute"
        | "ban"
        | "unban",
    ) =>
      repository.governMember({
        actorUserId,
        communityId,
        targetPublicProfileId,
        action,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "governMember", [
          communityId,
          targetPublicProfileId,
          action,
        ]),
        requestId: randomUUID(),
      });

    await govern(owner.userId, admin.publicProfileId, "assignAdmin");
    await expect(
      govern(admin.userId, owner.publicProfileId, "ban"),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);
    await expect(
      govern(member.userId, admin.publicProfileId, "mute"),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);
    await expect(
      govern(admin.userId, member.publicProfileId, "assignAdmin"),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);

    await govern(admin.userId, member.publicProfileId, "mute");
    await expect(
      govern(admin.userId, member.publicProfileId, "mute"),
    ).rejects.toBeInstanceOf(CommunityDataStaleError);
    await govern(admin.userId, member.publicProfileId, "unmute");

    expect(await memberCount(communityId)).toBe(3);
    await govern(admin.userId, member.publicProfileId, "ban");
    expect(await memberCount(communityId)).toBe(2);
    const afterBan = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
    });
    expect(afterBan.counts.all).toBe(2);
    expect(afterBan.items).toHaveLength(2);
    expect(
      afterBan.items.some(
        (item) => item.profile.publicProfileId === member.publicProfileId,
      ),
    ).toBe(false);
    const bannedRow = await pool.query<{ role: string; status: string }>({
      text: `
        select role, status
        from public.community_memberships
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, member.userId],
    });
    expect(bannedRow.rows[0]).toEqual({ role: "member", status: "banned" });

    const events = await pool.query<{ event_type: string }>({
      text: `
        select event_type
        from public.community_role_events
        where community_id = $1
        order by occurred_at, event_id
      `,
      values: [communityId],
    });
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "community_created",
      "member_joined",
      "member_joined",
      "role_changed",
      "member_muted",
      "member_unmuted",
      "member_banned",
    ]);
  });

  it("shows banned memberships only to governance and restores them on unban", async () => {
    const owner = await createAccount("unban-owner");
    const member = await createAccount("unban-member");
    const bystander = await createAccount("unban-bystander");
    const communityId = await createCommunity(owner.userId, "unbans");
    await join(member.userId, communityId);
    await join(bystander.userId, communityId);
    const joinedAt = (
      await repository.listMembers({
        viewerUserId: owner.userId,
        communityId,
        role: "all",
        limit: 50,
      })
    ).items.find(
      (item) => item.profile.publicProfileId === member.publicProfileId,
    )?.joinedAt;
    expect(joinedAt).toBeDefined();

    const govern = (actorUserId: string, action: "ban" | "unban") =>
      repository.governMember({
        actorUserId,
        communityId,
        targetPublicProfileId: member.publicProfileId,
        action,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "governMember", [
          communityId,
          member.publicProfileId,
          action,
        ]),
        requestId: randomUUID(),
      });

    await govern(owner.userId, "ban");

    const bannedView = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "banned",
      limit: 50,
    });
    expect(bannedView.items).toHaveLength(1);
    expect(bannedView.items[0]).toMatchObject({
      status: "banned",
      role: "member",
      joinedAt,
    });
    // The banned view never changes the non-banned segment counts.
    expect(bannedView.counts.all).toBe(2);
    const defaultView = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
    });
    expect(defaultView.items.some((item) => item.status === "banned")).toBe(
      false,
    );
    // A plain member may not read the governance view.
    await expect(
      repository.listMembers({
        viewerUserId: bystander.userId,
        communityId,
        role: "banned",
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);

    const unbanned = await govern(owner.userId, "unban");
    expect(unbanned.target).toMatchObject({
      role: "member",
      status: "active",
      joinedAt,
    });
    const afterUnban = await repository.listMembers({
      viewerUserId: owner.userId,
      communityId,
      role: "all",
      limit: 50,
    });
    expect(afterUnban.counts.all).toBe(3);
    expect(
      afterUnban.items.find(
        (item) => item.profile.publicProfileId === member.publicProfileId,
      ),
    ).toMatchObject({ role: "member", status: "active", joinedAt });
    expect(
      (
        await repository.listMembers({
          viewerUserId: owner.userId,
          communityId,
          role: "banned",
          limit: 50,
        })
      ).items,
    ).toHaveLength(0);

    const events = await pool.query<{ event_type: string }>({
      text: `
        select event_type
        from public.community_role_events
        where community_id = $1
        order by occurred_at, event_id
      `,
      values: [communityId],
    });
    expect(events.rows.map((row) => row.event_type)).toContain(
      "member_unbanned",
    );
  });

  it("keeps a banned account out and refuses an owner leaving", async () => {
    const owner = await createAccount("ban-owner");
    const member = await createAccount("ban-member");
    const communityId = await createCommunity(owner.userId, "bans");
    await join(member.userId, communityId);
    await repository.governMember({
      actorUserId: owner.userId,
      communityId,
      targetPublicProfileId: member.publicProfileId,
      action: "ban",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "governMember", [
        communityId,
        member.publicProfileId,
        "ban",
      ]),
      requestId: randomUUID(),
    });

    await expect(join(member.userId, communityId)).rejects.toBeInstanceOf(
      CommunityPermissionDeniedError,
    );
    await expect(
      repository.leaveCommunity({
        ownerUserId: owner.userId,
        communityId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "leaveCommunity", [
          communityId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);
  });

  it("transfers ownership and demotes the previous owner to admin", async () => {
    const owner = await createAccount("transfer-owner");
    const successor = await createAccount("transfer-successor");
    const communityId = await createCommunity(owner.userId, "transfers");
    await join(successor.userId, communityId);

    await repository.governMember({
      actorUserId: owner.userId,
      communityId,
      targetPublicProfileId: successor.publicProfileId,
      action: "transferOwnership",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "governMember", [
        communityId,
        successor.publicProfileId,
        "transferOwnership",
      ]),
      requestId: randomUUID(),
    });

    const page = await repository.listMembers({
      viewerUserId: successor.userId,
      communityId,
      role: "all",
      limit: 50,
    });
    expect(page.viewerMembership?.role).toBe("owner");
    const previous = page.items.find(
      (item) => item.profile.publicProfileId === owner.publicProfileId,
    );
    expect(previous?.role).toBe("admin");
    expect(page.counts.owner).toBe(1);
  });

  it("audits both role changes of an ownership transfer under one command", async () => {
    const owner = await createAccount("transfer-audit-owner");
    const successor = await createAccount("transfer-audit-successor");
    const communityId = await createCommunity(owner.userId, "transfer-audit");
    await join(successor.userId, communityId);
    await repository.governMember({
      actorUserId: owner.userId,
      communityId,
      targetPublicProfileId: successor.publicProfileId,
      action: "assignAdmin",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "governMember", [
        communityId,
        successor.publicProfileId,
        "assignAdmin",
      ]),
      requestId: randomUUID(),
    });

    const idempotencyKey = randomUUID();
    const requestSha256 = commandDigest("community", "governMember", [
      communityId,
      successor.publicProfileId,
      "transferOwnership",
    ]);
    const transfer = (): Promise<unknown> =>
      repository.governMember({
        actorUserId: owner.userId,
        communityId,
        targetPublicProfileId: successor.publicProfileId,
        action: "transferOwnership",
        idempotencyKey,
        requestSha256,
        requestId: randomUUID(),
      });
    const roleEvents = async (): Promise<readonly Record<string, unknown>[]> =>
      (
        await pool.query<Record<string, unknown>>({
          text: `
            select
              actor_user_id,
              target_user_id,
              from_role,
              to_role,
              reason_code,
              idempotency_record_id,
              request_id
            from public.community_role_events
            where community_id = $1 and event_type = 'role_changed'
            order by occurred_at, event_id
          `,
          values: [communityId],
        })
      ).rows;

    await transfer();
    const audited = await roleEvents();
    expect(
      audited.map((row) => [
        row["target_user_id"],
        row["from_role"],
        row["to_role"],
        row["reason_code"],
      ]),
    ).toEqual([
      [successor.userId, "member", "admin", "action_assignadmin"],
      [owner.userId, "owner", "admin", "action_transferownership_released"],
      [successor.userId, "admin", "owner", "action_transferownership"],
    ]);
    // Both halves of the transfer name the previous owner as the actor and
    // share one command record and one request, so the pair reconstructs as a
    // single irreversible action rather than as two unrelated demotions.
    const transferred = audited.slice(1);
    expect(transferred.map((row) => row["actor_user_id"])).toEqual([
      owner.userId,
      owner.userId,
    ]);
    expect(
      new Set(transferred.map((row) => row["idempotency_record_id"])).size,
    ).toBe(1);
    expect(transferred[0]?.["idempotency_record_id"]).not.toBe(
      audited[0]?.["idempotency_record_id"],
    );
    expect(new Set(transferred.map((row) => row["request_id"])).size).toBe(1);

    // Replaying the same command returns the stored outcome; the pair stays a
    // pair instead of becoming four rows.
    await transfer();
    expect(await roleEvents()).toEqual(audited);

    // The pair is allowed because its two rows name different subjects. One
    // command still cannot append two rows about the same account.
    const duplicate = await pool
      .query({
        text: `
          insert into public.community_role_events (
            community_id,
            actor_user_id,
            target_user_id,
            event_type,
            from_role,
            to_role,
            idempotency_record_id,
            request_id
          )
          values ($1, $2, $2, 'role_changed', 'owner', 'admin', $3, $4)
        `,
        values: [
          communityId,
          owner.userId,
          transferred[0]?.["idempotency_record_id"],
          randomUUID(),
        ],
      })
      .then(
        () => null,
        (error: unknown) => postgresError(error),
      );
    expect(duplicate).toEqual({
      code: "23505",
      constraint: "community_role_events_idempotency_unique",
    });
  });

  it("removes both follow edges when a block is created", async () => {
    const first = await createAccount("block-first");
    const second = await createAccount("block-second");

    await repository.follow({
      ownerUserId: first.userId,
      targetPublicProfileId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "follow", [
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    await repository.follow({
      ownerUserId: second.userId,
      targetPublicProfileId: first.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "follow", [
        first.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    expect(await repository.countConnections(first.userId)).toEqual({
      following: 1,
      followers: 1,
    });

    await repository.blockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "block", [
        "user",
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    expect(await repository.countConnections(first.userId)).toEqual({
      following: 0,
      followers: 0,
    });
    expect(await repository.countBlocks(first.userId)).toEqual({ user: 1 });

    await expect(
      repository.follow({
        ownerUserId: first.userId,
        targetPublicProfileId: second.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "follow", [
          second.publicProfileId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityTargetUnavailableError);
  });

  it("hides a non-discoverable account from follow and search", async () => {
    const viewer = await createAccount("search-viewer");
    const hidden = await createAccount("search-hidden");
    await pool.query({
      text: `
        update public.privacy_preferences_v2
        set discoverable = false
        where owner_user_id = $1
      `,
      values: [hidden.userId],
    });

    await expect(
      repository.follow({
        ownerUserId: viewer.userId,
        targetPublicProfileId: hidden.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "follow", [
          hidden.publicProfileId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityTargetUnavailableError);

    const results = await repository.searchUsers({
      viewerUserId: viewer.userId,
      prefix: "member_",
      limit: 20,
    });
    expect(
      results.some(
        (item) => item.profile.publicProfileId === hidden.publicProfileId,
      ),
    ).toBe(false);
  });

  it("sends a message request under the V2 admission rules and replays by key", async () => {
    const sender = await createAccount("send-sender");
    const recipient = await createAccount("send-recipient");
    const hidden = await createAccount("send-hidden");
    await pool.query({
      text: `update public.privacy_preferences_v2 set discoverable = false where owner_user_id = $1`,
      values: [hidden.userId],
    });

    const send = (
      targetPublicProfileId: string,
      idempotencyKey = randomUUID(),
    ) =>
      repository.sendMessageRequest({
        ownerUserId: sender.userId,
        targetPublicProfileId,
        idempotencyKey,
        requestSha256: commandDigest("socialGraph", "sendMessageRequest", [
          targetPublicProfileId,
        ]),
        requestId: randomUUID(),
      });

    // A non-discoverable target and the sender itself are both the same
    // non-enumerating failure.
    await expect(send(hidden.publicProfileId)).rejects.toBeInstanceOf(
      CommunityTargetUnavailableError,
    );
    await expect(send(sender.publicProfileId)).rejects.toBeInstanceOf(
      CommunityTargetUnavailableError,
    );

    const key = randomUUID();
    const sent = await send(recipient.publicProfileId, key);
    expect(sent.profile.publicProfileId).toBe(recipient.publicProfileId);
    expect(Date.parse(sent.expiresAt)).toBeGreaterThan(
      Date.parse(sent.createdAt),
    );

    // The recipient sees exactly that request, projected from the sender side.
    const inbox = await repository.listMessageRequests({
      ownerUserId: recipient.userId,
      limit: 20,
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.messageRequestId).toBe(sent.messageRequestId);
    expect(inbox[0]?.profile.publicProfileId).toBe(sender.publicProfileId);

    // The same key returns the original request; a new key hits the pending row.
    await expect(send(recipient.publicProfileId, key)).resolves.toEqual(sent);
    await expect(send(recipient.publicProfileId)).rejects.toBeInstanceOf(
      CommunityDataStaleError,
    );

    const events = await pool.query<{ event_type: string; subject_id: string }>(
      {
        text: `
        select event_type, subject_id
        from public.social_graph_events
        where actor_user_id = $1 and event_type = 'message_request_sent'
      `,
        values: [sender.userId],
      },
    );
    expect(events.rows).toEqual([
      { event_type: "message_request_sent", subject_id: sent.messageRequestId },
    ]);
  });

  it("refuses a message request across a block in either direction", async () => {
    const sender = await createAccount("send-blocked-sender");
    const recipient = await createAccount("send-blocked-recipient");
    await repository.blockUser({
      ownerUserId: recipient.userId,
      stableId: sender.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "block", [
        "user",
        sender.publicProfileId,
      ]),
      requestId: randomUUID(),
    });

    await expect(
      repository.sendMessageRequest({
        ownerUserId: sender.userId,
        targetPublicProfileId: recipient.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "sendMessageRequest", [
          recipient.publicProfileId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityTargetUnavailableError);
  });

  it("reports a message request as reject plus block plus audit in one transaction", async () => {
    const recipient = await createAccount("dm-recipient");
    const requester = await createAccount("dm-requester");
    const inserted = await pool.query<{ friend_request_id: string }>({
      text: `
        insert into public.friend_requests (
          requester_user_id, recipient_user_id, expires_at
        )
        values ($1, $2, clock_timestamp() + interval '7 days')
        returning friend_request_id
      `,
      values: [requester.userId, recipient.userId],
    });
    const messageRequestId = inserted.rows[0]?.friend_request_id ?? "";

    const pending = await repository.listMessageRequests({
      ownerUserId: recipient.userId,
      limit: 20,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.profile.publicProfileId).toBe(requester.publicProfileId);

    const decision = await repository.decideMessageRequest({
      ownerUserId: recipient.userId,
      messageRequestId,
      decision: "report",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
        messageRequestId,
        "report",
      ]),
      requestId: randomUUID(),
    });
    expect(decision).toEqual({
      messageRequestId,
      decision: "report",
      blocked: true,
    });

    const stored = await pool.query<{ status: string }>({
      text: `select status from public.friend_requests where friend_request_id = $1`,
      values: [messageRequestId],
    });
    expect(stored.rows[0]?.status).toBe("rejected");
    expect(await repository.countBlocks(recipient.userId)).toEqual({
      user: 1,
    });
    const audit = await pool.query<{
      event_type: string;
      result_status: string;
    }>({
      text: `
        select event_type, result_status
        from public.social_graph_events
        where actor_user_id = $1 and subject_id = $2
      `,
      values: [recipient.userId, messageRequestId],
    });
    expect(audit.rows).toEqual([
      { event_type: "message_request_reported", result_status: "reported" },
    ]);
    expect(
      await repository.listMessageRequests({
        ownerUserId: recipient.userId,
        limit: 20,
      }),
    ).toHaveLength(0);

    await expect(
      repository.decideMessageRequest({
        ownerUserId: recipient.userId,
        messageRequestId,
        decision: "accept",
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
          messageRequestId,
          "accept",
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityDataStaleError);
  });

  it("rejects an append-only audit mutation", async () => {
    const owner = await createAccount("audit-owner");
    const communityId = await createCommunity(owner.userId, "audit-guard");
    const failure = await pool
      .query({
        text: `
          update public.community_role_events
          set event_type = 'member_left'
          where community_id = $1
        `,
        values: [communityId],
      })
      .then(
        () => null,
        (error: unknown) => postgresError(error),
      );
    expect(failure?.code).toBe("55000");
  });

  it("verifies a community only through the operator path and writes an audit row", async () => {
    const owner = await createAccount("verify-owner");
    const communityId = await createCommunity(owner.userId, "verify-me");

    const verified = await repository.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });
    expect(verified.verificationStatus).toBe("verified");

    const audit = await pool.query<{ actor_type: string; reason_code: string }>(
      {
        text: `
          select actor_type, reason_code
          from public.community_role_events
          where community_id = $1 and event_type = 'community_verified'
        `,
        values: [communityId],
      },
    );
    expect(audit.rows).toEqual([
      { actor_type: "operator", reason_code: "operator_manual_review" },
    ]);

    const discoverable = await repository.searchCommunities({
      viewerUserId: owner.userId,
      prefix: "verify",
      verification: "verified",
      limit: 20,
    });
    expect(
      discoverable.some((item) => item.community.communityId === communityId),
    ).toBe(true);
  });

  it("hides an unverified community from a stranger and shows it to a member", async () => {
    const owner = await createAccount("hidden-owner");
    const stranger = await createAccount("hidden-stranger");
    const communityId = await createCommunity(owner.userId, "still-pending");

    const strangerView = await repository.searchCommunities({
      viewerUserId: stranger.userId,
      prefix: "still",
      verification: "all",
      limit: 20,
    });
    expect(strangerView).toHaveLength(0);

    const ownerView = await repository.searchCommunities({
      viewerUserId: owner.userId,
      prefix: "still",
      verification: "all",
      limit: 20,
    });
    expect(ownerView[0]?.community.communityId).toBe(communityId);
    expect(ownerView[0]?.viewerJoined).toBe(true);
  });

  it("orders discovery by verifiable facts in both sorts and both filters", async () => {
    const owner = await createAccount("discover-owner");
    const stranger = await createAccount("discover-stranger");
    const verifiedId = await createCommunity(
      owner.userId,
      "discover-verified",
      "Discover Verified",
    );
    const pendingId = await createCommunity(
      owner.userId,
      "discover-pending",
      "Discover Pending",
    );
    await repository.verifyCommunity({
      communityId: verifiedId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });

    for (const sort of ["members", "newest"] as const) {
      const strangerView = await repository.listCommunities({
        viewerUserId: stranger.userId,
        sort,
        verification: "verified",
        membership: "all",
        limit: 50,
      });
      const ids = strangerView.map((item) => item.communityId);
      expect(ids).toContain(verifiedId);
      expect(ids).not.toContain(pendingId);
      expect(
        strangerView.every((item) => item.verificationStatus === "verified"),
      ).toBe(true);
    }

    const strangerAll = await repository.listCommunities({
      viewerUserId: stranger.userId,
      sort: "members",
      verification: "all",
      membership: "all",
      limit: 50,
    });
    expect(strangerAll.map((item) => item.communityId)).not.toContain(
      pendingId,
    );

    const ownerAll = await repository.listCommunities({
      viewerUserId: owner.userId,
      sort: "newest",
      verification: "all",
      membership: "all",
      limit: 50,
    });
    expect(ownerAll.map((item) => item.communityId)).toContain(pendingId);
  });

  it("pages discovery with a stable keyset in both sorts", async () => {
    const owner = await createAccount("paging-owner");
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const communityId = await createCommunity(
        owner.userId,
        `paging-${String(index)}`,
        `Paging ${String(index)}`,
      );
      await repository.verifyCommunity({
        communityId,
        requestId: randomUUID(),
        reasonCode: "operator_manual_review",
      });
      created.push(communityId);
    }

    for (const sort of ["members", "newest"] as const) {
      const first = await repository.listCommunities({
        viewerUserId: owner.userId,
        sort,
        verification: "verified",
        membership: "all",
        limit: 1,
      });
      expect(first).toHaveLength(1);
      const head = first[0];
      if (head === undefined) {
        throw new Error("The first discovery page is empty");
      }
      const second = await repository.listCommunities({
        viewerUserId: owner.userId,
        sort,
        verification: "verified",
        membership: "all",
        limit: 1,
        after: {
          lastSortValue:
            sort === "members" ? String(head.memberCount) : head.createdAt,
          lastCommunityId: head.communityId,
        },
      });
      expect(second).toHaveLength(1);
      expect(second[0]?.communityId).not.toBe(head.communityId);
    }
    expect(created).toHaveLength(3);
  });

  it("aggregates the community home from joined and verified discover rows", async () => {
    const owner = await createAccount("home-owner");
    const joiner = await createAccount("home-joiner");
    const communityId = await createCommunity(
      owner.userId,
      "home-community",
      "Home Community",
    );
    await repository.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_manual_review",
    });

    const strangerHome = await repository.getCommunityHome({
      viewerUserId: joiner.userId,
      joinedLimit: 50,
      discoverLimit: 50,
    });
    expect(strangerHome.joined).toHaveLength(0);
    expect(strangerHome.discover.map((item) => item.communityId)).toContain(
      communityId,
    );
    expect(
      strangerHome.discover.every(
        (item) => item.verificationStatus === "verified",
      ),
    ).toBe(true);
    expect(Date.parse(strangerHome.observedAt)).toBeGreaterThan(0);
    const bounded = await repository.getCommunityHome({
      viewerUserId: joiner.userId,
      joinedLimit: 50,
      discoverLimit: 5,
    });
    expect(bounded.discover.length).toBeLessThanOrEqual(5);

    await join(joiner.userId, communityId);
    const joinedHome = await repository.getCommunityHome({
      viewerUserId: joiner.userId,
      joinedLimit: 50,
      discoverLimit: 50,
    });
    expect(
      joinedHome.joined.map((entry) => entry.community.communityId),
    ).toContain(communityId);
    expect(joinedHome.joined[0]?.viewerMembership?.role).toBe("member");
    expect(joinedHome.discover.map((item) => item.communityId)).not.toContain(
      communityId,
    );
  });

  it("keeps the personal follow graph untouched when a member is banned", async () => {
    const owner = await createAccount("ban-follow-owner");
    const member = await createAccount("ban-follow-member");
    const communityId = await createCommunity(
      owner.userId,
      "ban-follow",
      "Ban Follow",
    );
    await join(member.userId, communityId);
    await follow(owner.userId, member.publicProfileId);
    await follow(member.userId, owner.publicProfileId);
    expect(await repository.countConnections(owner.userId)).toEqual({
      following: 1,
      followers: 1,
    });

    await repository.governMember({
      actorUserId: owner.userId,
      communityId,
      targetPublicProfileId: member.publicProfileId,
      action: "ban",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "governMember", [
        communityId,
        member.publicProfileId,
        "ban",
      ]),
      requestId: randomUUID(),
    });

    // A ban is community scoped; only POST /v2/blocks drops follow edges.
    expect(await repository.countConnections(owner.userId)).toEqual({
      following: 1,
      followers: 1,
    });
  });

  it("does not restore a follow edge when a block is removed", async () => {
    const first = await createAccount("unblock-first");
    const second = await createAccount("unblock-second");
    await follow(first.userId, second.publicProfileId);
    const blockDigest = commandDigest("socialGraph", "block", [
      "user",
      second.publicProfileId,
    ]);
    await repository.blockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: blockDigest,
      requestId: randomUUID(),
    });
    expect(await repository.countConnections(first.userId)).toEqual({
      following: 0,
      followers: 0,
    });

    await repository.unblockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "unblock", [
        "user",
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    expect(await repository.countBlocks(first.userId)).toEqual({ user: 0 });
    expect(await repository.countConnections(first.userId)).toEqual({
      following: 0,
      followers: 0,
    });
  });

  it("replays follow and block from the audit row after the state reverses", async () => {
    const first = await createAccount("replay-follow-first");
    const second = await createAccount("replay-follow-second");
    const followKey = randomUUID();
    const followDigest = commandDigest("socialGraph", "follow", [
      second.publicProfileId,
    ]);
    await repository.follow({
      ownerUserId: first.userId,
      targetPublicProfileId: second.publicProfileId,
      idempotencyKey: followKey,
      requestSha256: followDigest,
      requestId: randomUUID(),
    });
    await repository.unfollow({
      ownerUserId: first.userId,
      targetPublicProfileId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "unfollow", [
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    const replayed = await repository.follow({
      ownerUserId: first.userId,
      targetPublicProfileId: second.publicProfileId,
      idempotencyKey: followKey,
      requestSha256: followDigest,
      requestId: randomUUID(),
    });
    expect(replayed.profile.publicProfileId).toBe(second.publicProfileId);
    expect(replayed.viewerFollows).toBe(false);

    const blockKey = randomUUID();
    const blockDigest = commandDigest("socialGraph", "block", [
      "user",
      second.publicProfileId,
    ]);
    await repository.blockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: blockKey,
      requestSha256: blockDigest,
      requestId: randomUUID(),
    });
    await repository.unblockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "unblock", [
        "user",
        second.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    const replayedBlock = await repository.blockUser({
      ownerUserId: first.userId,
      stableId: second.publicProfileId,
      idempotencyKey: blockKey,
      requestSha256: blockDigest,
      requestId: randomUUID(),
    });
    expect(replayedBlock.stableId).toBe(second.publicProfileId);
    expect(await repository.countBlocks(first.userId)).toEqual({ user: 0 });
  });

  it("decrements member_count when a member leaves", async () => {
    const owner = await createAccount("leave-owner");
    const member = await createAccount("leave-member");
    const communityId = await createCommunity(
      owner.userId,
      "leave-community",
      "Leave Community",
    );
    await join(member.userId, communityId);
    expect(await memberCount(communityId)).toBe(2);

    const detail = await repository.leaveCommunity({
      ownerUserId: member.userId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "leaveCommunity", [
        communityId,
      ]),
      requestId: randomUUID(),
    });
    expect(detail.viewerMembership).toBeNull();
    expect(detail.community.memberCount).toBe(1);
    expect(await memberCount(communityId)).toBe(1);
  });

  it("refuses to accept a message request across a block", async () => {
    const recipient = await createAccount("accept-block-recipient");
    const requester = await createAccount("accept-block-requester");
    const inserted = await pool.query<{ friend_request_id: string }>({
      text: `
        insert into public.friend_requests (
          requester_user_id, recipient_user_id, expires_at
        )
        values ($1, $2, clock_timestamp() + interval '7 days')
        returning friend_request_id
      `,
      values: [requester.userId, recipient.userId],
    });
    const messageRequestId = inserted.rows[0]?.friend_request_id ?? "";
    await repository.blockUser({
      ownerUserId: recipient.userId,
      stableId: requester.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "block", [
        "user",
        requester.publicProfileId,
      ]),
      requestId: randomUUID(),
    });

    await expect(
      repository.decideMessageRequest({
        ownerUserId: recipient.userId,
        messageRequestId,
        decision: "accept",
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
          messageRequestId,
          "accept",
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunityDataStaleError);
    const friendship = await pool.query({
      text: `
        select 1
        from public.friendships
        where accepted_friend_request_id = $1
      `,
      values: [messageRequestId],
    });
    expect(friendship.rowCount).toBe(0);
  });

  it("lets only the owner edit the community profile", async () => {
    const owner = await createAccount("edit-owner");
    const member = await createAccount("edit-member");
    const communityId = await createCommunity(
      owner.userId,
      "edit-community",
      "Edit Community",
    );
    await join(member.userId, communityId);

    const edit = (
      actorUserId: string,
      values: Parameters<typeof repository.updateCommunity>[0]["values"],
    ) =>
      repository.updateCommunity({
        ownerUserId: actorUserId,
        communityId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "updateCommunity", [
          communityId,
          ...updateCommunityDigestParts(values),
        ]),
        requestId: randomUUID(),
        values,
      });

    await expect(
      edit(member.userId, { name: "Hijacked" }),
    ).rejects.toBeInstanceOf(CommunityPermissionDeniedError);

    const updated = await edit(owner.userId, {
      description: "Frogs, updated",
      boundAssetKey: null,
    });
    expect(updated.community.description).toBe("Frogs, updated");
    expect(updated.community.name).toBe("Edit Community");
    expect(updated.community.slug).toBe("edit-community");
    expect(updated.community.verificationStatus).toBe("pending");

    const audit = await pool.query<{ reason_code: string }>({
      text: `
        select reason_code
        from public.community_role_events
        where community_id = $1 and event_type = 'community_profile_updated'
      `,
      values: [communityId],
    });
    expect(audit.rows).toEqual([{ reason_code: "owner_profile_edit" }]);
  });

  it("hides an unverified community from a stranger on every read path", async () => {
    const owner = await createAccount("visibility-owner");
    const stranger = await createAccount("visibility-stranger");
    const communityId = await createCommunity(
      owner.userId,
      "visibility-pending",
      "Visibility Pending",
    );

    await expect(
      repository.getCommunity({
        viewerUserId: stranger.userId,
        communityId,
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
    await expect(
      repository.listMembers({
        viewerUserId: stranger.userId,
        communityId,
        role: "all",
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);

    await expect(
      repository.getCommunity({ viewerUserId: owner.userId, communityId }),
    ).resolves.toMatchObject({
      community: { verificationStatus: "pending" },
    });
  });

  it("pages the viewer's own memberships with membership=joined", async () => {
    const owner = await createAccount("joined-owner");
    const joiner = await createAccount("joined-joiner");
    const mine = await createCommunity(owner.userId, "joined-mine", "Mine");
    const theirs = await createCommunity(
      joiner.userId,
      "joined-theirs",
      "Theirs",
    );
    for (const communityId of [mine, theirs]) {
      await repository.verifyCommunity({
        communityId,
        requestId: randomUUID(),
        reasonCode: "operator_manual_review",
      });
    }

    const joinedOnly = await repository.listCommunities({
      viewerUserId: owner.userId,
      sort: "newest",
      verification: "verified",
      membership: "joined",
      limit: 50,
    });
    const ids = joinedOnly.map((item) => item.communityId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("lists a verified community without a channel and repairs it through verifyCommunity", async () => {
    const owner = await createAccount("seeded-owner");
    const member = await createAccount("seeded-member");
    const communityId = await createCommunity(owner.userId, "seeded-verified");
    await join(member.userId, communityId);
    // A seed writes the verified state directly, so `verifyCommunity` never
    // ran and no channel row exists: exactly the state the operator script
    // repairs.
    await pool.query({
      text: `
        update public.communities
        set verification_status = 'verified', verified_at = clock_timestamp()
        where community_id = $1
      `,
      values: [communityId],
    });
    const before = await listVerifiedCommunitiesWithoutChannel(pool);
    expect(before).toContainEqual({
      communityId,
      slug: "seeded-verified",
      name: "Frog Holders",
      memberCount: 2,
    });

    const record = await repository.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_channel_provision",
    });
    expect(record.verificationStatus).toBe("verified");

    const channel = await pool.query<{ stream_channel_id: string }>({
      text: `select stream_channel_id from public.community_channels where community_id = $1`,
      values: [communityId],
    });
    expect(channel.rows).toHaveLength(1);
    const jobs = await pool.query<{ owner_user_id: string; kind: string }>({
      text: `
        select owner_user_id, kind from public.community_channel_sync_jobs
        where community_id = $1 order by owner_user_id
      `,
      values: [communityId],
    });
    expect(jobs.rows.map((row) => row.kind)).toEqual(["add", "add"]);
    expect(new Set(jobs.rows.map((row) => row.owner_user_id))).toEqual(
      new Set([owner.userId, member.userId]),
    );
    // The repair never writes a second verification audit row.
    const audits = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count from public.community_role_events
        where community_id = $1 and event_type = 'community_verified'
      `,
      values: [communityId],
    });
    expect(audits.rows[0]?.count).toBe("0");

    const after = await listVerifiedCommunitiesWithoutChannel(pool);
    expect(after.map((row) => row.communityId)).not.toContain(communityId);
  });

  it("raises NOT_FOUND semantics for an unknown community", async () => {
    const viewer = await createAccount("missing-viewer");
    await expect(
      repository.getCommunity({
        viewerUserId: viewer.userId,
        communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      }),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
  });
});
