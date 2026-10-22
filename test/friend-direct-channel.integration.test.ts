import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createPostgresChatChannelRepository } from "../src/database/chat-channel-repository.js";
import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import {
  createPostgresFriendDirectChannelJobRepository,
  enqueueFriendDirectChannelJob,
} from "../src/database/friend-direct-channel-job-repository.js";
import { createPostgresSocialRepository } from "../src/database/social-repository.js";
import { createChatChannelService } from "../src/features/communication/chat-channel-service.js";
import { createFriendDirectChannelService } from "../src/features/communication/friend-direct-channel-service.js";
import { commandDigest } from "../src/features/community/community-contract.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import type {
  StreamChannelGateway,
  UpsertFixedStreamMessagingChannelInput,
} from "../src/integrations/stream/channel-gateway.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

interface Account {
  readonly userId: string;
  readonly privyUserId: string;
  readonly publicProfileId: string;
}

describe("Decision 0172 friend direct channel guarantee (PostgreSQL)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const ownedUserIds = new Set<string>();
  const social = createPostgresSocialRepository(pool);
  const community = createPostgresCommunityRepository(pool);
  const chatRepository = createPostgresChatChannelRepository(pool);
  const jobs = createPostgresFriendDirectChannelJobRepository(pool);
  const created = new Map<string, UpsertFixedStreamMessagingChannelInput>();
  const upsert = vi.fn((input: UpsertFixedStreamMessagingChannelInput) => {
    created.set(input.channelId, input);
    return Promise.resolve({
      kind: "direct" as const,
      channelId: input.channelId,
      streamCid: `messaging:${input.channelId}`,
      memberStreamUserIds: input.memberStreamUserIds,
    });
  });
  const gateway: StreamChannelGateway = {
    upsertFixedMessagingChannel: upsert,
    readFixedMessagingChannel(input) {
      const channel = created.get(input.channelId);
      return Promise.resolve(
        channel === undefined
          ? { status: "not_found" as const }
          : {
              status: "found",
              channel: {
                kind: "direct",
                channelId: channel.channelId,
                streamCid: `messaging:${channel.channelId}`,
                memberStreamUserIds: channel.memberStreamUserIds,
              },
            },
      );
    },
  };
  const chat = createChatChannelService({
    repository: chatRepository,
    gateway,
  });
  const signal = new AbortController().signal;

  function lane(backfillEnabled = false) {
    return createFriendDirectChannelService({
      repository: jobs,
      chat,
      backfillEnabled,
    });
  }

  async function cleanup(): Promise<void> {
    const ids = [...ownedUserIds];
    created.clear();
    upsert.mockClear();
    if (ids.length === 0) {
      return;
    }
    // Append-only social / chat records can only be truncated (as every
    // other suite does); the suite's accounts are then deleted by id.
    await pool.query(`
      truncate table
        public.friend_direct_channel_jobs,
        public.chat_operation_events,
        public.direct_channels,
        public.chat_operations,
        public.social_operation_events,
        public.social_operations,
        public.social_graph_events,
        public.friendships,
        public.friend_requests
      cascade
    `);
    const statements = [
      // Decision 0177: friend requests / acceptances write inbox rows.
      `delete from public.notifications where owner_user_id = any($1::uuid[])`,
      `delete from public.user_blocks where owner_user_id = any($1::uuid[])`,
      `delete from public.social_privacy_preferences where owner_user_id = any($1::uuid[])`,
      `delete from public.user_profiles where owner_user_id = any($1::uuid[])`,
      `delete from public.idempotency_records where owner_user_id = any($1::uuid[])`,
      `delete from public.loop_users where id = any($1::uuid[])`,
    ];
    for (const text of statements) {
      await pool.query({ text, values: [ids] });
    }
    ownedUserIds.clear();
  }

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function createAccount(label: string): Promise<Account> {
    const privyUserId = `did:privy:s272:${label}:${randomUUID()}`;
    const owner = await pool.query<{ id: string }>({
      text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
      values: [privyUserId],
    });
    const userId = owner.rows[0]?.id ?? "";
    ownedUserIds.add(userId);
    const profile = await pool.query<{ public_profile_id: string }>({
      text: `
        insert into public.user_profiles (owner_user_id, alias)
        values ($1, $2)
        returning public_profile_id
      `,
      values: [userId, `S272 ${label}`],
    });
    await pool.query({
      text: `
        insert into public.social_privacy_preferences (
          owner_user_id, friend_requests, group_invites, direct_messages
        ) values ($1, 'enabled', 'friends', 'friends')
      `,
      values: [userId],
    });
    return Object.freeze({
      userId,
      privyUserId,
      publicProfileId: profile.rows[0]?.public_profile_id ?? "",
    });
  }

  async function pendingRequest(
    requester: Account,
    recipient: Account,
  ): Promise<string> {
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
    return inserted.rows[0]?.friend_request_id ?? "";
  }

  async function readJob(first: Account, second: Account) {
    const result = await pool.query<{
      owner_user_id: string;
      source: string;
      state: string;
      last_error_code: string | null;
      operation_id: string | null;
    }>({
      text: `
        select owner_user_id, source, state, last_error_code, operation_id
        from public.friend_direct_channel_jobs
        where user_id_low = least($1::uuid, $2::uuid)
          and user_id_high = greatest($1::uuid, $2::uuid)
      `,
      values: [first.userId, second.userId],
    });
    return result.rows[0] ?? null;
  }

  async function directChannels(first: Account, second: Account) {
    const result = await pool.query<{
      stream_channel_id: string;
      channel_state: string;
    }>({
      text: `
        select stream_channel_id, channel_state
        from public.direct_channels
        where user_id_low = least($1::uuid, $2::uuid)
          and user_id_high = greatest($1::uuid, $2::uuid)
      `,
      values: [first.userId, second.userId],
    });
    return result.rows;
  }

  function principal(account: Account) {
    return {
      userId: account.userId,
      privyUserId: account.privyUserId,
      streamUserId: deriveStreamUserId(account.userId),
    };
  }

  it("enqueues inside the friend-request accept and the lane creates the channel once; the app's call converges", async () => {
    const alice = await createAccount("alice");
    const bob = await createAccount("bob");
    const friendRequestId = await pendingRequest(alice, bob);

    await social.decideFriendRequest({
      ownerUserId: bob.userId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestSha256: digest(`accept-${friendRequestId}`),
      friendRequestId,
      decision: "accept",
    });
    expect(await readJob(alice, bob)).toMatchObject({
      owner_user_id: bob.userId,
      source: "accept",
      state: "pending",
    });
    expect(await directChannels(alice, bob)).toEqual([]);

    const result = await lane().runOnce(signal);
    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await readJob(alice, bob)).toMatchObject({ state: "succeeded" });
    const channels = await directChannels(alice, bob);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.channel_state).toBe("active");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0].memberStreamUserIds).toEqual(
      [deriveStreamUserId(alice.userId), deriveStreamUserId(bob.userId)].sort(),
    );

    // The app's own best-effort call after the accept: same CID, no Stream write.
    const appCall = await chat.getOrCreateDirect({
      principal: principal(alice),
      operationId: randomUUID(),
      requestId: randomUUID(),
      body: { target_public_profile_id: bob.publicProfileId },
      signal,
    });
    expect(appCall.status).toBe("succeeded");
    expect(appCall.result).toMatchObject({
      stream_cid: `messaging:${channels[0]?.stream_channel_id}`,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await directChannels(alice, bob)).toHaveLength(1);

    // A second pass has nothing due.
    expect(await lane().runOnce(signal)).toMatchObject({ claimed: 0 });
  });

  it("enqueues inside the message-request accept; when the app won the race the lane makes no Stream write", async () => {
    const recipient = await createAccount("dm-recipient");
    const requester = await createAccount("dm-requester");
    const messageRequestId = await pendingRequest(requester, recipient);

    await community.decideMessageRequest({
      ownerUserId: recipient.userId,
      messageRequestId,
      decision: "accept",
      idempotencyKey: randomUUID(),
      requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
        messageRequestId,
        "accept",
      ]),
      requestId: randomUUID(),
    });
    expect(await readJob(recipient, requester)).toMatchObject({
      owner_user_id: recipient.userId,
      source: "accept",
      state: "pending",
    });

    const appCall = await chat.getOrCreateDirect({
      principal: principal(recipient),
      operationId: randomUUID(),
      requestId: randomUUID(),
      body: { target_public_profile_id: requester.publicProfileId },
      signal,
    });
    expect(appCall.status).toBe("succeeded");
    expect(upsert).toHaveBeenCalledTimes(1);

    expect(await lane().runOnce(signal)).toMatchObject({ succeeded: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await directChannels(recipient, requester)).toHaveLength(1);
    expect(await readJob(recipient, requester)).toMatchObject({
      state: "succeeded",
    });
  });

  it("skips a pair refused by the route's rules without touching the accepted friendship", async () => {
    const alice = await createAccount("closed-alice");
    const bob = await createAccount("closed-bob");
    const friendRequestId = await pendingRequest(alice, bob);
    await social.decideFriendRequest({
      ownerUserId: bob.userId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestSha256: digest(`accept-${friendRequestId}`),
      friendRequestId,
      decision: "accept",
    });
    await pool.query({
      text: `
        update public.social_privacy_preferences
        set direct_messages = 'disabled'
        where owner_user_id = any($1::uuid[])
      `,
      values: [[alice.userId, bob.userId]],
    });

    expect(await lane().runOnce(signal)).toMatchObject({ skipped: 1 });
    expect(await readJob(alice, bob)).toMatchObject({
      state: "skipped",
      last_error_code: "direct_target_unavailable",
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(await directChannels(alice, bob)).toEqual([]);
    const friendship = await pool.query({
      text: `
        select 1 from public.friendships
        where user_id_low = least($1::uuid, $2::uuid)
          and user_id_high = greatest($1::uuid, $2::uuid)
      `,
      values: [alice.userId, bob.userId],
    });
    expect(friendship.rowCount).toBe(1);
  });

  it("re-arms a settled job on a later accept and leaves a pending one alone", async () => {
    const alice = await createAccount("rearm-alice");
    const bob = await createAccount("rearm-bob");
    const client = await pool.connect();
    try {
      await enqueueFriendDirectChannelJob(client, {
        ownerUserId: bob.userId,
        peerUserId: alice.userId,
        source: "accept",
      });
      await pool.query({
        text: `
          update public.friend_direct_channel_jobs
          set state = 'skipped', attempts = 4, last_error_code = 'direct_target_unavailable'
          where user_id_low = least($1::uuid, $2::uuid)
        `,
        values: [alice.userId, bob.userId],
      });
      await enqueueFriendDirectChannelJob(client, {
        ownerUserId: alice.userId,
        peerUserId: bob.userId,
        source: "accept",
      });
      expect(await readJob(alice, bob)).toMatchObject({
        owner_user_id: alice.userId,
        state: "pending",
        last_error_code: null,
      });
      await enqueueFriendDirectChannelJob(client, {
        ownerUserId: bob.userId,
        peerUserId: alice.userId,
        source: "accept",
      });
      expect(await readJob(alice, bob)).toMatchObject({
        owner_user_id: alice.userId,
        state: "pending",
      });
    } finally {
      client.release();
    }
  });

  it("backfills, bounded and idempotently, only friendships without a direct channel or job", async () => {
    const alice = await createAccount("bf-alice");
    const bob = await createAccount("bf-bob");
    const carol = await createAccount("bf-carol");
    // alice–bob: an old friendship (before Decision 0172), no channel, no job.
    const first = await pendingRequest(alice, bob);
    await social.decideFriendRequest({
      ownerUserId: bob.userId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestSha256: digest(`accept-${first}`),
      friendRequestId: first,
      decision: "accept",
    });
    // alice–carol: friendship whose channel already exists.
    const second = await pendingRequest(carol, alice);
    await social.decideFriendRequest({
      ownerUserId: alice.userId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestSha256: digest(`accept-${second}`),
      friendRequestId: second,
      decision: "accept",
    });
    await chat.getOrCreateDirect({
      principal: principal(alice),
      operationId: randomUUID(),
      requestId: randomUUID(),
      body: { target_public_profile_id: carol.publicProfileId },
      signal,
    });
    // Simulate pre-0172 rows: no outbox entries at all.
    await pool.query({
      text: `
        delete from public.friend_direct_channel_jobs
        where user_id_low = any($1::uuid[]) or user_id_high = any($1::uuid[])
      `,
      values: [[alice.userId, bob.userId, carol.userId]],
    });

    const before = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.friend_direct_channel_jobs`,
    );
    expect(await lane(false).runOnce(signal)).toMatchObject({
      backfillEnqueued: null,
      claimed: 0,
    });

    const swept = await jobs.enqueueBackfill({ limit: 200 });
    // Other suites may leave friendships behind in a shared database; this
    // suite's own pairs are what is asserted.
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await readJob(alice, bob)).toMatchObject({
      owner_user_id: bob.userId,
      source: "backfill",
      state: "pending",
    });
    expect(await readJob(alice, carol)).toBeNull();
    expect(await jobs.enqueueBackfill({ limit: 200 })).toBe(0);
    const after = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.friend_direct_channel_jobs`,
    );
    expect(Number(after.rows[0]?.count)).toBe(
      Number(before.rows[0]?.count) + swept,
    );

    upsert.mockClear();
    const result = await lane(true).runOnce(signal);
    expect(result).toMatchObject({ backfillEnqueued: 0 });
    expect(await readJob(alice, bob)).toMatchObject({ state: "succeeded" });
    expect(await directChannels(alice, bob)).toHaveLength(1);
    expect(upsert).toHaveBeenCalled();
  });
});
