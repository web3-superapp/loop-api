import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SocialFriendRequestAlreadyDecidedError,
  SocialIdempotencyConflictError,
  SocialIncomingRequestPendingError,
  SocialPrivacyVersionConflictError,
  SocialTargetUnavailableError,
  createPostgresSocialRepository,
  type SocialRepository,
} from "../src/database/social-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

describe("PostgreSQL social repository", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const ownedUserIds = new Set<string>();
  let repository: SocialRepository;

  beforeAll(() => {
    repository = createPostgresSocialRepository(pool);
  });

  async function cleanup(): Promise<void> {
    await pool.query(`
      truncate table
    public.community_review_notes,
    public.launch2_snapshot_publication_releases,
    public.launch_project_rejections,
    public.launch_project_approvals,
    public.hooks_launch_config_rejections,
    public.hooks_launch_owner_config_versions,
    public.launch2_snapshot_closures,
    public.launch2_buyback_attempts,
    public.launch2_pool_swaps,
    public.launch2_snapshot_publications,
    public.launch2_intents,
    public.mining_reward_ledger_events,
    public.mining_reward_balances,
    public.mining_claims,
    public.mining_epoch_rewards,
    public.mining_epochs,
    public.mining_parameter_versions,
    public.launch2_positions,
    public.launch2_snapshot_members,
    public.launch2_buybacks,
    public.launch2_trades,
    public.launch2_nft_mints,
    public.launch2_events,
    public.launch2_meme_transfers,
    public.launch2_instances,
    public.meme_intents,
    public.meme_holders,
    public.meme_trades,
    public.meme_indexed_events,
    public.meme_salts,
    public.meme_tokens,
        public.community_member_buy_events,
        public.media_objects,
        public.push_deliveries,
        public.device_push_token_commands,
        public.device_push_tokens,
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
        delete from public.user_blocks
        where owner_user_id = any($1::uuid[])
          or target_user_id = any($1::uuid[])
      `,
      values: [ids],
    });
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

  async function createUser(input: {
    readonly label: string;
    readonly alias: string;
    readonly discoverable?: boolean;
    readonly friendRequests?: "enabled" | "disabled";
  }): Promise<{
    readonly ownerUserId: string;
    readonly publicProfileId: string;
    readonly profileCode: string;
  }> {
    const owner = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:social:${input.label}:${randomUUID()}`],
    });
    const ownerUserId = owner.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Social owner setup failed");
    }
    ownedUserIds.add(ownerUserId);
    const profile = await pool.query<{
      profile_code: string;
      public_profile_id: string;
    }>({
      text: `
        insert into public.user_profiles (owner_user_id, alias)
        values ($1, $2)
        returning public_profile_id, profile_code
      `,
      values: [ownerUserId, input.alias],
    });
    const publicProfileId = profile.rows[0]?.public_profile_id;
    const profileCode = profile.rows[0]?.profile_code;
    if (publicProfileId === undefined || profileCode === undefined) {
      throw new Error("Social profile setup failed");
    }
    await pool.query({
      text: `
        insert into public.privacy_preferences (
          owner_user_id,
          discoverable,
          copy_trade_visibility
        ) values ($1, $2, 'private')
      `,
      values: [ownerUserId, input.discoverable ?? true],
    });
    await pool.query({
      text: `
        insert into public.social_privacy_preferences (
          owner_user_id,
          friend_requests,
          group_invites,
          direct_messages
        ) values ($1, $2, 'friends', 'friends')
      `,
      values: [ownerUserId, input.friendRequests ?? "enabled"],
    });
    return Object.freeze({ ownerUserId, publicProfileId, profileCode });
  }

  function sendInput(input: {
    readonly ownerUserId: string;
    readonly targetPublicProfileId: string;
    readonly idempotencyKey?: string;
    readonly suffix: string;
  }) {
    return Object.freeze({
      ownerUserId: input.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      requestSha256: digest(`send:${input.suffix}`),
      targetPublicProfileId: input.targetPublicProfileId,
    });
  }

  it("keeps social privacy fail closed and applies natural CAS replay", async () => {
    const owner = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:social-privacy:${randomUUID()}`],
    });
    const ownerUserId = owner.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Social privacy owner setup failed");
    }
    ownedUserIds.add(ownerUserId);

    await expect(repository.getSocialPrivacy(ownerUserId)).resolves.toBeNull();
    await expect(
      repository.replaceSocialPrivacy({
        ownerUserId,
        expectedVersion: 1,
        privacy: {
          friend_requests: "disabled",
          group_invites: "disabled",
          direct_messages: "disabled",
        },
      }),
    ).rejects.toBeInstanceOf(SocialPrivacyVersionConflictError);
    const created = await repository.replaceSocialPrivacy({
      ownerUserId,
      expectedVersion: 0,
      privacy: {
        friend_requests: "disabled",
        group_invites: "disabled",
        direct_messages: "disabled",
      },
    });
    expect(created).toMatchObject({
      version: 1,
      friendRequests: "disabled",
      groupInvites: "disabled",
      directMessages: "disabled",
    });
    await expect(
      repository.replaceSocialPrivacy({
        ownerUserId,
        expectedVersion: 0,
        privacy: {
          friend_requests: "disabled",
          group_invites: "disabled",
          direct_messages: "disabled",
        },
      }),
    ).resolves.toEqual(created);
    await expect(
      repository.replaceSocialPrivacy({
        ownerUserId,
        expectedVersion: 0,
        privacy: {
          friend_requests: "enabled",
          group_invites: "friends",
          direct_messages: "friends",
        },
      }),
    ).rejects.toBeInstanceOf(SocialPrivacyVersionConflictError);
  });

  it("supports discovery, exact command replay, explicit acceptance, and stable friend projections", async () => {
    const alice = await createUser({ label: "alice", alias: "Alice" });
    const bob = await createUser({ label: "bob", alias: "Alice Builder" });
    const hidden = await createUser({
      label: "hidden",
      alias: "Alice Hidden",
      friendRequests: "disabled",
    });
    const missingPrivacy = await createUser({
      label: "missing-social-privacy",
      alias: "Alice Missing",
    });
    await pool.query({
      text: `
        delete from public.social_privacy_preferences
        where owner_user_id = $1
      `,
      values: [missingPrivacy.ownerUserId],
    });

    const initialSearch = await repository.searchFriends({
      ownerUserId: alice.ownerUserId,
      aliasPrefix: "al",
      limit: 20,
    });
    expect(initialSearch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicProfileId: bob.publicProfileId,
          profileCode: bob.profileCode,
          relationship: "none",
          friendRequestId: null,
        }),
      ]),
    );
    expect(
      initialSearch.find(
        ({ publicProfileId }) => publicProfileId === hidden.publicProfileId,
      ),
    ).toBeUndefined();
    // Decision 0070: no social privacy row is the open default, so the
    // account is listed and can receive a request.
    expect(
      initialSearch.find(
        ({ publicProfileId }) =>
          publicProfileId === missingPrivacy.publicProfileId,
      ),
    ).toMatchObject({ relationship: "none", friendRequestId: null });
    const toMissing = await repository.sendFriendRequest(
      sendInput({
        ownerUserId: alice.ownerUserId,
        targetPublicProfileId: missingPrivacy.publicProfileId,
        suffix: "alice-missing",
      }),
    );
    expect(toMissing.created).toBe(true);
    expect(toMissing.operation.result).toMatchObject({ status: "pending" });

    const command = sendInput({
      ownerUserId: alice.ownerUserId,
      targetPublicProfileId: bob.publicProfileId,
      suffix: "alice-bob",
    });
    await expect(
      repository.preflightSocialCommand({
        ownerUserId: command.ownerUserId,
        idempotencyKey: command.idempotencyKey,
        requestSha256: command.requestSha256,
        kind: "friend_request_send",
      }),
    ).resolves.toEqual({ status: "new" });
    const created = await repository.sendFriendRequest(command);
    await expect(
      repository.preflightSocialCommand({
        ownerUserId: command.ownerUserId,
        idempotencyKey: command.idempotencyKey,
        requestSha256: command.requestSha256,
        kind: "friend_request_send",
      }),
    ).resolves.toEqual({ status: "replay" });
    const replay = await repository.sendFriendRequest({
      ...command,
      requestId: randomUUID(),
    });
    expect(created.created).toBe(true);
    expect(replay).toMatchObject({
      created: false,
      operation: created.operation,
      request: created.request,
    });
    expect(created.operation.operationId).toBe(command.idempotencyKey);
    expect(created.operation.result).toMatchObject({ status: "pending" });

    await pool.query({
      text: `
        update public.social_privacy_preferences
        set friend_requests = 'disabled'
        where owner_user_id = $1
      `,
      values: [bob.ownerUserId],
    });

    await expect(
      repository.preflightSocialCommand({
        ownerUserId: command.ownerUserId,
        idempotencyKey: command.idempotencyKey,
        requestSha256: digest("changed-body"),
        kind: "friend_request_send",
      }),
    ).rejects.toBeInstanceOf(SocialIdempotencyConflictError);
    await expect(
      repository.sendFriendRequest({
        ...command,
        requestId: randomUUID(),
        requestSha256: digest("changed-body"),
        targetPublicProfileId: hidden.publicProfileId,
      }),
    ).rejects.toBeInstanceOf(SocialIdempotencyConflictError);

    const aliceSearch = await repository.searchFriends({
      ownerUserId: alice.ownerUserId,
      aliasPrefix: "al",
      limit: 20,
    });
    expect(
      aliceSearch.find(
        ({ publicProfileId }) => publicProfileId === bob.publicProfileId,
      ),
    ).toMatchObject({
      relationship: "outgoing_pending",
      friendRequestId: created.request?.friendRequestId,
    });
    const bobIncoming = await repository.listFriendRequests({
      ownerUserId: bob.ownerUserId,
      direction: "incoming",
      status: "pending",
      limit: 20,
    });
    expect(bobIncoming).toHaveLength(1);
    expect(bobIncoming[0]).toMatchObject({
      direction: "incoming",
      counterpartyPublicProfileId: alice.publicProfileId,
      status: "pending",
    });

    const friendRequestId = created.request?.friendRequestId;
    if (friendRequestId === undefined) {
      throw new Error("Friend request was not returned");
    }
    const accepted = await repository.decideFriendRequest({
      ownerUserId: bob.ownerUserId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestSha256: digest("accept-alice-bob"),
      friendRequestId,
      decision: "accept",
    });
    expect(accepted.operation.result).toEqual({
      friendRequestId,
      status: "accepted",
    });
    expect(accepted.friendship).toMatchObject({
      publicProfileId: alice.publicProfileId,
      profileCode: alice.profileCode,
    });

    await expect(
      repository.listFriends({ ownerUserId: alice.ownerUserId, limit: 20 }),
    ).resolves.toEqual([
      expect.objectContaining({
        publicProfileId: bob.publicProfileId,
        profileCode: bob.profileCode,
        alias: "Alice Builder",
      }),
    ]);
    await expect(
      repository.searchFriends({
        ownerUserId: alice.ownerUserId,
        aliasPrefix: "al",
        limit: 20,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicProfileId: bob.publicProfileId,
          relationship: "friend",
          friendRequestId: null,
        }),
      ]),
    );
    await expect(
      repository.getSocialOperation(
        bob.ownerUserId,
        accepted.operation.operationId,
      ),
    ).resolves.toEqual(accepted.operation);
    await expect(
      repository.getSocialOperation(
        alice.ownerUserId,
        accepted.operation.operationId,
      ),
    ).resolves.toBeNull();

    await expect(
      repository.sendFriendRequest(
        sendInput({
          ownerUserId: alice.ownerUserId,
          targetPublicProfileId: hidden.publicProfileId,
          suffix: "hidden-target",
        }),
      ),
    ).rejects.toBeInstanceOf(SocialTargetUnavailableError);
    await expect(
      repository.sendFriendRequest(
        sendInput({
          ownerUserId: alice.ownerUserId,
          targetPublicProfileId: alice.publicProfileId,
          suffix: "self-target",
        }),
      ),
    ).rejects.toBeInstanceOf(SocialTargetUnavailableError);
  });

  it("admits targets regardless of discoverable and refuses disabled or blocked ones (Decision 0096)", async () => {
    const sender = await createUser({ label: "s107b-sender", alias: "Sender" });
    const bare = await createUser({ label: "s107b-bare", alias: "Bare" });
    await pool.query({
      text: `delete from public.social_privacy_preferences where owner_user_id = $1`,
      values: [bare.ownerUserId],
    });
    await pool.query({
      text: `delete from public.privacy_preferences where owner_user_id = $1`,
      values: [bare.ownerUserId],
    });
    const notDiscoverable = await createUser({
      label: "s107b-hidden",
      alias: "Hidden",
      discoverable: false,
    });
    const closed = await createUser({
      label: "s107b-closed",
      alias: "Closed",
      discoverable: false,
      friendRequests: "disabled",
    });
    const blockedByTarget = await createUser({
      label: "s107b-blocker",
      alias: "Blocker",
    });
    const blockedBySender = await createUser({
      label: "s107b-blocked",
      alias: "Blocked",
    });
    await pool.query({
      text: `
        insert into public.user_blocks (
          owner_user_id, kind, stable_id, target_user_id
        ) values
          ($1, 'user', $2, $3),
          ($3, 'user', $4, $5)
      `,
      values: [
        blockedByTarget.ownerUserId,
        sender.publicProfileId,
        sender.ownerUserId,
        blockedBySender.publicProfileId,
        blockedBySender.ownerUserId,
      ],
    });

    const toBare = await repository.sendFriendRequest(
      sendInput({
        ownerUserId: sender.ownerUserId,
        targetPublicProfileId: bare.publicProfileId,
        suffix: "s107b-bare",
      }),
    );
    expect(toBare.created).toBe(true);
    expect(toBare.operation.result).toMatchObject({ status: "pending" });

    const toHidden = await repository.sendFriendRequest(
      sendInput({
        ownerUserId: sender.ownerUserId,
        targetPublicProfileId: notDiscoverable.publicProfileId,
        suffix: "s107b-hidden",
      }),
    );
    expect(toHidden.created).toBe(true);
    expect(toHidden.operation.result).toMatchObject({ status: "pending" });

    for (const target of [closed, blockedByTarget, blockedBySender]) {
      await expect(
        repository.sendFriendRequest(
          sendInput({
            ownerUserId: sender.ownerUserId,
            targetPublicProfileId: target.publicProfileId,
            suffix: `s107b-refused-${target.publicProfileId}`,
          }),
        ),
      ).rejects.toBeInstanceOf(SocialTargetUnavailableError);
    }

    // Search still honours discoverable (Decision 0090 unchanged).
    const search = await repository.searchFriends({
      ownerUserId: sender.ownerUserId,
      aliasPrefix: "hi",
      limit: 20,
    });
    expect(
      search.find(
        ({ publicProfileId }) =>
          publicProfileId === notDiscoverable.publicProfileId,
      ),
    ).toBeUndefined();
  });

  it("serializes reverse sends and concurrent decisions so only the first transition wins", async () => {
    const alice = await createUser({
      label: "race-alice",
      alias: "Race Alice",
    });
    const bob = await createUser({ label: "race-bob", alias: "Race Bob" });
    const sends = await Promise.allSettled([
      repository.sendFriendRequest(
        sendInput({
          ownerUserId: alice.ownerUserId,
          targetPublicProfileId: bob.publicProfileId,
          suffix: "race-a-b",
        }),
      ),
      repository.sendFriendRequest(
        sendInput({
          ownerUserId: bob.ownerUserId,
          targetPublicProfileId: alice.publicProfileId,
          suffix: "race-b-a",
        }),
      ),
    ]);
    expect(sends.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejectedSend = sends.find(({ status }) => status === "rejected");
    expect(rejectedSend?.status).toBe("rejected");
    if (rejectedSend?.status !== "rejected") {
      throw new Error("Expected one reverse request to be rejected");
    }
    const rejectedSendReason: unknown = rejectedSend.reason;
    expect(rejectedSendReason).toBeInstanceOf(
      SocialIncomingRequestPendingError,
    );

    const pending = await pool.query<{
      friend_request_id: string;
      recipient_user_id: string;
    }>(`
      select friend_request_id, recipient_user_id
      from public.friend_requests
      where status = 'pending'
    `);
    expect(pending.rows).toHaveLength(1);
    const pendingRow = pending.rows[0];
    if (pendingRow === undefined) {
      throw new Error("Pending request was not stored");
    }

    const decisions = await Promise.allSettled([
      repository.decideFriendRequest({
        ownerUserId: pendingRow.recipient_user_id,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestSha256: digest("race-accept"),
        friendRequestId: pendingRow.friend_request_id,
        decision: "accept",
      }),
      repository.decideFriendRequest({
        ownerUserId: pendingRow.recipient_user_id,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestSha256: digest("race-reject"),
        friendRequestId: pendingRow.friend_request_id,
        decision: "reject",
      }),
    ]);
    expect(
      decisions.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejectedDecision = decisions.find(
      ({ status }) => status === "rejected",
    );
    expect(rejectedDecision?.status).toBe("rejected");
    if (rejectedDecision?.status !== "rejected") {
      throw new Error("Expected one decision to lose the terminal race");
    }
    const rejectedDecisionReason: unknown = rejectedDecision.reason;
    expect(rejectedDecisionReason).toBeInstanceOf(
      SocialFriendRequestAlreadyDecidedError,
    );
    const state = await pool.query<{ count: string; status: string }>({
      text: `
        select
          request.status,
          (select count(*)::text from public.friendships) as count
        from public.friend_requests as request
        where request.friend_request_id = $1
      `,
      values: [pendingRow.friend_request_id],
    });
    expect(["accepted", "rejected"]).toContain(state.rows[0]?.status);
    expect(["0", "1"]).toContain(state.rows[0]?.count);
    expect(state.rows[0]?.count).toBe(
      state.rows[0]?.status === "accepted" ? "1" : "0",
    );
  });
});
