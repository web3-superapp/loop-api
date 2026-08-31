import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import {
  ChatChannelIdempotencyConflictRepositoryError,
  ChatChannelRepositoryUnavailableError,
  ChatChannelTargetUnavailableRepositoryError,
  type ChatChannelExpectation,
  type ChatChannelRepository,
  type ChatOperationRecord,
  type ClaimChatReconciliationInput,
  type FailChatOperationInput,
  type LocateChatOperationInput,
  type PrepareDirectChatOperationInput,
  type PrepareGroupChatOperationInput,
  type RefreshChatOperationInput,
  type TransitionChatOperationInput,
} from "../features/communication/chat-channel-repository.js";

const chatIdempotencyScope = "chat_channel_command";
const chatDigestVersion = "chat_channel_command_v1";
const providerAttemptDurationMilliseconds = 10_000;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const channelIdPattern = /^loop_(?:group|direct)_[0-9a-f]{32}$/;
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const profileCodePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const forbiddenNameCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const uuidSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const chatStatusSchema = z.enum([
  "pending",
  "submitting",
  "reconciling",
  "succeeded",
  "failed",
  "operator_required",
]);
const chatKindSchema = z.enum(["group_create", "direct_get_or_create"]);
const groupNameSchema = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 60 &&
      !forbiddenNameCharacters.test(value),
  );

const operationRowSchema = z
  .object({
    operation_id: uuidV4Schema,
    owner_user_id: uuidSchema,
    request_sha256: z.string().regex(digestPattern),
    operation_kind: chatKindSchema,
    state: chatStatusSchema,
    fixed_stream_channel_id: z.string().regex(channelIdPattern),
    attempt_committed_at: dateSchema.nullable(),
    result_json: z.record(z.string(), z.unknown()).nullable(),
    error_code: z.string().regex(codePattern).nullable(),
    created_at: dateSchema,
    updated_at: dateSchema,
    group_id: uuidSchema.nullable(),
    group_name: z.string().nullable(),
    friend_public_profile_ids: z.array(uuidSchema),
    target_public_profile_id: uuidSchema.nullable(),
  })
  .strict();

const lockedOperationRowSchema = z
  .object({
    operation_id: uuidV4Schema,
    owner_user_id: uuidSchema,
    operation_kind: chatKindSchema,
    state: chatStatusSchema,
    fixed_stream_channel_id: z.string().regex(channelIdPattern),
    attempt_committed_at: dateSchema.nullable(),
    created_at: dateSchema,
  })
  .strict();

const transitionRowSchema = z
  .object({
    state: chatStatusSchema,
    record_version: z.string().regex(/^\d+$/),
    transport_attempt_id: uuidSchema.nullable(),
    error_code: z.string().regex(codePattern).nullable(),
  })
  .strict();

const idempotencyRowSchema = z.object({ id: uuidSchema }).strict();
const targetRowSchema = z
  .object({
    owner_user_id: uuidSchema,
    public_profile_id: uuidSchema,
    profile_code: z.string().regex(profileCodePattern),
  })
  .strict();
const directRowSchema = z
  .object({
    user_id_low: uuidSchema,
    user_id_high: uuidSchema,
    stream_channel_id: z.string().regex(/^loop_direct_[0-9a-f]{32}$/),
    create_operation_id: uuidV4Schema,
    channel_state: z.enum([
      "pending",
      "active",
      "cancelled",
      "operator_required",
    ]),
    created_by_user_id: uuidSchema,
  })
  .strict();

const prepareBaseSchema = z
  .object({
    operationId: uuidV4Schema,
    ownerUserId: uuidSchema,
    requestId: uuidV4Schema,
    requestDigest: z.string().regex(digestPattern),
  })
  .strict();
const prepareGroupSchema = prepareBaseSchema
  .extend({
    name: groupNameSchema,
    friendPublicProfileIds: z
      .array(uuidSchema)
      .min(2)
      .max(29)
      .refine((value) => new Set(value).size === value.length),
  })
  .strict();
const prepareDirectSchema = prepareBaseSchema
  .extend({ targetPublicProfileId: uuidSchema })
  .strict();
const locateSchema = z
  .object({ operationId: uuidV4Schema, ownerUserId: uuidSchema })
  .strict();
const transitionSchema = locateSchema
  .extend({ requestId: uuidV4Schema })
  .strict();
const refreshSchema = transitionSchema
  .extend({ pendingBefore: z.string().datetime({ offset: true }) })
  .strict();
const reconcileSchema = transitionSchema
  .extend({ submittingBefore: z.string().datetime({ offset: true }) })
  .strict();
const failSchema = transitionSchema
  .extend({ errorCode: z.string().regex(codePattern) })
  .strict();

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

function toOperationRecord(value: unknown): ChatOperationRecord {
  const row = operationRowSchema.parse(value);
  const friendPublicProfileIds = Object.freeze([
    ...row.friend_public_profile_ids,
  ]);
  if (
    (row.operation_kind === "group_create" &&
      (!row.fixed_stream_channel_id.startsWith("loop_group_") ||
        row.group_id === null ||
        row.group_name === null ||
        friendPublicProfileIds.length < 2 ||
        friendPublicProfileIds.length > 29 ||
        row.target_public_profile_id !== null)) ||
    (row.operation_kind === "direct_get_or_create" &&
      (!row.fixed_stream_channel_id.startsWith("loop_direct_") ||
        row.group_id !== null ||
        row.group_name !== null ||
        friendPublicProfileIds.length !== 0 ||
        row.target_public_profile_id === null)) ||
    (row.state === "succeeded" && row.result_json === null) ||
    ((row.state === "failed" || row.state === "operator_required") &&
      row.error_code === null)
  ) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  return Object.freeze({
    operationId: row.operation_id,
    ownerUserId: row.owner_user_id,
    kind: row.operation_kind,
    requestDigest: row.request_sha256,
    status: row.state,
    channelId: row.fixed_stream_channel_id,
    groupId: row.group_id,
    groupName: row.group_name,
    friendPublicProfileIds,
    targetPublicProfileId: row.target_public_profile_id,
    errorCode: row.error_code,
    attemptStartedAt: row.attempt_committed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

async function readOperation(
  client: DatabaseClient,
  ownerUserId: string,
  operationId: string,
): Promise<ChatOperationRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        operation.operation_id,
        operation.owner_user_id,
        operation.request_sha256,
        operation.operation_kind,
        operation.state,
        operation.fixed_stream_channel_id,
        operation.attempt_committed_at,
        operation.result_json,
        operation.error_code,
        operation.created_at,
        operation.updated_at,
        group_record.group_id,
        group_record.name as group_name,
        case
          when operation.operation_kind = 'group_create' then coalesce((
            select array_agg(
              profile.public_profile_id::text
              order by profile.public_profile_id
            )
            from public.communication_group_members as member
            join public.user_profiles as profile
              on profile.owner_user_id = member.owner_user_id
            where member.group_id = group_record.group_id
              and member.owner_user_id <> operation.owner_user_id
          ), '{}'::text[])
          else '{}'::text[]
        end as friend_public_profile_ids,
        case
          when operation.operation_kind = 'direct_get_or_create' then (
            select profile.public_profile_id
            from public.direct_channels as direct_record
            join public.user_profiles as profile
              on profile.owner_user_id = case
                when direct_record.user_id_low = operation.owner_user_id
                  then direct_record.user_id_high
                else direct_record.user_id_low
              end
            where direct_record.stream_channel_id
                = operation.fixed_stream_channel_id
              and operation.owner_user_id in (
                direct_record.user_id_low,
                direct_record.user_id_high
              )
            limit 1
          )
          else null
        end as target_public_profile_id
      from public.chat_operations as operation
      left join public.communication_groups as group_record
        on group_record.create_operation_id = operation.operation_id
      where operation.operation_id = $1
        and operation.owner_user_id = $2
      limit 1
    `,
    values: [operationId, ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toOperationRecord(row);
}

async function lockOperation(
  client: DatabaseClient,
  input: LocateChatOperationInput,
) {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        operation_id,
        owner_user_id,
        operation_kind,
        state,
        fixed_stream_channel_id,
        attempt_committed_at,
        created_at
      from public.chat_operations
      where operation_id = $1 and owner_user_id = $2
      for update
    `,
    values: [input.operationId, input.ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : lockedOperationRowSchema.parse(row);
}

async function appendOperationEvent(
  client: DatabaseClient,
  input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly requestId: string;
    readonly fromState: string | null;
    readonly transition: z.infer<typeof transitionRowSchema>;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.chat_operation_events (
        operation_id,
        owner_user_id,
        request_id,
        from_state,
        to_state,
        operation_version,
        transport_attempt_id,
        reason_code
      )
      values ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      input.requestId,
      input.fromState,
      input.transition.state,
      input.transition.record_version,
      input.transition.transport_attempt_id,
      input.transition.error_code,
    ],
  });
}

async function appendInitialOperationEvent(
  client: DatabaseClient,
  operationId: string,
  ownerUserId: string,
  requestId: string,
): Promise<void> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        state,
        record_version::text as record_version,
        transport_attempt_id,
        error_code
      from public.chat_operations
      where operation_id = $1 and owner_user_id = $2
      limit 1
    `,
    values: [operationId, ownerUserId],
  });
  await appendOperationEvent(client, {
    operationId,
    ownerUserId,
    requestId,
    fromState: null,
    transition: transitionRowSchema.parse(result.rows[0]),
  });
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function translateError(error: unknown): never {
  if (
    error instanceof ChatChannelRepositoryUnavailableError ||
    error instanceof ChatChannelIdempotencyConflictRepositoryError ||
    error instanceof ChatChannelTargetUnavailableRepositoryError
  ) {
    throw error;
  }
  throw new ChatChannelRepositoryUnavailableError();
}

async function claimIdempotency(
  client: DatabaseClient,
  input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly requestDigest: string;
    readonly kind: "group_create" | "direct_get_or_create";
  },
): Promise<Readonly<{ id: string; replay: boolean }>> {
  const result = await client.query<Record<string, unknown>>({
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
      chatIdempotencyScope,
      input.operationId,
      input.requestDigest,
      chatDigestVersion,
    ],
  });
  const parsed = idempotencyRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new ChatChannelIdempotencyConflictRepositoryError();
  }
  const existing = await client.query<Record<string, unknown>>({
    text: `
      select
        operation_id,
        owner_user_id,
        request_sha256,
        operation_kind
      from public.chat_operations
      where idempotency_record_id = $1
      limit 1
    `,
    values: [parsed.data.id],
  });
  const row = existing.rows[0];
  if (row === undefined) {
    return Object.freeze({ id: parsed.data.id, replay: false });
  }
  if (
    row["operation_id"] !== input.operationId ||
    row["owner_user_id"] !== input.ownerUserId ||
    row["request_sha256"] !== input.requestDigest ||
    row["operation_kind"] !== input.kind
  ) {
    throw new ChatChannelIdempotencyConflictRepositoryError();
  }
  return Object.freeze({ id: parsed.data.id, replay: true });
}

async function eligibleGroupTargets(
  client: DatabaseClient,
  ownerUserId: string,
  publicProfileIds: readonly string[],
): Promise<readonly z.infer<typeof targetRowSchema>[]> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        profile.owner_user_id,
        profile.public_profile_id,
        profile.profile_code
      from unnest($2::uuid[]) as requested(public_profile_id)
      join public.user_profiles as profile
        on profile.public_profile_id = requested.public_profile_id
      join public.social_privacy_preferences as privacy
        on privacy.owner_user_id = profile.owner_user_id
       and privacy.group_invites = 'friends'
      where profile.owner_user_id <> $1
        and exists (
          select 1
          from public.friendships as friendship
          where friendship.user_id_low = least($1::uuid, profile.owner_user_id)
            and friendship.user_id_high = greatest($1::uuid, profile.owner_user_id)
        )
      order by profile.public_profile_id
    `,
    values: [ownerUserId, publicProfileIds],
  });
  const rows = result.rows.map((row) => targetRowSchema.parse(row));
  if (rows.length !== publicProfileIds.length) {
    throw new ChatChannelTargetUnavailableRepositoryError();
  }
  return Object.freeze(rows);
}

async function resolveDirectTarget(
  client: DatabaseClient,
  ownerUserId: string,
  publicProfileId: string,
): Promise<z.infer<typeof targetRowSchema>> {
  const profileResult = await client.query<Record<string, unknown>>({
    text: `
      select owner_user_id, public_profile_id, profile_code
      from public.user_profiles
      where public_profile_id = $1 and owner_user_id <> $2
      limit 1
    `,
    values: [publicProfileId, ownerUserId],
  });
  const profile = targetRowSchema.safeParse(profileResult.rows[0]);
  if (!profile.success) {
    throw new ChatChannelTargetUnavailableRepositoryError();
  }
  await client.query({
    text: `
      select id
      from public.loop_users
      where id = any($1::uuid[])
      order by id
      for no key update
    `,
    values: [[ownerUserId, profile.data.owner_user_id].sort()],
  });
  const eligible = await client.query<{ eligible: boolean }>({
    text: `
      select exists (
        select 1
        from public.friendships as friendship
        join public.social_privacy_preferences as privacy
          on privacy.owner_user_id = $2
         and privacy.direct_messages = 'friends'
        where friendship.user_id_low = least($1::uuid, $2::uuid)
          and friendship.user_id_high = greatest($1::uuid, $2::uuid)
      ) as eligible
    `,
    values: [ownerUserId, profile.data.owner_user_id],
  });
  if (eligible.rows[0]?.eligible !== true) {
    throw new ChatChannelTargetUnavailableRepositoryError();
  }
  return profile.data;
}

async function readDirectRecord(
  client: DatabaseClient,
  ownerUserId: string,
  channelId: string,
) {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        direct_record.user_id_low,
        direct_record.user_id_high,
        direct_record.stream_channel_id,
        direct_record.create_operation_id,
        direct_record.channel_state,
        creator.owner_user_id as created_by_user_id
      from public.direct_channels as direct_record
      join public.chat_operations as creator
        on creator.operation_id = direct_record.create_operation_id
      where direct_record.stream_channel_id = $1
        and $2::uuid in (
          direct_record.user_id_low,
          direct_record.user_id_high
        )
      limit 1
    `,
    values: [channelId, ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : directRowSchema.parse(row);
}

async function readExpectation(
  client: DatabaseClient,
  operation: z.infer<typeof lockedOperationRowSchema>,
): Promise<ChatChannelExpectation> {
  if (operation.operation_kind === "group_create") {
    const result = await client.query<Record<string, unknown>>({
      text: `
        select
          group_record.name,
          array_agg(member.owner_user_id::text order by member.owner_user_id)
            as member_user_ids
        from public.communication_groups as group_record
        join public.communication_group_members as member
          on member.group_id = group_record.group_id
        where group_record.create_operation_id = $1
          and group_record.stream_channel_id = $2
          and group_record.channel_kind = 'group'
        group by group_record.group_id, group_record.name
      `,
      values: [operation.operation_id, operation.fixed_stream_channel_id],
    });
    const parsed = z
      .object({
        name: groupNameSchema,
        member_user_ids: z.array(uuidSchema).min(3).max(30),
      })
      .strict()
      .parse(result.rows[0]);
    if (!parsed.member_user_ids.includes(operation.owner_user_id)) {
      throw new ChatChannelRepositoryUnavailableError();
    }
    return Object.freeze({
      operationId: operation.operation_id,
      kind: "group",
      channelId: operation.fixed_stream_channel_id,
      createdByUserId: operation.owner_user_id,
      memberUserIds: Object.freeze([...parsed.member_user_ids]),
      name: parsed.name,
    });
  }

  const direct = await readDirectRecord(
    client,
    operation.owner_user_id,
    operation.fixed_stream_channel_id,
  );
  if (direct === null) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  return Object.freeze({
    operationId: operation.operation_id,
    kind: "direct",
    channelId: operation.fixed_stream_channel_id,
    createdByUserId: direct.created_by_user_id,
    memberUserIds: Object.freeze([direct.user_id_low, direct.user_id_high]),
    name: null,
  });
}

function successResult(record: ChatOperationRecord): Record<string, unknown> {
  if (
    record.kind === "group_create" &&
    record.groupId !== null &&
    record.groupName !== null
  ) {
    return {
      group_id: record.groupId,
      name: record.groupName,
      friend_public_profile_ids: [...record.friendPublicProfileIds],
      stream_cid: `messaging:${record.channelId}`,
    };
  }
  if (
    record.kind === "direct_get_or_create" &&
    record.targetPublicProfileId !== null
  ) {
    return {
      target_public_profile_id: record.targetPublicProfileId,
      stream_cid: `messaging:${record.channelId}`,
    };
  }
  throw new ChatChannelRepositoryUnavailableError();
}

async function transitionPendingDirectFromMapping(
  client: DatabaseClient,
  input: TransitionChatOperationInput,
  operation: z.infer<typeof lockedOperationRowSchema>,
): Promise<boolean> {
  if (
    operation.operation_kind !== "direct_get_or_create" ||
    operation.state !== "pending"
  ) {
    return false;
  }
  const direct = await readDirectRecord(
    client,
    operation.owner_user_id,
    operation.fixed_stream_channel_id,
  );
  if (direct === null || direct.channel_state === "pending") {
    return false;
  }
  const current = await readOperation(
    client,
    input.ownerUserId,
    input.operationId,
  );
  if (current === null) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  const succeeded = direct.channel_state === "active";
  const result = await client.query<Record<string, unknown>>({
    text: `
      update public.chat_operations
      set
        state = $3,
        result_json = $4::jsonb,
        error_code = $5,
        record_version = record_version + 1,
        updated_at = greatest(clock_timestamp(), updated_at)
      where operation_id = $1
        and owner_user_id = $2
        and state = 'pending'
      returning
        state,
        record_version::text as record_version,
        transport_attempt_id,
        error_code
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      succeeded ? "succeeded" : "failed",
      succeeded ? JSON.stringify(successResult(current)) : null,
      succeeded ? null : "direct_channel_unavailable",
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    return false;
  }
  await appendOperationEvent(client, {
    operationId: input.operationId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    fromState: "pending",
    transition: transitionRowSchema.parse(row),
  });
  return true;
}

async function assertSubmissionEligibility(
  client: DatabaseClient,
  operation: z.infer<typeof lockedOperationRowSchema>,
  expectation: ChatChannelExpectation,
): Promise<void> {
  const lockedUsers = await client.query<{ id: string }>({
    text: `
      select id
      from public.loop_users
      where id = any($1::uuid[])
      order by id
      for update
    `,
    values: [[...expectation.memberUserIds].sort()],
  });
  if (
    lockedUsers.rows.length !== expectation.memberUserIds.length ||
    new Set(lockedUsers.rows.map((row) => row.id)).size !==
      expectation.memberUserIds.length
  ) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  if (expectation.createdByUserId !== operation.owner_user_id) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  const targetUserIds = expectation.memberUserIds.filter(
    (userId) => userId !== operation.owner_user_id,
  );
  const capability =
    expectation.kind === "group" ? "group_invites" : "direct_messages";
  const allowedValue = "friends";
  const result = await client.query<{ owner_user_id: string }>({
    text: `
      select target.owner_user_id
      from unnest($2::uuid[]) as target(owner_user_id)
      join public.social_privacy_preferences as privacy
        on privacy.owner_user_id = target.owner_user_id
      where case
        when $3 = 'group_invites' then privacy.group_invites = $4
        else privacy.direct_messages = $4
      end
        and exists (
          select 1
          from public.friendships as friendship
          where friendship.user_id_low = least($1::uuid, target.owner_user_id)
            and friendship.user_id_high = greatest($1::uuid, target.owner_user_id)
        )
      order by target.owner_user_id
    `,
    values: [operation.owner_user_id, targetUserIds, capability, allowedValue],
  });
  if (
    targetUserIds.length === 0 ||
    result.rows.length !== targetUserIds.length ||
    new Set(result.rows.map((row) => row.owner_user_id)).size !==
      targetUserIds.length
  ) {
    throw new ChatChannelTargetUnavailableRepositoryError();
  }
}

async function failPendingTargetBeforeSubmission(
  client: DatabaseClient,
  input: TransitionChatOperationInput,
  operation: z.infer<typeof lockedOperationRowSchema>,
): Promise<void> {
  if (operation.operation_kind === "group_create") {
    await client.query({
      text: `
        update public.communication_groups
        set
          channel_state = 'cancelled',
          updated_at = greatest(clock_timestamp(), updated_at)
        where create_operation_id = $1 and channel_state = 'pending'
      `,
      values: [input.operationId],
    });
  } else {
    await client.query({
      text: `
        update public.direct_channels
        set
          channel_state = 'cancelled',
          updated_at = greatest(clock_timestamp(), updated_at)
        where stream_channel_id = $1 and channel_state = 'pending'
      `,
      values: [operation.fixed_stream_channel_id],
    });
  }
  const result = await client.query<Record<string, unknown>>({
    text: `
      update public.chat_operations
      set
        state = 'failed',
        result_json = null,
        error_code = 'target_unavailable',
        record_version = record_version + 1,
        updated_at = greatest(clock_timestamp(), updated_at)
      where operation_id = $1
        and owner_user_id = $2
        and state = 'pending'
        and attempt_count = 0
      returning
        state,
        record_version::text as record_version,
        transport_attempt_id,
        error_code
    `,
    values: [input.operationId, input.ownerUserId],
  });
  const transition = transitionRowSchema.parse(result.rows[0]);
  await appendOperationEvent(client, {
    operationId: input.operationId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    fromState: "pending",
    transition,
  });
}

async function expirePendingDispatch(
  client: DatabaseClient,
  input: RefreshChatOperationInput,
  operation: z.infer<typeof lockedOperationRowSchema>,
): Promise<boolean> {
  if (
    operation.state !== "pending" ||
    operation.created_at.getTime() > Date.parse(input.pendingBefore)
  ) {
    return false;
  }

  if (operation.operation_kind === "group_create") {
    const cancelled = await client.query<{ group_id: string }>({
      text: `
        update public.communication_groups
        set
          channel_state = 'cancelled',
          updated_at = greatest(clock_timestamp(), updated_at)
        where create_operation_id = $1 and channel_state = 'pending'
        returning group_id
      `,
      values: [input.operationId],
    });
    if (cancelled.rows.length !== 1) {
      throw new ChatChannelRepositoryUnavailableError();
    }
    await failPendingDispatchOperation(client, {
      operationId: input.operationId,
      ownerUserId: input.ownerUserId,
      requestId: input.requestId,
      errorCode: "submission_not_started",
    });
    return true;
  }

  const direct = await readDirectRecord(
    client,
    operation.owner_user_id,
    operation.fixed_stream_channel_id,
  );
  if (direct === null || direct.channel_state !== "pending") {
    return false;
  }
  const isCreator = direct.create_operation_id === operation.operation_id;
  const creator = isCreator
    ? operation
    : await lockOperation(client, {
        operationId: direct.create_operation_id,
        ownerUserId: direct.created_by_user_id,
      });
  if (creator === null) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  if (!isCreator && creator.state !== "pending") {
    return false;
  }

  const cancelled = await client.query<{ direct_channel_id: string }>({
    text: `
      update public.direct_channels
      set
        channel_state = 'cancelled',
        updated_at = greatest(clock_timestamp(), updated_at)
      where create_operation_id = $1 and channel_state = 'pending'
      returning direct_channel_id
    `,
    values: [direct.create_operation_id],
  });
  if (cancelled.rows.length !== 1) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  if (!isCreator) {
    await failPendingDispatchOperation(client, {
      operationId: creator.operation_id,
      ownerUserId: creator.owner_user_id,
      requestId: input.requestId,
      errorCode: "submission_not_started",
    });
  }
  await failPendingDispatchOperation(client, {
    operationId: input.operationId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    errorCode: isCreator
      ? "submission_not_started"
      : "direct_channel_unavailable",
  });
  return true;
}

async function failPendingDispatchOperation(
  client: DatabaseClient,
  input: TransitionChatOperationInput & { readonly errorCode: string },
): Promise<void> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      update public.chat_operations
      set
        state = 'failed',
        result_json = null,
        error_code = $3,
        record_version = record_version + 1,
        updated_at = greatest(clock_timestamp(), updated_at)
      where operation_id = $1
        and owner_user_id = $2
        and state = 'pending'
        and attempt_count = 0
      returning
        state,
        record_version::text as record_version,
        transport_attempt_id,
        error_code
    `,
    values: [input.operationId, input.ownerUserId, input.errorCode],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatChannelRepositoryUnavailableError();
  }
  await appendOperationEvent(client, {
    operationId: input.operationId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    fromState: "pending",
    transition: transitionRowSchema.parse(row),
  });
}

function fixedChannelId(kind: "group" | "direct", operationId: string): string {
  return `loop_${kind}_${operationId.replaceAll("-", "")}`;
}

export function createPostgresChatChannelRepository(
  pool: Pool,
): ChatChannelRepository {
  return Object.freeze({
    async prepareGroupOperation(rawInput: PrepareGroupChatOperationInput) {
      try {
        const input = prepareGroupSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const idempotency = await claimIdempotency(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestDigest: input.requestDigest,
            kind: "group_create",
          });
          if (idempotency.replay) {
            const existing = await readOperation(
              client,
              input.ownerUserId,
              input.operationId,
            );
            if (existing === null) {
              throw new ChatChannelRepositoryUnavailableError();
            }
            return existing;
          }
          const targets = await eligibleGroupTargets(
            client,
            input.ownerUserId,
            input.friendPublicProfileIds,
          );
          const channelId = fixedChannelId("group", input.operationId);
          await client.query({
            text: `
              insert into public.chat_operations (
                operation_id,
                owner_user_id,
                idempotency_record_id,
                idempotency_scope,
                digest_version,
                request_sha256,
                operation_kind,
                fixed_stream_channel_id
              )
              values ($1, $2, $3, $4, $5, $6, 'group_create', $7)
            `,
            values: [
              input.operationId,
              input.ownerUserId,
              idempotency.id,
              chatIdempotencyScope,
              chatDigestVersion,
              input.requestDigest,
              channelId,
            ],
          });
          const groupResult = await client.query<{ group_id: string }>({
            text: `
              insert into public.communication_groups (
                stream_channel_type,
                stream_channel_id,
                channel_kind,
                name,
                create_operation_id,
                channel_state
              )
              values ('messaging', $1, 'group', $2, $3, 'pending')
              returning group_id
            `,
            values: [channelId, input.name, input.operationId],
          });
          const groupId = uuidSchema.parse(groupResult.rows[0]?.group_id);
          await client.query({
            text: `
              insert into public.communication_group_members (
                group_id,
                owner_user_id,
                member_role
              )
              values ($1, $2, 'creator')
            `,
            values: [groupId, input.ownerUserId],
          });
          await client.query({
            text: `
              insert into public.communication_group_members (
                group_id,
                owner_user_id,
                member_role
              )
              select $1, member.owner_user_id, 'member'
              from unnest($2::uuid[]) as member(owner_user_id)
            `,
            values: [groupId, targets.map((target) => target.owner_user_id)],
          });
          await appendInitialOperationEvent(
            client,
            input.operationId,
            input.ownerUserId,
            input.requestId,
          );
          const created = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (created === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return created;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async prepareDirectOperation(rawInput: PrepareDirectChatOperationInput) {
      try {
        const input = prepareDirectSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const idempotency = await claimIdempotency(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestDigest: input.requestDigest,
            kind: "direct_get_or_create",
          });
          if (idempotency.replay) {
            const existing = await readOperation(
              client,
              input.ownerUserId,
              input.operationId,
            );
            if (existing === null) {
              throw new ChatChannelRepositoryUnavailableError();
            }
            return existing;
          }
          const target = await resolveDirectTarget(
            client,
            input.ownerUserId,
            input.targetPublicProfileId,
          );
          const [userIdLow, userIdHigh] = [
            input.ownerUserId,
            target.owner_user_id,
          ].sort() as [string, string];
          const existingResult = await client.query<Record<string, unknown>>({
            text: `
              select
                direct_record.user_id_low,
                direct_record.user_id_high,
                direct_record.stream_channel_id,
                direct_record.create_operation_id,
                direct_record.channel_state,
                creator.owner_user_id as created_by_user_id
              from public.direct_channels as direct_record
              join public.chat_operations as creator
                on creator.operation_id = direct_record.create_operation_id
              where direct_record.user_id_low = $1
                and direct_record.user_id_high = $2
                and direct_record.channel_state in (
                  'pending', 'active', 'operator_required'
                )
              limit 1
            `,
            values: [userIdLow, userIdHigh],
          });
          const existingDirect =
            existingResult.rows[0] === undefined
              ? null
              : directRowSchema.parse(existingResult.rows[0]);
          const channelId =
            existingDirect?.stream_channel_id ??
            fixedChannelId("direct", input.operationId);
          const initialState =
            existingDirect?.channel_state === "active"
              ? "succeeded"
              : existingDirect?.channel_state === "operator_required"
                ? "failed"
                : "pending";
          const initialResult =
            initialState === "succeeded"
              ? {
                  target_public_profile_id: target.public_profile_id,
                  stream_cid: `messaging:${channelId}`,
                }
              : null;
          const initialError =
            initialState === "failed" ? "direct_channel_unavailable" : null;
          await client.query({
            text: `
              insert into public.chat_operations (
                operation_id,
                owner_user_id,
                idempotency_record_id,
                idempotency_scope,
                digest_version,
                request_sha256,
                operation_kind,
                state,
                fixed_stream_channel_id,
                result_json,
                error_code
              )
              values (
                $1, $2, $3, $4, $5, $6,
                'direct_get_or_create', $7, $8, $9::jsonb, $10
              )
            `,
            values: [
              input.operationId,
              input.ownerUserId,
              idempotency.id,
              chatIdempotencyScope,
              chatDigestVersion,
              input.requestDigest,
              initialState,
              channelId,
              initialResult === null ? null : JSON.stringify(initialResult),
              initialError,
            ],
          });
          if (existingDirect === null) {
            await client.query({
              text: `
                insert into public.direct_channels (
                  user_id_low,
                  user_id_high,
                  stream_channel_id,
                  create_operation_id
                )
                values ($1, $2, $3, $4)
              `,
              values: [userIdLow, userIdHigh, channelId, input.operationId],
            });
          }
          await appendInitialOperationEvent(
            client,
            input.operationId,
            input.ownerUserId,
            input.requestId,
          );
          const created = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (created === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return created;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async refreshOperation(rawInput: RefreshChatOperationInput) {
      try {
        const input = refreshSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          const transitioned = await transitionPendingDirectFromMapping(
            client,
            input,
            operation,
          );
          if (!transitioned) {
            await expirePendingDispatch(client, input, operation);
          }
          const refreshed = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (refreshed === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return refreshed;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async claimSubmission(rawInput: TransitionChatOperationInput) {
      try {
        const input = transitionSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const callerOperation = await lockOperation(client, input);
          if (callerOperation === null || callerOperation.state !== "pending") {
            return null;
          }
          if (
            await transitionPendingDirectFromMapping(
              client,
              input,
              callerOperation,
            )
          ) {
            return null;
          }
          let operation = callerOperation;
          let transitionInput: TransitionChatOperationInput = input;
          if (callerOperation.operation_kind === "direct_get_or_create") {
            const direct = await readDirectRecord(
              client,
              callerOperation.owner_user_id,
              callerOperation.fixed_stream_channel_id,
            );
            if (direct === null || direct.channel_state !== "pending") {
              return null;
            }
            if (direct.create_operation_id !== callerOperation.operation_id) {
              const canonical = await lockOperation(client, {
                operationId: direct.create_operation_id,
                ownerUserId: direct.created_by_user_id,
              });
              if (canonical === null || canonical.state !== "pending") {
                return null;
              }
              operation = canonical;
              transitionInput = Object.freeze({
                operationId: canonical.operation_id,
                ownerUserId: canonical.owner_user_id,
                requestId: input.requestId,
              });
            }
          }
          const expectation = await readExpectation(client, operation);
          try {
            await assertSubmissionEligibility(client, operation, expectation);
          } catch (error) {
            if (error instanceof ChatChannelTargetUnavailableRepositoryError) {
              await failPendingTargetBeforeSubmission(
                client,
                transitionInput,
                operation,
              );
              return null;
            }
            throw error;
          }
          const transportAttemptId = randomUUID();
          const result = await client.query<Record<string, unknown>>({
            text: `
              update public.chat_operations
              set
                state = 'submitting',
                attempt_count = 1,
                transport_attempt_id = $3,
                attempt_committed_at = clock_timestamp(),
                attempt_deadline_at = clock_timestamp()
                  + ($4::integer * interval '1 millisecond'),
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where operation_id = $1
                and owner_user_id = $2
                and state = 'pending'
                and attempt_count = 0
              returning
                state,
                record_version::text as record_version,
                transport_attempt_id,
                error_code
            `,
            values: [
              transitionInput.operationId,
              transitionInput.ownerUserId,
              transportAttemptId,
              providerAttemptDurationMilliseconds,
            ],
          });
          const transition = transitionRowSchema.parse(result.rows[0]);
          await appendOperationEvent(client, {
            operationId: transitionInput.operationId,
            ownerUserId: transitionInput.ownerUserId,
            requestId: input.requestId,
            fromState: "pending",
            transition,
          });
          return expectation;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async claimReconciliation(rawInput: ClaimChatReconciliationInput) {
      try {
        const input = reconcileSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            return null;
          }
          if (operation.state === "reconciling") {
            return await readExpectation(client, operation);
          }
          if (
            operation.state !== "submitting" ||
            operation.attempt_committed_at === null ||
            operation.attempt_committed_at.getTime() >
              Date.parse(input.submittingBefore)
          ) {
            return null;
          }
          const result = await client.query<Record<string, unknown>>({
            text: `
              update public.chat_operations
              set
                state = 'reconciling',
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where operation_id = $1
                and owner_user_id = $2
                and state = 'submitting'
              returning
                state,
                record_version::text as record_version,
                transport_attempt_id,
                error_code
            `,
            values: [input.operationId, input.ownerUserId],
          });
          const transition = transitionRowSchema.parse(result.rows[0]);
          await appendOperationEvent(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            fromState: "submitting",
            transition,
          });
          return await readExpectation(client, {
            ...operation,
            state: "reconciling",
          });
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async markReconciling(rawInput: TransitionChatOperationInput) {
      try {
        const input = transitionSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.state === "submitting") {
            const result = await client.query<Record<string, unknown>>({
              text: `
                update public.chat_operations
                set
                  state = 'reconciling',
                  record_version = record_version + 1,
                  updated_at = greatest(clock_timestamp(), updated_at)
                where operation_id = $1
                  and owner_user_id = $2
                  and state = 'submitting'
                returning
                  state,
                  record_version::text as record_version,
                  transport_attempt_id,
                  error_code
              `,
              values: [input.operationId, input.ownerUserId],
            });
            await appendOperationEvent(client, {
              operationId: input.operationId,
              ownerUserId: input.ownerUserId,
              requestId: input.requestId,
              fromState: "submitting",
              transition: transitionRowSchema.parse(result.rows[0]),
            });
          } else if (operation.state === "pending") {
            throw new ChatChannelRepositoryUnavailableError();
          }
          const updated = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (updated === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return updated;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async markSucceeded(rawInput: TransitionChatOperationInput) {
      try {
        const input = transitionSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.state === "succeeded") {
            const existing = await readOperation(
              client,
              input.ownerUserId,
              input.operationId,
            );
            if (existing === null) {
              throw new ChatChannelRepositoryUnavailableError();
            }
            return existing;
          }
          if (
            operation.state !== "submitting" &&
            operation.state !== "reconciling"
          ) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          const current = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (current === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.operation_kind === "group_create") {
            await client.query({
              text: `
                update public.communication_groups
                set
                  channel_state = 'active',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where create_operation_id = $1 and channel_state = 'pending'
              `,
              values: [input.operationId],
            });
          } else {
            await client.query({
              text: `
                update public.direct_channels
                set
                  channel_state = 'active',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where stream_channel_id = $1 and channel_state = 'pending'
              `,
              values: [operation.fixed_stream_channel_id],
            });
          }
          const result = await client.query<Record<string, unknown>>({
            text: `
              update public.chat_operations
              set
                state = 'succeeded',
                result_json = $3::jsonb,
                error_code = null,
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where operation_id = $1
                and owner_user_id = $2
                and state = any($4::text[])
              returning
                state,
                record_version::text as record_version,
                transport_attempt_id,
                error_code
            `,
            values: [
              input.operationId,
              input.ownerUserId,
              JSON.stringify(successResult(current)),
              ["submitting", "reconciling"],
            ],
          });
          const transition = transitionRowSchema.parse(result.rows[0]);
          await appendOperationEvent(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            fromState: operation.state,
            transition,
          });
          const updated = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (updated === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return updated;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async markOperatorRequired(rawInput: FailChatOperationInput) {
      try {
        const input = failSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (
            operation.state === "succeeded" ||
            operation.state === "failed" ||
            operation.state === "operator_required"
          ) {
            const existing = await readOperation(
              client,
              input.ownerUserId,
              input.operationId,
            );
            if (existing === null) {
              throw new ChatChannelRepositoryUnavailableError();
            }
            return existing;
          }
          if (
            operation.state !== "submitting" &&
            operation.state !== "reconciling"
          ) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.operation_kind === "group_create") {
            await client.query({
              text: `
                update public.communication_groups
                set
                  channel_state = 'operator_required',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where create_operation_id = $1 and channel_state = 'pending'
              `,
              values: [input.operationId],
            });
          } else {
            await client.query({
              text: `
                update public.direct_channels
                set
                  channel_state = 'operator_required',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where stream_channel_id = $1 and channel_state = 'pending'
              `,
              values: [operation.fixed_stream_channel_id],
            });
          }
          const result = await client.query<Record<string, unknown>>({
            text: `
              update public.chat_operations
              set
                state = 'operator_required',
                result_json = null,
                error_code = $3,
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where operation_id = $1
                and owner_user_id = $2
                and state = any($4::text[])
              returning
                state,
                record_version::text as record_version,
                transport_attempt_id,
                error_code
            `,
            values: [
              input.operationId,
              input.ownerUserId,
              input.errorCode,
              ["submitting", "reconciling"],
            ],
          });
          const transition = transitionRowSchema.parse(result.rows[0]);
          await appendOperationEvent(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            fromState: operation.state,
            transition,
          });
          const updated = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (updated === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return updated;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async markFailed(rawInput: FailChatOperationInput) {
      try {
        const input = failSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockOperation(client, input);
          if (operation === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.state === "failed") {
            const existing = await readOperation(
              client,
              input.ownerUserId,
              input.operationId,
            );
            if (existing === null) {
              throw new ChatChannelRepositoryUnavailableError();
            }
            return existing;
          }
          if (
            operation.state !== "submitting" &&
            operation.state !== "reconciling"
          ) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          if (operation.operation_kind === "group_create") {
            await client.query({
              text: `
                update public.communication_groups
                set
                  channel_state = 'operator_required',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where create_operation_id = $1 and channel_state = 'pending'
              `,
              values: [input.operationId],
            });
          } else {
            await client.query({
              text: `
                update public.direct_channels
                set
                  channel_state = 'operator_required',
                  updated_at = greatest(clock_timestamp(), updated_at)
                where stream_channel_id = $1 and channel_state = 'pending'
              `,
              values: [operation.fixed_stream_channel_id],
            });
          }
          const result = await client.query<Record<string, unknown>>({
            text: `
              update public.chat_operations
              set
                state = 'failed',
                result_json = null,
                error_code = $3,
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where operation_id = $1
                and owner_user_id = $2
                and state = any($4::text[])
              returning
                state,
                record_version::text as record_version,
                transport_attempt_id,
                error_code
            `,
            values: [
              input.operationId,
              input.ownerUserId,
              input.errorCode,
              ["submitting", "reconciling"],
            ],
          });
          const transition = transitionRowSchema.parse(result.rows[0]);
          await appendOperationEvent(client, {
            operationId: input.operationId,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            fromState: operation.state,
            transition,
          });
          const updated = await readOperation(
            client,
            input.ownerUserId,
            input.operationId,
          );
          if (updated === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return updated;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async findCanonicalDirectOperation(rawInput: LocateChatOperationInput) {
      try {
        const input = locateSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const caller = await lockOperation(client, input);
          if (
            caller === null ||
            caller.operation_kind !== "direct_get_or_create" ||
            caller.state !== "pending"
          ) {
            return null;
          }
          const direct = await readDirectRecord(
            client,
            caller.owner_user_id,
            caller.fixed_stream_channel_id,
          );
          if (
            direct === null ||
            direct.channel_state !== "pending" ||
            direct.create_operation_id === caller.operation_id
          ) {
            return null;
          }
          const canonical = await lockOperation(client, {
            operationId: direct.create_operation_id,
            ownerUserId: direct.created_by_user_id,
          });
          if (
            canonical === null ||
            canonical.operation_kind !== "direct_get_or_create" ||
            canonical.fixed_stream_channel_id !==
              caller.fixed_stream_channel_id ||
            (canonical.state !== "submitting" &&
              canonical.state !== "reconciling")
          ) {
            return null;
          }
          const record = await readOperation(
            client,
            canonical.owner_user_id,
            canonical.operation_id,
          );
          if (record === null) {
            throw new ChatChannelRepositoryUnavailableError();
          }
          return record;
        });
      } catch (error) {
        return translateError(error);
      }
    },

    async findOperation(rawInput: LocateChatOperationInput) {
      try {
        const input = locateSchema.parse(rawInput);
        return await readOperation(pool, input.ownerUserId, input.operationId);
      } catch (error) {
        return translateError(error);
      }
    },
  });
}
