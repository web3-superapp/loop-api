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

  it("generates one immutable, community-unique persona per member and resumes it", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);

    const first = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });
    expect(first.alias).toMatch(aliasPattern);
    expect(first.alias.toLowerCase()).not.toContain(
      member.replaceAll("-", "").slice(0, 8),
    );
    expect(first).toMatchObject({
      communityId,
      ownerUserId: member,
      aliasVersion: 1,
      projectionState: "pending",
      projectionAttempts: 0,
    });

    const again = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias: () => "Different-0001",
    });
    expect(again).toEqual(first);
    expect(
      await personas.findPersona({ communityId, ownerUserId: member }),
    ).toEqual(first);

    // The same account in another community draws independently.
    const otherCommunity = await createVerifiedCommunity(owner);
    await join(member, otherCommunity);
    const elsewhere = await personas.ensurePersona({
      communityId: otherCommunity,
      ownerUserId: member,
      generateAlias,
    });
    expect(elsewhere.personaId).not.toBe(first.personaId);

    await expect(
      pool.query({
        text: `update public.community_channel_personas set alias = 'Owl-0001' where persona_id = $1`,
        values: [first.personaId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `delete from public.community_channel_personas where persona_id = $1`,
        values: [first.personaId],
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
    expect(taken.alias).toBe("Harbor-4821");

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
    expect(colliding.alias).toBe("Comet-0042");
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

  it("confirms, resets, and exposes the viewer's persona on the channel read", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);
    const persona = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });

    await personas.confirmProjection({ personaId: persona.personaId });
    expect(await personaRow(persona.personaId)).toMatchObject({
      projection_state: "confirmed",
    });
    expect(
      (
        await communication.readCommunityChannel({
          communityId,
          viewerUserId: member,
        })
      ).viewerPersona,
    ).toEqual({ alias: persona.alias, projectionState: "confirmed" });

    await personas.resetProjection({
      personaId: persona.personaId,
      retryDelaySeconds: 600,
    });
    expect(await personaRow(persona.personaId)).toMatchObject({
      projection_state: "pending",
      confirmed_at: null,
      due: false,
    });

    await personas.resetProjectionForMember({
      communityId,
      ownerUserId: member,
      retryDelaySeconds: 0,
    });
    expect(await personaRow(persona.personaId)).toMatchObject({ due: true });
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
  });

  it("claims only due pending personas of synced members on a provisioned channel, under a lease", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);
    const persona = await personas.ensurePersona({
      communityId,
      ownerUserId: member,
      generateAlias,
    });

    // The member is still `pending` on the channel: nothing to project.
    const before = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    expect(
      before.some((target) => target.persona.personaId === persona.personaId),
    ).toBe(false);

    await syncCommunity(communityId);
    const claimed = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    const target = claimed.find(
      (candidate) => candidate.persona.personaId === persona.personaId,
    );
    expect(target).toEqual({
      persona: { ...persona, projectionAttempts: 1 },
      streamChannelId: deriveCommunityChannelId(communityId),
      memberStreamUserId: deriveStreamUserId(member),
    });

    // Leased: an immediate second claim does not hand it out again.
    const again = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    expect(
      again.some(
        (candidate) => candidate.persona.personaId === persona.personaId,
      ),
    ).toBe(false);

    await personas.confirmProjection({ personaId: persona.personaId });
    await personas.resetProjection({
      personaId: persona.personaId,
      retryDelaySeconds: 0,
    });
    const reclaimed = await personas.claimPendingProjections({
      limit: 20,
      leaseSeconds: 60,
    });
    expect(
      reclaimed.find((c) => c.persona.personaId === persona.personaId)?.persona
        .projectionAttempts,
    ).toBe(2);
  });

  it("lists synced members for the backfill with keyset paging and their persona when present", async () => {
    const owner = await createAccount();
    const communityId = await createVerifiedCommunity(owner);
    const members = [await createAccount(), await createAccount()];
    for (const member of members) {
      await join(member, communityId);
    }
    await syncCommunity(communityId);
    const persona = await personas.ensurePersona({
      communityId,
      ownerUserId: members[0] ?? owner,
      generateAlias,
    });

    const all: { ownerUserId: string; persona: unknown }[] = [];
    let after: { communityId: string; ownerUserId: string } | null = null;
    for (;;) {
      const page = await personas.listBackfillTargets({ limit: 2, after });
      for (const row of page) {
        if (row.communityId === communityId) {
          all.push({ ownerUserId: row.ownerUserId, persona: row.persona });
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
    const ids = all.map((row) => row.ownerUserId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([owner, ...members]));
    expect(all.find((row) => row.ownerUserId === members[0])?.persona).toEqual(
      persona,
    );
    expect(
      all.find((row) => row.ownerUserId === members[1])?.persona,
    ).toBeNull();
  });
});
