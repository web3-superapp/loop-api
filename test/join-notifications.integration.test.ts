import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCommunityChannelSyncWorker } from "../src/community-channel-sync-worker.js";
import { loadConfig } from "../src/config.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import { createPostgresCommunityChannelSyncRepository } from "../src/database/communication-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import type { CommunityChannelSyncRepository } from "../src/features/communication/communication-repository.js";
import type { CommunityPersonaService } from "../src/features/communication/community-persona-service.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import {
  CommunityIdempotencyConflictError,
  type CommunityNotificationPreference,
  type CommunityRepository,
} from "../src/features/community/community-repository.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { ProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
import {
  StreamChannelGatewayUnavailableError,
  type StreamCommunityChannelGateway,
  type StreamCommunityChannelMemberInput,
  type MuteStreamCommunityChannelForMemberInput,
} from "../src/integrations/stream/channel-gateway.js";
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

type StreamCall =
  | { readonly kind: "add"; readonly channelId: string; readonly user: string }
  | {
      readonly kind: "mute";
      readonly channelId: string;
      readonly user: string;
    };

/**
 * A Stream fake that records the provider calls in order. `muteFailures`
 * makes the next N mute calls fail as a transient provider fault.
 */
function streamFake(): {
  readonly gateway: StreamCommunityChannelGateway;
  readonly calls: StreamCall[];
  failNextMutes(count: number): void;
} {
  const calls: StreamCall[] = [];
  let muteFailures = 0;
  const gateway = {
    upsertCommunityChannel: (input: { channelId: string }) =>
      Promise.resolve({
        channelId: input.channelId,
        streamCid: `messaging:${input.channelId}`,
        memberCount: 1,
      }),
    addMembers: (input: StreamCommunityChannelMemberInput) => {
      for (const user of input.memberStreamUserIds) {
        calls.push({ kind: "add", channelId: input.channelId, user });
      }
      return Promise.resolve({
        channelId: input.channelId,
        streamCid: `messaging:${input.channelId}`,
        memberCount: null,
        confirmedPersonaStreamUserIds: [],
      });
    },
    muteCommunityChannelForMember: (
      input: MuteStreamCommunityChannelForMemberInput,
    ) => {
      if (muteFailures > 0) {
        muteFailures -= 1;
        return Promise.reject(new StreamChannelGatewayUnavailableError());
      }
      calls.push({
        kind: "mute",
        channelId: input.channelId,
        user: input.memberStreamUserId,
      });
      return Promise.resolve();
    },
    readCommunityChannelActivity: () => Promise.resolve([]),
  } as unknown as StreamCommunityChannelGateway;
  return {
    gateway,
    calls,
    failNextMutes(count: number) {
      muteFailures = count;
    },
  };
}

describe("join notification preference through the channel sync lane (Decision 0115)", () => {
  const databaseName = `loop_join_mute_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let community: CommunityRepository;
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
        V2_COMMUNITY_CHANNEL_MEMBER_CAP: "10",
      }),
      { error: () => undefined },
    );
    community = createPostgresCommunityRepository(pool, {
      communityChannelMemberCap: 10,
    });
    sync = createPostgresCommunityChannelSyncRepository(pool);
    profiles = createPostgresProfileV2Repository(pool);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createAccount(): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:join-mute:${randomUUID()}`,
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

  async function createVerifiedCommunity(ownerUserId: string): Promise<{
    readonly communityId: string;
    readonly streamChannelId: string;
  }> {
    const slug = `m-${randomUUID().slice(0, 8)}`;
    const detail = await community.createCommunity({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "createCommunity", [
        "Quiet Owls",
        slug,
        "",
        "",
        "",
      ]),
      requestId: randomUUID(),
      name: "Quiet Owls",
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
    return {
      communityId,
      streamChannelId: `loop_community_${communityId.replaceAll("-", "")}`,
    };
  }

  function join(
    ownerUserId: string,
    communityId: string,
    notifications: CommunityNotificationPreference = "default",
    idempotencyKey: string = randomUUID(),
  ): Promise<unknown> {
    return community.joinCommunity({
      ownerUserId,
      communityId,
      idempotencyKey,
      requestSha256: commandDigest(
        "community",
        "joinCommunity",
        notifications === "muted"
          ? [communityId, "notifications=muted"]
          : [communityId],
      ),
      requestId: randomUUID(),
      ...(notifications === "muted" ? { notifications } : {}),
    });
  }

  function worker(gateway: StreamCommunityChannelGateway) {
    return createCommunityChannelSyncWorker({
      repository: sync,
      gateway,
      // Real-identity mode (Decision 0095) keeps the persona lane out of
      // this suite; the mute step does not depend on it.
      personas: {} as CommunityPersonaService,
      realIdentity: true,
    });
  }

  async function jobRow(
    communityId: string,
    ownerUserId: string,
  ): Promise<Record<string, unknown>> {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select state, attempts, last_error_code
        from public.community_channel_sync_jobs
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, ownerUserId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("sync job missing");
    }
    return row;
  }

  async function makeJobDue(communityId: string, ownerUserId: string) {
    await pool.query({
      text: `
        update public.community_channel_sync_jobs
        set next_attempt_at = clock_timestamp()
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, ownerUserId],
    });
  }

  it("mutes a muted joiner right after Stream added it, and only then reports channelSynced", async () => {
    const owner = await createAccount();
    const { communityId, streamChannelId } =
      await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId, "muted");

    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({
      membership: { role: "member", status: "active" },
      notifications: "muted",
      channelSynced: false,
    });

    const stream = streamFake();
    const result = await worker(stream.gateway).runOnce();
    expect(result).toMatchObject({ failedCount: 0, retriedCount: 0 });

    const memberStreamUserId = deriveStreamUserId(member);
    const memberCalls = stream.calls.filter(
      (call) => call.user === memberStreamUserId,
    );
    expect(memberCalls).toEqual([
      { kind: "add", channelId: streamChannelId, user: memberStreamUserId },
      { kind: "mute", channelId: streamChannelId, user: memberStreamUserId },
    ]);
    // The owner joined by creating the community: default, never muted.
    expect(
      stream.calls.filter(
        (call) =>
          call.kind === "mute" && call.user === deriveStreamUserId(owner),
      ),
    ).toEqual([]);

    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ notifications: "muted", channelSynced: true });
    expect(
      await community.readMembershipSync({ viewerUserId: owner, communityId }),
    ).toMatchObject({ notifications: "default", channelSynced: true });
  });

  it("never mutes a default joiner", async () => {
    const owner = await createAccount();
    const { communityId } = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId);

    const stream = streamFake();
    await worker(stream.gateway).runOnce();

    expect(stream.calls.some((call) => call.kind === "mute")).toBe(false);
    expect(
      stream.calls.some(
        (call) =>
          call.kind === "add" && call.user === deriveStreamUserId(member),
      ),
    ).toBe(true);
    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ notifications: "default", channelSynced: true });
  });

  it("retries the job when the mute fails, re-adds idempotently, and mutes on the next attempt", async () => {
    const owner = await createAccount();
    const { communityId, streamChannelId } =
      await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId, "muted");

    const stream = streamFake();
    stream.failNextMutes(1);
    const first = await worker(stream.gateway).runOnce();
    expect(first.retriedCount).toBe(1);
    expect(await jobRow(communityId, member)).toMatchObject({
      state: "reconciling",
      attempts: 1,
      last_error_code: "stream_channel_mute_unavailable",
    });
    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ channelSynced: false });

    await makeJobDue(communityId, member);
    const second = await worker(stream.gateway).runOnce();
    expect(second).toMatchObject({ succeededCount: 1, retriedCount: 0 });
    expect(await jobRow(communityId, member)).toMatchObject({
      state: "succeeded",
      attempts: 2,
      last_error_code: null,
    });
    const memberStreamUserId = deriveStreamUserId(member);
    expect(
      stream.calls.filter((call) => call.user === memberStreamUserId),
    ).toEqual([
      { kind: "add", channelId: streamChannelId, user: memberStreamUserId },
      { kind: "add", channelId: streamChannelId, user: memberStreamUserId },
      { kind: "mute", channelId: streamChannelId, user: memberStreamUserId },
    ]);
    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ channelSynced: true });
  });

  it("does not mute again on a later re-add, and a re-join starts from its own preference", async () => {
    const owner = await createAccount();
    const { communityId } = await createVerifiedCommunity(owner);
    const member = await createAccount();
    await join(member, communityId, "muted");
    const stream = streamFake();
    await worker(stream.gateway).runOnce();
    const memberStreamUserId = deriveStreamUserId(member);
    const mutes = () =>
      stream.calls.filter(
        (call) => call.kind === "mute" && call.user === memberStreamUserId,
      ).length;
    expect(mutes()).toBe(1);

    // A role change re-runs the add; the mute was already applied.
    await pool.query({
      text: `
        update public.community_channel_sync_jobs
        set state = 'pending', attempts = 0, next_attempt_at = clock_timestamp()
        where community_id = $1 and owner_user_id = $2
      `,
      values: [communityId, member],
    });
    await worker(stream.gateway).runOnce();
    expect(mutes()).toBe(1);

    // Leave, then re-join with no preference: the new row is default.
    await community.leaveCommunity({
      ownerUserId: member,
      communityId,
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("community", "leaveCommunity", [
        communityId,
      ]),
      requestId: randomUUID(),
    });
    await worker(stream.gateway).runOnce();
    await join(member, communityId);
    await worker(stream.gateway).runOnce();
    expect(mutes()).toBe(1);
    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ notifications: "default", channelSynced: true });
  });

  it("keeps an existing membership's preference and binds the preference into the idempotency key", async () => {
    const owner = await createAccount();
    const { communityId } = await createVerifiedCommunity(owner);
    const member = await createAccount();
    const key = randomUUID();
    await join(member, communityId, "default", key);
    await expect(join(member, communityId, "muted", key)).rejects.toThrow(
      CommunityIdempotencyConflictError,
    );
    // A fresh muted join of an existing member changes nothing.
    await join(member, communityId, "muted");
    expect(
      await community.readMembershipSync({ viewerUserId: member, communityId }),
    ).toMatchObject({ notifications: "default" });
  });

  it("reads a non-member as nulls", async () => {
    const owner = await createAccount();
    const viewer = await createAccount();
    const { communityId } = await createVerifiedCommunity(owner);
    expect(
      await community.readMembershipSync({ viewerUserId: viewer, communityId }),
    ).toEqual({
      membership: null,
      notifications: null,
      channelSynced: false,
    });
  });
});
