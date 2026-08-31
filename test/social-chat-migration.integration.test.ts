import { createHash, randomUUID } from "node:crypto";

import pg, { type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

describe("social and Chat closed-loop migration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("begin");
  });

  afterEach(async () => {
    try {
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(label: string): Promise<string> {
    const result = await client.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`did:privy:social-migration:${label}:${randomUUID()}`],
    });
    const ownerUserId = result.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Migration owner setup failed");
    }
    return ownerUserId;
  }

  async function expectStatementRejected(
    statement: () => Promise<unknown>,
  ): Promise<void> {
    await client.query("savepoint expected_rejection");
    await expect(statement()).rejects.toBeDefined();
    await client.query("rollback to savepoint expected_rejection");
    await client.query("release savepoint expected_rejection");
  }

  async function insertChatOperation(input: {
    readonly ownerUserId: string;
    readonly kind: "group_create" | "direct_get_or_create";
    readonly channelId: string;
    readonly label: string;
  }): Promise<string> {
    const operationId = randomUUID();
    const requestDigest = digest(input.label);
    const idempotency = await client.query<{ id: string }>({
      text: `
        insert into public.idempotency_records (
          owner_user_id,
          scope,
          idempotency_key,
          key_source,
          request_sha256,
          digest_version
        ) values ($1, 'chat_channel_command', $2, 'client', $3,
          'chat_channel_command_v1')
        returning id
      `,
      values: [input.ownerUserId, operationId, requestDigest],
    });
    const idempotencyRecordId = idempotency.rows[0]?.id;
    if (idempotencyRecordId === undefined) {
      throw new Error("Chat idempotency setup failed");
    }
    await client.query({
      text: `
        insert into public.chat_operations (
          operation_id,
          owner_user_id,
          idempotency_record_id,
          request_sha256,
          operation_kind,
          fixed_stream_channel_id
        ) values ($1, $2, $3, $4, $5, $6)
      `,
      values: [
        operationId,
        input.ownerUserId,
        idempotencyRecordId,
        requestDigest,
        input.kind,
        input.channelId,
      ],
    });
    await client.query({
      text: `
        insert into public.chat_operation_events (
          operation_id,
          owner_user_id,
          request_id,
          from_state,
          to_state,
          operation_version
        ) values ($1, $2, $3, null, 'pending', 0)
      `,
      values: [operationId, input.ownerUserId, randomUUID()],
    });
    return operationId;
  }

  it("assigns non-reused fixed-width Crockford profile codes and makes them immutable", async () => {
    const ownerA = await createOwner("profile-a");
    const ownerB = await createOwner("profile-b");
    const profiles = await client.query<{ profile_code: string }>({
      text: `
        insert into public.user_profiles (owner_user_id, alias)
        values ($1, 'A'), ($2, 'B')
        returning profile_code
      `,
      values: [ownerA, ownerB],
    });
    expect(profiles.rows).toHaveLength(2);
    expect(
      new Set(profiles.rows.map(({ profile_code }) => profile_code)).size,
    ).toBe(2);
    for (const { profile_code } of profiles.rows) {
      expect(profile_code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    }
    const encodings = await client.query<{
      one: string;
      thirty_one: string;
      thirty_two: string;
      maximum: string;
    }>(`
      select
        public.loop_profile_code_from_sequence(1) as one,
        public.loop_profile_code_from_sequence(31) as thirty_one,
        public.loop_profile_code_from_sequence(32) as thirty_two,
        public.loop_profile_code_from_sequence(1125899906842623) as maximum
    `);
    expect(encodings.rows[0]).toEqual({
      one: "0000000001",
      thirty_one: "000000000Z",
      thirty_two: "0000000010",
      maximum: "ZZZZZZZZZZ",
    });
    await expectStatementRejected(() =>
      client.query({
        text: `update public.user_profiles set profile_code = $2 where owner_user_id = $1`,
        values: [ownerA, "0000000000"],
      }),
    );
  });

  it("enforces one pending unordered request and requires an accepted matching source for friendship", async () => {
    const ownerA = await createOwner("friend-a");
    const ownerB = await createOwner("friend-b");
    const request = await client.query<{ friend_request_id: string }>({
      text: `
        insert into public.friend_requests (
          requester_user_id,
          recipient_user_id,
          expires_at
        ) values ($1, $2, clock_timestamp() + interval '7 days')
        returning friend_request_id
      `,
      values: [ownerA, ownerB],
    });
    const friendRequestId = request.rows[0]?.friend_request_id;
    if (friendRequestId === undefined) {
      throw new Error("Friend request setup failed");
    }
    await expectStatementRejected(() =>
      client.query({
        text: `
          insert into public.friend_requests (
            requester_user_id,
            recipient_user_id,
            expires_at
          ) values ($1, $2, clock_timestamp() + interval '7 days')
        `,
        values: [ownerB, ownerA],
      }),
    );
    await expectStatementRejected(() =>
      client.query({
        text: `
          insert into public.friendships (
            user_id_low,
            user_id_high,
            accepted_friend_request_id
          ) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), $3)
        `,
        values: [ownerA, ownerB, friendRequestId],
      }),
    );
    await client.query({
      text: `
        update public.friend_requests
        set
          status = 'accepted',
          decided_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where friend_request_id = $1
      `,
      values: [friendRequestId],
    });
    await expect(
      client.query({
        text: `
          insert into public.friendships (
            user_id_low,
            user_id_high,
            accepted_friend_request_id,
            accepted_at
          ) values (
            least($1::uuid, $2::uuid),
            greatest($1::uuid, $2::uuid),
            $3,
            clock_timestamp()
          )
        `,
        values: [ownerA, ownerB, friendRequestId],
      }),
    ).resolves.toBeDefined();
    await expectStatementRejected(() =>
      client.query({
        text: `
          update public.friend_requests
          set status = 'rejected', rejection_cooldown_until = clock_timestamp()
          where friend_request_id = $1
        `,
        values: [friendRequestId],
      }),
    );
  });

  it("binds backend-created group/direct mappings to fixed-ID Chat operations and immutable member sets", async () => {
    const ownerA = await createOwner("chat-a");
    const ownerB = await createOwner("chat-b");
    const ownerC = await createOwner("chat-c");
    const groupChannelId = `loop_group_${randomUUID().replaceAll("-", "")}`;
    const groupOperationId = await insertChatOperation({
      ownerUserId: ownerA,
      kind: "group_create",
      channelId: groupChannelId,
      label: "group",
    });
    const group = await client.query<{ group_id: string }>({
      text: `
        insert into public.communication_groups (
          stream_channel_id,
          channel_kind,
          name,
          create_operation_id,
          channel_state
        ) values ($1, 'group', 'Test Group', $2, 'pending')
        returning group_id
      `,
      values: [groupChannelId, groupOperationId],
    });
    const groupId = group.rows[0]?.group_id;
    if (groupId === undefined) {
      throw new Error("Communication group setup failed");
    }
    await client.query({
      text: `
        insert into public.communication_group_members (
          group_id,
          owner_user_id,
          member_role
        ) values ($1, $2, 'creator'), ($1, $3, 'member'), ($1, $4, 'member')
      `,
      values: [groupId, ownerA, ownerB, ownerC],
    });
    await expectStatementRejected(() =>
      client.query({
        text: `
          insert into public.communication_group_members (
            group_id,
            owner_user_id,
            member_role
          ) values ($1, $2, 'creator')
        `,
        values: [groupId, ownerB],
      }),
    );
    await expectStatementRejected(() =>
      client.query({
        text: `
          update public.communication_groups
          set stream_channel_id = $2
          where group_id = $1
        `,
        values: [groupId, `loop_group_${randomUUID().replaceAll("-", "")}`],
      }),
    );

    const directChannelId = `loop_direct_${randomUUID().replaceAll("-", "")}`;
    const directOperationId = await insertChatOperation({
      ownerUserId: ownerA,
      kind: "direct_get_or_create",
      channelId: directChannelId,
      label: "direct-first",
    });
    await client.query({
      text: `
        insert into public.direct_channels (
          user_id_low,
          user_id_high,
          stream_channel_id,
          create_operation_id
        ) values (
          least($1::uuid, $2::uuid),
          greatest($1::uuid, $2::uuid),
          $3,
          $4
        )
      `,
      values: [ownerA, ownerB, directChannelId, directOperationId],
    });
    await expect(
      insertChatOperation({
        ownerUserId: ownerB,
        kind: "direct_get_or_create",
        channelId: directChannelId,
        label: "direct-second-key-same-channel",
      }),
    ).resolves.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
