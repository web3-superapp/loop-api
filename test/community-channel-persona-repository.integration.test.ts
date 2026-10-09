import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresCommunicationRepository,
  createPostgresCommunityChannelPersonaRepository,
  createPostgresCommunityChannelSyncRepository,
} from "../src/database/communication-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import type { CommunityRepository } from "../src/features/community/community-repository.js";
import { deriveCommunityChannelId } from "../src/features/communication/communication-contract.js";
import {
  CommunicationRepositoryUnavailableError,
  type CommunicationRepository,
  type CommunityChannelPersonaLease,
  type CommunityChannelPersonaRepository,
  type CommunityChannelSyncRepository,
} from "../src/features/communication/communication-repository.js";
import { createCommunityPersonaAliasGenerator } from "../src/features/communication/community-persona-generator.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Client, Pool } = pg;

const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const aliasPattern = /^[A-Z][a-z]{2,15}-[0-9]{4}$/;

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
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

describe("PostgreSQL community channel persona repository (Decision 0055)", () => {
  const databaseName = `loop_persona_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let community: CommunityRepository;
  let communication: CommunicationRepository;
  let sync: CommunityChannelSyncRepository;
  let personas: CommunityChannelPersonaRepository;
  let profiles: ProfileV2Repository;
  const generateAlias = createCommunityPersonaAliasGenerator();

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
      await runner({
        databaseUrl: temporaryDatabaseUrl,
        dir: migrationsDirectory,
        direction: "up",
        migrationsTable: "pgmigrations",
        log: () => undefined,
      });
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
        V2_COMMUNITY_CHANNEL_MEMBER_CAP: "10",
      }),
      { error: () => undefined },
    );
    community = createPostgresCommunityRepository(pool, {
      communityChannelMemberCap: 10,
    });
    communication = createPostgresCommunicationRepository(pool);
    sync = createPostgresCommunityChannelSyncRepository(pool);
    personas = createPostgresCommunityChannelPersonaRepository(pool);
    profiles = createPostgresProfileV2Repository(pool);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createAccount(): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:persona:${randomUUID()}`,
    );
    const alias = `member_${randomUUID().slice(0, 8)}`;
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
    return user.id;
  }

  async function createVerifiedCommunity(ownerUserId: string): Promise<string> {
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const detail = await community.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        "Night Owls",
        slug,
        "",
        "",
        "",
      ]),
      requestId: randomUUID(),
      name: "Night Owls",
      slug,
      description: null,
      logoRef: null,
      boundAssetKey: null,
    });
    const communityId = detail.community.communityId;
    await community.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_verified",
    });
    return communityId;
  }

  function join(ownerUserId: string, communityId: string): Promise<unknown> {
    return community.joinCommunity({
      ownerUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "joinCommunity", [communityId]),
      requestId: randomUUID(),
    });
  }

  /**
   * Drive the outbox the way the worker does for one community: claim the
   * due jobs, provision the channel, and complete every claimed `add` of
   * that community as `synced`. Jobs of other communities that the claim
   * swept up stay leased and simply expire.
   */
  async function syncCommunity(communityId: string): Promise<void> {
    const workerId = randomUUID();
    const jobs = await sync.claimDueJobs({
      workerId,
      leaseSeconds: 60,
      limit: 50,
    });
    const own = jobs.filter((job) => job.communityId === communityId);
    if (own.length === 0) {
      throw new Error("No add job of the community was due");
    }
    await sync.markChannelProvisioned({ communityId, workerId });
    for (const job of own) {
      await sync.completeJob({
        communityId,
        ownerUserId: job.ownerUserId,
        workerId,
        memberState: "synced",
        channelState: "created",
      });
    }
  }

  async function personaRow(
    personaId: string,
  ): Promise<Record<string, unknown>> {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select projection_state, confirmed_at, projection_attempts,
          projection_lease,
          next_projection_at <= clock_timestamp() as due
        from public.community_channel_personas
        where persona_id = $1
      `,
      values: [personaId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("persona row missing");
    }
    return row;
  }

  it("generates one immutable, community-unique persona per member, leases it, and resumes it", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);

    const first = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });
    expect(first.persona.alias).toMatch(aliasPattern);
    expect(first.persona.alias.toLowerCase()).not.toContain(
      member.replaceAll("-", "").slice(0, 8),
    );
    expect(first.persona).toMatchObject({
      communityId,
      ownerUserId: member,
      aliasVersion: 1,
      projectionState: "pending",
      projectionAttempts: 0,
    });
    expect(first.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    // L1: a fresh persona is not due for the lane (60 s lease).
    expect(await personaRow(first.persona.personaId)).toMatchObject({
      due: false,
      projection_lease: first.leaseToken,
    });

    const again = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias: () => "Different-0001",
    });
    expect(again.persona).toEqual(first.persona);
    // Re-ensuring issues a new lease and supersedes the old one.
    expect(again.leaseToken).not.toBe(first.leaseToken);
    expect(
      await personas.confirmProjection({
        personaId: first.persona.personaId,
        leaseToken: first.leaseToken,
      }),
    ).toBe(false);
    expect(
      await personas.findPersona({ communityId, ownerUserId: member }),
    ).toEqual(first.persona);

    // The same account in another community draws independently.
    const otherCommunity = await createVerifiedCommunity(owner);
    await join(member, otherCommunity);
    const elsewhere = await personas.ensurePersona({
      communityId: otherCommunity,
      ownerUserId: member,
      generateAlias,
    });
    expect(elsewhere.persona.personaId).not.toBe(first.persona.personaId);

    await expect(
      pool.query({
        text: `update public.community_channel_personas set alias = 'Owl-0001' where persona_id = $1`,
        values: [first.persona.personaId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `delete from public.community_channel_personas where persona_id = $1`,
        values: [first.persona.personaId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `insert into public.community_channel_personas (community_id, owner_user_id, alias, projection_state, confirmed_at) values ($1, $2, 'Owl-0002', 'confirmed', clock_timestamp())`,
        values: [communityId, owner],
      }),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("retries a community-local alias collision with a fresh draw and gives up after the bound", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const first = await createAccount();
    const second = await createAccount();
    await join(first, communityId);
    await join(second, communityId);

    const taken = await personas.ensurePersona({
      communityId,
      ownerUserId: first,
      generateAlias: () => "Harbor-4821",
    });
    expect(taken.persona.alias).toBe("Harbor-4821");

    const draws = ["Harbor-4821", "Harbor-4821", "Comet-0042"];
    let calls = 0;
    const colliding = await personas.ensurePersona({
      communityId,
      ownerUserId: second,
      generateAlias: () => {
        calls += 1;
        return draws.shift() ?? "Zephyr-9999";
      },
    });
    expect(colliding.persona.alias).toBe("Comet-0042");
    expect(calls).toBe(3);

    const third = await createAccount();
    await join(third, communityId);
    await expect(
      personas.ensurePersona({
        communityId,
        ownerUserId: third,
        generateAlias: () => "Harbor-4821",
      }),
    ).rejects.toBeInstanceOf(CommunicationRepositoryUnavailableError);
    expect(
      await personas.findPersona({ communityId, ownerUserId: third }),
    ).toBeNull();

    await expect(
      personas.ensurePersona({
        communityId,
        ownerUserId: third,
        generateAlias: () => "loop_3bb585972e3145e7b5f0957803a824ed",
      }),
    ).rejects.toBeInstanceOf(CommunicationRepositoryUnavailableError);
  });

  it("fences confirm and reset by lease and pending state, and exposes the viewer's persona on the channel read (M2)", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);
    const lease = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });
    const personaId = lease.persona.personaId;

    // Wrong lease: nothing written.
    expect(
      await personas.confirmProjection({
        personaId,
        leaseToken: randomUUID(),
      }),
    ).toBe(false);
    expect(
      await personas.resetProjection({
        personaId,
        leaseToken: randomUUID(),
        retryDelaySeconds: 600,
      }),
    ).toBe(false);
    expect(await personaRow(personaId)).toMatchObject({
      projection_state: "pending",
      projection_lease: lease.leaseToken,
    });

    // Right lease: confirmed, lease consumed.
    expect(
      await personas.confirmProjection({
        personaId,
        leaseToken: lease.leaseToken,
      }),
    ).toBe(true);
    expect(await personaRow(personaId)).toMatchObject({
      projection_state: "confirmed",
      projection_lease: null,
    });
    expect(
      (
        await communication.readCommunityChannel({
          communityId,
          viewerUserId: member,
        })
      ).viewerPersona,
    ).toEqual({ alias: lease.persona.alias, projectionState: "confirmed" });

    // A confirmed row is never reset through the fenced path, even with the
    // (already consumed) lease.
    expect(
      await personas.resetProjection({
        personaId,
        leaseToken: lease.leaseToken,
        retryDelaySeconds: 0,
      }),
    ).toBe(false);

    // The unfenced remove path forces pending and clears any lease.
    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: member,
      retryDelaySeconds: 600,
    });
    expect(await personaRow(personaId)).toMatchObject({
      projection_state: "pending",
      confirmed_at: null,
      projection_lease: null,
      due: false,
    });
    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: member,
      retryDelaySeconds: 0,
    });
    expect(await personaRow(personaId)).toMatchObject({ due: true });
    // No persona: a no-op, never an error.
    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: owner,
      retryDelaySeconds: 0,
    });
    expect(
      (
        await communication.readCommunityChannel({
          communityId,
          viewerUserId: owner,
        })
      ).viewerPersona,
    ).toBeNull();

    // Fenced reset under a fresh lease from ensure: written, lease cleared.
    const release = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });
    expect(
      await personas.resetProjection({
        personaId,
        leaseToken: release.leaseToken,
        retryDelaySeconds: 5,
      }),
    ).toBe(true);
    expect(await personaRow(personaId)).toMatchObject({
      projection_state: "pending",
      projection_lease: null,
      due: false,
    });
  });

  it("claims only due pending personas of synced members on a provisioned channel, issuing a lease per claim", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);
    const lease = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });
    const personaId = lease.persona.personaId;
    const findClaim = (
      targets: readonly CommunityChannelPersonaLease[],
    ): CommunityChannelPersonaLease | undefined =>
      targets.find((t) => t.persona.personaId === personaId);

    // Not due yet (ensure lease) and the member is still `pending`.
    expect(
      findClaim(
        await personas.claimPendingProjections({ limit: 20, leaseSeconds: 60 }),
      ),
    ).toBeUndefined();

    // Make it due; the member is still not synced: still not claimable.
    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: member,
      retryDelaySeconds: 0,
    });
    expect(
      findClaim(
        await personas.claimPendingProjections({ limit: 20, leaseSeconds: 60 }),
      ),
    ).toBeUndefined();

    await syncCommunity(communityId);
    const claimed = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    const target = claimed.find((c) => c.persona.personaId === personaId);
    expect(target).toBeDefined();
    expect(target).toMatchObject({
      persona: { ...lease.persona, projectionAttempts: 1 },
      streamChannelId: deriveCommunityChannelId(communityId),
      memberStreamUserId: deriveStreamUserId(member),
    });
    expect(target?.leaseToken).not.toBe(lease.leaseToken);
    expect(await personaRow(personaId)).toMatchObject({
      projection_lease: target?.leaseToken,
      due: false,
    });

    // Leased: an immediate second claim does not hand it out again.
    expect(
      findClaim(
        await personas.claimPendingProjections({ limit: 20, leaseSeconds: 60 }),
      ),
    ).toBeUndefined();

    // The claim's lease is what confirm needs.
    expect(
      await personas.confirmProjection({
        personaId,
        leaseToken: target?.leaseToken ?? "",
      }),
    ).toBe(true);
    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: member,
      retryDelaySeconds: 0,
    });
    const reclaimed = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    expect(findClaim(reclaimed)?.persona.projectionAttempts).toBe(2);
  });

  it("lists synced members without a persona for the backfill with keyset paging", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const members = [await createAccount(), await createAccount()];
    for (const member of members) {
      await join(member, communityId);
    }
    await syncCommunity(communityId);
    await personas.ensurePersona({
      communityId,
      ownerUserId: members[0] ?? owner,
      generateAlias,
    });

    const listed: string[] = [];
    let after: { communityId: string; ownerUserId: string } | null = null;
    for (;;) {
      const page = await personas.listMembersWithoutPersona({
        limit: 2,
        after,
      });
      for (const row of page) {
        if (row.communityId === communityId) {
          listed.push(row.ownerUserId);
          expect(row.streamChannelId).toBe(
            deriveCommunityChannelId(communityId),
          );
          expect(row.memberStreamUserId).toBe(
            deriveStreamUserId(row.ownerUserId),
          );
        }
      }
      const last = page.at(-1);
      if (page.length < 2 || last === undefined) {
        break;
      }
      after = { communityId: last.communityId, ownerUserId: last.ownerUserId };
    }
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(expect.arrayContaining([owner, members[1]]));
    expect(listed).not.toContain(members[0]);
  });

  it("refuses to truncate while personas exist unless the operator opts in (L4)", async () => {
    await expect(
      pool.query("truncate table public.community_channel_personas"),
    ).rejects.toMatchObject({ code: "55000" });
    // Cascading from a parent table hits the same guard.
    await expect(
      pool.query("truncate table public.loop_users cascade"),
    ).rejects.toMatchObject({ code: "55000" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('loop.allow_persona_truncate', 'on', true)",
      );
      await client.query("truncate table public.community_channel_personas");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const remaining = await pool.query(
      "select count(*)::int as n from public.community_channel_personas",
    );
    expect(remaining.rows[0]).toEqual({ n: 0 });
    // An empty table may be truncated without the opt-in (test fixtures).
    await expect(
      pool.query("truncate table public.community_channel_personas"),
    ).resolves.toBeDefined();
  });
});
