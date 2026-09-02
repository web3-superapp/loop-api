import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresChatChannelRepository } from "../src/database/chat-channel-repository.js";
import {
  ChatChannelIdempotencyConflictRepositoryError,
  type ChatChannelRepository,
} from "../src/features/communication/chat-channel-repository.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

describe("PostgreSQL Chat channel repository", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const ownedUserIds = new Set<string>();
  let repository: ChatChannelRepository;

  beforeAll(() => {
    repository = createPostgresChatChannelRepository(pool);
  });

  async function cleanup(): Promise<void> {
    await pool.query(`
      truncate table
        public.chat_operation_events,
        public.communication_group_members,
        public.group_alias_reservations,
        public.direct_channels,
        public.communication_groups,
        public.chat_operations,
        public.social_operation_events,
        public.social_operations,
        public.friendships,
        public.friend_requests,
        public.device_session_events,
        public.device_session_commands,
        public.device_sessions
    `);
    const ids = [...ownedUserIds];
    if (ids.length === 0) {
      return;
    }
    await pool.query({
      text: `
        delete from public.social_privacy_preferences
        where owner_user_id = any($1::uuid[])
      `,
      values: [ids],
    });
    await pool.query({
      text: `
        delete from public.privacy_preferences
        where owner_user_id = any($1::uuid[])
      `,
      values: [ids],
    });
    await pool.query({
      text: `
        delete from public.user_profiles
        where owner_user_id = any($1::uuid[])
      `,
      values: [ids],
    });
    await pool.query({
      text: `
        delete from public.idempotency_records
        where owner_user_id = any($1::uuid[])
      `,
      values: [ids],
    });
    await pool.query({
      text: `delete from public.loop_users where id = any($1::uuid[])`,
      values: [ids],
    });
    ownedUserIds.clear();
  }

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function createUser(label: string): Promise<{
    readonly ownerUserId: string;
    readonly publicProfileId: string;
  }> {
    const owner = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:chat-repository:${label}:${randomUUID()}`],
    });
    const ownerUserId = owner.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Chat repository user setup failed");
    }
    ownedUserIds.add(ownerUserId);
    const profile = await pool.query<{ public_profile_id: string }>({
      text: `
        insert into public.user_profiles (owner_user_id, alias)
        values ($1, $2)
        returning public_profile_id
      `,
      values: [ownerUserId, `Chat ${label}`],
    });
    const publicProfileId = profile.rows[0]?.public_profile_id;
    if (publicProfileId === undefined) {
      throw new Error("Chat repository profile setup failed");
    }
    await pool.query({
      text: `
        insert into public.social_privacy_preferences (
          owner_user_id,
          friend_requests,
          group_invites,
          direct_messages
        ) values ($1, 'enabled', 'friends', 'friends')
      `,
      values: [ownerUserId],
    });
    return Object.freeze({ ownerUserId, publicProfileId });
  }

  async function makeFriends(firstUserId: string, secondUserId: string) {
    const requester = firstUserId;
    const recipient = secondUserId;
    const request = await pool.query<{ friend_request_id: string }>({
      text: `
        insert into public.friend_requests (
          requester_user_id,
          recipient_user_id,
          status,
          expires_at,
          decided_at,
          created_at,
          updated_at
        ) values (
          $1,
          $2,
          'accepted',
          clock_timestamp() + interval '1 day',
          clock_timestamp(),
          clock_timestamp() - interval '1 minute',
          clock_timestamp()
        )
        returning friend_request_id
      `,
      values: [requester, recipient],
    });
    const friendRequestId = request.rows[0]?.friend_request_id;
    if (friendRequestId === undefined) {
      throw new Error("Friend request setup failed");
    }
    const [userIdLow, userIdHigh] = [firstUserId, secondUserId].sort();
    await pool.query({
      text: `
        insert into public.friendships (
          user_id_low,
          user_id_high,
          accepted_friend_request_id
        ) values ($1, $2, $3)
      `,
      values: [userIdLow, userIdHigh, friendRequestId],
    });
  }

  it("persists one group target before a single submission and reconciles it to success", async () => {
    const owner = await createUser("owner");
    const first = await createUser("first");
    const second = await createUser("second");
    await makeFriends(owner.ownerUserId, first.ownerUserId);
    await makeFriends(owner.ownerUserId, second.ownerUserId);
    const operationId = randomUUID();
    const requestDigest = digest("group-create");
    const prepared = await repository.prepareGroupOperation({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest,
      name: "Integration desk",
      friendPublicProfileIds: [second.publicProfileId, first.publicProfileId],
    });

    expect(prepared).toMatchObject({
      operationId,
      ownerUserId: owner.ownerUserId,
      status: "pending",
      groupName: "Integration desk",
      targetPublicProfileId: null,
    });
    expect(prepared.channelId).toBe(
      `loop_group_${operationId.replaceAll("-", "")}`,
    );
    expect(prepared.friendPublicProfileIds).toEqual(
      [first.publicProfileId, second.publicProfileId].sort(),
    );

    const replay = await repository.prepareGroupOperation({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest,
      name: "Integration desk",
      friendPublicProfileIds: [first.publicProfileId, second.publicProfileId],
    });
    expect(replay).toEqual(prepared);
    await expect(
      repository.prepareGroupOperation({
        operationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
        requestDigest: digest("changed-group"),
        name: "Changed desk",
        friendPublicProfileIds: [first.publicProfileId, second.publicProfileId],
      }),
    ).rejects.toBeInstanceOf(ChatChannelIdempotencyConflictRepositoryError);

    const submission = await repository.claimSubmission({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
    });
    expect(submission).toEqual({
      operationId,
      kind: "group",
      channelId: prepared.channelId,
      createdByUserId: owner.ownerUserId,
      memberUserIds: [
        owner.ownerUserId,
        first.ownerUserId,
        second.ownerUserId,
      ].sort(),
      name: "Integration desk",
    });
    await repository.markReconciling({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
    });
    const reconciliation = await repository.claimReconciliation({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      submittingBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(reconciliation).toEqual(submission);
    const succeeded = await repository.markSucceeded({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
    expect(typeof succeeded.groupId).toBe("string");
    await expect(
      repository.findOperation({
        operationId,
        ownerUserId: first.ownerUserId,
      }),
    ).resolves.toBeNull();
    const mapping = await pool.query<{
      channel_state: string;
      event_count: string;
    }>({
      text: `
        select
          group_record.channel_state,
          (
            select count(*)::text
            from public.chat_operation_events
            where operation_id = $1
          ) as event_count
        from public.communication_groups as group_record
        where group_record.create_operation_id = $1
      `,
      values: [operationId],
    });
    expect(mapping.rows[0]).toEqual({
      channel_state: "active",
      event_count: "4",
    });
  });

  it("rechecks social privacy immediately before claiming the provider write", async () => {
    const owner = await createUser("privacy-owner");
    const target = await createUser("privacy-target");
    await makeFriends(owner.ownerUserId, target.ownerUserId);
    const operationId = randomUUID();
    const prepared = await repository.prepareDirectOperation({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("privacy-direct"),
      targetPublicProfileId: target.publicProfileId,
    });
    const privacyClient = await pool.connect();
    await privacyClient.query("begin");
    await privacyClient.query({
      text: `
        select id
        from public.loop_users
        where id = $1
        for update
      `,
      values: [target.ownerUserId],
    });
    const claim = repository.claimSubmission({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
    });
    await privacyClient.query({
      text: `
        update public.social_privacy_preferences
        set
          direct_messages = 'disabled',
          record_version = record_version + 1,
          updated_at = clock_timestamp()
        where owner_user_id = $1
      `,
      values: [target.ownerUserId],
    });
    await privacyClient.query("commit");
    privacyClient.release();

    await expect(claim).resolves.toBeNull();
    await expect(
      repository.findOperation({
        operationId,
        ownerUserId: owner.ownerUserId,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "target_unavailable",
      attemptStartedAt: null,
    });
    const cancelled = await pool.query<{
      attempt_count: number;
      channel_state: string;
      event_count: string;
    }>({
      text: `
        select
          operation.attempt_count,
          direct_record.channel_state,
          (
            select count(*)::text
            from public.chat_operation_events
            where operation_id = operation.operation_id
          ) as event_count
        from public.chat_operations as operation
        join public.direct_channels as direct_record
          on direct_record.stream_channel_id = operation.fixed_stream_channel_id
        where operation.operation_id = $1
      `,
      values: [operationId],
    });
    expect(cancelled.rows[0]).toEqual({
      attempt_count: 0,
      channel_state: "cancelled",
      event_count: "2",
    });
    await expect(
      repository.prepareDirectOperation({
        operationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
        requestDigest: digest("privacy-direct"),
        targetPublicProfileId: target.publicProfileId,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "target_unavailable",
    });

    await pool.query({
      text: `
        update public.social_privacy_preferences
        set
          direct_messages = 'friends',
          record_version = record_version + 1,
          updated_at = clock_timestamp()
        where owner_user_id = $1
      `,
      values: [target.ownerUserId],
    });
    const retryOperationId = randomUUID();
    const retry = await repository.prepareDirectOperation({
      operationId: retryOperationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("privacy-direct-retry"),
      targetPublicProfileId: target.publicProfileId,
    });
    expect(retry).toMatchObject({ status: "pending", errorCode: null });
    expect(retry.channelId).not.toBe(prepared.channelId);
    await expect(
      repository.claimSubmission({
        operationId: retryOperationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ channelId: retry.channelId, kind: "direct" });
    await repository.markFailed({
      operationId: retryOperationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      errorCode: "stream_channel_not_created",
    });
    const blockedRetry = await repository.prepareDirectOperation({
      operationId: randomUUID(),
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("privacy-direct-operator-hold"),
      targetPublicProfileId: target.publicProfileId,
    });
    expect(blockedRetry).toMatchObject({
      status: "failed",
      channelId: retry.channelId,
      errorCode: "direct_channel_unavailable",
    });
  });

  it("converges opposite direct requests on one fixed channel and one provider writer", async () => {
    const first = await createUser("direct-first");
    const second = await createUser("direct-second");
    await makeFriends(first.ownerUserId, second.ownerUserId);
    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const [firstPrepared, secondPrepared] = await Promise.all([
      repository.prepareDirectOperation({
        operationId: firstOperationId,
        ownerUserId: first.ownerUserId,
        requestId: randomUUID(),
        requestDigest: digest("direct-first"),
        targetPublicProfileId: second.publicProfileId,
      }),
      repository.prepareDirectOperation({
        operationId: secondOperationId,
        ownerUserId: second.ownerUserId,
        requestId: randomUUID(),
        requestDigest: digest("direct-second"),
        targetPublicProfileId: first.publicProfileId,
      }),
    ]);

    expect(firstPrepared.channelId).toBe(secondPrepared.channelId);
    const firstClaim = await repository.claimSubmission({
      operationId: firstOperationId,
      ownerUserId: first.ownerUserId,
      requestId: randomUUID(),
    });
    const secondClaim = await repository.claimSubmission({
      operationId: secondOperationId,
      ownerUserId: second.ownerUserId,
      requestId: randomUUID(),
    });
    const creator = firstClaim === null ? secondClaim : firstClaim;
    const creatorOperationId =
      firstClaim === null ? secondOperationId : firstOperationId;
    const creatorOwnerUserId =
      firstClaim === null ? second.ownerUserId : first.ownerUserId;
    const waitingOperationId =
      firstClaim === null ? firstOperationId : secondOperationId;
    const waitingOwnerUserId =
      firstClaim === null ? first.ownerUserId : second.ownerUserId;
    expect(creator).not.toBeNull();
    expect(firstClaim === null || secondClaim === null).toBe(true);

    await repository.markSucceeded({
      operationId: creatorOperationId,
      ownerUserId: creatorOwnerUserId,
      requestId: randomUUID(),
    });
    const waiting = await repository.refreshOperation({
      operationId: waitingOperationId,
      ownerUserId: waitingOwnerUserId,
      requestId: randomUUID(),
      pendingBefore: new Date(Date.now() - 20_000).toISOString(),
    });
    expect(waiting).toMatchObject({
      status: "succeeded",
      channelId: firstPrepared.channelId,
    });
    const directCount = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.direct_channels`,
    });
    expect(directCount.rows[0]?.count).toBe("1");
  });

  it("lets a direct waiter atomically dispatch the canonical creator operation", async () => {
    const creatorUser = await createUser("takeover-creator");
    const waiterUser = await createUser("takeover-waiter");
    await makeFriends(creatorUser.ownerUserId, waiterUser.ownerUserId);

    const creatorOperationId = randomUUID();
    const creator = await repository.prepareDirectOperation({
      operationId: creatorOperationId,
      ownerUserId: creatorUser.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("takeover-creator"),
      targetPublicProfileId: waiterUser.publicProfileId,
    });
    const waiterOperationId = randomUUID();
    const waiter = await repository.prepareDirectOperation({
      operationId: waiterOperationId,
      ownerUserId: waiterUser.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("takeover-waiter"),
      targetPublicProfileId: creatorUser.publicProfileId,
    });
    expect(waiter.channelId).toBe(creator.channelId);

    const expectation = await repository.claimSubmission({
      operationId: waiterOperationId,
      ownerUserId: waiterUser.ownerUserId,
      requestId: randomUUID(),
    });
    expect(expectation).toMatchObject({
      operationId: creatorOperationId,
      channelId: creator.channelId,
      createdByUserId: creatorUser.ownerUserId,
    });
    await expect(
      repository.claimSubmission({
        operationId: creatorOperationId,
        ownerUserId: creatorUser.ownerUserId,
        requestId: randomUUID(),
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findCanonicalDirectOperation({
        operationId: waiterOperationId,
        ownerUserId: waiterUser.ownerUserId,
      }),
    ).resolves.toMatchObject({
      operationId: creatorOperationId,
      ownerUserId: creatorUser.ownerUserId,
      status: "submitting",
      channelId: creator.channelId,
    });

    await repository.markSucceeded({
      operationId: creatorOperationId,
      ownerUserId: creatorUser.ownerUserId,
      requestId: randomUUID(),
    });
    await expect(
      repository.refreshOperation({
        operationId: waiterOperationId,
        ownerUserId: waiterUser.ownerUserId,
        requestId: randomUUID(),
        pendingBefore: new Date(Date.now() - 20_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      operationId: waiterOperationId,
      status: "succeeded",
      channelId: creator.channelId,
    });
  });

  it("expires stale undispatched group, direct creator, and direct waiter operations safely", async () => {
    const owner = await createUser("dispatch-owner");
    const first = await createUser("dispatch-first");
    const second = await createUser("dispatch-second");
    await makeFriends(owner.ownerUserId, first.ownerUserId);
    await makeFriends(owner.ownerUserId, second.ownerUserId);
    const pendingBefore = new Date(Date.now() + 60_000).toISOString();

    const groupOperationId = randomUUID();
    await repository.prepareGroupOperation({
      operationId: groupOperationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("stale-group"),
      name: "Stale group",
      friendPublicProfileIds: [first.publicProfileId, second.publicProfileId],
    });
    await expect(
      repository.refreshOperation({
        operationId: groupOperationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
        pendingBefore,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "submission_not_started",
      attemptStartedAt: null,
    });
    await expect(
      repository.claimSubmission({
        operationId: groupOperationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
      }),
    ).resolves.toBeNull();
    const cancelledGroup = await pool.query<{
      channel_state: string;
      event_count: string;
    }>({
      text: `
        select
          group_record.channel_state,
          (
            select count(*)::text
            from public.chat_operation_events
            where operation_id = $1
          ) as event_count
        from public.communication_groups as group_record
        where group_record.create_operation_id = $1
      `,
      values: [groupOperationId],
    });
    expect(cancelledGroup.rows[0]).toEqual({
      channel_state: "cancelled",
      event_count: "2",
    });

    const creatorOperationId = randomUUID();
    const creator = await repository.prepareDirectOperation({
      operationId: creatorOperationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("stale-direct-creator"),
      targetPublicProfileId: first.publicProfileId,
    });
    const waiterOperationId = randomUUID();
    const waiter = await repository.prepareDirectOperation({
      operationId: waiterOperationId,
      ownerUserId: first.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("stale-direct-waiter"),
      targetPublicProfileId: owner.publicProfileId,
    });
    expect(waiter.channelId).toBe(creator.channelId);

    await expect(
      repository.refreshOperation({
        operationId: waiterOperationId,
        ownerUserId: first.ownerUserId,
        requestId: randomUUID(),
        pendingBefore,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "direct_channel_unavailable",
      attemptStartedAt: null,
    });
    const cancelledByWaiter = await pool.query<{ channel_state: string }>({
      text: `
        select channel_state
        from public.direct_channels
        where stream_channel_id = $1
      `,
      values: [creator.channelId],
    });
    expect(cancelledByWaiter.rows[0]?.channel_state).toBe("cancelled");

    await expect(
      repository.refreshOperation({
        operationId: creatorOperationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
        pendingBefore,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "submission_not_started",
      attemptStartedAt: null,
    });
    const cancelledDirect = await pool.query<{ channel_state: string }>({
      text: `
        select channel_state
        from public.direct_channels
        where stream_channel_id = $1
      `,
      values: [creator.channelId],
    });
    expect(cancelledDirect.rows[0]?.channel_state).toBe("cancelled");

    const retry = await repository.prepareDirectOperation({
      operationId: randomUUID(),
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("stale-direct-retry"),
      targetPublicProfileId: first.publicProfileId,
    });
    expect(retry).toMatchObject({ status: "pending", errorCode: null });
    expect(retry.channelId).not.toBe(creator.channelId);
  });

  it("persists an authoritative provider mismatch as operator_required", async () => {
    const owner = await createUser("operator-owner");
    const first = await createUser("operator-first");
    const second = await createUser("operator-second");
    await makeFriends(owner.ownerUserId, first.ownerUserId);
    await makeFriends(owner.ownerUserId, second.ownerUserId);
    const operationId = randomUUID();
    await repository.prepareGroupOperation({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
      requestDigest: digest("operator-group"),
      name: "Operator group",
      friendPublicProfileIds: [first.publicProfileId, second.publicProfileId],
    });
    await repository.claimSubmission({
      operationId,
      ownerUserId: owner.ownerUserId,
      requestId: randomUUID(),
    });

    await expect(
      repository.markOperatorRequired({
        operationId,
        ownerUserId: owner.ownerUserId,
        requestId: randomUUID(),
        errorCode: "stream_channel_projection_mismatch",
      }),
    ).resolves.toMatchObject({
      status: "operator_required",
      errorCode: "stream_channel_projection_mismatch",
    });
    const persisted = await pool.query<{
      channel_state: string;
      event_count: string;
    }>({
      text: `
        select
          group_record.channel_state,
          (
            select count(*)::text
            from public.chat_operation_events
            where operation_id = $1
          ) as event_count
        from public.communication_groups as group_record
        where group_record.create_operation_id = $1
      `,
      values: [operationId],
    });
    expect(persisted.rows[0]).toEqual({
      channel_state: "operator_required",
      event_count: "3",
    });
  });
});
