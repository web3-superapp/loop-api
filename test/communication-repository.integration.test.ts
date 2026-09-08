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
} from "../src/features/communication/communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationPermissionDeniedError,
  type CommunicationRepository,
  type CommunityChannelSyncRepository,
} from "../src/features/communication/communication-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";

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

  it("enqueues a remove on ban and nothing on unban", async () => {
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

    await sync.completeJob({
      communityId,
      ownerUserId: member.userId,
      workerId: randomUUID(),
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
    // Unban must not silently restore chat access.
    expect(await jobRow(communityId, member.userId)).toMatchObject({
      kind: "remove",
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

    await sync.completeJob({
      communityId,
      ownerUserId: member.userId,
      workerId: randomUUID(),
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
    });
    expect(record.viewerRole).toBe("host");

    await expect(createVoiceRoom(owner.userId, communityId)).rejects.toThrow();

    const member = await createAccount();
    await join(member.userId, communityId);
    await expect(
      createVoiceRoom(member.userId, communityId),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
  });

  it("orders concurrent hand raises with a gapless sequence and one pending raise each", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);

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
    expect(queue).toHaveLength(8);
    expect(queue.map((entry) => entry.sequence)).toEqual([
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
      new Set(queue.map((entry) => entry.profile.publicProfileId)).size,
    ).toBe(8);

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
    expect(queue).toHaveLength(0);
  });

  it("ends the room and makes every later write stale", async () => {
    const owner = await createAccount();
    const communityId = await createCommunity(owner.userId);
    const voiceRoomId = await createVoiceRoom(owner.userId, communityId);
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

    const preparation = await communication.prepareChatGroupLeave({
      actorUserId: member.userId,
      groupId,
    });
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
      }),
    ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);

    const key = randomUUID();
    const digest = communicationCommandDigest("chatGroupLeave", [groupId]);
    await communication.commitChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: key,
      requestSha256: digest,
      requestId: randomUUID(),
    });
    const remaining = await pool.query({
      text: `select owner_user_id from public.communication_group_members where group_id = $1`,
      values: [groupId],
    });
    expect(remaining.rowCount).toBe(1);

    // An exact replay is a no-op that returns the original committed result.
    await communication.commitChatGroupLeave({
      actorUserId: member.userId,
      groupId,
      idempotencyKey: key,
      requestSha256: digest,
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
});
