import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import {
  communicationCommandDigestVersion,
  communicationCommandIdempotencyScope,
  communityChannelMemberStates,
  communityChannelStates,
  deriveVoiceCallId,
  handRaiseStates,
  voiceRoomProvisionStates,
  voiceRoomRoles,
  voiceRoomStates,
  type CommunityChannelMemberState,
  type CommunityChannelState,
  type VoiceRoomProvisionState,
  type VoiceRoomRole,
} from "../features/communication/communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationIdempotencyConflictError,
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  CommunicationProfileRequiredError,
  CommunicationRepositoryUnavailableError,
  CommunicationResourceConflictError,
  type CommunicationRepository,
  type CommunityChannelSyncJobRecord,
  type CommunityChannelSyncRepository,
  type ChatGroupLeavePreparation,
  type CommunityChannelViewerRecord,
  type CreateVoiceRoomInput,
  type HandRaiseQueueEntryRecord,
  type VoiceRoomCommandInput,
  type VoiceRoomIdentity,
  type VoiceRoomRecord,
  type VoiceRoomTargetCommandInput,
  type VoiceRoomTargetRecord,
  type VoiceRoomViewerRecord,
} from "../features/communication/communication-repository.js";
import { generateOpaqueId } from "../core/ids/opaque-id.js";
import { deriveStreamUserId } from "../features/identity/loop-identifiers.js";

interface DatabaseClient {
  query<Row extends Record<string, unknown>>(config: {
    text: string;
    values?: unknown[];
  }): Promise<QueryResult<Row>>;
}

const userIdSchema = z.string().uuid();
const opaqueIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const publicProfileIdSchema = z.string().uuid();
const uuidV4Schema = opaqueIdSchema;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateSchema = z.date();
const loopIdSchema = z.string().min(1).max(64);
const limitSchema = z.number().int().min(1).max(100);

const voiceRoomColumns = `
  room.voice_room_id,
  room.community_id,
  room.call_id,
  room.state,
  room.provision_state,
  room.backstage,
  room.created_at,
  room.ended_at
`;

const identityColumns = `
  profile.public_profile_id,
  account.loop_id,
  profile.alias,
  profile.avatar_ref
`;

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505" &&
    (constraint === undefined || candidate.constraint === constraint)
  );
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof CommunicationDataStaleError ||
    error instanceof CommunicationIdempotencyConflictError ||
    error instanceof CommunicationNotFoundError ||
    error instanceof CommunicationPermissionDeniedError ||
    error instanceof CommunicationProfileRequiredError ||
    error instanceof CommunicationRepositoryUnavailableError ||
    error instanceof CommunicationResourceConflictError
  ) {
    throw error;
  }
  if (isUniqueViolation(error, "voice_rooms_one_live_per_community_idx")) {
    throw new CommunicationResourceConflictError();
  }
  throw new CommunicationRepositoryUnavailableError();
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new CommunicationRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claim the durable idempotency record. The same key with a different owner or
 * canonical digest returns no row (IDEMPOTENCY_CONFLICT); an identical replay
 * returns the same record ID so the caller finds its original audit row.
 */
async function claimCommand(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<string> {
  const claimed = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, 'client', $4, $5)
      on conflict (scope, idempotency_key)
      do update set last_seen_at = clock_timestamp()
      where idempotency_records.owner_user_id = excluded.owner_user_id
        and idempotency_records.key_source = excluded.key_source
        and idempotency_records.request_sha256 = excluded.request_sha256
        and idempotency_records.digest_version = excluded.digest_version
      returning id
    `,
    values: [
      input.ownerUserId,
      communicationCommandIdempotencyScope,
      input.idempotencyKey,
      input.requestSha256,
      communicationCommandDigestVersion,
    ],
  });
  const id = claimed.rows[0]?.id;
  if (id === undefined) {
    throw new CommunicationIdempotencyConflictError();
  }
  return id;
}

async function findVoiceRoomAudit(
  client: DatabaseClient,
  idempotencyRecordId: string,
): Promise<{ readonly voiceRoomId: string } | null> {
  const result = await client.query<{ voice_room_id: string }>({
    text: `
      select voice_room_id
      from public.voice_room_events
      where idempotency_record_id = $1
      limit 1
    `,
    values: [idempotencyRecordId],
  });
  const row = result.rows[0];
  return row === undefined
    ? null
    : Object.freeze({ voiceRoomId: opaqueIdSchema.parse(row.voice_room_id) });
}

async function appendVoiceRoomAudit(
  client: DatabaseClient,
  input: {
    readonly voiceRoomId: string;
    readonly actorUserId: string | null;
    readonly targetUserId: string | null;
    readonly eventType: string;
    readonly fromRole?: VoiceRoomRole | null;
    readonly toRole?: VoiceRoomRole | null;
    readonly reasonCode?: string | null;
    readonly idempotencyRecordId: string | null;
    readonly requestId: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.voice_room_events (
        voice_room_id,
        actor_user_id,
        target_user_id,
        event_type,
        from_role,
        to_role,
        reason_code,
        idempotency_record_id,
        request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    values: [
      input.voiceRoomId,
      input.actorUserId,
      input.targetUserId,
      input.eventType,
      input.fromRole ?? null,
      input.toRole ?? null,
      input.reasonCode ?? null,
      input.idempotencyRecordId,
      input.requestId,
    ],
  });
}

async function requireActiveProfile(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<string> {
  const result = await client.query<{ public_profile_id: string }>({
    text: `
      select public_profile_id
      from public.user_profiles
      where owner_user_id = $1 and profile_status = 'active'
      limit 1
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunicationProfileRequiredError();
  }
  return publicProfileIdSchema.parse(row.public_profile_id);
}

/** Non-banned membership is the read and join predicate for a community. */
async function requireCommunityStanding(
  client: DatabaseClient,
  communityId: string,
  ownerUserId: string,
): Promise<"owner" | "admin" | "member"> {
  const result = await client.query<{ role: string; status: string }>({
    text: `
      select role, status
      from public.community_memberships
      where community_id = $1 and owner_user_id = $2
      limit 1
    `,
    values: [communityId, ownerUserId],
  });
  const row = result.rows[0];
  if (row === undefined || row.status === "banned") {
    throw new CommunicationPermissionDeniedError();
  }
  const role = z.enum(["owner", "admin", "member"]).parse(row.role);
  return role;
}

function toVoiceRoomRecord(value: Record<string, unknown>): VoiceRoomRecord {
  return Object.freeze({
    voiceRoomId: opaqueIdSchema.parse(value["voice_room_id"]),
    communityId: opaqueIdSchema.parse(value["community_id"]),
    callId: z
      .string()
      .regex(/^loop_voice_[0-9a-f]{32}$/)
      .parse(value["call_id"]),
    state: z.enum(voiceRoomStates).parse(value["state"]),
    provisionState: z
      .enum(voiceRoomProvisionStates)
      .parse(value["provision_state"]),
    backstage: z.boolean().parse(value["backstage"]),
    createdAt: dateSchema.parse(value["created_at"]).toISOString(),
    endedAt:
      value["ended_at"] === null
        ? null
        : dateSchema.parse(value["ended_at"]).toISOString(),
  });
}

function toIdentity(value: Record<string, unknown>): VoiceRoomIdentity {
  return Object.freeze({
    publicProfileId: publicProfileIdSchema.parse(value["public_profile_id"]),
    loopId: loopIdSchema.parse(value["loop_id"]),
    alias: value["alias"] === null ? null : z.string().parse(value["alias"]),
    avatarRef:
      value["avatar_ref"] === null
        ? null
        : z.string().parse(value["avatar_ref"]),
  });
}

async function readVoiceRoom(
  client: DatabaseClient,
  voiceRoomId: string,
  forUpdate = false,
): Promise<VoiceRoomRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${voiceRoomColumns}
      from public.voice_rooms as room
      where room.voice_room_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [voiceRoomId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunicationNotFoundError();
  }
  return toVoiceRoomRecord(row);
}

async function readViewerRecord(
  client: DatabaseClient,
  room: VoiceRoomRecord,
  viewerUserId: string,
): Promise<VoiceRoomViewerRecord> {
  const memberRow = await client.query<{ role: string; state: string }>({
    text: `
      select role, state
      from public.voice_room_members
      where voice_room_id = $1 and owner_user_id = $2
      limit 1
    `,
    values: [room.voiceRoomId, viewerUserId],
  });
  const member = memberRow.rows[0];
  const viewerRole =
    member === undefined || member.state !== "joined"
      ? null
      : z.enum(voiceRoomRoles).parse(member.role);

  const handRaiseRow = await client.query<{
    hand_raise_id: string;
    sequence: string;
    state: string;
    created_at: Date;
  }>({
    text: `
      select hand_raise_id, sequence::text as sequence, state, created_at
      from public.voice_room_hand_raises
      where voice_room_id = $1 and owner_user_id = $2
      order by sequence desc
      limit 1
    `,
    values: [room.voiceRoomId, viewerUserId],
  });
  const handRaise = handRaiseRow.rows[0];

  const hostRow = await client.query<{ owner_user_id: string }>({
    text: `
      select owner_user_id
      from public.voice_room_members
      where voice_room_id = $1 and role = 'host'
      limit 1
    `,
    values: [room.voiceRoomId],
  });
  const hostUserId = hostRow.rows[0]?.owner_user_id;
  if (hostUserId === undefined) {
    throw new CommunicationRepositoryUnavailableError();
  }

  const counts = await client.query<{ role: string; total: string }>({
    text: `
      select role, count(*)::text as total
      from public.voice_room_members
      where voice_room_id = $1 and state = 'joined'
      group by role
    `,
    values: [room.voiceRoomId],
  });
  let speakerCount = 0;
  let listenerCount = 0;
  for (const row of counts.rows) {
    const total = Number.parseInt(row.total, 10);
    if (row.role === "speaker") {
      speakerCount = total;
    } else if (row.role === "listener") {
      listenerCount = total;
    }
  }

  return Object.freeze({
    room,
    viewerRole,
    viewerHandRaise:
      handRaise === undefined
        ? null
        : Object.freeze({
            handRaiseId: opaqueIdSchema.parse(handRaise.hand_raise_id),
            sequence: handRaise.sequence,
            state: z.enum(handRaiseStates).parse(handRaise.state),
            createdAt: dateSchema.parse(handRaise.created_at).toISOString(),
          }),
    hostStreamUserId: deriveStreamUserId(userIdSchema.parse(hostUserId)),
    speakerCount,
    listenerCount,
  });
}

async function requireLiveRoom(
  client: DatabaseClient,
  voiceRoomId: string,
): Promise<VoiceRoomRecord> {
  const room = await readVoiceRoom(client, voiceRoomId, true);
  if (room.state !== "live") {
    throw new CommunicationDataStaleError();
  }
  return room;
}

async function requireHost(
  client: DatabaseClient,
  voiceRoomId: string,
  actorUserId: string,
): Promise<void> {
  const result = await client.query<{ role: string; state: string }>({
    text: `
      select role, state
      from public.voice_room_members
      where voice_room_id = $1 and owner_user_id = $2
      limit 1
    `,
    values: [voiceRoomId, actorUserId],
  });
  const row = result.rows[0];
  if (row === undefined || row.role !== "host" || row.state !== "joined") {
    throw new CommunicationPermissionDeniedError();
  }
}

async function resolveTarget(
  client: DatabaseClient,
  targetPublicProfileId: string,
): Promise<{ userId: string; profile: VoiceRoomIdentity }> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select profile.owner_user_id, ${identityColumns}
      from public.user_profiles as profile
      join public.loop_users as account
        on account.id = profile.owner_user_id
      where profile.public_profile_id = $1
        and profile.profile_status = 'active'
      limit 1
    `,
    values: [targetPublicProfileId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunicationNotFoundError();
  }
  return {
    userId: userIdSchema.parse(row["owner_user_id"]),
    profile: toIdentity(row),
  };
}

export function createPostgresCommunicationRepository(
  pool: Pool,
): CommunicationRepository {
  async function targetCommand(
    rawInput: VoiceRoomTargetCommandInput,
    action: "invite" | "remove",
  ): Promise<VoiceRoomTargetRecord> {
    const actorUserId = userIdSchema.parse(rawInput.actorUserId);
    const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
    const targetPublicProfileId = publicProfileIdSchema.parse(
      rawInput.targetPublicProfileId,
    );
    const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
    const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
    const requestId = uuidV4Schema.parse(rawInput.requestId);
    return await withTransaction(pool, async (client) => {
      const recordId = await claimCommand(client, {
        ownerUserId: actorUserId,
        idempotencyKey,
        requestSha256,
      });
      const target = await resolveTarget(client, targetPublicProfileId);
      if ((await findVoiceRoomAudit(client, recordId)) !== null) {
        const room = await readVoiceRoom(client, voiceRoomId);
        const memberRow = await client.query<{ role: string }>({
          text: `
            select role from public.voice_room_members
            where voice_room_id = $1 and owner_user_id = $2 limit 1
          `,
          values: [voiceRoomId, target.userId],
        });
        return Object.freeze({
          room: await readViewerRecord(client, room, actorUserId),
          targetStreamUserId: deriveStreamUserId(target.userId),
          targetRole:
            memberRow.rows[0] === undefined
              ? "listener"
              : z.enum(voiceRoomRoles).parse(memberRow.rows[0].role),
          profile: target.profile,
        });
      }
      const room = await requireLiveRoom(client, voiceRoomId);
      await requireHost(client, voiceRoomId, actorUserId);
      if (target.userId === actorUserId) {
        throw new CommunicationPermissionDeniedError();
      }
      const currentRow = await client.query<{ role: string; state: string }>({
        text: `
          select role, state from public.voice_room_members
          where voice_room_id = $1 and owner_user_id = $2 limit 1
          for update
        `,
        values: [voiceRoomId, target.userId],
      });
      const current = currentRow.rows[0];
      if (current === undefined || current.state !== "joined") {
        throw new CommunicationDataStaleError();
      }
      const fromRole = z.enum(voiceRoomRoles).parse(current.role);
      if (fromRole === "host") {
        throw new CommunicationPermissionDeniedError();
      }
      const toRole: VoiceRoomRole =
        action === "invite" ? "speaker" : "listener";
      if (fromRole === toRole) {
        throw new CommunicationDataStaleError();
      }
      await client.query({
        text: `
          update public.voice_room_members
          set role = $3, updated_at = clock_timestamp()
          where voice_room_id = $1 and owner_user_id = $2
        `,
        values: [voiceRoomId, target.userId, toRole],
      });
      if (action === "invite") {
        await client.query({
          text: `
            update public.voice_room_hand_raises
            set state = 'invited', updated_at = clock_timestamp()
            where voice_room_id = $1 and owner_user_id = $2 and state = 'pending'
          `,
          values: [voiceRoomId, target.userId],
        });
      }
      await appendVoiceRoomAudit(client, {
        voiceRoomId,
        actorUserId,
        targetUserId: target.userId,
        eventType: action === "invite" ? "speaker_invited" : "speaker_removed",
        fromRole,
        toRole,
        idempotencyRecordId: recordId,
        requestId,
      });
      return Object.freeze({
        room: await readViewerRecord(client, room, actorUserId),
        targetStreamUserId: deriveStreamUserId(target.userId),
        targetRole: toRole,
        profile: target.profile,
      });
    });
  }

  return Object.freeze({
    async readCommunityChannel(rawInput: {
      readonly communityId: string;
      readonly viewerUserId: string;
    }): Promise<CommunityChannelViewerRecord> {
      try {
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              channel.stream_channel_id,
              channel.state,
              channel.member_cap,
              (channel.provisioned_at is not null) as provisioned,
              member.state as member_state,
              (
                membership.owner_user_id is not null
                and membership.status <> 'banned'
              ) as community_member,
              room.voice_room_id as current_voice_room_id,
              (room.provision_state = 'provisioned')
                as current_voice_room_provisioned
            from public.communities as community
            left join public.community_channels as channel
              on channel.community_id = community.community_id
            left join public.community_channel_members as member
              on member.community_id = community.community_id
              and member.owner_user_id = $2
            left join public.community_memberships as membership
              on membership.community_id = community.community_id
              and membership.owner_user_id = $2
            left join public.voice_rooms as room
              on room.community_id = community.community_id
              and room.state = 'live'
            where community.community_id = $1
            limit 1
          `,
          values: [communityId, viewerUserId],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new CommunicationNotFoundError();
        }
        return Object.freeze({
          channel:
            row["stream_channel_id"] === null
              ? null
              : Object.freeze({
                  communityId,
                  streamChannelId: z
                    .string()
                    .regex(/^loop_community_[0-9a-f]{32}$/)
                    .parse(row["stream_channel_id"]),
                  state: z.enum(communityChannelStates).parse(row["state"]),
                  memberCap: z.number().int().parse(row["member_cap"]),
                  provisioned: z.boolean().parse(row["provisioned"]),
                }),
          viewerMemberState:
            row["member_state"] === null || row["member_state"] === undefined
              ? null
              : z.enum(communityChannelMemberStates).parse(row["member_state"]),
          viewerIsCommunityMember: row["community_member"] === true,
          currentVoiceRoomId:
            row["current_voice_room_id"] === null ||
            row["current_voice_room_id"] === undefined
              ? null
              : opaqueIdSchema.parse(row["current_voice_room_id"]),
          currentVoiceRoomProvisioned:
            row["current_voice_room_provisioned"] === true,
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async createVoiceRoom(
      rawInput: CreateVoiceRoomInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findVoiceRoomAudit(client, recordId);
          if (replay !== null) {
            const room = await readVoiceRoom(client, replay.voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          await requireActiveProfile(client, actorUserId);
          const role = await requireCommunityStanding(
            client,
            communityId,
            actorUserId,
          );
          if (role !== "owner" && role !== "admin") {
            throw new CommunicationPermissionDeniedError();
          }
          // Serialize concurrent creation on the community row so the partial
          // unique index cannot be raced into an ambiguous provider state.
          await client.query({
            text: `select community_id from public.communities where community_id = $1 for update`,
            values: [communityId],
          });
          const existing = await client.query<{ voice_room_id: string }>({
            text: `
              select voice_room_id from public.voice_rooms
              where community_id = $1 and state = 'live' limit 1
            `,
            values: [communityId],
          });
          if (existing.rows[0] !== undefined) {
            throw new CommunicationResourceConflictError();
          }
          // The call ID is a pure function of the opaque room ID, so a lost
          // response can never allocate a second Stream call for one room.
          const voiceRoomId = generateOpaqueId();
          const inserted = await client.query<Record<string, unknown>>({
            text: `
              insert into public.voice_rooms (
                voice_room_id, community_id, call_id, created_by_user_id
              )
              values ($1, $2, $3, $4)
              returning
                voice_room_id,
                community_id,
                call_id,
                state,
                provision_state,
                backstage,
                created_at,
                ended_at
            `,
            values: [
              voiceRoomId,
              communityId,
              deriveVoiceCallId(voiceRoomId),
              actorUserId,
            ],
          });
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new CommunicationRepositoryUnavailableError();
          }
          const room = toVoiceRoomRecord(row);
          await client.query({
            text: `
              insert into public.voice_room_members (
                voice_room_id, owner_user_id, role, state
              )
              values ($1, $2, 'host', 'joined')
            `,
            values: [room.voiceRoomId, actorUserId],
          });
          await appendVoiceRoomAudit(client, {
            voiceRoomId: room.voiceRoomId,
            actorUserId,
            targetUserId: actorUserId,
            eventType: "room_created",
            toRole: "host",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async recordVoiceRoomProvisioning(rawInput: {
      readonly voiceRoomId: string;
      readonly provisionState: VoiceRoomProvisionState;
      readonly errorCode: string | null;
    }): Promise<VoiceRoomRecord> {
      try {
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const provisionState = z
          .enum(voiceRoomProvisionStates)
          .parse(rawInput.provisionState);
        const errorCode =
          rawInput.errorCode === null
            ? null
            : z
                .string()
                .regex(/^[a-z][a-z0-9_]{0,63}$/)
                .parse(rawInput.errorCode);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            update public.voice_rooms as room
            set
              provision_state = $2,
              last_error_code = $3,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where room.voice_room_id = $1
            returning ${voiceRoomColumns}
          `,
          values: [voiceRoomId, provisionState, errorCode],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new CommunicationNotFoundError();
        }
        return toVoiceRoomRecord(row);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getCurrentVoiceRoom(rawInput: {
      readonly communityId: string;
      readonly viewerUserId: string;
    }): Promise<VoiceRoomViewerRecord | null> {
      try {
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        return await withTransaction(pool, async (client) => {
          await requireCommunityStanding(client, communityId, viewerUserId);
          const result = await client.query<Record<string, unknown>>({
            text: `
              select ${voiceRoomColumns}
              from public.voice_rooms as room
              where room.community_id = $1 and room.state = 'live'
              limit 1
            `,
            values: [communityId],
          });
          const row = result.rows[0];
          if (row === undefined) {
            return null;
          }
          return readViewerRecord(client, toVoiceRoomRecord(row), viewerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getVoiceRoom(rawInput: {
      readonly voiceRoomId: string;
      readonly viewerUserId: string;
    }): Promise<VoiceRoomViewerRecord> {
      try {
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        return await withTransaction(pool, async (client) => {
          const room = await readVoiceRoom(client, voiceRoomId);
          await requireCommunityStanding(
            client,
            room.communityId,
            viewerUserId,
          );
          return readViewerRecord(client, room, viewerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async joinVoiceRoom(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          const room = await requireLiveRoom(client, voiceRoomId);
          await requireActiveProfile(client, actorUserId);
          await requireCommunityStanding(client, room.communityId, actorUserId);
          // Join is idempotent: an existing member keeps its current role and
          // the command reports that role instead of failing.
          const inserted = await client.query<{ role: string }>({
            text: `
              insert into public.voice_room_members (
                voice_room_id, owner_user_id, role, state
              )
              values ($1, $2, 'listener', 'joined')
              on conflict (voice_room_id, owner_user_id) do update
              set state = 'joined', updated_at = clock_timestamp()
              returning role
            `,
            values: [voiceRoomId, actorUserId],
          });
          const role = z.enum(voiceRoomRoles).parse(inserted.rows[0]?.role);
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: actorUserId,
            eventType: "member_joined",
            toRole: role,
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async leaveVoiceRoom(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          const room = await requireLiveRoom(client, voiceRoomId);
          const currentRow = await client.query<{
            role: string;
            state: string;
          }>({
            text: `
                select role, state from public.voice_room_members
                where voice_room_id = $1 and owner_user_id = $2 limit 1
                for update
              `,
            values: [voiceRoomId, actorUserId],
          });
          const current = currentRow.rows[0];
          if (current === undefined || current.state !== "joined") {
            throw new CommunicationDataStaleError();
          }
          if (current.role === "host") {
            // The host owns the room lifecycle; it ends the room instead.
            throw new CommunicationPermissionDeniedError();
          }
          await client.query({
            text: `
              update public.voice_room_members
              set state = 'left', role = 'listener', updated_at = clock_timestamp()
              where voice_room_id = $1 and owner_user_id = $2
            `,
            values: [voiceRoomId, actorUserId],
          });
          await client.query({
            text: `
              update public.voice_room_hand_raises
              set state = 'cancelled', updated_at = clock_timestamp()
              where voice_room_id = $1 and owner_user_id = $2 and state = 'pending'
            `,
            values: [voiceRoomId, actorUserId],
          });
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: actorUserId,
            eventType: "member_left",
            fromRole: z.enum(voiceRoomRoles).parse(current.role),
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async raiseHand(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          // The sequence is allocated under the voice_rooms row lock, so
          // concurrent raises get a stable total order with no gaps.
          const room = await requireLiveRoom(client, voiceRoomId);
          const memberRow = await client.query<{ role: string; state: string }>(
            {
              text: `
              select role, state from public.voice_room_members
              where voice_room_id = $1 and owner_user_id = $2 limit 1
            `,
              values: [voiceRoomId, actorUserId],
            },
          );
          const member = memberRow.rows[0];
          if (member === undefined || member.state !== "joined") {
            throw new CommunicationDataStaleError();
          }
          if (member.role !== "listener") {
            throw new CommunicationDataStaleError();
          }
          const pending = await client.query<{ hand_raise_id: string }>({
            text: `
              select hand_raise_id from public.voice_room_hand_raises
              where voice_room_id = $1 and owner_user_id = $2 and state = 'pending'
              limit 1
            `,
            values: [voiceRoomId, actorUserId],
          });
          if (pending.rows[0] !== undefined) {
            throw new CommunicationDataStaleError();
          }
          const sequenceRow = await client.query<{
            hand_raise_sequence: string;
          }>({
            text: `
                update public.voice_rooms
                set
                  hand_raise_sequence = hand_raise_sequence + 1,
                  updated_at = clock_timestamp()
                where voice_room_id = $1
                returning hand_raise_sequence::text as hand_raise_sequence
              `,
            values: [voiceRoomId],
          });
          const sequence = sequenceRow.rows[0]?.hand_raise_sequence;
          if (sequence === undefined) {
            throw new CommunicationRepositoryUnavailableError();
          }
          await client.query({
            text: `
              insert into public.voice_room_hand_raises (
                voice_room_id, owner_user_id, sequence, state
              )
              values ($1, $2, $3::bigint, 'pending')
            `,
            values: [voiceRoomId, actorUserId, sequence],
          });
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: actorUserId,
            eventType: "hand_raised",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async cancelHandRaise(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          const room = await requireLiveRoom(client, voiceRoomId);
          const cancelled = await client.query({
            text: `
              update public.voice_room_hand_raises
              set state = 'cancelled', updated_at = clock_timestamp()
              where voice_room_id = $1 and owner_user_id = $2 and state = 'pending'
            `,
            values: [voiceRoomId, actorUserId],
          });
          if (cancelled.rowCount === 0) {
            throw new CommunicationDataStaleError();
          }
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: actorUserId,
            eventType: "hand_raise_cancelled",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listHandRaises(rawInput: {
      readonly voiceRoomId: string;
      readonly viewerUserId: string;
      readonly limit: number;
    }): Promise<readonly HandRaiseQueueEntryRecord[]> {
      try {
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        return await withTransaction(pool, async (client) => {
          const room = await readVoiceRoom(client, voiceRoomId);
          await requireCommunityStanding(
            client,
            room.communityId,
            viewerUserId,
          );
          const result = await client.query<Record<string, unknown>>({
            text: `
              select
                raise.hand_raise_id,
                raise.sequence::text as sequence,
                raise.state,
                raise.created_at,
                ${identityColumns}
              from public.voice_room_hand_raises as raise
              join public.user_profiles as profile
                on profile.owner_user_id = raise.owner_user_id
              join public.loop_users as account
                on account.id = raise.owner_user_id
              where raise.voice_room_id = $1 and raise.state = 'pending'
              order by raise.sequence asc
              limit $2
            `,
            values: [voiceRoomId, limit],
          });
          return Object.freeze(
            result.rows.map((row) =>
              Object.freeze({
                handRaiseId: opaqueIdSchema.parse(row["hand_raise_id"]),
                sequence: z.string().parse(row["sequence"]),
                state: z.enum(handRaiseStates).parse(row["state"]),
                createdAt: dateSchema.parse(row["created_at"]).toISOString(),
                profile: toIdentity(row),
              }),
            ),
          );
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    inviteSpeaker(
      rawInput: VoiceRoomTargetCommandInput,
    ): Promise<VoiceRoomTargetRecord> {
      return targetCommand(rawInput, "invite").catch(translateRepositoryError);
    },

    removeSpeaker(
      rawInput: VoiceRoomTargetCommandInput,
    ): Promise<VoiceRoomTargetRecord> {
      return targetCommand(rawInput, "remove").catch(translateRepositoryError);
    },

    async recordMuteAll(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          const room = await requireLiveRoom(client, voiceRoomId);
          await requireHost(client, voiceRoomId, actorUserId);
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: null,
            eventType: "muted_all",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, room, actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async endVoiceRoom(
      rawInput: VoiceRoomCommandInput,
    ): Promise<VoiceRoomViewerRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const voiceRoomId = opaqueIdSchema.parse(rawInput.voiceRoomId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findVoiceRoomAudit(client, recordId)) !== null) {
            const room = await readVoiceRoom(client, voiceRoomId);
            return readViewerRecord(client, room, actorUserId);
          }
          await requireLiveRoom(client, voiceRoomId);
          await requireHost(client, voiceRoomId, actorUserId);
          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.voice_rooms as room
              set
                state = 'ended',
                ended_at = clock_timestamp(),
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where room.voice_room_id = $1 and room.state = 'live'
              returning ${voiceRoomColumns}
            `,
            values: [voiceRoomId],
          });
          const row = updated.rows[0];
          if (row === undefined) {
            throw new CommunicationDataStaleError();
          }
          await client.query({
            text: `
              update public.voice_room_hand_raises
              set state = 'cancelled', updated_at = clock_timestamp()
              where voice_room_id = $1 and state = 'pending'
            `,
            values: [voiceRoomId],
          });
          await appendVoiceRoomAudit(client, {
            voiceRoomId,
            actorUserId,
            targetUserId: null,
            eventType: "room_ended",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readViewerRecord(client, toVoiceRoomRecord(row), actorUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async prepareChatGroupLeave(rawInput: {
      readonly actorUserId: string;
      readonly groupId: string;
    }): Promise<ChatGroupLeavePreparation> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const groupId = opaqueIdSchema.parse(rawInput.groupId);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              groups.stream_channel_id,
              creator.owner_user_id as creator_user_id,
              self.member_role as self_role
            from public.communication_groups as groups
            join public.communication_group_members as creator
              on creator.group_id = groups.group_id
              and creator.member_role = 'creator'
            left join public.communication_group_members as self
              on self.group_id = groups.group_id
              and self.owner_user_id = $2
            where groups.group_id = $1
              and groups.channel_kind = 'group'
              and groups.channel_state = 'active'
            limit 1
          `,
          values: [groupId, actorUserId],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new CommunicationNotFoundError();
        }
        if (row["self_role"] === null || row["self_role"] === undefined) {
          throw new CommunicationDataStaleError();
        }
        if (row["self_role"] !== "member") {
          // The group creator cannot leave in this step; group member
          // management stays unavailable until a later decision.
          throw new CommunicationPermissionDeniedError();
        }
        return Object.freeze({
          groupId,
          streamChannelId: z
            .string()
            .regex(/^loop_group_[0-9a-f]{32}$/)
            .parse(row["stream_channel_id"]),
          channelCreatedByStreamUserId: deriveStreamUserId(
            userIdSchema.parse(row["creator_user_id"]),
          ),
          memberStreamUserId: deriveStreamUserId(actorUserId),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async commitChatGroupLeave(rawInput: {
      readonly actorUserId: string;
      readonly groupId: string;
      readonly idempotencyKey: string;
      readonly requestSha256: string;
      readonly requestId: string;
    }): Promise<void> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const groupId = opaqueIdSchema.parse(rawInput.groupId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        await withTransaction(pool, async (client) => {
          const recordId = await claimCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await client.query<{ event_id: string }>({
            text: `
              select event_id from public.chat_group_membership_events
              where idempotency_record_id = $1 limit 1
            `,
            values: [recordId],
          });
          if (replay.rows[0] !== undefined) {
            return;
          }
          const deleted = await client.query({
            text: `
              delete from public.communication_group_members
              where group_id = $1
                and owner_user_id = $2
                and member_role = 'member'
            `,
            values: [groupId, actorUserId],
          });
          if (deleted.rowCount === 0) {
            throw new CommunicationDataStaleError();
          }
          await client.query({
            text: `
              insert into public.chat_group_membership_events (
                group_id, actor_user_id, event_type, reason_code,
                idempotency_record_id, request_id
              )
              values ($1, $2, 'member_left', 'self_leave', $3, $4)
            `,
            values: [groupId, actorUserId, recordId, requestId],
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}

/**
 * Outbox lane repository. Every claim takes a fenced lease so two worker
 * replicas cannot attempt the same Stream write, and the LOOP membership fact
 * is never changed here: only the Stream projection is.
 */
export function createPostgresCommunityChannelSyncRepository(
  pool: Pool,
): CommunityChannelSyncRepository {
  return Object.freeze({
    async claimDueJobs(input: {
      readonly workerId: string;
      readonly leaseSeconds: number;
      readonly limit: number;
    }): Promise<readonly CommunityChannelSyncJobRecord[]> {
      const workerId = uuidV4Schema.parse(input.workerId);
      const leaseSeconds = z
        .number()
        .int()
        .min(1)
        .max(600)
        .parse(input.leaseSeconds);
      const limit = limitSchema.parse(input.limit);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          with due as (
            select job.community_id, job.owner_user_id
            from public.community_channel_sync_jobs as job
            where job.state in ('pending', 'reconciling')
              and job.next_attempt_at <= clock_timestamp()
              and (
                job.lease_expires_at is null
                or job.lease_expires_at <= clock_timestamp()
              )
            order by job.next_attempt_at asc, job.community_id asc, job.owner_user_id asc
            limit $3
            for update skip locked
          )
          update public.community_channel_sync_jobs as job
          set
            lease_worker_id = $1,
            lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision),
            attempts = job.attempts + 1,
            updated_at = clock_timestamp()
          from due
          where job.community_id = due.community_id
            and job.owner_user_id = due.owner_user_id
          returning
            job.community_id,
            job.owner_user_id,
            job.kind,
            job.attempts,
            (
              select channel.stream_channel_id
              from public.community_channels as channel
              where channel.community_id = job.community_id
            ) as stream_channel_id,
            (
              select channel.created_by_user_id
              from public.community_channels as channel
              where channel.community_id = job.community_id
            ) as channel_created_by_user_id,
            (
              select channel.provisioned_at is not null
              from public.community_channels as channel
              where channel.community_id = job.community_id
            ) as channel_provisioned,
            (
              select channel.member_cap
              from public.community_channels as channel
              where channel.community_id = job.community_id
            ) as member_cap,
            (
              select community.name
              from public.communities as community
              where community.community_id = job.community_id
            ) as channel_name,
            (
              select count(*)
              from public.community_channel_members as member
              where member.community_id = job.community_id
                and member.state = 'synced'
            ) as synced_member_count
        `,
        values: [workerId, leaseSeconds, limit],
      });
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            communityId: opaqueIdSchema.parse(row["community_id"]),
            ownerUserId: userIdSchema.parse(row["owner_user_id"]),
            streamChannelId: z
              .string()
              .regex(/^loop_community_[0-9a-f]{32}$/)
              .parse(row["stream_channel_id"]),
            channelCreatedByStreamUserId: deriveStreamUserId(
              userIdSchema.parse(row["channel_created_by_user_id"]),
            ),
            memberStreamUserId: deriveStreamUserId(
              userIdSchema.parse(row["owner_user_id"]),
            ),
            kind: z.enum(["add", "remove"]).parse(row["kind"]),
            attempts: z.number().int().parse(row["attempts"]),
            channelProvisioned: row["channel_provisioned"] === true,
            channelName: z.string().min(1).parse(row["channel_name"]),
            memberCap: z.number().int().parse(row["member_cap"]),
            syncedMemberCount: Number.parseInt(
              String(row["synced_member_count"]),
              10,
            ),
          }),
        ),
      );
    },

    async markChannelProvisioned(input: {
      readonly communityId: string;
      readonly workerId: string;
    }): Promise<void> {
      await pool.query({
        text: `
          update public.community_channels
          set
            provisioned_at = coalesce(provisioned_at, clock_timestamp()),
            state = case when state = 'failed' then 'created' else state end,
            last_error_code = null,
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where community_id = $1
        `,
        values: [opaqueIdSchema.parse(input.communityId)],
      });
    },

    async completeJob(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
      readonly workerId: string;
      readonly memberState: CommunityChannelMemberState;
      readonly channelState: CommunityChannelState;
    }): Promise<void> {
      const communityId = opaqueIdSchema.parse(input.communityId);
      const ownerUserId = userIdSchema.parse(input.ownerUserId);
      const workerId = uuidV4Schema.parse(input.workerId);
      const memberState = z
        .enum(communityChannelMemberStates)
        .parse(input.memberState);
      const channelState = z
        .enum(communityChannelStates)
        .parse(input.channelState);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query({
          text: `
            update public.community_channel_sync_jobs
            set
              state = 'succeeded',
              last_error_code = null,
              lease_worker_id = null,
              lease_expires_at = null,
              updated_at = clock_timestamp()
            where community_id = $1
              and owner_user_id = $2
              and lease_worker_id = $3
          `,
          values: [communityId, ownerUserId, workerId],
        });
        await client.query({
          text: `
            update public.community_channel_members
            set state = $3, updated_at = clock_timestamp()
            where community_id = $1 and owner_user_id = $2
          `,
          values: [communityId, ownerUserId, memberState],
        });
        await client.query({
          text: `
            update public.community_channels
            set
              state = $2,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where community_id = $1 and state <> $2
          `,
          values: [communityId, channelState],
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async retryJob(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
      readonly workerId: string;
      readonly errorCode: string;
      readonly retryDelaySeconds: number;
    }): Promise<void> {
      await pool.query({
        text: `
          update public.community_channel_sync_jobs
          set
            state = 'reconciling',
            last_error_code = $4,
            next_attempt_at = clock_timestamp()
              + make_interval(secs => $5::double precision),
            lease_worker_id = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
          where community_id = $1
            and owner_user_id = $2
            and lease_worker_id = $3
        `,
        values: [
          opaqueIdSchema.parse(input.communityId),
          userIdSchema.parse(input.ownerUserId),
          uuidV4Schema.parse(input.workerId),
          z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,63}$/)
            .parse(input.errorCode),
          z.number().int().min(1).max(3_600).parse(input.retryDelaySeconds),
        ],
      });
    },

    async failJob(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
      readonly workerId: string;
      readonly errorCode: string;
    }): Promise<void> {
      const communityId = opaqueIdSchema.parse(input.communityId);
      const ownerUserId = userIdSchema.parse(input.ownerUserId);
      const workerId = uuidV4Schema.parse(input.workerId);
      const errorCode = z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .parse(input.errorCode);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query({
          text: `
            update public.community_channel_sync_jobs
            set
              state = 'failed',
              last_error_code = $4,
              lease_worker_id = null,
              lease_expires_at = null,
              updated_at = clock_timestamp()
            where community_id = $1
              and owner_user_id = $2
              and lease_worker_id = $3
          `,
          values: [communityId, ownerUserId, workerId, errorCode],
        });
        await client.query({
          text: `
            update public.community_channels
            set
              state = 'failed',
              last_error_code = $2,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where community_id = $1
          `,
          values: [communityId, errorCode],
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
