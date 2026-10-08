import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresCommunicationRepository,
  createPostgresVoiceRoomReaperRepository,
} from "../src/database/communication-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import type { CommunityRepository } from "../src/features/community/community-repository.js";
import { communicationCommandDigest } from "../src/features/communication/communication-contract.js";
import type {
  CommunicationRepository,
  VoiceRoomReaperRepository,
} from "../src/features/communication/communication-repository.js";
import { createVoiceRoomReaperService } from "../src/features/communication/voice-room-reaper-service.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import {
  createUnavailableStreamCallGateway,
  type StreamCallGateway,
} from "../src/integrations/stream/call-gateway.js";
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

function fakeGateway(participantCount: number) {
  const observeSession = vi.fn(() =>
    Promise.resolve({
      participantCount,
      sessionActive: participantCount > 0,
      observedAt: new Date().toISOString(),
    }),
  );
  const endCall = vi.fn(() => Promise.resolve());
  const gateway: StreamCallGateway = {
    ...createUnavailableStreamCallGateway(),
    observeSession,
    endCall,
  };
  return { gateway, observeSession, endCall };
}

describe("voice_room_reaper lane against PostgreSQL (Decision 0094)", () => {
  const databaseName = `loop_reaper_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let community: CommunityRepository;
  let communication: CommunicationRepository;
  let reaper: VoiceRoomReaperRepository;
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
    const temporaryDatabaseUrl = databaseConnectionUrl(
      databaseUrl,
      databaseName,
    );
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
    community = createPostgresCommunityRepository(pool);
    communication = createPostgresCommunicationRepository(pool);
    reaper = createPostgresVoiceRoomReaperRepository(pool);
    profiles = createPostgresProfileV2Repository(pool);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createAccount(): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:reaper:${randomUUID()}`,
    );
    const alias = `reaper_${randomUUID().slice(0, 8)}`;
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

  async function createCommunity(ownerUserId: string): Promise<string> {
    const slug = `r-${randomUUID().slice(0, 8)}`;
    const detail = await community.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        "Reaper Room",
        slug,
        "",
        "",
        "",
      ]),
      requestId: randomUUID(),
      name: "Reaper Room",
      slug,
      description: null,
      logoRef: null,
      boundAssetKey: null,
    });
    return detail.community.communityId;
  }

  /** A provisioned live room in its own community, hosted by a new account. */
  async function liveRoom(): Promise<{
    readonly voiceRoomId: string;
    readonly communityId: string;
  }> {
    const host = await createAccount();
    const communityId = await createCommunity(host);
    const record = await communication.createVoiceRoom({
      actorUserId: host,
      communityId,
      title: null,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomCreate", [
        communityId,
      ]),
      requestId: randomUUID(),
    });
    const voiceRoomId = record.room.voiceRoomId;
    await communication.recordVoiceRoomProvisioning({
      voiceRoomId,
      provisionState: "provisioned",
      errorCode: null,
      backstage: false,
    });
    return { voiceRoomId, communityId };
  }

  async function addListener(
    voiceRoomId: string,
    communityId: string,
  ): Promise<string> {
    const listener = await createAccount();
    await community.joinCommunity({
      ownerUserId: listener,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "joinCommunity", [communityId]),
      requestId: randomUUID(),
    });
    await communication.joinVoiceRoom({
      actorUserId: listener,
      voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomJoin", [voiceRoomId]),
      requestId: randomUUID(),
    });
    return listener;
  }

  /** Moves the room and every member row `minutes` into the past. */
  async function age(voiceRoomId: string, minutes: number): Promise<void> {
    await pool.query({
      text: `
        update public.voice_rooms
        set created_at = created_at - make_interval(mins => $2),
            updated_at = updated_at - make_interval(mins => $2)
        where voice_room_id = $1
      `,
      values: [voiceRoomId, minutes],
    });
    await pool.query({
      text: `
        update public.voice_room_members
        set joined_at = joined_at - make_interval(mins => $2),
            updated_at = updated_at - make_interval(mins => $2)
        where voice_room_id = $1
      `,
      values: [voiceRoomId, minutes],
    });
  }

  async function roomState(voiceRoomId: string): Promise<{
    readonly state: string;
    readonly endedAt: Date | null;
    readonly recordVersion: number;
  }> {
    const result = await pool.query<{
      state: string;
      ended_at: Date | null;
      record_version: number;
    }>({
      text: `select state, ended_at, record_version from public.voice_rooms where voice_room_id = $1`,
      values: [voiceRoomId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("expected a room row");
    }
    return {
      state: row.state,
      endedAt: row.ended_at,
      recordVersion: row.record_version,
    };
  }

  async function endAudit(
    voiceRoomId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select actor_user_id, reason_code, idempotency_record_id, request_id
        from public.voice_room_events
        where voice_room_id = $1 and event_type = 'room_ended'
      `,
      values: [voiceRoomId],
    });
    return result.rows;
  }

  async function endAllLiveRooms(): Promise<void> {
    await pool.query(`
      update public.voice_rooms
      set state = 'ended', ended_at = clock_timestamp(), updated_at = clock_timestamp()
      where state = 'live'
    `);
  }

  it("ends an empty, idle live room in one pass and keeps a room with a listener", async () => {
    await endAllLiveRooms();
    const empty = await liveRoom();
    await age(empty.voiceRoomId, 11);
    const occupied = await liveRoom();
    await addListener(occupied.voiceRoomId, occupied.communityId);
    await age(occupied.voiceRoomId, 11);
    const fresh = await liveRoom();

    const { gateway, observeSession, endCall } = fakeGateway(0);
    const requestId = randomUUID();
    const service = createVoiceRoomReaperService({
      repository: reaper,
      callGateway: gateway,
      thresholds: { idleEndMinutes: 10, maxLiveHours: 12 },
      createUuid: () => requestId,
    });

    const result = await service.runOnce(new AbortController().signal);

    expect(result).toMatchObject({
      kind: "completed",
      examinedCount: 3,
      endedIdleCount: 1,
      endedMaxAgeCount: 0,
      keptCount: 2,
      providerUnconfirmedCount: 0,
      failedCount: 0,
    });
    // Only the empty room reached Stream: the occupied one is decided by
    // LOOP, the fresh one by its recent creation.
    expect(observeSession).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledTimes(1);

    const ended = await roomState(empty.voiceRoomId);
    expect(ended.state).toBe("ended");
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(ended.recordVersion).toBe(3);
    expect(await endAudit(empty.voiceRoomId)).toEqual([
      {
        actor_user_id: null,
        reason_code: "voice_room_idle_ended",
        idempotency_record_id: null,
        request_id: requestId,
      },
    ]);

    expect((await roomState(occupied.voiceRoomId)).state).toBe("live");
    expect(await endAudit(occupied.voiceRoomId)).toEqual([]);
    expect((await roomState(fresh.voiceRoomId)).state).toBe("live");
  });

  it("keeps an idle room while Stream reports a connected device", async () => {
    await endAllLiveRooms();
    const room = await liveRoom();
    await age(room.voiceRoomId, 30);
    const { gateway, endCall } = fakeGateway(1);

    const result = await createVoiceRoomReaperService({
      repository: reaper,
      callGateway: gateway,
      thresholds: { idleEndMinutes: 10, maxLiveHours: 12 },
    }).runOnce(new AbortController().signal);

    expect(result).toMatchObject({ examinedCount: 1, keptCount: 1 });
    expect(endCall).not.toHaveBeenCalled();
    expect((await roomState(room.voiceRoomId)).state).toBe("live");
  });

  it("ends an over-age room even with a listener, and cancels its pending hand raises", async () => {
    await endAllLiveRooms();
    const room = await liveRoom();
    const listener = await addListener(room.voiceRoomId, room.communityId);
    await communication.raiseHand({
      actorUserId: listener,
      voiceRoomId: room.voiceRoomId,
      idempotencyKey: randomUUID(),
      requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
        room.voiceRoomId,
      ]),
      requestId: randomUUID(),
    });
    await age(room.voiceRoomId, 12 * 60 + 1);
    const { gateway, observeSession, endCall } = fakeGateway(5);

    const result = await createVoiceRoomReaperService({
      repository: reaper,
      callGateway: gateway,
      thresholds: { idleEndMinutes: 10, maxLiveHours: 12 },
    }).runOnce(new AbortController().signal);

    expect(result).toMatchObject({ endedMaxAgeCount: 1, endedIdleCount: 0 });
    expect(observeSession).not.toHaveBeenCalled();
    expect(endCall).toHaveBeenCalledTimes(1);
    expect((await roomState(room.voiceRoomId)).state).toBe("ended");
    expect(await endAudit(room.voiceRoomId)).toEqual([
      expect.objectContaining({
        actor_user_id: null,
        reason_code: "voice_room_max_age_ended",
      }),
    ]);
    const pending = await pool.query({
      text: `select 1 from public.voice_room_hand_raises where voice_room_id = $1 and state = 'pending'`,
      values: [room.voiceRoomId],
    });
    expect(pending.rowCount).toBe(0);
  });

  it("re-checks the rule under the row lock: a listener or an ended room is skipped", async () => {
    await endAllLiveRooms();
    const room = await liveRoom();
    await age(room.voiceRoomId, 30);
    const [listed] = await reaper.listLiveVoiceRoomsForReaper({ limit: 50 });
    expect(listed).toMatchObject({
      voiceRoomId: room.voiceRoomId,
      provisionState: "provisioned",
      nonHostJoinedCount: 0,
    });

    // A listener joins between the listing and the end.
    await addListener(room.voiceRoomId, room.communityId);
    const input = {
      voiceRoomId: room.voiceRoomId,
      idleEndMinutes: 10,
      maxLiveHours: 12,
      requestId: randomUUID(),
    };
    expect(
      await reaper.endVoiceRoomByReaper({ ...input, reason: "idle" }),
    ).toEqual({ outcome: "skipped" });
    // Too young for the hard cap as well.
    expect(
      await reaper.endVoiceRoomByReaper({ ...input, reason: "max_age" }),
    ).toEqual({ outcome: "skipped" });
    expect((await roomState(room.voiceRoomId)).state).toBe("live");

    await endAllLiveRooms();
    expect(
      await reaper.endVoiceRoomByReaper({ ...input, reason: "max_age" }),
    ).toEqual({ outcome: "skipped" });
    expect(await endAudit(room.voiceRoomId)).toEqual([]);
  });

  it("lists at most the requested number of live rooms, oldest first, and refuses an invalid limit", async () => {
    await endAllLiveRooms();
    const older = await liveRoom();
    await age(older.voiceRoomId, 20);
    const newer = await liveRoom();

    const listed = await reaper.listLiveVoiceRoomsForReaper({ limit: 50 });
    expect(listed.map((room) => room.voiceRoomId)).toEqual([
      older.voiceRoomId,
      newer.voiceRoomId,
    ]);
    expect(await reaper.listLiveVoiceRoomsForReaper({ limit: 1 })).toHaveLength(
      1,
    );
    await expect(
      reaper.listLiveVoiceRoomsForReaper({ limit: 51 }),
    ).rejects.toThrow();
  });
});
