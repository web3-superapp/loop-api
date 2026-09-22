import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresChatChannelRepository } from "../src/database/chat-channel-repository.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresCommunicationRepository,
  createPostgresCommunityChannelSyncRepository,
} from "../src/database/communication-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import type { CommunityRepository } from "../src/features/community/community-repository.js";
import {
  communicationCommandDigest,
  deriveCommunityChannelId,
  deriveVoiceCallId,
} from "../src/features/communication/communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  type CommunicationRepository,
  CommunicationRepositoryUnavailableError,
  CommunicationUnprovisionedRoomError,
  type CommunityChannelSyncRepository,
  type VoiceRoomViewerRecord,
} from "../src/features/communication/communication-repository.js";
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

describe("PostgreSQL V2 communication repository", () => {
  const databaseName = `loop_comm_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let community: CommunityRepository;
  let communication: CommunicationRepository;
  let sync: CommunityChannelSyncRepository;
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
        V2_COMMUNITY_CHANNEL_MEMBER_CAP: "2",
      }),
      { error: () => undefined },
    );
    community = createPostgresCommunityRepository(pool, {
      communityChannelMemberCap: 2,
    });
    communication = createPostgresCommunicationRepository(pool);
    sync = createPostgresCommunityChannelSyncRepository(pool);
    profiles = createPostgresProfileV2Repository(pool);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createAccount(): Promise<{
    readonly userId: string;
    readonly publicProfileId: string;
  }> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:comm:${randomUUID()}`,
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
    const result = await pool.query<{ public_profile_id: string }>({
      text: `select public_profile_id from public.user_profiles where owner_user_id = $1`,
      values: [user.id],
    });
    const publicProfileId = result.rows[0]?.public_profile_id;
    if (publicProfileId === undefined) {
      throw new Error("The activated profile has no public profile ID");
    }
    return { userId: user.id, publicProfileId };
  }

  async function createCommunity(ownerUserId: string): Promise<string> {
    const slug = `c-${randomUUID().slice(0, 8)}`;
    const detail = await community.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        "Frog Holders",
        slug,
        "",
        "",
        "",
      ]),
      requestId: randomUUID(),
      name: "Frog Holders",
      slug,
      description: null,
      logoRef: null,
      boundAssetKey: null,
    });
    return detail.community.communityId;
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

  async function jobRow(
    communityId: string,
    ownerUserId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select kind, state, attempts, last_error_code
        from public.community_channel_sync_jobs
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, ownerUserId],
    });
    return result.rows[0];
  }

  async function verifyCommunity(communityId: string): Promise<void> {
    await community.verifyCommunity({
      communityId,
      requestId: randomUUID(),
      reasonCode: "operator_verified",
    });
  }

  it("enqueues nothing before the community is verified", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const member = await createAccount();
    await join(member.userId, communityId);

    expect(await jobRow(communityId, member.userId)).toBeUndefined();
    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: member.userId,
    });
    expect(channel.channel).toBeNull();
    expect(channel.viewerIsCommunityMember).toBe(true);
  });

  it("provisions the deterministic channel and backfills existing members on verification", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const member = await createAccount();
    await join(member.userId, communityId);

    await verifyCommunity(communityId);

    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: member.userId,
    });
    expect(channel.channel).toMatchObject({
      communityId,
      streamChannelId: deriveCommunityChannelId(communityId),
      state: "created",
      memberCap: 2,
      provisioned: false,
    });
    expect(channel.viewerMemberState).toBe("pending");
    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      kind: "add",
      state: "pending",
      attempts: 0,
    });
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "add",
    });

    // Re-verifying is idempotent and must not allocate a second channel.
    await verifyCommunity(communityId);
    const channels = await pool.query({
      text: `select community_id from public.community_channels where community_id = $1`,
      values: [communityId],
    });
    expect(channels.rowCount).toBe(1);
  });

  it("collapses a join then leave into one remove job", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const member = await createAccount();

    await join(member.userId, communityId);
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "add",
    });

    await community.leaveCommunity({
      ownerUserId: member.userId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "leaveCommunity", [
        communityId,
      ]),
      requestId: randomUUID(),
    });

    const rows = await pool.query({
      text: `
        select kind from public.community_channel_sync_jobs
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, member.userId],
    });
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ kind: "remove" });
  });

  it("enqueues a remove on ban and an add on unban", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const member = await createAccount();
    await join(member.userId, communityId);

    await community.governMember({
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
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "remove",
    });

    const banWorkerId = randomUUID();
    await sync.claimDueJobs({
      workerId: banWorkerId,
      leaseSeconds: 60,
      limit: 10,
    });
    await sync.completeJob({
      communityId,
      ownerUserId: member.userId,
      workerId: banWorkerId,
      memberState: "removed",
      channelState: "created",
    });
    await community.governMember({
      actorUserId: owner.userId,
      communityId,
      targetPublicProfileId: member.publicProfileId,
      action: "unban",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "governMember", [
        communityId,
        member.publicProfileId,
        "unban",
      ]),
      requestId: randomUUID(),
    });
    // An unban restores the membership, so chat access is restored with it.
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "add",
      state: "pending",
      attempts: 0,
    });
  });

  it("leases due jobs exactly once across concurrent workers", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);

    const workerA = randomUUID();
    const workerB = randomUUID();
    const [claimedA, claimedB] = await Promise.all([
      sync.claimDueJobs({ workerId: workerA, leaseSeconds: 30, limit: 10 }),
      sync.claimDueJobs({ workerId: workerB, leaseSeconds: 30, limit: 10 }),
    ]);
    const owners = [...claimedA, ...claimedB].map((job) => job.ownerUserId);
    expect(new Set(owners).size).toBe(owners.length);
    expect(owners).toContain(owner.userId);
    const claimed = [...claimedA, ...claimedB].find(
      (job) => job.ownerUserId === owner.userId,
    );
    expect(claimed).toMatchObject({
      kind: "add",
      attempts: 1,
      channelProvisioned: false,
      channelName: "Frog Holders",
      memberCap: 2,
      syncedMemberCount: 0,
      streamChannelId: deriveCommunityChannelId(communityId),
    });
  });

  it("marks the channel provisioned, completes a job, and reports the synced member", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const workerId = randomUUID();
    await sync.claimDueJobs({ workerId, leaseSeconds: 30, limit: 10 });

    await sync.markChannelProvisioned({ communityId, workerId });
    await sync.completeJob({
      communityId,
      ownerUserId: owner.userId,
      workerId,
      memberState: "synced",
      channelState: "created",
    });

    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(channel.channel).toMatchObject({
      provisioned: true,
      state: "created",
    });
    expect(channel.viewerMemberState).toBe("synced");
    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      state: "succeeded",
      last_error_code: null,
    });
  });

  it("keeps a retried job reconciling and a failed job terminal", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const workerId = randomUUID();
    await sync.claimDueJobs({ workerId, leaseSeconds: 30, limit: 10 });

    await sync.retryJob({
      communityId,
      ownerUserId: owner.userId,
      workerId,
      errorCode: "stream_channel_sync_unavailable",
      retryDelaySeconds: 60,
    });
    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      state: "reconciling",
      last_error_code: "stream_channel_sync_unavailable",
    });
    // The lease is released, but the job is not due again yet.
    const notDue = await sync.claimDueJobs({
      workerId: randomUUID(),
      leaseSeconds: 30,
      limit: 10,
    });
    expect(notDue.some((job) => job.ownerUserId === owner.userId)).toBe(false);

    const secondWorker = randomUUID();
    await pool.query({
      text: `
        update public.community_channel_sync_jobs
        set next_attempt_at = clock_timestamp()
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, owner.userId],
    });
    await sync.claimDueJobs({
      workerId: secondWorker,
      leaseSeconds: 30,
      limit: 10,
    });
    await sync.failJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: secondWorker,
      errorCode: "stream_channel_sync_exhausted",
    });
    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      state: "failed",
      last_error_code: "stream_channel_sync_exhausted",
    });
    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(channel.channel).toMatchObject({ state: "failed" });
  });

  it("parks a member as capacityPending without losing its LOOP membership", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const member = await createAccount();
    await join(member.userId, communityId);

    const workerId = randomUUID();
    await sync.claimDueJobs({ workerId, leaseSeconds: 60, limit: 10 });
    await sync.completeJob({
      communityId,
      ownerUserId: member.userId,
      workerId,
      memberState: "capacityPending",
      channelState: "capacityPending",
    });

    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: member.userId,
    });
    expect(channel.viewerMemberState).toBe("capacityPending");
    expect(channel.viewerIsCommunityMember).toBe(true);
    expect(channel.channel).toMatchObject({ state: "capacityPending" });
  });

  it("refuses a stale lease write-back for the job, member, and channel", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const holder = randomUUID();
    await sync.claimDueJobs({ workerId: holder, leaseSeconds: 30, limit: 10 });

    const stale = randomUUID();
    await sync.completeJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: stale,
      memberState: "synced",
      channelState: "created",
    });
    await sync.failJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: stale,
      errorCode: "stream_channel_sync_exhausted",
    });
    await sync.retryJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: stale,
      errorCode: "stream_channel_sync_unavailable",
      retryDelaySeconds: 60,
    });
    await sync.markChannelProvisioned({ communityId, workerId: stale });

    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      state: "pending",
      last_error_code: null,
    });
    const channel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(channel.channel).toMatchObject({
      state: "created",
      provisioned: false,
    });
    expect(channel.viewerMemberState).toBe("pending");

    // The real lease holder still writes through.
    await sync.markChannelProvisioned({ communityId, workerId: holder });
    await sync.completeJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: holder,
      memberState: "synced",
      channelState: "created",
    });
    const settled = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(settled.channel).toMatchObject({ provisioned: true });
    expect(settled.viewerMemberState).toBe("synced");
  });

  it("never clears a failed channel from the provisioning step", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const first = randomUUID();
    await sync.claimDueJobs({ workerId: first, leaseSeconds: 30, limit: 10 });
    await sync.failJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: first,
      errorCode: "stream_channel_projection_mismatch",
    });

    await pool.query({
      text: `
        update public.community_channel_sync_jobs
        set state = 'pending', next_attempt_at = clock_timestamp()
        where community_id = $1
      `,
      values: [communityId],
    });
    const second = randomUUID();
    await sync.claimDueJobs({ workerId: second, leaseSeconds: 30, limit: 10 });
    await sync.markChannelProvisioned({ communityId, workerId: second });

    const stillFailed = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(stillFailed.channel).toMatchObject({
      state: "failed",
      provisioned: true,
    });

    // Only a confirmed member write clears the terminal channel failure.
    await sync.completeJob({
      communityId,
      ownerUserId: owner.userId,
      workerId: second,
      memberState: "synced",
      channelState: "created",
    });
    const cleared = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(cleared.channel).toMatchObject({ state: "created" });
  });

  it("decides the member cap inside the completing transaction", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const second = await createAccount();
    const third = await createAccount();
    await join(second.userId, communityId);
    await join(third.userId, communityId);

    const workerId = randomUUID();
    await sync.claimDueJobs({ workerId, leaseSeconds: 60, limit: 10 });
    // The cap is 2 for this database, so the first two members fit.
    for (const userId of [owner.userId, second.userId]) {
      await sync.completeJob({
        communityId,
        ownerUserId: userId,
        workerId,
        memberState: "synced",
        channelState: "created",
      });
    }
    // The worker believed there was room (it read a stale count), but the
    // transaction re-counts and parks the third member instead.
    await sync.completeJob({
      communityId,
      ownerUserId: third.userId,
      workerId,
      memberState: "synced",
      channelState: "created",
    });

    const parked = await communication.readCommunityChannel({
      communityId,
      viewerUserId: third.userId,
    });
    expect(parked.viewerMemberState).toBe("capacityPending");
    expect(parked.viewerIsCommunityMember).toBe(true);
    expect(parked.channel).toMatchObject({ state: "capacityPending" });
    expect(await jobRow(communityId, third.userId)).toMatchObject({
      state: "succeeded",
    });
  });

  it("repairs only the gaps when a verified community is verified again", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    await verifyCommunity(communityId);
    const workerId = randomUUID();
    await sync.claimDueJobs({ workerId, leaseSeconds: 60, limit: 10 });
    await sync.completeJob({
      communityId,
      ownerUserId: owner.userId,
      workerId,
      memberState: "synced",
      channelState: "created",
    });
    const member = await createAccount();
    await join(member.userId, communityId);
    await pool.query({
      text: `
        delete from public.community_channel_sync_jobs
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, member.userId],
    });

    await verifyCommunity(communityId);

    // The synced owner is untouched and gets no new job.
    const ownerChannel = await communication.readCommunityChannel({
      communityId,
      viewerUserId: owner.userId,
    });
    expect(ownerChannel.viewerMemberState).toBe("synced");
    expect(await jobRow(communityId, owner.userId)).toMatchObject({
      state: "succeeded",
    });
    // The member whose job was lost is re-enqueued.
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "add",
      state: "pending",
    });
  });

  async function createVoiceRoom(
    actorUserId: string,
    communityId: string,
  ): Promise<string> {
    const record = await communication.createVoiceRoom({
      actorUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomCreate", [
        communityId,
      ]),
      requestId: randomUUID(),
    });
    return record.room.voiceRoomId;
  }

  async function provision(voiceRoomId: string): Promise<void> {
    await communication.recordVoiceRoomProvisioning({
      voiceRoomId,
      provisionState: "provisioned",
      errorCode: null,
      backstage: false,
    });
  }

  async function leaveRoom(
    actorUserId: string,
    voiceRoomId: string,
  ): Promise<VoiceRoomViewerRecord> {
    return communication.leaveVoiceRoom({
      actorUserId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomLeave", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
  }

  async function memberJoinedAt(
    voiceRoomId: string,
    ownerUserId: string,
  ): Promise<{ readonly joinedAt: Date; readonly state: string }> {
    const result = await pool.query<{ joined_at: Date; state: string }>({
      text: `
        select joined_at, state from public.voice_room_members
        where voice_room_id = $1 and owner_user_id = $2
      `,
      values: [voiceRoomId, ownerUserId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("expected a member row");
    }
    return { joinedAt: row.joined_at, state: row.state };
  }

  function joinRoom(
    actorUserId: string,
    voiceRoomId: string,
  ): Promise<unknown> {
    return communication.joinVoiceRoom({
      actorUserId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomJoin", [voiceRoomId]),
      requestId: randomUUID(),
    });
  }

  it("allows one live room per community and makes the creator its host", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);

    const record = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(record.room).toMatchObject({
      state: "live",
      provisionState: "pending",
      backstage: true,
      callId: deriveVoiceCallId(voiceRoomId),
      // The banner name is the community row's name at read time (0052).
      communityName: "Frog Holders",
    });
    expect(record.viewerRole).toBe("host");
    await pool.query({
      text: `update public.communities set name = 'Frog Holders Renamed' where community_id = $1`,
      values: [communityId],
    });
    const renamed = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(renamed.room.communityName).toBe("Frog Holders Renamed");

    await expect(createVoiceRoom(owner.userId, communityId)).rejects.toThrow();

    const member = await createAccount();
    await join(member.userId, communityId);
    await expect(
      createVoiceRoom(member.userId, communityId),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
  });

  it("counts the host in joinedCount but in neither role count, and drops a leaver (Decision 0051)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);

    const hostOnly = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(hostOnly).toMatchObject({
      viewerRole: "host",
      speakerCount: 0,
      listenerCount: 0,
      joinedCount: 1,
    });

    const listener = await createAccount();
    await join(listener.userId, communityId);
    const joined = (await joinRoom(
      listener.userId,
      voiceRoomId,
    )) as VoiceRoomViewerRecord;
    expect(joined).toMatchObject({
      viewerRole: "listener",
      speakerCount: 0,
      listenerCount: 1,
      joinedCount: 2,
    });

    const left = await communication.leaveVoiceRoom({
      actorUserId: listener.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomLeave", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    expect(left).toMatchObject({
      viewerRole: null,
      listenerCount: 0,
      joinedCount: 1,
    });

    await expect(
      communication.leaveVoiceRoom({
        actorUserId: owner.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomLeave", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
    const stillLive = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(stillLive.room.state).toBe("live");
    expect(stillLive.joinedCount).toBe(1);
  });

  it("records the backstage flag with the provisioning outcome and never a provisioned room in backstage (Decision 0054)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);

    const reconciling = await communication.recordVoiceRoomProvisioning({
      voiceRoomId,
      provisionState: "reconciling",
      errorCode: "stream_call_go_live_unconfirmed",
      backstage: true,
    });
    expect(reconciling).toMatchObject({
      provisionState: "reconciling",
      backstage: true,
    });
    const listener = await createAccount();
    await join(listener.userId, communityId);
    await expect(joinRoom(listener.userId, voiceRoomId)).rejects.toBeInstanceOf(
      CommunicationUnprovisionedRoomError,
    );

    await expect(
      communication.recordVoiceRoomProvisioning({
        voiceRoomId,
        provisionState: "provisioned",
        errorCode: null,
        backstage: true,
      }),
    ).rejects.toBeInstanceOf(CommunicationRepositoryUnavailableError);
    const untouched = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(untouched.room).toMatchObject({
      provisionState: "reconciling",
      backstage: true,
    });

    const live = await communication.recordVoiceRoomProvisioning({
      voiceRoomId,
      provisionState: "provisioned",
      errorCode: null,
      backstage: false,
    });
    expect(live).toMatchObject({
      provisionState: "provisioned",
      backstage: false,
    });
    const errorRow = await pool.query<{ last_error_code: string | null }>({
      text: `select last_error_code from public.voice_rooms where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    expect(errorRow.rows[0]?.last_error_code).toBeNull();
    const joined = (await joinRoom(
      listener.userId,
      voiceRoomId,
    )) as VoiceRoomViewerRecord;
    expect(joined.room.backstage).toBe(false);
    expect(joined.viewerRole).toBe("listener");
  });

  it("flips backstage to false only while the room is live, provisioned, and in backstage (self-heal write-back)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);

    // Pending room: nothing to heal, no error, the row is untouched.
    const pending = await communication.recordVoiceRoomLive({ voiceRoomId });
    expect(pending).toMatchObject({
      provisionState: "pending",
      backstage: true,
    });

    // A pre-0054 shape: provisioned but still in backstage.
    await pool.query({
      text: `update public.voice_rooms set provision_state = 'provisioned', last_error_code = 'stream_call_go_live_unconfirmed' where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    const before = await pool.query<{ record_version: number }>({
      text: `select record_version from public.voice_rooms where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    const healed = await communication.recordVoiceRoomLive({ voiceRoomId });
    expect(healed).toMatchObject({
      provisionState: "provisioned",
      backstage: false,
    });
    const after = await pool.query<{
      record_version: number;
      last_error_code: string | null;
    }>({
      text: `select record_version, last_error_code from public.voice_rooms where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    expect(after.rows[0]?.record_version).toBe(
      before.rows[0]!.record_version + 1,
    );
    expect(after.rows[0]?.last_error_code).toBeNull();

    // Already healed: zero rows matched, no error, no version bump.
    const again = await communication.recordVoiceRoomLive({ voiceRoomId });
    expect(again.backstage).toBe(false);
    const unchanged = await pool.query<{ record_version: number }>({
      text: `select record_version from public.voice_rooms where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    expect(unchanged.rows[0]?.record_version).toBe(
      after.rows[0]!.record_version,
    );

    // An ended room in backstage stays as it is.
    await pool.query({
      text: `update public.voice_rooms set backstage = true, state = 'ended', ended_at = clock_timestamp() where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    const ended = await communication.recordVoiceRoomLive({ voiceRoomId });
    expect(ended).toMatchObject({ state: "ended", backstage: true });

    await expect(
      communication.recordVoiceRoomLive({ voiceRoomId: randomUUID() }),
    ).rejects.toBeInstanceOf(CommunicationNotFoundError);
  });

  it("shows a member who just joined on the roster and in the counts on the very next read (Decision 0069 §2)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const listener = await createAccount();
    await join(listener.userId, communityId);

    const before = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
    });
    expect(before.items).toEqual([]);

    await joinRoom(listener.userId, voiceRoomId);

    // No other write in between: the join committed before it answered, and
    // every read goes to PostgreSQL, so the host's next read has the member.
    const roster = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
    });
    expect(roster.items.map((item) => item.publicProfileId)).toEqual([
      listener.publicProfileId,
    ]);
    expect(roster.room).toMatchObject({
      viewerRole: "host",
      listenerCount: 1,
      joinedCount: 2,
    });
    const hostView = await communication.getVoiceRoom({
      voiceRoomId,
      viewerUserId: owner.userId,
    });
    expect(hostView).toMatchObject({ listenerCount: 1, joinedCount: 2 });
  });

  it("treats leave by an account not in the live room as a no-op, keeps the host refusal, and keeps the ended room stale (Decision 0069 §4)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const member = await createAccount();
    await join(member.userId, communityId);

    async function leftAudits(): Promise<number> {
      const result = await pool.query<{ total: string }>({
        text: `
          select count(*)::text as total from public.voice_room_events
          where voice_room_id = $1 and event_type = 'member_left'
        `,
        values: [voiceRoomId],
      });
      return Number.parseInt(result.rows[0]?.total ?? "0", 10);
    }

    // Never joined: the end state already holds.
    const neverJoined = await leaveRoom(member.userId, voiceRoomId);
    expect(neverJoined).toMatchObject({ viewerRole: null, joinedCount: 1 });
    expect(await leftAudits()).toBe(0);

    await joinRoom(member.userId, voiceRoomId);
    const left = await leaveRoom(member.userId, voiceRoomId);
    expect(left).toMatchObject({ viewerRole: null, joinedCount: 1 });
    expect(await leftAudits()).toBe(1);

    // Already left, a fresh key: still the same end state, no second audit.
    const leftAgain = await leaveRoom(member.userId, voiceRoomId);
    expect(leftAgain).toMatchObject({ viewerRole: null, joinedCount: 1 });
    expect(await leftAudits()).toBe(1);
    expect(await memberJoinedAt(voiceRoomId, member.userId)).toMatchObject({
      state: "left",
    });

    // The host is refused, not ignored: it ends the room instead.
    await expect(leaveRoom(owner.userId, voiceRoomId)).rejects.toBeInstanceOf(
      CommunicationPermissionDeniedError,
    );

    await joinRoom(member.userId, voiceRoomId);
    await communication.endVoiceRoom({
      actorUserId: owner.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomEnd", [voiceRoomId]),
      requestId: randomUUID(),
    });
    // Every write on an ended room stays DATA_STALE (Decision 0032), a
    // member's leave included.
    await expect(leaveRoom(member.userId, voiceRoomId)).rejects.toBeInstanceOf(
      CommunicationDataStaleError,
    );
  });

  it("refreshes joined_at when a member re-joins after leaving, and keeps it on an idempotent re-join (R4-6)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const listener = await createAccount();
    await join(listener.userId, communityId);

    await joinRoom(listener.userId, voiceRoomId);
    const first = await memberJoinedAt(voiceRoomId, listener.userId);
    expect(first.state).toBe("joined");

    // A second join while still joined is idempotent: same joined_at.
    await joinRoom(listener.userId, voiceRoomId);
    const again = await memberJoinedAt(voiceRoomId, listener.userId);
    expect(again.joinedAt.getTime()).toBe(first.joinedAt.getTime());

    await leaveRoom(listener.userId, voiceRoomId);
    expect((await memberJoinedAt(voiceRoomId, listener.userId)).state).toBe(
      "left",
    );
    // Make the clock tick past the first join's millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await joinRoom(listener.userId, voiceRoomId);
    const rejoined = await memberJoinedAt(voiceRoomId, listener.userId);
    expect(rejoined.state).toBe("joined");
    expect(rejoined.joinedAt.getTime()).toBeGreaterThan(
      first.joinedAt.getTime(),
    );

    // The roster orders by joined_at, so the re-joined member sorts after a
    // member that joined between its two memberships.
    const other = await createAccount();
    await join(other.userId, communityId);
    await leaveRoom(listener.userId, voiceRoomId);
    await joinRoom(other.userId, voiceRoomId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await joinRoom(listener.userId, voiceRoomId);
    const roster = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
    });
    expect(roster.items.map((row) => row.ownerUserId)).toEqual([
      other.userId,
      listener.userId,
    ]);
  });

  it("leaves no row behind when joining a room whose Stream call is unconfirmed", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    const listener = await createAccount();
    await join(listener.userId, communityId);

    const key = randomUUID();
    await expect(
      communication.joinVoiceRoom({
        actorUserId: listener.userId,
        voiceRoomId,
        idempotencyKey: key,
        requestSha256: communicationCommandDigest("voiceRoomJoin", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunicationUnprovisionedRoomError);

    for (const [text, values] of [
      [
        `select 1 from public.voice_room_members where voice_room_id = $1 and owner_user_id = $2`,
        [voiceRoomId, listener.userId],
      ],
      [
        `select 1 from public.voice_room_events where voice_room_id = $1 and actor_user_id = $2`,
        [voiceRoomId, listener.userId],
      ],
      [
        `select 1 from public.idempotency_records where idempotency_key = $1`,
        [key],
      ],
    ] as const) {
      const result = await pool.query({ text, values: [...values] });
      expect(result.rowCount).toBe(0);
    }
  });

  it("orders concurrent hand raises with a gapless sequence and one pending raise each", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);

    const listeners = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const account = await createAccount();
        await join(account.userId, communityId);
        await joinRoom(account.userId, voiceRoomId);
        return account;
      }),
    );

    await Promise.all(
      listeners.map((listener) =>
        communication.raiseHand({
          actorUserId: listener.userId,
          voiceRoomId,
          idempotencyKey: randomUUID(),
          requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
            voiceRoomId,
          ]),
          requestId: randomUUID(),
        }),
      ),
    );

    const queue = await communication.listHandRaises({
      voiceRoomId,
      viewerUserId: owner.userId,
      limit: 50,
    });
    expect(queue.room.viewerRole).toBe("host");
    expect(queue.items).toHaveLength(8);
    expect(queue.items.map((entry) => entry.sequence)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    expect(
      new Set(queue.items.map((entry) => entry.publicProfileId)).size,
    ).toBe(8);
    expect(queue.items.every((entry) => entry.alias !== null)).toBe(true);
    expect(queue.items.every((entry) => !entry.anonymousMode)).toBe(true);

    const first = listeners[0];
    if (first === undefined) {
      throw new Error("Expected a listener");
    }
    await expect(
      communication.raiseHand({
        actorUserId: first.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
  });

  it("only lets the host promote a speaker and clears that pending raise", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const listener = await createAccount();
    await join(listener.userId, communityId);
    await joinRoom(listener.userId, voiceRoomId);
    await communication.raiseHand({
      actorUserId: listener.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });

    const other = await createAccount();
    await join(other.userId, communityId);
    await joinRoom(other.userId, voiceRoomId);
    await expect(
      communication.inviteSpeaker({
        actorUserId: other.userId,
        voiceRoomId,
        targetPublicProfileId: listener.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomSpeakerInvite", [
          voiceRoomId,
          listener.publicProfileId,
        ]),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);

    const invited = await communication.inviteSpeaker({
      actorUserId: owner.userId,
      voiceRoomId,
      targetPublicProfileId: listener.publicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomSpeakerInvite", [
        voiceRoomId,
        listener.publicProfileId,
      ]),
      requestId: randomUUID(),
    });
    expect(invited.targetRole).toBe("speaker");
    const queue = await communication.listHandRaises({
      voiceRoomId,
      viewerUserId: owner.userId,
      limit: 50,
    });
    expect(queue.items).toHaveLength(0);
  });

  function targetCommand(
    operation:
      | "voiceRoomSpeakerInvite"
      | "voiceRoomSpeakerRemove"
      | "voiceRoomSpeakerMute"
      | "voiceRoomSpeakerUnmute",
    actorUserId: string,
    voiceRoomId: string,
    targetPublicProfileId: string,
  ) {
    return {
      actorUserId,
      voiceRoomId,
      targetPublicProfileId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest(operation, [
        voiceRoomId,
        targetPublicProfileId,
      ]),
      requestId: randomUUID(),
    };
  }

  it("lists the roster by role in join order with hand raise, anonymous mode, and mute intent (Decision 0052)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const members = [] as { userId: string; publicProfileId: string }[];
    for (let index = 0; index < 4; index += 1) {
      const member = await createAccount();
      await join(member.userId, communityId);
      await joinRoom(member.userId, voiceRoomId);
      members.push(member);
    }
    const [first, second, third, fourth] = members as [
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
    ];
    await communication.raiseHand({
      actorUserId: second.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    await pool.query({
      text: `
        insert into public.privacy_preferences_v2 (owner_user_id, anonymous_mode)
        values ($1, true)
      `,
      values: [third.userId],
    });
    await communication.inviteSpeaker(
      targetCommand(
        "voiceRoomSpeakerInvite",
        owner.userId,
        voiceRoomId,
        first.publicProfileId,
      ),
    );

    const listeners = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
    });
    expect(listeners.room.viewerRole).toBe("host");
    expect(listeners.items.map((item) => item.publicProfileId)).toEqual([
      second.publicProfileId,
      third.publicProfileId,
      fourth.publicProfileId,
    ]);
    expect(listeners.items.map((item) => item.handRaised)).toEqual([
      true,
      false,
      false,
    ]);
    expect(listeners.items.map((item) => item.anonymousMode)).toEqual([
      false,
      true,
      false,
    ]);
    expect(listeners.items.every((item) => !item.muted)).toBe(true);
    // The queue carries the same identity columns as the roster (0053 §2).
    await communication.raiseHand({
      actorUserId: third.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    const queue = await communication.listHandRaises({
      voiceRoomId,
      viewerUserId: fourth.userId,
      limit: 50,
    });
    expect(queue.room.viewerRole).toBe("listener");
    expect(
      queue.items.map((entry) => [
        entry.publicProfileId,
        entry.ownerUserId,
        entry.anonymousMode,
      ]),
    ).toEqual([
      [second.publicProfileId, second.userId, false],
      [third.publicProfileId, third.userId, true],
    ]);
    // The host is in neither view; the invited member moved to the speakers.
    const speakers = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: fourth.userId,
      role: "speaker",
      limit: 10,
    });
    expect(speakers.room.viewerRole).toBe("listener");
    expect(speakers.items).toHaveLength(1);
    expect(speakers.items[0]).toMatchObject({
      publicProfileId: first.publicProfileId,
      role: "speaker",
      handRaised: false,
      muted: false,
    });

    // Keyset continuation: the page after the first listener row.
    const secondPage = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
      after: {
        lastJoinedAt: listeners.items[0]!.joinedAt,
        lastPublicProfileId: listeners.items[0]!.publicProfileId,
      },
    });
    expect(secondPage.items.map((item) => item.publicProfileId)).toEqual([
      third.publicProfileId,
      fourth.publicProfileId,
    ]);

    // A non-member of the community cannot read the roster.
    const stranger = await createAccount();
    await expect(
      communication.listVoiceRoomMembers({
        voiceRoomId,
        viewerUserId: stranger.userId,
        role: "listener",
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
  });

  it("records the host's mute intent per speaker, on mute-all, and clears it on every role transition (Decision 0052)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const speaker = await createAccount();
    const other = await createAccount();
    const listener = await createAccount();
    for (const account of [speaker, other, listener]) {
      await join(account.userId, communityId);
      await joinRoom(account.userId, voiceRoomId);
    }
    for (const account of [speaker, other]) {
      await communication.inviteSpeaker(
        targetCommand(
          "voiceRoomSpeakerInvite",
          owner.userId,
          voiceRoomId,
          account.publicProfileId,
        ),
      );
    }

    // Only the host; a listener target and a repeat are stale.
    await expect(
      communication.muteSpeaker(
        targetCommand(
          "voiceRoomSpeakerMute",
          other.userId,
          voiceRoomId,
          speaker.publicProfileId,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
    await expect(
      communication.muteSpeaker(
        targetCommand(
          "voiceRoomSpeakerMute",
          owner.userId,
          voiceRoomId,
          listener.publicProfileId,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
    const muted = await communication.muteSpeaker(
      targetCommand(
        "voiceRoomSpeakerMute",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    expect(muted.targetRole).toBe("speaker");
    expect(muted.room.speakerCount).toBe(2);
    await expect(
      communication.muteSpeaker(
        targetCommand(
          "voiceRoomSpeakerMute",
          owner.userId,
          voiceRoomId,
          speaker.publicProfileId,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
    const audit = await pool.query({
      text: `
        select 1 from public.voice_room_events
        where voice_room_id = $1 and event_type = 'speaker_muted' and target_user_id = $2
      `,
      values: [voiceRoomId, speaker.userId],
    });
    expect(audit.rowCount).toBe(1);

    const afterMute = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "speaker",
      limit: 10,
    });
    expect(
      afterMute.items.map((item) => [item.publicProfileId, item.muted]),
    ).toEqual([
      [speaker.publicProfileId, true],
      [other.publicProfileId, false],
    ]);

    // Mute-all is the same intent applied to every joined speaker.
    await communication.recordMuteAll({
      actorUserId: owner.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomMuteAll", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    const afterMuteAll = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "speaker",
      limit: 10,
    });
    expect(afterMuteAll.items.every((item) => item.muted)).toBe(true);
    const listenersUntouched = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "listener",
      limit: 10,
    });
    expect(listenersUntouched.items.map((item) => item.muted)).toEqual([false]);

    // Remove → listener clears it; re-invite starts unmuted.
    await communication.removeSpeaker(
      targetCommand(
        "voiceRoomSpeakerRemove",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    const mutedColumn = async (userId: string) =>
      (
        await pool.query<{ muted_at: Date | null; role: string }>({
          text: `select muted_at, role from public.voice_room_members where voice_room_id = $1 and owner_user_id = $2`,
          values: [voiceRoomId, userId],
        })
      ).rows[0];
    expect(await mutedColumn(speaker.userId)).toEqual({
      muted_at: null,
      role: "listener",
    });
    await communication.inviteSpeaker(
      targetCommand(
        "voiceRoomSpeakerInvite",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    expect(await mutedColumn(speaker.userId)).toEqual({
      muted_at: null,
      role: "speaker",
    });
    // Leaving clears it too.
    await communication.leaveVoiceRoom({
      actorUserId: other.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomLeave", [
        voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    expect(await mutedColumn(other.userId)).toEqual({
      muted_at: null,
      role: "listener",
    });
    // The schema itself refuses a muted listener.
    await expect(
      pool.query({
        text: `update public.voice_room_members set muted_at = clock_timestamp() where voice_room_id = $1 and owner_user_id = $2`,
        values: [voiceRoomId, listener.userId],
      }),
    ).rejects.toThrow(/voice_room_members_muted_role_check/);
  });

  it("lets the muted speaker or the host clear the mute intent, nobody else (Decision 0053)", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const speaker = await createAccount();
    const other = await createAccount();
    const listener = await createAccount();
    for (const account of [speaker, other, listener]) {
      await join(account.userId, communityId);
      await joinRoom(account.userId, voiceRoomId);
    }
    await communication.inviteSpeaker(
      targetCommand(
        "voiceRoomSpeakerInvite",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    const unmute = (actorUserId: string, targetPublicProfileId: string) =>
      communication.unmuteSpeaker(
        targetCommand(
          "voiceRoomSpeakerUnmute",
          actorUserId,
          voiceRoomId,
          targetPublicProfileId,
        ),
      );

    // Nothing to clear yet: stale for the speaker itself and for the host.
    await expect(
      unmute(speaker.userId, speaker.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
    await expect(
      unmute(owner.userId, speaker.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);

    await communication.muteSpeaker(
      targetCommand(
        "voiceRoomSpeakerMute",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    // A third member may not clear someone else's mute.
    await expect(
      unmute(other.userId, speaker.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
    // A listener has no mute to clear, whoever asks.
    await expect(
      unmute(owner.userId, listener.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
    await expect(
      unmute(listener.userId, listener.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);
    // The host row can never carry a mute; targeting it is a permission error.
    await expect(
      unmute(owner.userId, owner.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);

    // The speaker clears its own intent.
    const selfCleared = await unmute(speaker.userId, speaker.publicProfileId);
    expect(selfCleared.targetRole).toBe("speaker");
    expect(selfCleared.room.viewerRole).toBe("speaker");
    let roster = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: speaker.userId,
      role: "speaker",
      limit: 10,
    });
    expect(roster.items.map((item) => item.muted)).toEqual([false]);
    await expect(
      unmute(speaker.userId, speaker.publicProfileId),
    ).rejects.toBeInstanceOf(CommunicationDataStaleError);

    // The host clears it after a second mute.
    await communication.muteSpeaker(
      targetCommand(
        "voiceRoomSpeakerMute",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    const hostCleared = await unmute(owner.userId, speaker.publicProfileId);
    expect(hostCleared.room.viewerRole).toBe("host");
    roster = await communication.listVoiceRoomMembers({
      voiceRoomId,
      viewerUserId: owner.userId,
      role: "speaker",
      limit: 10,
    });
    expect(roster.items.map((item) => item.muted)).toEqual([false]);

    const audit = await pool.query<{ reason_code: string; actor: string }>({
      text: `
        select reason_code, actor_user_id::text as actor
        from public.voice_room_events
        where voice_room_id = $1 and event_type = 'speaker_unmuted' and target_user_id = $2
        order by occurred_at asc, event_id asc
      `,
      values: [voiceRoomId, speaker.userId],
    });
    expect(audit.rows).toEqual([
      { reason_code: "self_unmute", actor: speaker.userId },
      { reason_code: "host_unmute", actor: owner.userId },
    ]);

    // An exact replay returns the committed result instead of going stale.
    const replay = targetCommand(
      "voiceRoomSpeakerUnmute",
      owner.userId,
      voiceRoomId,
      speaker.publicProfileId,
    );
    await communication.muteSpeaker(
      targetCommand(
        "voiceRoomSpeakerMute",
        owner.userId,
        voiceRoomId,
        speaker.publicProfileId,
      ),
    );
    await communication.unmuteSpeaker(replay);
    const replayed = await communication.unmuteSpeaker(replay);
    expect(replayed.targetRole).toBe("speaker");
  });

  it("ends the room and makes every later write stale", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
    await provision(voiceRoomId);
    const listener = await createAccount();
    await join(listener.userId, communityId);
    await joinRoom(listener.userId, voiceRoomId);

    const ended = await communication.endVoiceRoom({
      actorUserId: owner.userId,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomEnd", [voiceRoomId]),
      requestId: randomUUID(),
    });
    expect(ended.room.state).toBe("ended");
    expect(ended.room.endedAt).not.toBeNull();

    for (const call of [
      () => joinRoom(listener.userId, voiceRoomId),
      () =>
        communication.raiseHand({
          actorUserId: listener.userId,
          voiceRoomId,
          idempotencyKey: randomUUID(),
          requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
            voiceRoomId,
          ]),
          requestId: randomUUID(),
        }),
      () =>
        communication.endVoiceRoom({
          actorUserId: owner.userId,
          voiceRoomId,
          idempotencyKey: randomUUID(),
          requestSha256: communicationCommandDigest("voiceRoomEnd", [
            voiceRoomId,
          ]),
          requestId: randomUUID(),
        }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CommunicationDataStaleError);
    }

    // A new room can be opened once the previous one ended.
    await expect(
      createVoiceRoom(owner.userId, communityId),
    ).resolves.toBeTypeOf("string");
  });

  /**
   * Decision 0032 narrows the Decision 0025 freeze on
   * communication_group_members to exactly one transition. This builds the
   * minimal group fixture directly so the trigger change is proved, not
   * assumed.
   */
  async function createGroupFixture(
    creatorUserId: string,
    memberUserId: string,
  ): Promise<string> {
    const operationId = randomUUID();
    const channelId = `loop_group_${randomUUID().replaceAll("-", "")}`;
    const digest = "a".repeat(64);
    const record = await pool.query<{ id: string }>({
      text: `
        insert into public.idempotency_records (
          owner_user_id, scope, idempotency_key, key_source,
          request_sha256, digest_version
        )
        values ($1, 'chat_channel_command', $2, 'client', $3,
          'chat_channel_command_v1')
        returning id
      `,
      values: [creatorUserId, operationId, digest],
    });
    const recordId = record.rows[0]?.id;
    if (recordId === undefined) {
      throw new Error("Expected an idempotency record");
    }
    await pool.query({
      text: `
        insert into public.chat_operations (
          operation_id, owner_user_id, idempotency_record_id, request_sha256,
          operation_kind, state, fixed_stream_channel_id
        )
        values ($1, $2, $3, $4, 'group_create', 'pending', $5)
      `,
      values: [operationId, creatorUserId, recordId, digest, channelId],
    });
    const group = await pool.query<{ group_id: string }>({
      text: `
        insert into public.communication_groups (
          stream_channel_id, channel_kind, name, create_operation_id,
          channel_state
        )
        values ($1, 'group', 'Frog Squad', $2, 'pending')
        returning group_id
      `,
      values: [channelId, operationId],
    });
    const groupId = group.rows[0]?.group_id;
    if (groupId === undefined) {
      throw new Error("Expected a group");
    }
    await pool.query({
      text: `
        insert into public.communication_group_members (
          group_id, owner_user_id, member_role
        )
        values ($1, $2, 'creator'), ($1, $3, 'member')
      `,
      values: [groupId, creatorUserId, memberUserId],
    });
    await pool.query({
      text: `
        update public.communication_groups
        set channel_state = 'active', updated_at = clock_timestamp()
        where group_id = $1
      `,
      values: [groupId],
    });
    return groupId;
  }

  it("lets a group member leave but keeps the creator and role changes frozen", async () => {
    const creator = await createAccount();
    const member = await createAccount();
    const groupId = await createGroupFixture(creator.userId, member.userId);

    const leaveKey = randomUUID();
    const leaveDigest = communicationCommandDigest("chatGroupLeave", [groupId]);
    const preparation = await communication.prepareChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: leaveKey,
      requestSha256: leaveDigest,
    });
    expect(preparation.alreadyCommitted).toBe(false);
    expect(preparation.groupId).toBe(groupId);
    expect(preparation.streamChannelId).toMatch(/^loop_group_[0-9a-f]{32}$/);
    expect(preparation.memberStreamUserId).toBe(
      `loop_${member.userId.replaceAll("-", "")}`,
    );
    expect(preparation.channelCreatedByStreamUserId).toBe(
      `loop_${creator.userId.replaceAll("-", "")}`,
    );

    await expect(
      communication.prepareChatGroupLeave({
        actorUserId: creator.userId,
        groupId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("chatGroupLeave", [groupId]),
      }),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);

    await communication.commitChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: leaveKey,
      requestSha256: leaveDigest,
      requestId: randomUUID(),
    });
    const remaining = await pool.query({
      text: `select owner_user_id from public.communication_group_members where group_id = $1`,
      values: [groupId],
    });
    expect(remaining.rowCount).toBe(1);

    // A retry with the same key after a lost response replays the preparation
    // (so the caller can repeat only the idempotent Stream removal) and the
    // commit stays a no-op.
    const replay = await communication.prepareChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: leaveKey,
      requestSha256: leaveDigest,
    });
    expect(replay.alreadyCommitted).toBe(true);
    expect(replay.streamChannelId).toBe(preparation.streamChannelId);
    await communication.commitChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: leaveKey,
      requestSha256: leaveDigest,
      requestId: randomUUID(),
    });
    const audits = await pool.query({
      text: `select event_id from public.chat_group_membership_events where group_id = $1`,
      values: [groupId],
    });
    expect(audits.rowCount).toBe(1);

    // The database still refuses a creator removal and any role change.
    await expect(
      pool.query({
        text: `delete from public.communication_group_members where group_id = $1 and member_role = 'creator'`,
        values: [groupId],
      }),
    ).rejects.toThrow();
    await expect(
      pool.query({
        text: `update public.communication_group_members set member_role = 'creator' where group_id = $1`,
        values: [groupId],
      }),
    ).rejects.toThrow();
  });

  it("returns the committed result for an exact idempotent replay", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const key = randomUUID();
    const digest = communicationCommandDigest("voiceRoomCreate", [communityId]);
    const first = await communication.createVoiceRoom({
      actorUserId: owner.userId,
      communityId,
      idempotencyKey: key,
      requestSha256: digest,
      requestId: randomUUID(),
    });
    const replay = await communication.createVoiceRoom({
      actorUserId: owner.userId,
      communityId,
      idempotencyKey: key,
      requestSha256: digest,
      requestId: randomUUID(),
    });
    expect(replay.room.voiceRoomId).toBe(first.room.voiceRoomId);
    const rooms = await pool.query({
      text: `select voice_room_id from public.voice_rooms where community_id = $1`,
      values: [communityId],
    });
    expect(rooms.rowCount).toBe(1);
  });

  describe("listDirectChannels (Decision 0056)", () => {
    function digest(label: string): string {
      return createHash("sha256").update(label, "utf8").digest("hex");
    }

    /** Accepted friendship + social privacy that admits a DM, both ways. */
    async function befriend(
      firstUserId: string,
      secondUserId: string,
    ): Promise<void> {
      for (const ownerUserId of [firstUserId, secondUserId]) {
        await pool.query({
          text: `
            insert into public.social_privacy_preferences (
              owner_user_id, friend_requests, group_invites, direct_messages
            ) values ($1, 'enabled', 'friends', 'friends')
            on conflict (owner_user_id) do update
              set direct_messages = 'friends',
                  group_invites = 'friends',
                  friend_requests = 'enabled'
          `,
          values: [ownerUserId],
        });
      }
      const request = await pool.query<{ friend_request_id: string }>({
        text: `
          insert into public.friend_requests (
            requester_user_id, recipient_user_id, status, expires_at,
            decided_at, created_at, updated_at
          ) values (
            $1, $2, 'accepted', clock_timestamp() + interval '1 day',
            clock_timestamp(), clock_timestamp() - interval '1 minute',
            clock_timestamp()
          )
          returning friend_request_id
        `,
        values: [firstUserId, secondUserId],
      });
      const [userIdLow, userIdHigh] = [firstUserId, secondUserId].sort();
      await pool.query({
        text: `
          insert into public.friendships (
            user_id_low, user_id_high, accepted_friend_request_id
          ) values ($1, $2, $3)
        `,
        values: [userIdLow, userIdHigh, request.rows[0]!.friend_request_id],
      });
    }

    /**
     * The real product path in repository terms: prepare the fixed channel,
     * claim the one submission, and record success. Returns the
     * `loop_direct_<32 hex>` channel ID, or leaves the row `pending` when
     * `succeed` is false.
     */
    async function openDirect(
      ownerUserId: string,
      targetPublicProfileId: string,
      succeed = true,
    ): Promise<string> {
      const chat = createPostgresChatChannelRepository(pool);
      const operationId = randomUUID();
      const prepared = await chat.prepareDirectOperation({
        operationId,
        ownerUserId,
        requestId: randomUUID(),
        requestDigest: digest(`direct:${operationId}`),
        targetPublicProfileId,
      });
      if (!succeed) {
        return prepared.channelId;
      }
      const claim = await chat.claimSubmission({
        operationId,
        ownerUserId,
        requestId: randomUUID(),
      });
      expect(claim?.kind).toBe("direct");
      await chat.markSucceeded({
        operationId,
        ownerUserId,
        requestId: randomUUID(),
      });
      return prepared.channelId;
    }

    async function identityOf(userId: string): Promise<{
      readonly publicProfileId: string;
      readonly loopId: string;
      readonly alias: string | null;
      readonly avatarRef: string | null;
    }> {
      const row = await pool.query<{
        public_profile_id: string;
        loop_id: string;
        alias: string | null;
        avatar_ref: string | null;
      }>({
        text: `
          select profile.public_profile_id, account.loop_id,
                 profile.alias, profile.avatar_ref
          from public.user_profiles as profile
          join public.loop_users as account on account.id = profile.owner_user_id
          where profile.owner_user_id = $1
        `,
        values: [userId],
      });
      const found = row.rows[0]!;
      return {
        publicProfileId: found.public_profile_id,
        loopId: found.loop_id,
        alias: found.alias,
        avatarRef: found.avatar_ref,
      };
    }

    it("lists only the viewer's active channels, newest first, with the peer's public identity", async () => {
      const viewer = await createAccount();
      const first = await createAccount();
      const second = await createAccount();
      const pendingFriend = await createAccount();
      const outsider = await createAccount();
      await befriend(viewer.userId, first.userId);
      await befriend(viewer.userId, second.userId);
      await befriend(viewer.userId, pendingFriend.userId);
      await befriend(first.userId, second.userId);

      // Two active channels for the viewer, one active channel between the
      // two friends (not the viewer's), and one still-pending channel.
      const withFirst = await openDirect(viewer.userId, first.publicProfileId);
      const withSecond = await openDirect(
        second.userId,
        viewer.publicProfileId,
      );
      const between = await openDirect(first.userId, second.publicProfileId);
      const pending = await openDirect(
        viewer.userId,
        pendingFriend.publicProfileId,
        false,
      );

      const page = await communication.listDirectChannels({
        viewerUserId: viewer.userId,
        limit: 10,
      });
      expect(page.map((row) => row.streamChannelId).sort()).toEqual(
        [withFirst, withSecond].sort(),
      );
      expect(page.map((row) => row.streamChannelId)).not.toContain(between);
      expect(page.map((row) => row.streamChannelId)).not.toContain(pending);
      const byChannel = new Map(page.map((row) => [row.streamChannelId, row]));
      expect(byChannel.get(withFirst)?.peer).toEqual(
        await identityOf(first.userId),
      );
      expect(byChannel.get(withSecond)?.peer).toEqual(
        await identityOf(second.userId),
      );
      // Newest first; ties on the millisecond fall back to the channel ID.
      const ordered = [...page].sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.streamChannelId.localeCompare(a.streamChannelId)
          : b.createdAt.localeCompare(a.createdAt),
      );
      expect(page).toEqual(ordered);
      for (const row of page) {
        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
        expect(JSON.stringify(row)).not.toContain(viewer.userId);
        expect(JSON.stringify(row)).not.toContain(
          viewer.userId.replaceAll("-", ""),
        );
      }

      // The other friend sees the two channels it belongs to, and nothing
      // of the viewer's other channel; a stranger sees nothing.
      const firstView = await communication.listDirectChannels({
        viewerUserId: first.userId,
        limit: 10,
      });
      expect(firstView.map((row) => row.streamChannelId).sort()).toEqual(
        [withFirst, between].sort(),
      );
      expect(byChannel.get(withFirst)?.peer?.publicProfileId).toBe(
        first.publicProfileId,
      );
      expect(
        firstView.find((row) => row.streamChannelId === withFirst)?.peer
          ?.publicProfileId,
      ).toBe(viewer.publicProfileId);
      await expect(
        communication.listDirectChannels({
          viewerUserId: outsider.userId,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it("pages by (created_at, stream_channel_id) keyset without gaps or repeats", async () => {
      const viewer = await createAccount();
      const channels: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const friend = await createAccount();
        await befriend(viewer.userId, friend.userId);
        channels.push(await openDirect(viewer.userId, friend.publicProfileId));
      }
      const all = await communication.listDirectChannels({
        viewerUserId: viewer.userId,
        limit: 10,
      });
      expect(all).toHaveLength(4);

      const walked: string[] = [];
      let after: { lastCreatedAt: string; lastStreamChannelId: string } | null =
        null;
      for (let guard = 0; guard < 6; guard += 1) {
        const page = await communication.listDirectChannels({
          viewerUserId: viewer.userId,
          limit: 2,
          ...(after === null ? {} : { after }),
        });
        if (page.length === 0) {
          break;
        }
        walked.push(...page.map((row) => row.streamChannelId));
        const last = page.at(-1)!;
        after = {
          lastCreatedAt: last.createdAt,
          lastStreamChannelId: last.streamChannelId,
        };
        if (page.length < 2) {
          break;
        }
      }
      expect(walked).toEqual(all.map((row) => row.streamChannelId));
      expect(new Set(walked).size).toBe(4);
      expect(walked.sort()).toEqual([...channels].sort());
    });

    it("keeps the row with peer null when the other account has no public profile", async () => {
      const viewer = await createAccount();
      const gone = await createAccount();
      await befriend(viewer.userId, gone.userId);
      const channel = await openDirect(viewer.userId, gone.publicProfileId);
      await pool.query({
        text: `delete from public.user_profiles where owner_user_id = $1`,
        values: [gone.userId],
      });

      const page = await communication.listDirectChannels({
        viewerUserId: viewer.userId,
        limit: 10,
      });
      expect(page).toHaveLength(1);
      expect(page[0]).toMatchObject({ streamChannelId: channel, peer: null });
      expect(JSON.stringify(page)).not.toContain(gone.userId);
      expect(JSON.stringify(page)).not.toContain(
        gone.userId.replaceAll("-", ""),
      );
    });

    it("rejects an invalid viewer or page size as unavailable, never as a row", async () => {
      await expect(
        communication.listDirectChannels({
          viewerUserId: "not-a-uuid",
          limit: 10,
        }),
      ).rejects.toBeInstanceOf(CommunicationRepositoryUnavailableError);
      const viewer = await createAccount();
      await expect(
        communication.listDirectChannels({
          viewerUserId: viewer.userId,
          limit: 0,
        }),
      ).rejects.toBeInstanceOf(CommunicationRepositoryUnavailableError);
    });
  });

  describe("community channel activity observations (Decision 0061)", () => {
    it("lists only provisioned channels that are due, and records what the lane observed", async () => {
      const owner = await createAccount();
      const communityId = await createCommunity(owner.userId);
      await verifyCommunity(communityId);
      const channelId = deriveCommunityChannelId(communityId);

      // Not provisioned yet: there is no channel to read, so it is not due.
      const beforeProvisioning = await sync.listChannelsDueForActivity({
        staleAfterSeconds: 900,
        limit: 25,
      });
      expect(
        beforeProvisioning.map((target) => target.communityId),
      ).not.toContain(communityId);

      const workerId = randomUUID();
      await sync.claimDueJobs({ workerId, leaseSeconds: 30, limit: 10 });
      await sync.markChannelProvisioned({ communityId, workerId });

      const due = await sync.listChannelsDueForActivity({
        staleAfterSeconds: 900,
        limit: 25,
      });
      expect(due).toContainEqual({
        communityId,
        streamChannelId: channelId,
      });

      const observedAt = new Date().toISOString();
      await sync.recordChannelActivity({
        communityId,
        streamChannelId: channelId,
        windowDays: 7,
        messageCount: 12,
        bounded: true,
        totalMessageCount: 240,
        lastMessageAt: "2026-09-21T08:00:00.000Z",
        observedAt,
      });

      const row = await pool.query<Record<string, unknown>>({
        text: `select * from public.community_channel_activity where community_id = $1`,
        values: [communityId],
      });
      expect(row.rows[0]).toMatchObject({
        stream_channel_id: channelId,
        window_days: 7,
        recent_message_count: "12",
        recent_count_bounded: true,
        total_message_count: "240",
      });

      // A fresh observation takes the community out of the due list.
      const afterObservation = await sync.listChannelsDueForActivity({
        staleAfterSeconds: 900,
        limit: 25,
      });
      expect(
        afterObservation.map((target) => target.communityId),
      ).not.toContain(communityId);

      // The newest observation replaces the previous one; there is one row.
      await sync.recordChannelActivity({
        communityId,
        streamChannelId: channelId,
        windowDays: 7,
        messageCount: 3,
        bounded: false,
        totalMessageCount: null,
        lastMessageAt: null,
        observedAt: new Date().toISOString(),
      });
      const replaced = await pool.query<Record<string, unknown>>({
        text: `select count(*)::int as rows, max(recent_message_count) as count
               from public.community_channel_activity where community_id = $1`,
        values: [communityId],
      });
      expect(replaced.rows[0]).toMatchObject({ rows: 1, count: "3" });
    });

    it("refuses an observation that names another window or a negative count", async () => {
      const owner = await createAccount();
      const communityId = await createCommunity(owner.userId);
      await verifyCommunity(communityId);
      const channelId = deriveCommunityChannelId(communityId);
      const observedAt = new Date().toISOString();
      await expect(
        sync.recordChannelActivity({
          communityId,
          streamChannelId: channelId,
          windowDays: 30,
          messageCount: 1,
          bounded: false,
          totalMessageCount: null,
          lastMessageAt: null,
          observedAt,
        }),
      ).rejects.toThrow();
      await expect(
        sync.recordChannelActivity({
          communityId,
          streamChannelId: channelId,
          windowDays: 7,
          messageCount: -1,
          bounded: false,
          totalMessageCount: null,
          lastMessageAt: null,
          observedAt,
        }),
      ).rejects.toThrow();
    });
  });
});
