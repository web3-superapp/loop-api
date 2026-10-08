import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import { createPostgresCommunicationRepository } from "../src/database/communication-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import {
  CommunityOwnerOnlyFieldError,
  CommunityPermissionDeniedError,
  type CommunityRepository,
  type UpdateCommunityInput,
} from "../src/features/community/community-repository.js";
import { communicationCommandDigest } from "../src/features/communication/communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationIdempotencyConflictError,
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  type CommunicationRepository,
} from "../src/features/communication/communication-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0098 against a real PostgreSQL: the 000048 rename guard and audit,
 * the admin community edit with the owner-only bound token, and the voice
 * room title and live-list speaker preview.
 */

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

describe("Decision 0098: group rename, admin community edit, voice-room title (PostgreSQL)", () => {
  const databaseName = `loop_s109b_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let community: CommunityRepository;
  let communication: CommunicationRepository;
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
      }),
      { error: () => undefined },
    );
    community = createPostgresCommunityRepository(pool, {
      communityChannelMemberCap: 100,
    });
    communication = createPostgresCommunicationRepository(pool);
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
      `did:privy:s109b:${randomUUID()}`,
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

  function joinCommunity(
    ownerUserId: string,
    communityId: string,
  ): Promise<unknown> {
    return community.joinCommunity({
      ownerUserId,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "joinCommunity", [communityId]),
      requestId: randomUUID(),
    });
  }

  /**
   * The minimal small-group fixture, built the way the chat-channel
   * repository leaves it: a `group_create` operation, a `pending` group,
   * the creator and members, and (unless `pending`) the transition to
   * `active`.
   */
  async function createGroupFixture(
    creatorUserId: string,
    memberUserIds: readonly string[],
    options: { readonly pending?: boolean } = {},
  ): Promise<string> {
    const operationId = randomUUID();
    const channelId = `loop_group_${randomUUID().replaceAll("-", "")}`;
    const digest = "b".repeat(64);
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
    await pool.query({
      text: `
        insert into public.chat_operations (
          operation_id, owner_user_id, idempotency_record_id, request_sha256,
          operation_kind, state, fixed_stream_channel_id
        )
        values ($1, $2, $3, $4, 'group_create', 'pending', $5)
      `,
      values: [
        operationId,
        creatorUserId,
        record.rows[0]?.id,
        digest,
        channelId,
      ],
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
        values ($1, $2, 'creator')
      `,
      values: [groupId, creatorUserId],
    });
    for (const memberUserId of memberUserIds) {
      await pool.query({
        text: `
          insert into public.communication_group_members (
            group_id, owner_user_id, member_role
          )
          values ($1, $2, 'member')
        `,
        values: [groupId, memberUserId],
      });
    }
    if (options.pending !== true) {
      await pool.query({
        text: `
          update public.communication_groups
          set channel_state = 'active', updated_at = clock_timestamp()
          where group_id = $1
        `,
        values: [groupId],
      });
    }
    return groupId;
  }

  function rename(
    actorUserId: string,
    groupId: string,
    name: string,
    idempotencyKey: string = randomUUID(),
  ) {
    return communication.renameChatGroup({
      actorUserId,
      groupId,
      name,
      idempotencyKey,
      requestSha256: communicationCommandDigest("chatGroupRename", [
        groupId,
        name,
      ]),
      requestId: randomUUID(),
    });
  }

  async function groupRow(groupId: string) {
    const result = await pool.query<{
      name: string;
      name_version: number;
      channel_state: string;
    }>({
      text: `select name, name_version, channel_state from public.communication_groups where group_id = $1`,
      values: [groupId],
    });
    return result.rows[0];
  }

  async function renameEvents(groupId: string) {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select event_type, actor_user_id, old_name, new_name, name_version
        from public.communication_group_events
        where group_id = $1
        order by name_version
      `,
      values: [groupId],
    });
    return result.rows;
  }

  it("is the migration head", async () => {
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
    expect(Number(latestMigrationName.slice(0, 6)) >= 48).toBe(true);
  });

  describe("small-group rename", () => {
    it("lets the creator rename, bumps the version, audits once, and replays by key", async () => {
      const creator = await createAccount();
      const member = await createAccount();
      const groupId = await createGroupFixture(creator.userId, [member.userId]);
      expect(await groupRow(groupId)).toEqual({
        name: "Frog Squad",
        name_version: 1,
        channel_state: "active",
      });

      const key = randomUUID();
      const renamed = await rename(
        creator.userId,
        groupId,
        "Frog Squad II",
        key,
      );
      expect(renamed).toMatchObject({
        groupId,
        name: "Frog Squad II",
        nameVersion: 2,
        changed: true,
        channelCreatedByStreamUserId: `loop_${creator.userId.replaceAll("-", "")}`,
      });
      expect(renamed.streamChannelId).toMatch(/^loop_group_[0-9a-f]{32}$/);
      expect(await groupRow(groupId)).toMatchObject({
        name: "Frog Squad II",
        name_version: 2,
      });
      expect(await renameEvents(groupId)).toEqual([
        {
          event_type: "group_renamed",
          actor_user_id: creator.userId,
          old_name: "Frog Squad",
          new_name: "Frog Squad II",
          name_version: 2,
        },
      ]);

      // A same-key replay answers the recorded result and writes nothing.
      const replay = await rename(
        creator.userId,
        groupId,
        "Frog Squad II",
        key,
      );
      expect(replay).toEqual(renamed);
      expect(await renameEvents(groupId)).toHaveLength(1);

      // The same key for a different name is a conflict.
      await expect(
        rename(creator.userId, groupId, "Something Else", key),
      ).rejects.toBeInstanceOf(CommunicationIdempotencyConflictError);

      // A same-name request is a successful no-op: no version bump, no audit.
      const noOpKey = randomUUID();
      const noOp = await rename(
        creator.userId,
        groupId,
        "Frog Squad II",
        noOpKey,
      );
      expect(noOp).toMatchObject({
        name: "Frog Squad II",
        nameVersion: 2,
        updatedAt: renamed.updatedAt,
        changed: false,
      });
      expect(await renameEvents(groupId)).toHaveLength(1);

      const third = await rename(creator.userId, groupId, "蛙群 三");
      expect(third).toMatchObject({ name: "蛙群 三", nameVersion: 3 });

      // Replaying the earlier no-op key never reverts the later rename.
      const noOpReplay = await rename(
        creator.userId,
        groupId,
        "Frog Squad II",
        noOpKey,
      );
      expect(noOpReplay).toMatchObject({
        name: "蛙群 三",
        nameVersion: 3,
        changed: false,
      });
      expect(await groupRow(groupId)).toMatchObject({
        name: "蛙群 三",
        name_version: 3,
      });
      expect(await renameEvents(groupId)).toHaveLength(2);
    });

    it("refuses a member that is not the creator, a non-member, an unknown group, and a pending group", async () => {
      const creator = await createAccount();
      const member = await createAccount();
      const stranger = await createAccount();
      const groupId = await createGroupFixture(creator.userId, [member.userId]);

      await expect(
        rename(member.userId, groupId, "Hijacked"),
      ).rejects.toBeInstanceOf(CommunicationPermissionDeniedError);
      await expect(
        rename(stranger.userId, groupId, "Hijacked"),
      ).rejects.toBeInstanceOf(CommunicationNotFoundError);
      await expect(
        rename(creator.userId, randomUUID(), "Nowhere"),
      ).rejects.toBeInstanceOf(CommunicationNotFoundError);

      const pendingId = await createGroupFixture(
        creator.userId,
        [member.userId],
        { pending: true },
      );
      await expect(
        rename(creator.userId, pendingId, "Too Early"),
      ).rejects.toBeInstanceOf(CommunicationNotFoundError);

      // A refused command leaves no claim behind: the same key still works
      // for the creator afterwards would be a different owner, so only the
      // stored state is checked here.
      expect(await groupRow(groupId)).toMatchObject({
        name: "Frog Squad",
        name_version: 1,
      });
      expect(await renameEvents(groupId)).toHaveLength(0);
    });

    it("keeps every other column immutable and the name tied to a single version step", async () => {
      const creator = await createAccount();
      const member = await createAccount();
      const groupId = await createGroupFixture(creator.userId, [member.userId]);
      const rejected = [
        `update public.communication_groups set name = 'Sneaky' where group_id = $1`,
        `update public.communication_groups set name = 'Sneaky', name_version = name_version + 2 where group_id = $1`,
        `update public.communication_groups set name_version = name_version + 1 where group_id = $1`,
        `update public.communication_groups set name = 'Sneaky', name_version = name_version + 1, channel_state = 'cancelled' where group_id = $1`,
        `update public.communication_groups set stream_channel_id = 'loop_group_ffffffffffffffffffffffffffffffff' where group_id = $1`,
        `update public.communication_groups set create_operation_id = gen_random_uuid() where group_id = $1`,
        `update public.communication_groups set created_at = created_at - interval '1 day' where group_id = $1`,
        `update public.communication_groups set channel_state = 'cancelled' where group_id = $1`,
        `delete from public.communication_groups where group_id = $1`,
      ];
      for (const text of rejected) {
        await expect(
          pool.query({ text, values: [groupId] }),
          text,
        ).rejects.toThrow();
      }
      // The single rename step the guard admits.
      await pool.query({
        text: `update public.communication_groups set name = 'Direct', name_version = name_version + 1, updated_at = clock_timestamp() where group_id = $1`,
        values: [groupId],
      });
      expect(await groupRow(groupId)).toMatchObject({
        name: "Direct",
        name_version: 2,
      });

      // A pending group's name stays frozen even with a version step.
      const pendingId = await createGroupFixture(
        creator.userId,
        [member.userId],
        { pending: true },
      );
      await expect(
        pool.query({
          text: `update public.communication_groups set name = 'Early', name_version = 2 where group_id = $1`,
          values: [pendingId],
        }),
      ).rejects.toThrow(/rename is invalid/);
      // ...and its Decision 0025 activation still works.
      await pool.query({
        text: `update public.communication_groups set channel_state = 'active', updated_at = clock_timestamp() where group_id = $1`,
        values: [pendingId],
      });

      // The audit is append-only.
      await rename(creator.userId, groupId, "Audited");
      await expect(
        pool.query({
          text: `update public.communication_group_events set new_name = 'x' where group_id = $1`,
          values: [groupId],
        }),
      ).rejects.toThrow();
      await expect(
        pool.query({
          text: `delete from public.communication_group_events where group_id = $1`,
          values: [groupId],
        }),
      ).rejects.toThrow();

      // The Decision 0032 member trigger is untouched: the creator still
      // cannot be removed and roles still cannot change.
      await expect(
        pool.query({
          text: `delete from public.communication_group_members where group_id = $1 and member_role = 'creator'`,
          values: [groupId],
        }),
      ).rejects.toThrow();
      await expect(
        pool.query({
          text: `update public.communication_group_members set member_role = 'creator' where group_id = $1 and member_role = 'member'`,
          values: [groupId],
        }),
      ).rejects.toThrow();
    });
  });

  describe("admin community profile edit", () => {
    const boundAsset = "eip155:56:0x55d398326f99059ff775485246999027b3197955";

    function update(
      ownerUserId: string,
      communityId: string,
      values: UpdateCommunityInput["values"],
    ) {
      return community.updateCommunity({
        ownerUserId,
        communityId,
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "updateCommunity", [
          communityId,
          JSON.stringify(values),
        ]),
        requestId: randomUUID(),
        values,
      });
    }

    async function profileEditReasons(communityId: string) {
      const result = await pool.query<{ reason_code: string }>({
        text: `
          select reason_code from public.community_role_events
          where community_id = $1 and event_type = 'community_profile_updated'
          order by occurred_at
        `,
        values: [communityId],
      });
      return result.rows.map((row) => row.reason_code);
    }

    it("lets an admin edit name, description and logo, but only the owner change the bound token", async () => {
      const owner = await createAccount();
      const admin = await createAccount();
      const member = await createAccount();
      const communityId = await createCommunity(owner.userId);
      await joinCommunity(admin.userId, communityId);
      await joinCommunity(member.userId, communityId);
      await community.governMember({
        actorUserId: owner.userId,
        communityId,
        targetPublicProfileId: admin.publicProfileId,
        action: "assignAdmin",
        idempotencyKey: randomUUID(),
        requestSha256: commandDigest("community", "governMember", [
          communityId,
          admin.publicProfileId,
          "assignAdmin",
        ]),
        requestId: randomUUID(),
      });

      const edited = await update(admin.userId, communityId, {
        name: "Frog Holders DAO",
        description: "Run by admins too",
        logoRef: "avatar:preset/community-04",
      });
      expect(edited.community).toMatchObject({
        name: "Frog Holders DAO",
        description: "Run by admins too",
        logoRef: "avatar:preset/community-04",
        boundAssetKey: null,
      });

      // Sending the stored bound token back unchanged is not a change.
      await expect(
        update(admin.userId, communityId, {
          description: "Still fine",
          boundAssetKey: null,
        }),
      ).resolves.toMatchObject({ community: { description: "Still fine" } });

      // Changing it is owner-only, and nothing of the request is written.
      await expect(
        update(admin.userId, communityId, {
          description: "Should not land",
          boundAssetKey: boundAsset,
        }),
      ).rejects.toBeInstanceOf(CommunityOwnerOnlyFieldError);

      // Decision 0097: the owner's bound token must be a registry asset.
      await pool.query({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          )
          values (
            $1, 'eip155:56', '0x55d398326f99059ff775485246999027b3197955',
            'USDT', 'Tether USD', 18, 'pending', 'chain_call',
            122037728, now()
          )
          on conflict (asset_id) do nothing
        `,
        values: [boundAsset],
      });
      const ownerEdit = await update(owner.userId, communityId, {
        boundAssetKey: boundAsset,
      });
      expect(ownerEdit.community).toMatchObject({
        description: "Still fine",
        boundAssetKey: boundAsset,
      });

      // Clearing it is a change too.
      await expect(
        update(admin.userId, communityId, { boundAssetKey: null }),
      ).rejects.toBeInstanceOf(CommunityOwnerOnlyFieldError);

      // A plain member still has no edit right at all.
      const memberAttempt = update(member.userId, communityId, {
        name: "Mine now",
      });
      await expect(memberAttempt).rejects.toBeInstanceOf(
        CommunityPermissionDeniedError,
      );
      await expect(memberAttempt).rejects.not.toBeInstanceOf(
        CommunityOwnerOnlyFieldError,
      );

      expect(await profileEditReasons(communityId)).toEqual([
        "admin_profile_edit",
        "admin_profile_edit",
        "owner_profile_edit",
      ]);
    });
  });

  describe("voice-room title and live speaker preview", () => {
    async function verify(communityId: string): Promise<void> {
      await community.verifyCommunity({
        communityId,
        requestId: randomUUID(),
        reasonCode: "operator_verified",
      });
    }

    async function openRoom(
      hostUserId: string,
      communityId: string,
      title: string | null,
    ): Promise<string> {
      const record = await communication.createVoiceRoom({
        actorUserId: hostUserId,
        communityId,
        title,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest(
          "voiceRoomCreate",
          title === null ? [communityId] : [communityId, "title", title],
        ),
        requestId: randomUUID(),
      });
      await communication.recordVoiceRoomProvisioning({
        voiceRoomId: record.room.voiceRoomId,
        provisionState: "provisioned",
        errorCode: null,
        backstage: false,
      });
      return record.room.voiceRoomId;
    }

    async function joinAsSpeaker(
      hostUserId: string,
      voiceRoomId: string,
      speaker: { readonly userId: string; readonly publicProfileId: string },
      joinedAt: string,
    ): Promise<void> {
      await communication.joinVoiceRoom({
        actorUserId: speaker.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomJoin", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });
      await communication.inviteSpeaker({
        actorUserId: hostUserId,
        voiceRoomId,
        targetPublicProfileId: speaker.publicProfileId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomSpeakerInvite", [
          voiceRoomId,
          speaker.publicProfileId,
        ]),
        requestId: randomUUID(),
      });
      // Pin the join time so the preview order is deterministic.
      await pool.query({
        text: `
          update public.voice_room_members
          set joined_at = $3, updated_at = greatest(updated_at, $3::timestamptz)
          where voice_room_id = $1 and owner_user_id = $2
        `,
        values: [voiceRoomId, speaker.userId, joinedAt],
      });
    }

    it("stores the title, reads it back, and the database refuses an out-of-bound title", async () => {
      const owner = await createAccount();
      const communityId = await createCommunity(owner.userId);
      const voiceRoomId = await openRoom(owner.userId, communityId, "周五 AMA");
      const read = await communication.getVoiceRoom({
        voiceRoomId,
        viewerUserId: owner.userId,
      });
      expect(read.room.title).toBe("周五 AMA");

      for (const title of ["语".repeat(41), "", " padded "]) {
        await expect(
          pool.query({
            text: `update public.voice_rooms set title = $2 where voice_room_id = $1`,
            values: [voiceRoomId, title],
          }),
          JSON.stringify(title),
        ).rejects.toThrow(/voice_rooms_title_check/);
      }
      await pool.query({
        text: `update public.voice_rooms set title = $2 where voice_room_id = $1`,
        values: [voiceRoomId, "语".repeat(40)],
      });

      await communication.endVoiceRoom({
        actorUserId: owner.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomEnd", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });
      const untitledId = await openRoom(owner.userId, communityId, null);
      const untitled = await communication.getVoiceRoom({
        voiceRoomId: untitledId,
        viewerUserId: owner.userId,
      });
      expect(untitled.room.title).toBeNull();
      await communication.endVoiceRoom({
        actorUserId: owner.userId,
        voiceRoomId: untitledId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomEnd", [untitledId]),
        requestId: randomUUID(),
      });
    });

    it("lists the title and the first three joined speakers in join order, anonymous ones flagged", async () => {
      const host = await createAccount();
      const viewer = await createAccount();
      const communityId = await createCommunity(host.userId);
      await verify(communityId);
      const speakers = [
        await createAccount(),
        await createAccount(),
        await createAccount(),
        await createAccount(),
      ];
      const listener = await createAccount();
      for (const account of [viewer, listener, ...speakers]) {
        await joinCommunity(account.userId, communityId);
      }
      // The second speaker (by join time) is anonymous.
      await pool.query({
        text: `insert into public.privacy_preferences_v2 (owner_user_id, anonymous_mode) values ($1, true)`,
        values: [speakers[1]!.userId],
      });
      const voiceRoomId = await openRoom(host.userId, communityId, "Frog AMA");
      // Joined out of order; the preview sorts by join time.
      await joinAsSpeaker(
        host.userId,
        voiceRoomId,
        speakers[2]!,
        "2026-10-08T03:00:03.000Z",
      );
      await joinAsSpeaker(
        host.userId,
        voiceRoomId,
        speakers[0]!,
        "2026-10-08T03:00:01.000Z",
      );
      await joinAsSpeaker(
        host.userId,
        voiceRoomId,
        speakers[3]!,
        "2026-10-08T03:00:04.000Z",
      );
      await joinAsSpeaker(
        host.userId,
        voiceRoomId,
        speakers[1]!,
        "2026-10-08T03:00:02.000Z",
      );
      await communication.joinVoiceRoom({
        actorUserId: listener.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomJoin", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });

      const rows = await communication.listLiveVoiceRooms({
        viewerUserId: viewer.userId,
        limit: 50,
      });
      const row = rows.find(
        (candidate) => candidate.voiceRoomId === voiceRoomId,
      );
      expect(row).toBeDefined();
      expect(row?.title).toBe("Frog AMA");
      expect(row?.host.ownerUserId).toBe(host.userId);
      expect(row?.speakerCount).toBe(4);
      expect(row?.listenerCount).toBe(1);
      expect(row?.speakers.map((speaker) => speaker.ownerUserId)).toEqual([
        speakers[0]!.userId,
        speakers[1]!.userId,
        speakers[2]!.userId,
      ]);
      expect(row?.speakers.map((speaker) => speaker.anonymousMode)).toEqual([
        false,
        true,
        false,
      ]);
      expect(row?.speakers[0]).toMatchObject({
        publicProfileId: speakers[0]!.publicProfileId,
        alias: expect.stringMatching(/^member_/) as string,
        avatarRef: null,
      });

      // A speaker who leaves drops out of the preview; the fourth moves in.
      await communication.leaveVoiceRoom({
        actorUserId: speakers[0]!.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomLeave", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });
      const after = await communication.listLiveVoiceRooms({
        viewerUserId: viewer.userId,
        limit: 50,
      });
      expect(
        after
          .find((candidate) => candidate.voiceRoomId === voiceRoomId)
          ?.speakers.map((speaker) => speaker.ownerUserId),
      ).toEqual([
        speakers[1]!.userId,
        speakers[2]!.userId,
        speakers[3]!.userId,
      ]);
    });
    it("lets a speaker step down to listener, refuses the host, and no-ops for a listener", async () => {
      const host = await createAccount();
      const speaker = await createAccount();
      const listener = await createAccount();
      const communityId = await createCommunity(host.userId);
      await joinCommunity(speaker.userId, communityId);
      await joinCommunity(listener.userId, communityId);
      await pool.query({
        text: `update public.user_profiles set avatar_ref = 'avatar:preset/people-02' where owner_user_id = $1`,
        values: [speaker.userId],
      });
      const voiceRoomId = await openRoom(host.userId, communityId, null);
      await joinAsSpeaker(
        host.userId,
        voiceRoomId,
        speaker,
        "2026-10-08T03:00:01.000Z",
      );
      await communication.joinVoiceRoom({
        actorUserId: listener.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomJoin", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });

      // The room record carries the host identity for the resource.
      const viewed = await communication.getVoiceRoom({
        voiceRoomId,
        viewerUserId: listener.userId,
      });
      expect(viewed.host).toMatchObject({
        ownerUserId: host.userId,
        publicProfileId: host.publicProfileId,
        anonymousMode: false,
      });

      // The roster carries the stored avatar ref.
      const speakersPage = await communication.listVoiceRoomMembers({
        voiceRoomId,
        viewerUserId: listener.userId,
        role: "speaker",
        limit: 10,
      });
      expect(speakersPage.items.map((row) => row.avatarRef)).toEqual([
        "avatar:preset/people-02",
      ]);

      const stepDown = (actorUserId: string, key: string = randomUUID()) =>
        communication.stepDownSpeaker({
          actorUserId,
          voiceRoomId,
          idempotencyKey: key,
          requestSha256: communicationCommandDigest(
            "voiceRoomSpeakerStepDown",
            [voiceRoomId],
          ),
          requestId: randomUUID(),
        });

      await expect(stepDown(host.userId)).rejects.toBeInstanceOf(
        CommunicationPermissionDeniedError,
      );
      const listenerNoOp = await stepDown(listener.userId);
      expect(listenerNoOp.outcome).toBe("no_op");

      const key = randomUUID();
      const stepped = await stepDown(speaker.userId, key);
      expect(stepped).toMatchObject({
        outcome: "stepped_down",
        viewerRole: "listener",
        speakerCount: 0,
        listenerCount: 2,
        callerStreamUserId: `loop_${speaker.userId.replaceAll("-", "")}`,
      });
      const replay = await stepDown(speaker.userId, key);
      expect(replay.outcome).toBe("stepped_down");
      const again = await stepDown(speaker.userId);
      expect(again.outcome).toBe("no_op");

      const events = await pool.query<Record<string, unknown>>({
        text: `
          select event_type, from_role, to_role, reason_code
          from public.voice_room_events
          where voice_room_id = $1 and event_type = 'speaker_stepped_down'
        `,
        values: [voiceRoomId],
      });
      expect(events.rows).toEqual([
        {
          event_type: "speaker_stepped_down",
          from_role: "speaker",
          to_role: "listener",
          reason_code: "self_step_down",
        },
      ]);
      const member = await pool.query<{ role: string; muted_at: unknown }>({
        text: `select role, muted_at from public.voice_room_members where voice_room_id = $1 and owner_user_id = $2`,
        values: [voiceRoomId, speaker.userId],
      });
      expect(member.rows[0]).toEqual({ role: "listener", muted_at: null });

      await communication.endVoiceRoom({
        actorUserId: host.userId,
        voiceRoomId,
        idempotencyKey: randomUUID(),
        requestSha256: communicationCommandDigest("voiceRoomEnd", [
          voiceRoomId,
        ]),
        requestId: randomUUID(),
      });
      await expect(stepDown(speaker.userId)).rejects.toBeInstanceOf(
        CommunicationDataStaleError,
      );
    });
  });
});
