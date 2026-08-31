import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import { parseAliasSearchPrefix } from "../features/identity/alias-contract.js";

export type SocialFriendRequestsPreference = "enabled" | "disabled";
export type SocialGroupInvitesPreference = "friends" | "disabled";
export type SocialDirectMessagesPreference = "friends" | "disabled";

export interface SocialPrivacyValues {
  readonly friend_requests: SocialFriendRequestsPreference;
  readonly group_invites: SocialGroupInvitesPreference;
  readonly direct_messages: SocialDirectMessagesPreference;
}

export interface SocialPrivacyRecord {
  readonly ownerUserId: string;
  readonly version: number;
  readonly friendRequests: SocialFriendRequestsPreference;
  readonly groupInvites: SocialGroupInvitesPreference;
  readonly directMessages: SocialDirectMessagesPreference;
  readonly updatedAt: string;
}

export interface ProfilePresentationRecord {
  readonly publicProfileId: string;
  readonly profileCode: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

export interface FriendRecord extends ProfilePresentationRecord {
  readonly friendshipId: string;
  readonly acceptedAt: string;
}

export type FriendRelationship =
  "none" | "outgoing_pending" | "incoming_pending" | "friend";

export interface FriendSearchRecord extends ProfilePresentationRecord {
  readonly alias: string;
  readonly relationship: FriendRelationship;
  readonly friendRequestId: string | null;
}

export type FriendRequestDirection = "incoming" | "outgoing";
export type FriendRequestStatus =
  "pending" | "accepted" | "rejected" | "expired";

export interface FriendRequestRecord {
  readonly friendRequestId: string;
  readonly counterpartyPublicProfileId: string;
  readonly counterpartyProfileCode: string;
  readonly counterpartyAlias: string | null;
  readonly counterpartyAvatarRef: string | null;
  readonly direction: FriendRequestDirection;
  readonly status: FriendRequestStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type SocialOperationKind =
  "friend_request_send" | "friend_request_decide";
export type SocialOperationStatus = "succeeded" | "failed";

export interface SocialOperationRecord {
  readonly operationId: string;
  readonly kind: SocialOperationKind;
  readonly status: SocialOperationStatus;
  readonly result: Readonly<{
    readonly friendRequestId: string;
    readonly status: FriendRequestStatus;
  }> | null;
  readonly error: Readonly<{ readonly code: string }> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceSocialPrivacyInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly privacy: SocialPrivacyValues;
}

export interface ListFriendsInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly beforeAcceptedAt?: string | undefined;
  readonly beforeFriendshipId?: string | undefined;
}

export interface SearchFriendsInput {
  readonly ownerUserId: string;
  readonly aliasPrefix: string;
  readonly limit: number;
}

export interface SendFriendRequestInput {
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly targetPublicProfileId: string;
}

export interface ListFriendRequestsInput {
  readonly ownerUserId: string;
  readonly direction: FriendRequestDirection;
  readonly status: FriendRequestStatus;
  readonly limit: number;
  readonly beforeCreatedAt?: string | undefined;
  readonly beforeFriendRequestId?: string | undefined;
}

export interface DecideFriendRequestInput {
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly friendRequestId: string;
  readonly decision: "accept" | "reject";
}

export interface PreflightSocialCommandInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly kind: SocialOperationKind;
}

export type SocialCommandPreflight = Readonly<
  { readonly status: "new" } | { readonly status: "replay" }
>;

export interface SocialCommandResult {
  readonly created: boolean;
  readonly operation: SocialOperationRecord;
  readonly request: FriendRequestRecord | null;
  readonly friendship: FriendRecord | null;
}

export interface SocialRepository {
  getSocialPrivacy(ownerUserId: string): Promise<SocialPrivacyRecord | null>;
  replaceSocialPrivacy(
    input: ReplaceSocialPrivacyInput,
  ): Promise<SocialPrivacyRecord | null>;
  listFriends(input: ListFriendsInput): Promise<readonly FriendRecord[]>;
  searchFriends(
    input: SearchFriendsInput,
  ): Promise<readonly FriendSearchRecord[]>;
  preflightSocialCommand(
    input: PreflightSocialCommandInput,
  ): Promise<SocialCommandPreflight>;
  sendFriendRequest(
    input: SendFriendRequestInput,
  ): Promise<SocialCommandResult>;
  listFriendRequests(
    input: ListFriendRequestsInput,
  ): Promise<readonly FriendRequestRecord[]>;
  decideFriendRequest(
    input: DecideFriendRequestInput,
  ): Promise<SocialCommandResult>;
  getSocialOperation(
    ownerUserId: string,
    operationId: string,
  ): Promise<SocialOperationRecord | null>;
}

export class SocialRepositoryUnavailableError extends Error {
  constructor() {
    super("The social repository is unavailable");
    this.name = "SocialRepositoryUnavailableError";
  }
}

export class SocialPrivacyVersionConflictError extends Error {
  constructor() {
    super("The social privacy resource version conflicts");
    this.name = "SocialPrivacyVersionConflictError";
  }
}

export class SocialIdempotencyConflictError extends Error {
  constructor() {
    super("The social idempotency key conflicts");
    this.name = "SocialIdempotencyConflictError";
  }
}

export class SocialTargetUnavailableError extends Error {
  constructor() {
    super("The social target is unavailable");
    this.name = "SocialTargetUnavailableError";
  }
}

export class SocialProfileRequiredError extends Error {
  constructor() {
    super("A LOOP public profile is required for social commands");
    this.name = "SocialProfileRequiredError";
  }
}

export class SocialIncomingRequestPendingError extends Error {
  constructor() {
    super("An incoming friend request is already pending");
    this.name = "SocialIncomingRequestPendingError";
  }
}

export class SocialOutgoingRequestPendingError extends Error {
  constructor() {
    super("An outgoing friend request is already pending");
    this.name = "SocialOutgoingRequestPendingError";
  }
}

export class SocialAlreadyFriendsError extends Error {
  constructor() {
    super("The users are already friends");
    this.name = "SocialAlreadyFriendsError";
  }
}

export class SocialRequestCooldownError extends Error {
  constructor() {
    super("A rejected friend request is still in cooldown");
    this.name = "SocialRequestCooldownError";
  }
}

export class SocialFriendRequestNotFoundError extends Error {
  constructor() {
    super("The friend request was not found");
    this.name = "SocialFriendRequestNotFoundError";
  }
}

export class SocialFriendRequestAlreadyDecidedError extends Error {
  constructor() {
    super("The friend request was already decided");
    this.name = "SocialFriendRequestAlreadyDecidedError";
  }
}

export const SOCIAL_COMMAND_IDEMPOTENCY_SCOPE = "social_command";
export const SOCIAL_COMMAND_DIGEST_VERSION = "social_command_v1";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const profileCodePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const maximumRecordVersion = 2_147_483_647;
const friendRequestLifetimeSql = "7 days";
const rejectionCooldownSql = "24 hours";

const uuidSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const sha256Schema = z.string().regex(sha256Pattern);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const timestampInputSchema = z.string().datetime({ offset: true });
const profileCodeSchema = z.string().regex(profileCodePattern);
const avatarReferenceSchema = z
  .string()
  .regex(/^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/);
const friendRequestStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "expired",
]);

const socialPrivacyValuesSchema = z
  .object({
    friend_requests: z.enum(["enabled", "disabled"]),
    group_invites: z.enum(["friends", "disabled"]),
    direct_messages: z.enum(["friends", "disabled"]),
  })
  .strict();

const rawSocialPrivacyRowSchema = z
  .object({
    owner_user_id: uuidSchema,
    friend_requests: z.enum(["enabled", "disabled"]),
    group_invites: z.enum(["friends", "disabled"]),
    direct_messages: z.enum(["friends", "disabled"]),
    record_version: z.number().int().min(1).max(maximumRecordVersion),
    updated_at: dateSchema,
  })
  .strict();

const rawFriendRowSchema = z
  .object({
    friendship_id: uuidSchema,
    public_profile_id: uuidSchema,
    profile_code: profileCodeSchema,
    alias: z.string().nullable(),
    avatar_ref: avatarReferenceSchema.nullable(),
    accepted_at: dateSchema,
  })
  .strict();

const rawFriendSearchRowSchema = z
  .object({
    public_profile_id: uuidSchema,
    profile_code: profileCodeSchema,
    alias: z.string(),
    avatar_ref: avatarReferenceSchema.nullable(),
    relationship: z.enum([
      "none",
      "outgoing_pending",
      "incoming_pending",
      "friend",
    ]),
    friend_request_id: uuidSchema.nullable(),
  })
  .strict();

const rawFriendRequestRowSchema = z
  .object({
    friend_request_id: uuidSchema,
    counterparty_public_profile_id: uuidSchema,
    counterparty_profile_code: profileCodeSchema,
    counterparty_alias: z.string().nullable(),
    counterparty_avatar_ref: avatarReferenceSchema.nullable(),
    direction: z.enum(["incoming", "outgoing"]),
    status: friendRequestStatusSchema,
    created_at: dateSchema,
    expires_at: dateSchema,
  })
  .strict();

const socialOperationResultSchema = z
  .object({
    friend_request_id: uuidSchema,
    status: friendRequestStatusSchema,
  })
  .strict();

const rawSocialOperationRowSchema = z
  .object({
    operation_id: uuidV4Schema,
    operation_kind: z.enum(["friend_request_send", "friend_request_decide"]),
    status: z.enum(["succeeded", "failed"]),
    result_json: z.unknown().nullable(),
    error_code: z.string().nullable(),
    created_at: dateSchema,
    updated_at: dateSchema,
  })
  .strict();

const replaceSocialPrivacyInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    expectedVersion: z.number().int().min(0).max(maximumRecordVersion),
    privacy: socialPrivacyValuesSchema,
  })
  .strict();

const listFriendsInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    limit: z.number().int().min(1).max(51),
    beforeAcceptedAt: timestampInputSchema.optional(),
    beforeFriendshipId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.beforeAcceptedAt === undefined) !==
      (value.beforeFriendshipId === undefined)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

const searchFriendsInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    aliasPrefix: z.string(),
    limit: z.number().int().min(1).max(51),
  })
  .strict();

const sendFriendRequestInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    requestId: uuidV4Schema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    targetPublicProfileId: uuidSchema,
  })
  .strict();

const listFriendRequestsInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    direction: z.enum(["incoming", "outgoing"]),
    status: friendRequestStatusSchema,
    limit: z.number().int().min(1).max(51),
    beforeCreatedAt: timestampInputSchema.optional(),
    beforeFriendRequestId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.beforeCreatedAt === undefined) !==
      (value.beforeFriendRequestId === undefined)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

const decideFriendRequestInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    requestId: uuidV4Schema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    friendRequestId: uuidSchema,
    decision: z.enum(["accept", "reject"]),
  })
  .strict();

const preflightSocialCommandInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    kind: z.enum(["friend_request_send", "friend_request_decide"]),
  })
  .strict();

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

interface ClaimedCommand {
  readonly idempotencyRecordId: string;
  readonly existingOperation: SocialOperationRecord | null;
}

interface TransactionCommandOutcome {
  readonly result: SocialCommandResult | null;
  readonly error: Error | null;
}

const friendRequestProjectionSql = `
  select
    request.friend_request_id,
    counterparty.public_profile_id as counterparty_public_profile_id,
    counterparty.profile_code as counterparty_profile_code,
    counterparty.alias as counterparty_alias,
    counterparty.avatar_ref as counterparty_avatar_ref,
    case
      when request.recipient_user_id = $1 then 'incoming'
      else 'outgoing'
    end as direction,
    request.status,
    request.created_at,
    request.expires_at
  from public.friend_requests as request
  join public.user_profiles as counterparty
    on counterparty.owner_user_id = case
      when request.recipient_user_id = $1 then request.requester_user_id
      else request.recipient_user_id
    end
`;

function toSocialPrivacyRecord(value: unknown): SocialPrivacyRecord {
  const row = rawSocialPrivacyRowSchema.parse(value);
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    version: row.record_version,
    friendRequests: row.friend_requests,
    groupInvites: row.group_invites,
    directMessages: row.direct_messages,
    updatedAt: row.updated_at.toISOString(),
  });
}

function toFriendRecord(value: unknown): FriendRecord {
  const row = rawFriendRowSchema.parse(value);
  return Object.freeze({
    friendshipId: row.friendship_id,
    publicProfileId: row.public_profile_id,
    profileCode: row.profile_code,
    alias: row.alias,
    avatarRef: row.avatar_ref,
    acceptedAt: row.accepted_at.toISOString(),
  });
}

function toFriendSearchRecord(value: unknown): FriendSearchRecord {
  const row = rawFriendSearchRowSchema.parse(value);
  return Object.freeze({
    publicProfileId: row.public_profile_id,
    profileCode: row.profile_code,
    alias: row.alias,
    avatarRef: row.avatar_ref,
    relationship: row.relationship,
    friendRequestId: row.friend_request_id,
  });
}

function toFriendRequestRecord(value: unknown): FriendRequestRecord {
  const row = rawFriendRequestRowSchema.parse(value);
  return Object.freeze({
    friendRequestId: row.friend_request_id,
    counterpartyPublicProfileId: row.counterparty_public_profile_id,
    counterpartyProfileCode: row.counterparty_profile_code,
    counterpartyAlias: row.counterparty_alias,
    counterpartyAvatarRef: row.counterparty_avatar_ref,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
}

function toSocialOperationRecord(value: unknown): SocialOperationRecord {
  const row = rawSocialOperationRowSchema.parse(value);
  const parsedResult =
    row.result_json === null
      ? null
      : socialOperationResultSchema.parse(row.result_json);
  return Object.freeze({
    operationId: row.operation_id,
    kind: row.operation_kind,
    status: row.status,
    result:
      parsedResult === null
        ? null
        : Object.freeze({
            friendRequestId: parsedResult.friend_request_id,
            status: parsedResult.status,
          }),
    error:
      row.error_code === null ? null : Object.freeze({ code: row.error_code }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function socialPrivacyValues(record: SocialPrivacyRecord): SocialPrivacyValues {
  return Object.freeze({
    friend_requests: record.friendRequests,
    group_invites: record.groupInvites,
    direct_messages: record.directMessages,
  });
}

function socialPrivacyEqual(
  left: SocialPrivacyValues,
  right: SocialPrivacyValues,
): boolean {
  return (
    left.friend_requests === right.friend_requests &&
    left.group_invites === right.group_invites &&
    left.direct_messages === right.direct_messages
  );
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
    try {
      await client.query("rollback");
    } catch {
      throw new SocialRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockOwner(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>({
    text: `
      select id
      from public.loop_users
      where id = $1
      for update
    `,
    values: [ownerUserId],
  });
  if (result.rows[0]?.id !== ownerUserId) {
    throw new SocialRepositoryUnavailableError();
  }
}

async function readSocialPrivacy(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<SocialPrivacyRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        owner_user_id,
        friend_requests,
        group_invites,
        direct_messages,
        record_version,
        updated_at
      from public.social_privacy_preferences
      where owner_user_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toSocialPrivacyRecord(row);
}

async function readSocialOperation(
  client: DatabaseClient,
  ownerUserId: string,
  operationId: string,
): Promise<SocialOperationRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        operation_id,
        operation_kind,
        status,
        result_json,
        error_code,
        created_at,
        updated_at
      from public.social_operations
      where owner_user_id = $1 and operation_id = $2
      limit 1
    `,
    values: [ownerUserId, operationId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toSocialOperationRecord(row);
}

async function claimSocialCommand(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<ClaimedCommand> {
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
      SOCIAL_COMMAND_IDEMPOTENCY_SCOPE,
      input.idempotencyKey,
      input.requestSha256,
      SOCIAL_COMMAND_DIGEST_VERSION,
    ],
  });
  const idempotencyRecordId = claimed.rows[0]?.id;
  if (idempotencyRecordId === undefined) {
    throw new SocialIdempotencyConflictError();
  }
  return Object.freeze({
    idempotencyRecordId,
    existingOperation: await readSocialOperation(
      client,
      input.ownerUserId,
      input.idempotencyKey,
    ),
  });
}

async function preflightSocialCommand(
  client: DatabaseClient,
  input: PreflightSocialCommandInput,
): Promise<SocialCommandPreflight> {
  const result = await client.query<{
    owner_user_id: string;
    key_source: string;
    request_sha256: string;
    digest_version: string;
    operation_kind: string | null;
  }>({
    text: `
      select
        record.owner_user_id,
        record.key_source,
        record.request_sha256,
        record.digest_version,
        operation.operation_kind
      from public.idempotency_records as record
      left join public.social_operations as operation
        on operation.idempotency_record_id = record.id
      where record.scope = $1
        and record.idempotency_key = $2
      limit 1
    `,
    values: [SOCIAL_COMMAND_IDEMPOTENCY_SCOPE, input.idempotencyKey],
  });
  const row = result.rows[0];
  if (row === undefined) {
    return Object.freeze({ status: "new" });
  }
  if (
    row.owner_user_id !== input.ownerUserId ||
    row.key_source !== "client" ||
    row.request_sha256 !== input.requestSha256 ||
    row.digest_version !== SOCIAL_COMMAND_DIGEST_VERSION ||
    (row.operation_kind !== null && row.operation_kind !== input.kind)
  ) {
    throw new SocialIdempotencyConflictError();
  }
  if (row.operation_kind === null) {
    throw new SocialRepositoryUnavailableError();
  }
  return Object.freeze({ status: "replay" });
}

async function insertSocialOperation(
  client: DatabaseClient,
  input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly requestId: string;
    readonly idempotencyRecordId: string;
    readonly requestSha256: string;
    readonly kind: SocialOperationKind;
    readonly status: SocialOperationStatus;
    readonly friendRequestId: string | null;
    readonly friendRequestStatus: FriendRequestStatus | null;
    readonly errorCode: string | null;
  },
): Promise<SocialOperationRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      with inserted_operation as (
        insert into public.social_operations (
          operation_id,
          owner_user_id,
          idempotency_record_id,
          request_sha256,
          operation_kind,
          status,
          result_json,
          error_code
        ) values (
          $1, $2, $3, $4, $5, $6,
          case
            when $6 = 'succeeded' then jsonb_build_object(
              'friend_request_id', $7::uuid,
              'status', $8::text
            )
            else null
          end,
          $9
        )
        returning
          operation_id,
          operation_kind,
          status,
          result_json,
          error_code,
          created_at,
          updated_at
      ), inserted_event as (
        insert into public.social_operation_events (
          operation_id,
          owner_user_id,
          request_id,
          status,
          reason_code
        ) values ($1, $2, $10, $6, $9)
        returning event_id
      )
      select inserted_operation.*
      from inserted_operation
      cross join inserted_event
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      input.idempotencyRecordId,
      input.requestSha256,
      input.kind,
      input.status,
      input.friendRequestId,
      input.friendRequestStatus,
      input.errorCode,
      input.requestId,
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new SocialRepositoryUnavailableError();
  }
  return toSocialOperationRecord(row);
}

function errorForCode(code: string): Error {
  switch (code) {
    case "target_unavailable":
      return new SocialTargetUnavailableError();
    case "profile_required":
      return new SocialProfileRequiredError();
    case "incoming_request_pending":
      return new SocialIncomingRequestPendingError();
    case "outgoing_request_pending":
      return new SocialOutgoingRequestPendingError();
    case "already_friends":
      return new SocialAlreadyFriendsError();
    case "friend_request_cooldown":
      return new SocialRequestCooldownError();
    case "friend_request_not_found":
      return new SocialFriendRequestNotFoundError();
    case "friend_request_already_decided":
      return new SocialFriendRequestAlreadyDecidedError();
    default:
      return new SocialRepositoryUnavailableError();
  }
}

function throwCommandError(error: Error): never {
  throw error;
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof SocialRepositoryUnavailableError ||
    error instanceof SocialPrivacyVersionConflictError ||
    error instanceof SocialIdempotencyConflictError ||
    error instanceof SocialTargetUnavailableError ||
    error instanceof SocialProfileRequiredError ||
    error instanceof SocialIncomingRequestPendingError ||
    error instanceof SocialOutgoingRequestPendingError ||
    error instanceof SocialAlreadyFriendsError ||
    error instanceof SocialRequestCooldownError ||
    error instanceof SocialFriendRequestNotFoundError ||
    error instanceof SocialFriendRequestAlreadyDecidedError
  ) {
    throw error;
  }
  throw new SocialRepositoryUnavailableError();
}

async function readFriendRequestForOwner(
  client: DatabaseClient,
  ownerUserId: string,
  friendRequestId: string,
): Promise<FriendRequestRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      ${friendRequestProjectionSql}
      where request.friend_request_id = $2
        and $1 in (request.requester_user_id, request.recipient_user_id)
      limit 1
    `,
    values: [ownerUserId, friendRequestId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toFriendRequestRecord(row);
}

async function readFriendshipForOwnerAndRequest(
  client: DatabaseClient,
  ownerUserId: string,
  friendRequestId: string,
): Promise<FriendRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        friendship.friendship_id,
        profile.public_profile_id,
        profile.profile_code,
        profile.alias,
        profile.avatar_ref,
        friendship.accepted_at
      from public.friendships as friendship
      join public.user_profiles as profile
        on profile.owner_user_id = case
          when friendship.user_id_low = $1 then friendship.user_id_high
          else friendship.user_id_low
        end
      where friendship.accepted_friend_request_id = $2
        and $1 in (friendship.user_id_low, friendship.user_id_high)
      limit 1
    `,
    values: [ownerUserId, friendRequestId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toFriendRecord(row);
}

async function replayCommand(
  client: DatabaseClient,
  ownerUserId: string,
  operation: SocialOperationRecord,
): Promise<TransactionCommandOutcome> {
  if (operation.status === "failed") {
    const code = operation.error?.code;
    return Object.freeze({
      result: null,
      error:
        code === undefined
          ? new SocialRepositoryUnavailableError()
          : errorForCode(code),
    });
  }
  const friendRequestId = operation.result?.friendRequestId;
  if (friendRequestId === undefined) {
    throw new SocialRepositoryUnavailableError();
  }
  const request = await readFriendRequestForOwner(
    client,
    ownerUserId,
    friendRequestId,
  );
  if (request === null) {
    throw new SocialRepositoryUnavailableError();
  }
  const friendship =
    operation.kind === "friend_request_decide" &&
    operation.result?.status === "accepted"
      ? await readFriendshipForOwnerAndRequest(
          client,
          ownerUserId,
          friendRequestId,
        )
      : null;
  if (
    operation.kind === "friend_request_decide" &&
    operation.result?.status === "accepted" &&
    friendship === null
  ) {
    throw new SocialRepositoryUnavailableError();
  }
  return Object.freeze({
    result: Object.freeze({
      created: false,
      operation,
      request,
      friendship,
    }),
    error: null,
  });
}

async function failCommand(
  client: DatabaseClient,
  input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly requestId: string;
    readonly idempotencyRecordId: string;
    readonly requestSha256: string;
    readonly kind: SocialOperationKind;
    readonly errorCode: string;
  },
): Promise<TransactionCommandOutcome> {
  await insertSocialOperation(client, {
    ...input,
    status: "failed",
    friendRequestId: null,
    friendRequestStatus: null,
  });
  return Object.freeze({
    result: null,
    error: errorForCode(input.errorCode),
  });
}

async function succeedCommand(
  client: DatabaseClient,
  input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly requestId: string;
    readonly idempotencyRecordId: string;
    readonly requestSha256: string;
    readonly kind: SocialOperationKind;
    readonly request: FriendRequestRecord;
    readonly friendship: FriendRecord | null;
  },
): Promise<TransactionCommandOutcome> {
  const operation = await insertSocialOperation(client, {
    operationId: input.operationId,
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    idempotencyRecordId: input.idempotencyRecordId,
    requestSha256: input.requestSha256,
    kind: input.kind,
    status: "succeeded",
    friendRequestId: input.request.friendRequestId,
    friendRequestStatus: input.request.status,
    errorCode: null,
  });
  return Object.freeze({
    result: Object.freeze({
      created: true,
      operation,
      request: input.request,
      friendship: input.friendship,
    }),
    error: null,
  });
}

export function createUnavailableSocialRepository(): SocialRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new SocialRepositoryUnavailableError());
  return Object.freeze({
    getSocialPrivacy: unavailable,
    replaceSocialPrivacy: unavailable,
    listFriends: unavailable,
    searchFriends: unavailable,
    preflightSocialCommand: unavailable,
    sendFriendRequest: unavailable,
    listFriendRequests: unavailable,
    decideFriendRequest: unavailable,
    getSocialOperation: unavailable,
  });
}

export function createPostgresSocialRepository(pool: Pool): SocialRepository {
  return Object.freeze({
    async getSocialPrivacy(rawOwnerUserId: string) {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        return await readSocialPrivacy(pool, ownerUserId, false);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceSocialPrivacy(rawInput: ReplaceSocialPrivacyInput) {
      try {
        const input = replaceSocialPrivacyInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          await lockOwner(client, input.ownerUserId);
          const existing = await readSocialPrivacy(
            client,
            input.ownerUserId,
            true,
          );
          if (existing === null) {
            if (input.expectedVersion !== 0) {
              throw new SocialPrivacyVersionConflictError();
            }
            const inserted = await client.query<Record<string, unknown>>({
              text: `
                insert into public.social_privacy_preferences (
                  owner_user_id,
                  friend_requests,
                  group_invites,
                  direct_messages
                ) values ($1, $2, $3, $4)
                returning
                  owner_user_id,
                  friend_requests,
                  group_invites,
                  direct_messages,
                  record_version,
                  updated_at
              `,
              values: [
                input.ownerUserId,
                input.privacy.friend_requests,
                input.privacy.group_invites,
                input.privacy.direct_messages,
              ],
            });
            const row = inserted.rows[0];
            if (row === undefined) {
              throw new SocialRepositoryUnavailableError();
            }
            return toSocialPrivacyRecord(row);
          }
          if (
            socialPrivacyEqual(socialPrivacyValues(existing), input.privacy)
          ) {
            return existing;
          }
          if (
            existing.version !== input.expectedVersion ||
            existing.version >= maximumRecordVersion
          ) {
            throw new SocialPrivacyVersionConflictError();
          }
          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.social_privacy_preferences
              set
                friend_requests = $3,
                group_invites = $4,
                direct_messages = $5,
                record_version = record_version + 1,
                updated_at = greatest(clock_timestamp(), updated_at)
              where owner_user_id = $1 and record_version = $2
              returning
                owner_user_id,
                friend_requests,
                group_invites,
                direct_messages,
                record_version,
                updated_at
            `,
            values: [
              input.ownerUserId,
              input.expectedVersion,
              input.privacy.friend_requests,
              input.privacy.group_invites,
              input.privacy.direct_messages,
            ],
          });
          const row = updated.rows[0];
          if (row === undefined) {
            throw new SocialPrivacyVersionConflictError();
          }
          return toSocialPrivacyRecord(row);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listFriends(rawInput: ListFriendsInput) {
      try {
        const input = listFriendsInputSchema.parse(rawInput);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              friendship.friendship_id,
              profile.public_profile_id,
              profile.profile_code,
              profile.alias,
              profile.avatar_ref,
              friendship.accepted_at
            from public.friendships as friendship
            join public.user_profiles as profile
              on profile.owner_user_id = case
                when friendship.user_id_low = $1
                  then friendship.user_id_high
                else friendship.user_id_low
              end
            where $1 in (friendship.user_id_low, friendship.user_id_high)
              and (
                $3::timestamptz is null
                or (friendship.accepted_at, friendship.friendship_id)
                  < ($3::timestamptz, $4::uuid)
              )
            order by friendship.accepted_at desc, friendship.friendship_id desc
            limit $2
          `,
          values: [
            input.ownerUserId,
            input.limit,
            input.beforeAcceptedAt ?? null,
            input.beforeFriendshipId ?? null,
          ],
        });
        return Object.freeze(result.rows.map(toFriendRecord));
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async searchFriends(rawInput: SearchFriendsInput) {
      try {
        const parsed = searchFriendsInputSchema.parse(rawInput);
        const input = Object.freeze({
          ...parsed,
          aliasPrefix: parseAliasSearchPrefix(parsed.aliasPrefix),
        });
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with search_input as (
              select public.loop_alias_search_key_unicode17_v1($2::text)
                collate "C" as prefix
            )
            select
              profile.public_profile_id,
              profile.profile_code,
              profile.alias,
              profile.avatar_ref,
              case
                when friendship.friendship_id is not null then 'friend'
                when pending.requester_user_id = $1 then 'outgoing_pending'
                when pending.recipient_user_id = $1 then 'incoming_pending'
                else 'none'
              end as relationship,
              case
                when friendship.friendship_id is null
                  then pending.friend_request_id
                else null
              end as friend_request_id
            from public.user_profiles as profile
            join public.privacy_preferences as privacy
              on privacy.owner_user_id = profile.owner_user_id
            left join public.social_privacy_preferences as social_privacy
              on social_privacy.owner_user_id = profile.owner_user_id
            cross join search_input
            left join public.friendships as friendship
              on friendship.user_id_low = least($1::uuid, profile.owner_user_id)
              and friendship.user_id_high = greatest(
                $1::uuid,
                profile.owner_user_id
              )
            left join public.friend_requests as pending
              on pending.pair_user_id_low = least(
                $1::uuid,
                profile.owner_user_id
              )
              and pending.pair_user_id_high = greatest(
                $1::uuid,
                profile.owner_user_id
              )
              and pending.status = 'pending'
              and pending.expires_at > clock_timestamp()
            where profile.owner_user_id <> $1
              and privacy.discoverable = true
              and (
                social_privacy.friend_requests = 'enabled'
                or friendship.friendship_id is not null
                or pending.friend_request_id is not null
              )
              and profile.alias is not null
              and profile.alias_search_key collate "C" like
                replace(
                  replace(
                    replace(search_input.prefix, '\\', '\\\\'),
                    '%', '\\%'
                  ),
                  '_', '\\_'
                ) || '%' escape '\\'
            order by
              profile.alias_search_key collate "C" asc,
              profile.public_profile_id asc
            limit $3
          `,
          values: [input.ownerUserId, input.aliasPrefix, input.limit],
        });
        return Object.freeze(result.rows.map(toFriendSearchRecord));
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async preflightSocialCommand(rawInput: PreflightSocialCommandInput) {
      try {
        const input = preflightSocialCommandInputSchema.parse(rawInput);
        return await preflightSocialCommand(pool, input);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async sendFriendRequest(rawInput: SendFriendRequestInput) {
      try {
        const input = sendFriendRequestInputSchema.parse(rawInput);
        const outcome = await withTransaction(pool, async (client) => {
          const claim = await claimSocialCommand(client, input);
          if (claim.existingOperation !== null) {
            return replayCommand(
              client,
              input.ownerUserId,
              claim.existingOperation,
            );
          }
          const failureBase = Object.freeze({
            operationId: input.idempotencyKey,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            idempotencyRecordId: claim.idempotencyRecordId,
            requestSha256: input.requestSha256,
            kind: "friend_request_send" as const,
          });

          const senderProfile = await client.query<{ owner_user_id: string }>({
            text: `
              select owner_user_id
              from public.user_profiles
              where owner_user_id = $1
              limit 1
            `,
            values: [input.ownerUserId],
          });
          if (senderProfile.rows[0]?.owner_user_id !== input.ownerUserId) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "profile_required",
            });
          }

          const targetIdentity = await client.query<{ owner_user_id: string }>({
            text: `
              select owner_user_id
              from public.user_profiles
              where public_profile_id = $1
              limit 1
            `,
            values: [input.targetPublicProfileId],
          });
          const targetUserId = targetIdentity.rows[0]?.owner_user_id;
          if (targetUserId === input.ownerUserId) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "target_unavailable",
            });
          }
          if (targetUserId === undefined) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "target_unavailable",
            });
          }

          await client.query({
            text: `
              select id
              from public.loop_users
              where id in ($1, $2)
              order by id
              for update
            `,
            values: [input.ownerUserId, targetUserId],
          });

          const eligibleTarget = await client.query<{ owner_user_id: string }>({
            text: `
              select profile.owner_user_id
              from public.user_profiles as profile
              join public.privacy_preferences as privacy
                on privacy.owner_user_id = profile.owner_user_id
              join public.social_privacy_preferences as social_privacy
                on social_privacy.owner_user_id = profile.owner_user_id
              where profile.public_profile_id = $1
                and profile.alias is not null
                and privacy.discoverable = true
                and social_privacy.friend_requests = 'enabled'
              limit 1
            `,
            values: [input.targetPublicProfileId],
          });
          if (eligibleTarget.rows[0]?.owner_user_id !== targetUserId) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "target_unavailable",
            });
          }

          await client.query({
            text: `
              update public.friend_requests
              set
                status = 'expired',
                decided_at = greatest(clock_timestamp(), created_at),
                updated_at = greatest(clock_timestamp(), updated_at)
              where pair_user_id_low = least($1::uuid, $2::uuid)
                and pair_user_id_high = greatest($1::uuid, $2::uuid)
                and status = 'pending'
                and expires_at <= clock_timestamp()
            `,
            values: [input.ownerUserId, targetUserId],
          });

          const friendship = await client.query<{ friendship_id: string }>({
            text: `
              select friendship_id
              from public.friendships
              where user_id_low = least($1::uuid, $2::uuid)
                and user_id_high = greatest($1::uuid, $2::uuid)
              limit 1
            `,
            values: [input.ownerUserId, targetUserId],
          });
          if (friendship.rows[0] !== undefined) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "already_friends",
            });
          }

          const pending = await client.query<{
            requester_user_id: string;
            recipient_user_id: string;
          }>({
            text: `
              select requester_user_id, recipient_user_id
              from public.friend_requests
              where pair_user_id_low = least($1::uuid, $2::uuid)
                and pair_user_id_high = greatest($1::uuid, $2::uuid)
                and status = 'pending'
              limit 1
            `,
            values: [input.ownerUserId, targetUserId],
          });
          const pendingRow = pending.rows[0];
          if (pendingRow !== undefined) {
            return failCommand(client, {
              ...failureBase,
              errorCode:
                pendingRow.requester_user_id === input.ownerUserId
                  ? "outgoing_request_pending"
                  : "incoming_request_pending",
            });
          }

          const cooldown = await client.query<{ blocked: boolean }>({
            text: `
              select true as blocked
              from public.friend_requests
              where pair_user_id_low = least($1::uuid, $2::uuid)
                and pair_user_id_high = greatest($1::uuid, $2::uuid)
                and status = 'rejected'
                and rejection_cooldown_until > clock_timestamp()
              order by rejection_cooldown_until desc
              limit 1
            `,
            values: [input.ownerUserId, targetUserId],
          });
          if (cooldown.rows[0]?.blocked === true) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "friend_request_cooldown",
            });
          }

          const insertedRequest = await client.query<{
            friend_request_id: string;
          }>({
            text: `
              insert into public.friend_requests (
                requester_user_id,
                recipient_user_id,
                expires_at
              ) values (
                $1,
                $2,
                clock_timestamp() + $3::interval
              )
              returning friend_request_id
            `,
            values: [input.ownerUserId, targetUserId, friendRequestLifetimeSql],
          });
          const friendRequestId = insertedRequest.rows[0]?.friend_request_id;
          if (friendRequestId === undefined) {
            throw new SocialRepositoryUnavailableError();
          }
          const request = await readFriendRequestForOwner(
            client,
            input.ownerUserId,
            friendRequestId,
          );
          if (request === null) {
            throw new SocialRepositoryUnavailableError();
          }
          return succeedCommand(client, {
            ...failureBase,
            request,
            friendship: null,
          });
        });
        if (outcome.error !== null) {
          return throwCommandError(outcome.error);
        }
        if (outcome.result === null) {
          throw new SocialRepositoryUnavailableError();
        }
        return outcome.result;
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listFriendRequests(rawInput: ListFriendRequestsInput) {
      try {
        const input = listFriendRequestsInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          await client.query({
            text: `
              update public.friend_requests
              set
                status = 'expired',
                decided_at = greatest(clock_timestamp(), created_at),
                updated_at = greatest(clock_timestamp(), updated_at)
              where $1 in (requester_user_id, recipient_user_id)
                and status = 'pending'
                and expires_at <= clock_timestamp()
            `,
            values: [input.ownerUserId],
          });
          const ownerColumn =
            input.direction === "incoming"
              ? "request.recipient_user_id"
              : "request.requester_user_id";
          const result = await client.query<Record<string, unknown>>({
            text: `
              ${friendRequestProjectionSql}
              where ${ownerColumn} = $1
                and request.status = $2
                and (
                  $4::timestamptz is null
                  or (request.created_at, request.friend_request_id)
                    < ($4::timestamptz, $5::uuid)
                )
              order by request.created_at desc, request.friend_request_id desc
              limit $3
            `,
            values: [
              input.ownerUserId,
              input.status,
              input.limit,
              input.beforeCreatedAt ?? null,
              input.beforeFriendRequestId ?? null,
            ],
          });
          return Object.freeze(result.rows.map(toFriendRequestRecord));
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async decideFriendRequest(rawInput: DecideFriendRequestInput) {
      try {
        const input = decideFriendRequestInputSchema.parse(rawInput);
        const outcome = await withTransaction(pool, async (client) => {
          const claim = await claimSocialCommand(client, input);
          if (claim.existingOperation !== null) {
            return replayCommand(
              client,
              input.ownerUserId,
              claim.existingOperation,
            );
          }
          const failureBase = Object.freeze({
            operationId: input.idempotencyKey,
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            idempotencyRecordId: claim.idempotencyRecordId,
            requestSha256: input.requestSha256,
            kind: "friend_request_decide" as const,
          });
          const locked = await client.query<{
            requester_user_id: string;
            recipient_user_id: string;
            status: FriendRequestStatus;
            expires_at: Date;
          }>({
            text: `
              select
                requester_user_id,
                recipient_user_id,
                status,
                expires_at
              from public.friend_requests
              where friend_request_id = $1
                and recipient_user_id = $2
              limit 1
              for update
            `,
            values: [input.friendRequestId, input.ownerUserId],
          });
          const lockedRow = locked.rows[0];
          if (lockedRow === undefined) {
            return failCommand(client, {
              ...failureBase,
              errorCode: "friend_request_not_found",
            });
          }
          if (lockedRow.status === "pending") {
            const expired = await client.query<{ friend_request_id: string }>({
              text: `
                update public.friend_requests
                set
                  status = 'expired',
                  decided_at = greatest(clock_timestamp(), created_at),
                  updated_at = greatest(clock_timestamp(), updated_at)
                where friend_request_id = $1
                  and status = 'pending'
                  and expires_at <= clock_timestamp()
                returning friend_request_id
              `,
              values: [input.friendRequestId],
            });
            if (expired.rows[0] !== undefined) {
              return failCommand(client, {
                ...failureBase,
                errorCode: "friend_request_already_decided",
              });
            }
          }
          if (lockedRow.status !== "pending") {
            return failCommand(client, {
              ...failureBase,
              errorCode: "friend_request_already_decided",
            });
          }

          const senderProfile = await client.query<{ owner_user_id: string }>({
            text: `
              select owner_user_id
              from public.user_profiles
              where owner_user_id = $1
              limit 1
            `,
            values: [lockedRow.requester_user_id],
          });
          if (
            senderProfile.rows[0]?.owner_user_id !== lockedRow.requester_user_id
          ) {
            throw new SocialRepositoryUnavailableError();
          }

          if (input.decision === "accept") {
            const existingFriendship = await client.query<{
              friendship_id: string;
            }>({
              text: `
                select friendship_id
                from public.friendships
                where user_id_low = least($1::uuid, $2::uuid)
                  and user_id_high = greatest($1::uuid, $2::uuid)
                limit 1
              `,
              values: [input.ownerUserId, lockedRow.requester_user_id],
            });
            if (existingFriendship.rows[0] !== undefined) {
              return failCommand(client, {
                ...failureBase,
                errorCode: "already_friends",
              });
            }
          }

          await client.query({
            text:
              input.decision === "accept"
                ? `
                  update public.friend_requests
                  set
                    status = 'accepted',
                    decided_at = greatest(clock_timestamp(), created_at),
                    updated_at = greatest(clock_timestamp(), updated_at)
                  where friend_request_id = $1 and status = 'pending'
                `
                : `
                  update public.friend_requests
                  set
                    status = 'rejected',
                    decided_at = greatest(clock_timestamp(), created_at),
                    rejection_cooldown_until =
                      greatest(clock_timestamp(), created_at) + $2::interval,
                    updated_at = greatest(clock_timestamp(), updated_at)
                  where friend_request_id = $1 and status = 'pending'
                `,
            values:
              input.decision === "accept"
                ? [input.friendRequestId]
                : [input.friendRequestId, rejectionCooldownSql],
          });

          if (input.decision === "accept") {
            await client.query({
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
              values: [
                input.ownerUserId,
                lockedRow.requester_user_id,
                input.friendRequestId,
              ],
            });
          }

          const request = await readFriendRequestForOwner(
            client,
            input.ownerUserId,
            input.friendRequestId,
          );
          if (request === null) {
            throw new SocialRepositoryUnavailableError();
          }
          const friendship =
            input.decision === "accept"
              ? await readFriendshipForOwnerAndRequest(
                  client,
                  input.ownerUserId,
                  input.friendRequestId,
                )
              : null;
          if (input.decision === "accept" && friendship === null) {
            throw new SocialRepositoryUnavailableError();
          }
          return succeedCommand(client, {
            ...failureBase,
            request,
            friendship,
          });
        });
        if (outcome.error !== null) {
          return throwCommandError(outcome.error);
        }
        if (outcome.result === null) {
          throw new SocialRepositoryUnavailableError();
        }
        return outcome.result;
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getSocialOperation(rawOwnerUserId: string, rawOperationId: string) {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        const operationId = uuidV4Schema.parse(rawOperationId);
        return await readSocialOperation(pool, ownerUserId, operationId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
