import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import { normalizeDecimalString } from "../features/market/market-contract.js";
import {
  communityActivityObservationMaxAgeSeconds,
  communityCommandDigestVersion,
  communityCommandIdempotencyScope,
  communityConfigVersion,
  communityVerificationStatuses,
  socialGraphCommandDigestVersion,
  socialGraphCommandIdempotencyScope,
  type IdentityProjection,
} from "../features/community/community-contract.js";
import {
  defaultCommunityChannelMemberCap,
  deriveCommunityChannelId,
} from "../features/communication/communication-contract.js";
import { deriveStreamUserId } from "../features/identity/loop-identifiers.js";
import {
  canPerformSelfAction,
  canPerformTargetAction,
  communityMembershipStatuses,
  communityRoles,
  membershipAfterAction,
  targetStateAllowsAction,
  viewerPermissions,
  type CommunityRole,
  type CommunityTargetAction,
} from "../features/community/community-policy.js";
import {
  CommunityDataStaleError,
  CommunityIdempotencyConflictError,
  CommunityNotFoundError,
  CommunityPermissionDeniedError,
  CommunityProfileRequiredError,
  CommunityRepositoryUnavailableError,
  CommunitySlugTakenError,
  CommunityTargetUnavailableError,
  type BlockCommandInput,
  type BlockCountsRecord,
  type BlockRecord,
  type CommunityDetailRecord,
  type CommunityHomeRecord,
  type CommunityMemberPageRecord,
  type CommunityMemberRecord,
  type CommunityMembershipCommandInput,
  type CommunityOrderingFacts,
  type CommunityRecord,
  type CommunityRepository,
  type ConnectionCountsRecord,
  type ConnectionRecord,
  type CreateCommunityInput,
  type UpdateCommunityInput,
  type DecideMessageRequestInput,
  type FollowCommandInput,
  type GovernMemberInput,
  type GovernMemberRecord,
  type ListBlocksInput,
  type ListCommunitiesInput,
  type ListConnectionsInput,
  type ListMembersInput,
  type ListMessageRequestsInput,
  type MembershipRecord,
  type MessageRequestDecisionRecord,
  type SendMessageRequestInput,
  type MessageRequestRecord,
  type SearchCommunitiesInput,
  type SearchCommunityRecord,
  type SearchUserRecord,
  type SearchUsersInput,
} from "../features/community/community-repository.js";

/**
 * PostgreSQL implementation of the V2 community, follow-graph, block-list,
 * message-request, and search boundary (Decision 0031).
 *
 * Every command is one transaction that claims a durable owner/scope/digest
 * idempotency record, applies the state change, and appends one audit row.
 * `member_count` is maintained by the in-transaction trigger installed by
 * `000016_v2_community_social`, so a concurrent join can neither lose nor
 * double count.
 */

const rejectionCooldownSql = "24 hours";
/** The V1 friend-request lifetime, reused verbatim by the V2 send path. */
const messageRequestLifetimeSql = "7 days";
const uniqueViolation = "23505";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const userIdSchema = z.string().regex(canonicalUuidPattern);
const opaqueIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const limitSchema = z.number().int().min(1).max(101);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const communityRowSchema = z
  .object({
    community_id: opaqueIdSchema,
    name: z.string().min(1),
    slug: z.string().min(3),
    description: z.string().min(1).nullable(),
    logo_ref: z.string().min(1).nullable(),
    verification_status: z.enum(communityVerificationStatuses),
    bound_asset_key: z.string().min(1).nullable(),
    member_count: z.number().int().min(0),
    config_version: z.literal(communityConfigVersion),
    created_at: dateSchema,
  })
  .strict();

const membershipRowSchema = z
  .object({
    role: z.enum(communityRoles),
    status: z.enum(communityMembershipStatuses),
    joined_at: dateSchema,
  })
  .strict();

const identityRowSchema = z
  .object({
    public_profile_id: opaqueIdSchema,
    loop_id: z.string().regex(/^LOOP-[0-9A-HJKMNP-TV-Z]{8}$/),
    alias: z.string().min(1).nullable(),
    avatar_ref: z.string().min(1).nullable(),
  })
  .strict();

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

const communityColumns = `
  community.community_id,
  community.name,
  community.slug,
  community.description,
  community.logo_ref,
  community.verification_status,
  community.bound_asset_key,
  community.member_count,
  community.config_version,
  community.created_at
`;

const identityColumns = `
  profile.public_profile_id,
  account.loop_id,
  profile.alias,
  profile.avatar_ref
`;

const identityFromSql = `
  from public.user_profiles as profile
  join public.loop_users as account on account.id = profile.owner_user_id
`;

/**
 * A community that is not `verified` is visible only to its creator and to
 * its own non-banned members. Every read path (discovery, search, record,
 * member directory) applies the same predicate, so an unverified community
 * cannot be enumerated by a stranger through any surface. `$1` is the viewer
 * and is always referenced so PostgreSQL can infer the parameter type.
 */
const communityVisibleToViewerSql = `(
  community.verification_status = 'verified'
  or community.created_by_user_id = $1::uuid
  or exists (
    select 1
    from public.community_memberships as viewer
    where viewer.community_id = community.community_id
      and viewer.owner_user_id = $1::uuid
      and viewer.status <> 'banned'
  )
)`;

function toCommunityRecord(value: unknown): CommunityRecord {
  const row = communityRowSchema.parse(value);
  return Object.freeze({
    communityId: row.community_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoRef: row.logo_ref,
    verificationStatus: row.verification_status,
    boundAssetKey: row.bound_asset_key,
    memberCount: row.member_count,
    createdAt: row.created_at.toISOString(),
    configVersion: row.config_version,
  });
}

const miningOrderingRowSchema = z
  .object({
    mining_power: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    mining_participant_count: z.number().int().min(0).nullable(),
    mining_weight: z.string().min(1).nullable(),
    mining_weight_config_version: z.string().min(1).nullable(),
    mining_weight_reviewed_at: dateSchema.nullable(),
  })
  .strict();

const activityOrderingRowSchema = z
  .object({
    activity_message_count: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    activity_bounded: z.boolean().nullable(),
    activity_observed_at: dateSchema.nullable(),
  })
  .strict();

const emptyOrderingFacts: CommunityOrderingFacts = Object.freeze({
  miningPower: null,
  miningParticipantCount: null,
  miningWeight: null,
  miningWeightConfigVersion: null,
  miningWeightReviewedAt: null,
  activityMessageCount: null,
  activityBounded: null,
  activityObservedAt: null,
});

/**
 * A discover row of an ordering sort (Decision 0061): the community itself
 * plus the fact it was ordered by. A community the ordering fact does not
 * cover keeps a null fact rather than a zero — "no approved weight" and "no
 * observation" are not the number nought.
 */
function toOrderedCommunityRecord(
  value: unknown,
  sort: "activity" | "miningPower",
): CommunityRecord {
  const row = value as Record<string, unknown>;
  const community = toCommunityRecord({
    community_id: row["community_id"],
    name: row["name"],
    slug: row["slug"],
    description: row["description"],
    logo_ref: row["logo_ref"],
    verification_status: row["verification_status"],
    bound_asset_key: row["bound_asset_key"],
    member_count: row["member_count"],
    config_version: row["config_version"],
    created_at: row["created_at"],
  });
  if (sort === "miningPower") {
    const ordering = miningOrderingRowSchema.parse({
      mining_power: row["mining_power"],
      mining_participant_count: row["mining_participant_count"],
      mining_weight: row["mining_weight"],
      mining_weight_config_version: row["mining_weight_config_version"],
      mining_weight_reviewed_at: row["mining_weight_reviewed_at"],
    });
    const weighted = ordering.mining_weight !== null;
    return Object.freeze({
      ...community,
      ordering: Object.freeze({
        ...emptyOrderingFacts,
        miningPower: weighted
          ? normalizeDecimalString(ordering.mining_power)
          : null,
        miningParticipantCount: weighted
          ? (ordering.mining_participant_count ?? 0)
          : null,
        miningWeight: ordering.mining_weight,
        miningWeightConfigVersion: ordering.mining_weight_config_version,
        miningWeightReviewedAt:
          ordering.mining_weight_reviewed_at === null
            ? null
            : ordering.mining_weight_reviewed_at.toISOString(),
      }),
    });
  }
  const ordering = activityOrderingRowSchema.parse({
    activity_message_count: row["activity_message_count"],
    activity_bounded: row["activity_bounded"],
    activity_observed_at: row["activity_observed_at"],
  });
  return Object.freeze({
    ...community,
    ordering: Object.freeze({
      ...emptyOrderingFacts,
      activityMessageCount:
        ordering.activity_message_count === null
          ? null
          : Number(ordering.activity_message_count),
      activityBounded: ordering.activity_bounded,
      activityObservedAt:
        ordering.activity_observed_at === null
          ? null
          : ordering.activity_observed_at.toISOString(),
    }),
  });
}

function toMembershipRecord(value: unknown): MembershipRecord {
  const row = membershipRowSchema.parse(value);
  return Object.freeze({
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at.toISOString(),
  });
}

const memberIdentityRowSchema = z
  .object({
    public_profile_id: opaqueIdSchema.nullable(),
    loop_id: z.string().regex(/^LOOP-[0-9A-HJKMNP-TV-Z]{8}$/),
    alias: z.string().min(1).nullable(),
    avatar_ref: z.string().min(1).nullable(),
  })
  .strict();

/** Member-directory identity; `publicProfileId` is null without a profile row. */
function toMemberIdentity(value: Record<string, unknown>): {
  readonly publicProfileId: string | null;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
} {
  const row = memberIdentityRowSchema.parse({
    public_profile_id: value["public_profile_id"] ?? null,
    loop_id: value["loop_id"],
    alias: value["alias"] ?? null,
    avatar_ref: value["avatar_ref"] ?? null,
  });
  return Object.freeze({
    publicProfileId: row.public_profile_id,
    loopId: row.loop_id,
    alias: row.alias,
    avatarRef: row.avatar_ref,
  });
}

function toIdentity(value: unknown): IdentityProjection {
  const row = identityRowSchema.parse(value);
  return Object.freeze({
    publicProfileId: row.public_profile_id,
    loopId: row.loop_id,
    alias: row.alias,
    avatarRef: row.avatar_ref,
  });
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  if (error.code !== uniqueViolation) {
    return false;
  }
  if (constraint === undefined) {
    return true;
  }
  return (
    "constraint" in error &&
    typeof error.constraint === "string" &&
    error.constraint === constraint
  );
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof CommunityDataStaleError ||
    error instanceof CommunityIdempotencyConflictError ||
    error instanceof CommunityNotFoundError ||
    error instanceof CommunityPermissionDeniedError ||
    error instanceof CommunityProfileRequiredError ||
    error instanceof CommunityRepositoryUnavailableError ||
    error instanceof CommunitySlugTakenError ||
    error instanceof CommunityTargetUnavailableError
  ) {
    throw error;
  }
  if (isUniqueViolation(error, "communities_slug_unique")) {
    throw new CommunitySlugTakenError();
  }
  throw new CommunityRepositoryUnavailableError();
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
      throw new CommunityRepositoryUnavailableError();
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
    text: `select id from public.loop_users where id = $1 for update`,
    values: [ownerUserId],
  });
  if (result.rows[0]?.id !== ownerUserId) {
    throw new CommunityRepositoryUnavailableError();
  }
}

/**
 * Claim the durable idempotency record. The same key with a different owner
 * or canonical digest returns no row, which is an idempotency conflict; an
 * identical replay returns the same record ID so the caller can find the
 * original audit row.
 */
async function claimCommand(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly scope: string;
    readonly digestVersion: string;
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
      input.scope,
      input.idempotencyKey,
      input.requestSha256,
      input.digestVersion,
    ],
  });
  const id = claimed.rows[0]?.id;
  if (id === undefined) {
    throw new CommunityIdempotencyConflictError();
  }
  return id;
}

function claimCommunityCommand(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<string> {
  return claimCommand(client, {
    ...input,
    scope: communityCommandIdempotencyScope,
    digestVersion: communityCommandDigestVersion,
  });
}

function claimSocialGraphCommand(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<string> {
  return claimCommand(client, {
    ...input,
    scope: socialGraphCommandIdempotencyScope,
    digestVersion: socialGraphCommandDigestVersion,
  });
}

async function findCommunityAudit(
  client: DatabaseClient,
  idempotencyRecordId: string,
): Promise<{ readonly communityId: string } | null> {
  const result = await client.query<{ community_id: string }>({
    text: `
      select community_id
      from public.community_role_events
      where idempotency_record_id = $1
      limit 1
    `,
    values: [idempotencyRecordId],
  });
  const row = result.rows[0];
  return row === undefined
    ? null
    : Object.freeze({ communityId: opaqueIdSchema.parse(row.community_id) });
}

async function findSocialGraphAudit(
  client: DatabaseClient,
  idempotencyRecordId: string,
): Promise<{
  readonly targetUserId: string | null;
  readonly subjectId: string | null;
  readonly resultStatus: string | null;
  readonly occurredAt: string;
} | null> {
  const result = await client.query<{
    target_user_id: string | null;
    subject_id: string | null;
    result_status: string | null;
    occurred_at: Date;
  }>({
    text: `
      select target_user_id, subject_id, result_status, occurred_at
      from public.social_graph_events
      where idempotency_record_id = $1
      limit 1
    `,
    values: [idempotencyRecordId],
  });
  const row = result.rows[0];
  return row === undefined
    ? null
    : Object.freeze({
        targetUserId: row.target_user_id,
        subjectId: row.subject_id,
        resultStatus: row.result_status,
        occurredAt: dateSchema.parse(row.occurred_at).toISOString(),
      });
}

async function appendCommunityAudit(
  client: DatabaseClient,
  input: {
    readonly communityId: string;
    readonly actorUserId: string | null;
    readonly targetUserId: string | null;
    readonly eventType: string;
    readonly fromRole?: CommunityRole | null;
    readonly toRole?: CommunityRole | null;
    readonly fromStatus?: string | null;
    readonly toStatus?: string | null;
    readonly reasonCode?: string | null;
    readonly idempotencyRecordId: string | null;
    readonly requestId: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.community_role_events (
        community_id,
        actor_user_id,
        actor_type,
        target_user_id,
        event_type,
        from_role,
        to_role,
        from_status,
        to_status,
        reason_code,
        idempotency_record_id,
        request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    values: [
      input.communityId,
      input.actorUserId,
      input.actorUserId === null ? "operator" : "member",
      input.targetUserId,
      input.eventType,
      input.fromRole ?? null,
      input.toRole ?? null,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.reasonCode ?? null,
      input.idempotencyRecordId,
      input.requestId,
    ],
  });
}

async function appendSocialGraphAudit(
  client: DatabaseClient,
  input: {
    readonly actorUserId: string;
    readonly eventType: string;
    readonly targetUserId: string | null;
    readonly subjectId: string | null;
    readonly resultStatus: string | null;
    readonly reasonCode: string | null;
    readonly idempotencyRecordId: string;
    readonly requestId: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.social_graph_events (
        actor_user_id,
        event_type,
        target_user_id,
        subject_id,
        result_status,
        reason_code,
        idempotency_record_id,
        request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    values: [
      input.actorUserId,
      input.eventType,
      input.targetUserId,
      input.subjectId,
      input.resultStatus,
      input.reasonCode,
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
    throw new CommunityProfileRequiredError();
  }
  return opaqueIdSchema.parse(row.public_profile_id);
}

async function readCommunity(
  client: DatabaseClient,
  communityId: string,
  forUpdate = false,
): Promise<CommunityRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${communityColumns}
      from public.communities as community
      where community.community_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [communityId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunityNotFoundError();
  }
  return toCommunityRecord(row);
}

/** Read a community only when it is visible to the viewer (see the predicate). */
async function readVisibleCommunity(
  client: DatabaseClient,
  communityId: string,
  viewerUserId: string,
): Promise<CommunityRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${communityColumns}
      from public.communities as community
      where community.community_id = $2
        and ${communityVisibleToViewerSql}
      limit 1
    `,
    values: [viewerUserId, communityId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunityNotFoundError();
  }
  return toCommunityRecord(row);
}

async function readMembership(
  client: DatabaseClient,
  communityId: string,
  ownerUserId: string,
  forUpdate = false,
): Promise<MembershipRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select role, status, joined_at
      from public.community_memberships
      where community_id = $1 and owner_user_id = $2
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [communityId, ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toMembershipRecord(row);
}

async function readDetail(
  client: DatabaseClient,
  communityId: string,
  viewerUserId: string,
): Promise<CommunityDetailRecord> {
  return Object.freeze({
    community: await readVisibleCommunity(client, communityId, viewerUserId),
    viewerMembership: await readMembership(client, communityId, viewerUserId),
  });
}

/**
 * Resolve another account from its public profile ID. Nonexistent, inactive,
 * self, blocked, and (when required) non-discoverable targets all raise the
 * same non-enumerating error.
 */
async function resolveTarget(
  client: DatabaseClient,
  input: {
    readonly viewerUserId: string;
    readonly targetPublicProfileId: string;
    readonly requireDiscoverable: boolean;
    readonly requireUnblocked: boolean;
  },
): Promise<{ readonly userId: string; readonly profile: IdentityProjection }> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        profile.owner_user_id,
        ${identityColumns},
        coalesce(privacy.discoverable, false) as discoverable,
        exists (
          select 1
          from public.user_blocks as blocks
          where blocks.kind = 'user'
            and (
              (blocks.owner_user_id = $1
                and blocks.target_user_id = profile.owner_user_id)
              or (blocks.owner_user_id = profile.owner_user_id
                and blocks.target_user_id = $1)
            )
        ) as blocked
      ${identityFromSql}
      left join public.privacy_preferences_v2 as privacy
        on privacy.owner_user_id = profile.owner_user_id
      where profile.public_profile_id = $2
        and profile.profile_status = 'active'
      limit 1
    `,
    values: [input.viewerUserId, input.targetPublicProfileId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunityTargetUnavailableError();
  }
  const ownerUserId = userIdSchema.parse(row["owner_user_id"]);
  if (
    ownerUserId === input.viewerUserId ||
    (input.requireDiscoverable && row["discoverable"] !== true) ||
    (input.requireUnblocked && row["blocked"] === true)
  ) {
    throw new CommunityTargetUnavailableError();
  }
  return Object.freeze({
    userId: ownerUserId,
    profile: toIdentity({
      public_profile_id: row["public_profile_id"],
      loop_id: row["loop_id"],
      alias: row["alias"],
      avatar_ref: row["avatar_ref"],
    }),
  });
}

/**
 * Project one `friend_requests` row in the shape of a V2 message-request item.
 * The identity is the **recipient**: this projection answers the sender, while
 * `listMessageRequests` answers the recipient and therefore projects the
 * requester. Both carry the same fields.
 */
async function readMessageRequest(
  client: DatabaseClient,
  messageRequestId: string,
): Promise<MessageRequestRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        request.friend_request_id,
        request.created_at,
        request.expires_at,
        ${identityColumns}
      from public.friend_requests as request
      join public.user_profiles as profile
        on profile.owner_user_id = request.recipient_user_id
      join public.loop_users as account
        on account.id = request.recipient_user_id
      where request.friend_request_id = $1
      limit 1
    `,
    values: [messageRequestId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunityRepositoryUnavailableError();
  }
  return Object.freeze({
    messageRequestId: opaqueIdSchema.parse(row["friend_request_id"]),
    profile: toIdentity({
      public_profile_id: row["public_profile_id"],
      loop_id: row["loop_id"],
      alias: row["alias"],
      avatar_ref: row["avatar_ref"],
    }),
    createdAt: dateSchema.parse(row["created_at"]).toISOString(),
    expiresAt: dateSchema.parse(row["expires_at"]).toISOString(),
  });
}

async function readIdentityByUserId(
  client: DatabaseClient,
  userId: string,
): Promise<IdentityProjection> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${identityColumns}
      ${identityFromSql}
      where profile.owner_user_id = $1
      limit 1
    `,
    values: [userId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new CommunityTargetUnavailableError();
  }
  return toIdentity(row);
}

async function removeFollowEdges(
  client: DatabaseClient,
  first: string,
  second: string,
): Promise<void> {
  await client.query({
    text: `
      delete from public.follow_edges
      where (follower_user_id = $1 and followee_user_id = $2)
         or (follower_user_id = $2 and followee_user_id = $1)
    `,
    values: [first, second],
  });
}

/**
 * Transactional outbox for the official community channel (Decision 0032).
 * The Stream write itself never happens here: the row records the latest
 * intended membership change and the standalone `community-channel-sync`
 * worker lane performs it after this transaction has committed. Communities
 * without an official channel (not verified yet) enqueue nothing.
 */
async function enqueueCommunityChannelSync(
  client: DatabaseClient,
  input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly kind: "add" | "remove";
    readonly requestId: string;
    /**
     * `reset` records a new intent and restarts the job. `fillGap` only
     * creates what is missing: it never resets an already `synced` member and
     * never restarts a job that already exists, so re-running verification is
     * a repair rather than a re-synchronization of the whole community.
     */
    readonly mode?: "reset" | "fillGap";
  },
): Promise<void> {
  const fillGap = input.mode === "fillGap";
  await client.query({
    text: `
      insert into public.community_channel_members (
        community_id, owner_user_id, stream_user_id, state
      )
      select $1, $2, $3, 'pending'
      where exists (
        select 1 from public.community_channels where community_id = $1
      )
      on conflict (community_id, owner_user_id) do update
      set state = 'pending', updated_at = clock_timestamp()
      ${fillGap ? "where false" : ""}
    `,
    values: [
      input.communityId,
      input.ownerUserId,
      deriveStreamUserId(input.ownerUserId),
    ],
  });
  await client.query({
    text: `
      insert into public.community_channel_sync_jobs (
        community_id, owner_user_id, kind, state, attempts, request_id
      )
      select $1, $2, $3, 'pending', 0, $4
      where exists (
        select 1 from public.community_channels where community_id = $1
      )
      on conflict (community_id, owner_user_id) do ${
        fillGap
          ? "nothing"
          : `update
      set
        kind = excluded.kind,
        state = 'pending',
        attempts = 0,
        next_attempt_at = clock_timestamp(),
        last_error_code = null,
        lease_worker_id = null,
        lease_expires_at = null,
        request_id = excluded.request_id,
        updated_at = clock_timestamp()`
      }
    `,
    values: [input.communityId, input.ownerUserId, input.kind, input.requestId],
  });
}

/**
 * Allocate the official channel record when a community becomes verified and
 * enqueue one `add` job per existing non-banned member. The channel ID is a
 * pure function of the community ID, so a replay can never allocate a second
 * channel.
 */
async function provisionCommunityChannel(
  client: DatabaseClient,
  input: {
    readonly communityId: string;
    readonly memberCap: number;
    readonly requestId: string;
    /** `repair` re-runs verification without disturbing synced members. */
    readonly mode?: "initial" | "repair";
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.community_channels (
        community_id, stream_channel_id, member_cap, created_by_user_id
      )
      select $1, $2, $3, community.created_by_user_id
      from public.communities as community
      where community.community_id = $1
      on conflict (community_id) do nothing
    `,
    values: [
      input.communityId,
      deriveCommunityChannelId(input.communityId),
      input.memberCap,
    ],
  });
  const repair = input.mode === "repair";
  // A repair only looks at memberships whose channel projection is missing or
  // not yet `synced`; an account Stream already accepted is left alone.
  const members = await client.query<{ owner_user_id: string }>({
    text: `
      select membership.owner_user_id
      from public.community_memberships as membership
      left join public.community_channel_members as member
        on member.community_id = membership.community_id
        and member.owner_user_id = membership.owner_user_id
      where membership.community_id = $1
        and membership.status <> 'banned'
        and ($2::boolean is false or member.state is distinct from 'synced')
      order by membership.joined_at asc
    `,
    values: [input.communityId, repair],
  });
  for (const member of members.rows) {
    await enqueueCommunityChannelSync(client, {
      communityId: input.communityId,
      ownerUserId: userIdSchema.parse(member.owner_user_id),
      kind: "add",
      requestId: input.requestId,
      mode: repair ? "fillGap" : "reset",
    });
  }
}

/**
 * Verified communities whose official channel was never allocated. Only the
 * operator repair path (`pnpm community:provision-channels`) reads this: a
 * community reaches this state when its rows were written outside the
 * product write path (a seed), because `verifyCommunity` is the one place
 * that allocates the channel. The repair itself goes back through
 * `verifyCommunity`, never through a direct write to `community_channels`.
 */
export interface CommunityMissingChannelRecord {
  readonly communityId: string;
  readonly slug: string;
  readonly name: string;
  readonly memberCount: number;
}

export async function listVerifiedCommunitiesWithoutChannel(
  pool: Pool,
): Promise<readonly CommunityMissingChannelRecord[]> {
  const result = await pool.query<{
    community_id: string;
    slug: string;
    name: string;
    member_count: number;
  }>({
    text: `
      select community.community_id, community.slug, community.name,
        community.member_count
      from public.communities as community
      where community.verification_status = 'verified'
        and not exists (
          select 1 from public.community_channels as channel
          where channel.community_id = community.community_id
        )
      order by community.member_count desc, community.community_id asc
    `,
  });
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        communityId: opaqueIdSchema.parse(row.community_id),
        slug: row.slug,
        name: row.name,
        memberCount: Number(row.member_count),
      }),
    ),
  );
}

export interface PostgresCommunityRepositoryOptions {
  /** Stream channel member ceiling recorded on a newly provisioned channel. */
  readonly communityChannelMemberCap?: number;
}

export function createPostgresCommunityRepository(
  pool: Pool,
  options: PostgresCommunityRepositoryOptions = {},
): CommunityRepository {
  const communityChannelMemberCap =
    options.communityChannelMemberCap ?? defaultCommunityChannelMemberCap;

  /**
   * Discover ordering (Decision 0061). `members` and `newest` order by a
   * stored column; `miningPower` joins the caller's snapshot and orders by
   * the community's power on its bound asset; `activity` joins the last
   * observation of its official channel and orders by the messages of the
   * window. A community that has no such fact is not hidden: it sorts after
   * every community that does, on the sentinel `-1`, and carries a null
   * ordering fact the service publishes as unavailable.
   */
  async function listCommunitiesQuery(
    client: DatabaseClient,
    input: ListCommunitiesInput,
  ): Promise<readonly CommunityRecord[]> {
    const after = input.after;
    const values: unknown[] = [
      input.viewerUserId,
      input.limit,
      input.verification,
      after?.lastSortValue ?? null,
      after?.lastCommunityId ?? null,
      input.membership,
    ];
    if (input.sort === "miningPower") {
      const ordering = input.miningOrdering;
      if (ordering === undefined) {
        // The caller resolves the baseline; without one there is no
        // ordering to apply and the list must not silently fall back.
        throw new CommunityRepositoryUnavailableError();
      }
      values.push(ordering.snapshotId, ordering.configVersion);
    }
    if (input.sort === "activity") {
      values.push(
        z
          .number()
          .int()
          .min(1)
          .max(604_800)
          .parse(
            input.activityMaxAgeSeconds ??
              communityActivityObservationMaxAgeSeconds,
          ),
      );
    }
    // The keyset bounds are always referenced (null before the first cursor)
    // so PostgreSQL can infer every parameter type in both branches.
    const keyset =
      input.sort === "members"
        ? `and (
            $4::text is null
            or community.member_count < $4::integer
            or (community.member_count = $4::integer
              and community.community_id > $5::uuid)
          )`
        : input.sort === "newest"
          ? `and (
            $4::text is null
            or community.created_at < $4::timestamptz
            or (community.created_at = $4::timestamptz
              and community.community_id < $5::uuid)
          )`
          : input.sort === "miningPower"
            ? `and (
            $4::text is null
            or coalesce(ordering.mining_power, -1) < $4::numeric
            or (coalesce(ordering.mining_power, -1) = $4::numeric
              and community.community_id > $5::uuid)
          )`
            : `and (
            $4::text is null
            or coalesce(activity.recent_message_count, -1) < $4::numeric
            or (coalesce(activity.recent_message_count, -1) = $4::numeric
              and community.community_id > $5::uuid)
          )`;
    const orderingJoin =
      input.sort === "miningPower"
        ? `left join lateral (
            select
              -- A weighted community with no member power is a zero, not an
              -- absence: it must order as 0 and project as "0", the same
              -- number the cursor carries. Only a community without an
              -- approved weight has no row here at all.
              coalesce(sum(power.power::numeric), 0) as mining_power,
              count(power.owner_user_id)
                filter (where power.power::numeric > 0)::int
                as mining_participant_count,
              weight.weight::text as mining_weight,
              weight.config_version as mining_weight_config_version,
              weight.reviewed_at as mining_weight_reviewed_at
            from public.community_mining_weights as weight
            left join public.community_memberships as member
              on member.community_id = weight.community_id
              and member.status <> 'banned'
            left join public.mining_snapshot_powers as power
              on power.snapshot_id = $7::uuid
              and power.owner_user_id = member.owner_user_id
              and power.asset_id = community.bound_asset_key
            where weight.community_id = community.community_id
              and weight.status = 'approved'
              and weight.config_version = $8::text
              and community.bound_asset_key is not null
            group by weight.weight, weight.config_version, weight.reviewed_at
          ) as ordering on true`
        : input.sort === "activity"
          ? `left join public.community_channel_activity as activity
            on activity.community_id = community.community_id
            and activity.observed_at
              >= clock_timestamp() - make_interval(secs => $7::double precision)`
          : "";
    const orderingColumns =
      input.sort === "miningPower"
        ? `,
        coalesce(ordering.mining_power, 0)::text as mining_power,
        ordering.mining_participant_count,
        ordering.mining_weight,
        ordering.mining_weight_config_version,
        ordering.mining_weight_reviewed_at`
        : input.sort === "activity"
          ? `,
        activity.recent_message_count::text as activity_message_count,
        activity.recent_count_bounded as activity_bounded,
        activity.observed_at as activity_observed_at`
          : "";
    const orderBy =
      input.sort === "members"
        ? "community.member_count desc, community.community_id asc"
        : input.sort === "newest"
          ? "community.created_at desc, community.community_id desc"
          : input.sort === "miningPower"
            ? "coalesce(ordering.mining_power, -1) desc, community.community_id asc"
            : "coalesce(activity.recent_message_count, -1) desc, community.community_id asc";
    // `verification=verified` narrows to verified only; `all` additionally
    // shows what the shared visibility predicate already allows (the viewer's
    // own applications and the communities they joined). `membership=joined`
    // restricts the page to the viewer's own memberships.
    const result = await client.query<Record<string, unknown>>({
      text: `
        select ${communityColumns}${orderingColumns}
        from public.communities as community
        ${orderingJoin}
        where ${communityVisibleToViewerSql}
        and (
          $3::text = 'all'
          or community.verification_status = 'verified'
        )
        and (
          $6::text = 'all'
          or exists (
            select 1
            from public.community_memberships as joined
            where joined.community_id = community.community_id
              and joined.owner_user_id = $1::uuid
              and joined.status <> 'banned'
          )
        )
        ${keyset}
        order by ${orderBy}
        limit $2
      `,
      values,
    });
    return Object.freeze(
      result.rows.map((row) =>
        input.sort === "miningPower" || input.sort === "activity"
          ? toOrderedCommunityRecord(row, input.sort)
          : toCommunityRecord(row),
      ),
    );
  }

  return Object.freeze({
    async listCommunities(rawInput: ListCommunitiesInput) {
      try {
        userIdSchema.parse(rawInput.viewerUserId);
        limitSchema.parse(rawInput.limit);
        return await listCommunitiesQuery(pool, rawInput);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    /**
     * Whether `sort=activity` has anything to order by (Decision 0061).
     * Counted over the same freshness window the list query applies, so the
     * two can never disagree about which observations exist.
     */
    async getCommunityActivityObservation(rawInput: {
      readonly maxAgeSeconds: number;
    }) {
      try {
        const maxAgeSeconds = z
          .number()
          .int()
          .min(1)
          .max(604_800)
          .parse(rawInput.maxAgeSeconds);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              count(*)::int as observed_community_count,
              max(activity.observed_at) as latest_observed_at
            from public.community_channel_activity as activity
            where activity.observed_at
              >= clock_timestamp() - make_interval(secs => $1::double precision)
          `,
          values: [maxAgeSeconds],
        });
        const row = result.rows[0] ?? {};
        const latest = row["latest_observed_at"];
        return Object.freeze({
          observedCommunityCount: z
            .number()
            .int()
            .min(0)
            .parse(row["observed_community_count"]),
          latestObservedAt:
            latest === null || latest === undefined
              ? null
              : dateSchema.parse(latest).toISOString(),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getCommunityHome(rawInput: {
      readonly viewerUserId: string;
      readonly joinedLimit: number;
      readonly discoverLimit: number;
    }): Promise<CommunityHomeRecord> {
      try {
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const joinedLimit = limitSchema.parse(rawInput.joinedLimit);
        const discoverLimit = limitSchema.parse(rawInput.discoverLimit);
        const joined = await pool.query<Record<string, unknown>>({
          text: `
            select
              ${communityColumns},
              membership.role,
              membership.status,
              membership.joined_at
            from public.community_memberships as membership
            join public.communities as community
              on community.community_id = membership.community_id
            where membership.owner_user_id = $1
              and membership.status <> 'banned'
            order by membership.joined_at desc, membership.membership_id desc
            limit $2
          `,
          values: [viewerUserId, joinedLimit + 1],
        });
        const discover = await pool.query<Record<string, unknown>>({
          text: `
            select ${communityColumns}
            from public.communities as community
            where community.verification_status = 'verified'
              and not exists (
                select 1
                from public.community_memberships as membership
                where membership.community_id = community.community_id
                  and membership.owner_user_id = $1
                  and membership.status <> 'banned'
              )
            order by community.member_count desc, community.community_id asc
            limit $2
          `,
          values: [viewerUserId, discoverLimit],
        });
        const observed = await pool.query<{ observed_at: Date }>({
          text: `select clock_timestamp() as observed_at`,
        });
        const observedAt = dateSchema.parse(observed.rows[0]?.observed_at);
        const joinedRows = joined.rows.slice(0, joinedLimit);
        return Object.freeze({
          joinedTruncated: joined.rows.length > joinedLimit,
          joined: Object.freeze(
            joinedRows.map((row) =>
              Object.freeze({
                community: toCommunityRecord({
                  community_id: row["community_id"],
                  name: row["name"],
                  slug: row["slug"],
                  description: row["description"],
                  logo_ref: row["logo_ref"],
                  verification_status: row["verification_status"],
                  bound_asset_key: row["bound_asset_key"],
                  member_count: row["member_count"],
                  config_version: row["config_version"],
                  created_at: row["created_at"],
                }),
                viewerMembership: toMembershipRecord({
                  role: row["role"],
                  status: row["status"],
                  joined_at: row["joined_at"],
                }),
              }),
            ),
          ),
          discover: Object.freeze(discover.rows.map(toCommunityRecord)),
          observedAt: observedAt.toISOString(),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getCommunity(rawInput: {
      readonly viewerUserId: string;
      readonly communityId: string;
    }): Promise<CommunityDetailRecord> {
      try {
        return await readDetail(
          pool,
          opaqueIdSchema.parse(rawInput.communityId),
          userIdSchema.parse(rawInput.viewerUserId),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async createCommunity(
      rawInput: CreateCommunityInput,
    ): Promise<CommunityDetailRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommunityCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findCommunityAudit(client, recordId);
          if (replay !== null) {
            return readDetail(client, replay.communityId, ownerUserId);
          }
          await lockOwner(client, ownerUserId);
          await requireActiveProfile(client, ownerUserId);
          const created = await client.query<{ community_id: string }>({
            text: `
              insert into public.communities (
                name,
                slug,
                description,
                logo_ref,
                bound_asset_key,
                created_by_user_id
              )
              values ($1, $2, $3, $4, $5, $6)
              returning community_id
            `,
            values: [
              rawInput.name,
              rawInput.slug,
              rawInput.description,
              rawInput.logoRef,
              rawInput.boundAssetKey,
              ownerUserId,
            ],
          });
          const communityId = opaqueIdSchema.parse(
            created.rows[0]?.community_id,
          );
          await client.query({
            text: `
              insert into public.community_memberships (
                community_id,
                owner_user_id,
                role,
                status
              )
              values ($1, $2, 'owner', 'active')
            `,
            values: [communityId, ownerUserId],
          });
          await appendCommunityAudit(client, {
            communityId,
            actorUserId: ownerUserId,
            targetUserId: ownerUserId,
            eventType: "community_created",
            toRole: "owner",
            toStatus: "active",
            reasonCode: "member_application",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readDetail(client, communityId, ownerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async updateCommunity(
      rawInput: UpdateCommunityInput,
    ): Promise<CommunityDetailRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const values = rawInput.values;
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommunityCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findCommunityAudit(client, recordId)) !== null) {
            return readDetail(client, communityId, ownerUserId);
          }
          await readCommunity(client, communityId, true);
          const actor = await readMembership(
            client,
            communityId,
            ownerUserId,
            true,
          );
          if (!canPerformSelfAction(actor, "editProfile")) {
            throw new CommunityPermissionDeniedError();
          }
          // Only the keys actually present change; `slug` and
          // `verification_status` are immutable through this path.
          await client.query({
            text: `
              update public.communities
              set
                name = coalesce($2::text, name),
                description = case when $3::boolean then $4::text
                  else description end,
                logo_ref = case when $5::boolean then $6::text
                  else logo_ref end,
                bound_asset_key = case when $7::boolean then $8::text
                  else bound_asset_key end,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where community_id = $1
            `,
            values: [
              communityId,
              values.name ?? null,
              values.description !== undefined,
              values.description ?? null,
              values.logoRef !== undefined,
              values.logoRef ?? null,
              values.boundAssetKey !== undefined,
              values.boundAssetKey ?? null,
            ],
          });
          await appendCommunityAudit(client, {
            communityId,
            actorUserId: ownerUserId,
            targetUserId: ownerUserId,
            eventType: "community_profile_updated",
            reasonCode: "owner_profile_edit",
            idempotencyRecordId: recordId,
            requestId,
          });
          return readDetail(client, communityId, ownerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async joinCommunity(
      rawInput: CommunityMembershipCommandInput,
    ): Promise<CommunityDetailRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommunityCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findCommunityAudit(client, recordId)) !== null) {
            return readDetail(client, communityId, ownerUserId);
          }
          // Joining only needs the community to exist: the ruled visibility
          // predicate governs the read surfaces, and a joiner becomes a member
          // (and therefore a legitimate reader) by this command.
          await readCommunity(client, communityId);
          await requireActiveProfile(client, ownerUserId);
          const existing = await readMembership(
            client,
            communityId,
            ownerUserId,
            true,
          );
          if (existing !== null) {
            if (existing.status === "banned") {
              throw new CommunityPermissionDeniedError();
            }
            return readDetail(client, communityId, ownerUserId);
          }
          await client.query({
            text: `
              insert into public.community_memberships (
                community_id,
                owner_user_id,
                role,
                status
              )
              values ($1, $2, 'member', 'active')
              on conflict (community_id, owner_user_id) do nothing
            `,
            values: [communityId, ownerUserId],
          });
          await appendCommunityAudit(client, {
            communityId,
            actorUserId: ownerUserId,
            targetUserId: ownerUserId,
            eventType: "member_joined",
            toRole: "member",
            toStatus: "active",
            idempotencyRecordId: recordId,
            requestId,
          });
          await enqueueCommunityChannelSync(client, {
            communityId,
            ownerUserId,
            kind: "add",
            requestId,
          });
          return readDetail(client, communityId, ownerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async leaveCommunity(
      rawInput: CommunityMembershipCommandInput,
    ): Promise<CommunityDetailRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommunityCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          // Leaving removes the membership that made an unverified community
          // visible, so the response reads the record directly instead of
          // re-deriving viewer visibility after the change.
          const leftDetail = async (): Promise<CommunityDetailRecord> =>
            Object.freeze({
              community: await readCommunity(client, communityId),
              viewerMembership: await readMembership(
                client,
                communityId,
                ownerUserId,
              ),
            });
          if ((await findCommunityAudit(client, recordId)) !== null) {
            return leftDetail();
          }
          await readVisibleCommunity(client, communityId, ownerUserId);
          const existing = await readMembership(
            client,
            communityId,
            ownerUserId,
            true,
          );
          if (existing === null) {
            throw new CommunityDataStaleError();
          }
          if (!canPerformSelfAction(existing, "leave")) {
            throw new CommunityPermissionDeniedError();
          }
          await client.query({
            text: `
              delete from public.community_memberships
              where community_id = $1 and owner_user_id = $2
            `,
            values: [communityId, ownerUserId],
          });
          await appendCommunityAudit(client, {
            communityId,
            actorUserId: ownerUserId,
            targetUserId: ownerUserId,
            eventType: "member_left",
            fromRole: existing.role,
            fromStatus: existing.status,
            idempotencyRecordId: recordId,
            requestId,
          });
          await enqueueCommunityChannelSync(client, {
            communityId,
            ownerUserId,
            kind: "remove",
            requestId,
          });
          return leftDetail();
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listMembers(
      rawInput: ListMembersInput,
    ): Promise<CommunityMemberPageRecord> {
      try {
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const limit = limitSchema.parse(rawInput.limit);
        const community = await readVisibleCommunity(
          pool,
          communityId,
          viewerUserId,
        );
        const viewerMembership = await readMembership(
          pool,
          communityId,
          viewerUserId,
        );
        const viewerProfile = await pool.query<{ public_profile_id: string }>({
          text: `
            select public_profile_id
            from public.user_profiles
            where owner_user_id = $1
            limit 1
          `,
          values: [viewerUserId],
        });
        // `banned` is a governance view of the same directory: it lists the
        // memberships the other filters exclude, and only an account that may
        // ban (owner or admin) may read it. Every filter is a fixed literal,
        // never interpolated caller input.
        const bannedView = rawInput.role === "banned";
        if (bannedView && !viewerPermissions(viewerMembership).canBan) {
          throw new CommunityPermissionDeniedError();
        }
        const roleFilterSql =
          rawInput.role === "owner"
            ? "and membership.role = 'owner'"
            : rawInput.role === "admin"
              ? "and membership.role = 'admin'"
              : "";
        const statusFilterSql = bannedView
          ? "and membership.status = 'banned'"
          : "and membership.status <> 'banned'";
        const values: unknown[] = [communityId, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(
            after.lastRoleRank,
            after.lastJoinedAt,
            after.lastMembershipId,
          );
          // `joinedAt` travels through the cursor as the millisecond ISO form
          // the response projects, so both the ordering and the keyset compare
          // the millisecond-truncated column. Comparing the raw microsecond
          // value against a truncated bound would re-emit the boundary row on
          // the next page.
          keyset = `
            and (
              case membership.role
                when 'owner' then 0 when 'admin' then 1 else 2 end,
              date_trunc('milliseconds', membership.joined_at),
              membership.membership_id
            ) > ($3::integer, $4::timestamptz, $5::uuid)
          `;
        }
        // A member alias prefix narrows the same ordered directory: the key is
        // derived by the stored-column function so the comparison matches
        // `user_profiles.alias_search_key` exactly, and the LIKE metacharacters
        // in the caller's text are escaped rather than interpolated. A
        // membership whose profile row or alias is missing has a null key and
        // is therefore never a search hit.
        let aliasFilterSql = "";
        const aliasPrefix = rawInput.aliasPrefix;
        if (aliasPrefix !== undefined) {
          values.push(aliasPrefix);
          const placeholder = `$${String(values.length)}`;
          aliasFilterSql = `
            and profile.alias_search_key is not null
            and profile.alias_search_key collate "C" like
              replace(
                replace(
                  replace(
                    public.loop_alias_search_key_unicode17_v1(
                      ${placeholder}::text
                    ) collate "C",
                    '\\', '\\\\'
                  ),
                  '%', '\\%'
                ),
                '_', '\\_'
              ) || '%' escape '\\'
          `;
        }
        const members = await pool.query<Record<string, unknown>>({
          text: `
            select
              membership.membership_id,
              membership.role,
              membership.status,
              membership.joined_at,
              ${identityColumns}
            from public.community_memberships as membership
            left join public.user_profiles as profile
              on profile.owner_user_id = membership.owner_user_id
            join public.loop_users as account
              on account.id = membership.owner_user_id
            where membership.community_id = $1
              ${statusFilterSql}
              ${roleFilterSql}
              ${aliasFilterSql}
              ${keyset}
            order by
              case membership.role
                when 'owner' then 0 when 'admin' then 1 else 2 end asc,
              date_trunc('milliseconds', membership.joined_at) asc,
              membership.membership_id asc
            limit $2
          `,
          values,
        });
        const counts = await pool.query<{
          all_count: string;
          owner_count: string;
          admin_count: string;
        }>({
          text: `
            select
              count(*) as all_count,
              count(*) filter (where role = 'owner') as owner_count,
              count(*) filter (where role = 'admin') as admin_count
            from public.community_memberships
            where community_id = $1 and status <> 'banned'
          `,
          values: [communityId],
        });
        const countRow = counts.rows[0];
        if (countRow === undefined) {
          throw new CommunityRepositoryUnavailableError();
        }
        // The directory left joins `user_profiles`, so a membership whose
        // profile row is missing is still listed and still counted; it simply
        // has no public profile ID and can never be a governance target.
        const items: CommunityMemberRecord[] = members.rows.map((row) =>
          Object.freeze({
            membershipId: opaqueIdSchema.parse(row["membership_id"]),
            ...toMembershipRecord({
              role: row["role"],
              status: row["status"],
              joined_at: row["joined_at"],
            }),
            profile: toMemberIdentity(row),
          }),
        );
        return Object.freeze({
          community,
          viewerMembership,
          viewerPublicProfileId:
            viewerProfile.rows[0] === undefined
              ? null
              : opaqueIdSchema.parse(viewerProfile.rows[0].public_profile_id),
          items: Object.freeze(items),
          counts: Object.freeze({
            all: Number.parseInt(countRow.all_count, 10),
            owner: Number.parseInt(countRow.owner_count, 10),
            admin: Number.parseInt(countRow.admin_count, 10),
          }),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async governMember(
      rawInput: GovernMemberInput,
    ): Promise<GovernMemberRecord> {
      try {
        const actorUserId = userIdSchema.parse(rawInput.actorUserId);
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const targetPublicProfileId = opaqueIdSchema.parse(
          rawInput.targetPublicProfileId,
        );
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const action: CommunityTargetAction = rawInput.action;
        return await withTransaction(pool, async (client) => {
          const recordId = await claimCommunityCommand(client, {
            ownerUserId: actorUserId,
            idempotencyKey,
            requestSha256,
          });
          const community = await readCommunity(client, communityId, true);
          const actor = await readMembership(
            client,
            communityId,
            actorUserId,
            true,
          );
          if (actor === null) {
            throw new CommunityPermissionDeniedError();
          }
          if ((await findCommunityAudit(client, recordId)) !== null) {
            return Object.freeze({
              community,
              actorMembership: actor,
              target: null,
            });
          }
          const targetRow = await client.query<Record<string, unknown>>({
            text: `
              select
                membership.membership_id,
                membership.owner_user_id,
                membership.role,
                membership.status,
                membership.joined_at,
                ${identityColumns}
              from public.community_memberships as membership
              join public.user_profiles as profile
                on profile.owner_user_id = membership.owner_user_id
              join public.loop_users as account
                on account.id = membership.owner_user_id
              where membership.community_id = $1
                and profile.public_profile_id = $2
              limit 1
              for update of membership
            `,
            values: [communityId, targetPublicProfileId],
          });
          const target = targetRow.rows[0];
          if (target === undefined) {
            throw new CommunityNotFoundError();
          }
          const targetUserId = userIdSchema.parse(target["owner_user_id"]);
          const targetMembership = toMembershipRecord({
            role: target["role"],
            status: target["status"],
            joined_at: target["joined_at"],
          });
          if (
            !canPerformTargetAction({
              actor,
              action,
              targetRole: targetMembership.role,
              isSelf: targetUserId === actorUserId,
            })
          ) {
            throw new CommunityPermissionDeniedError();
          }
          if (!targetStateAllowsAction(action, targetMembership)) {
            throw new CommunityDataStaleError();
          }
          // Every governance action keeps the membership row, so `joined_at`
          // survives a ban and the unban that follows it.
          const next = membershipAfterAction(action, targetMembership);
          if (action === "transferOwnership") {
            await client.query({
              text: `
                update public.community_memberships
                set role = 'admin', updated_at = clock_timestamp(),
                    record_version = record_version + 1
                where community_id = $1 and owner_user_id = $2
              `,
              values: [communityId, actorUserId],
            });
            // A transfer changes two roles, so it appends two audit rows
            // (Decision 0042): this one records the previous owner giving
            // ownership up, and the row every action appends below records
            // the successor receiving it. Both carry the same
            // `idempotency_record_id` and `request_id`, so the pair rebuilds
            // as one irreversible command; only the reason code separates the
            // outgoing leg from the incoming one.
            await appendCommunityAudit(client, {
              communityId,
              actorUserId,
              targetUserId: actorUserId,
              eventType: "role_changed",
              fromRole: actor.role,
              toRole: "admin",
              fromStatus: actor.status,
              toStatus: actor.status,
              reasonCode: `action_${action.toLowerCase()}_released`,
              idempotencyRecordId: recordId,
              requestId,
            });
          }
          await client.query({
            text: `
              update public.community_memberships
              set
                role = $3,
                status = $4,
                updated_at = clock_timestamp(),
                record_version = record_version + 1
              where community_id = $1 and owner_user_id = $2
            `,
            values: [communityId, targetUserId, next.role, next.status],
          });
          const eventType =
            action === "mute"
              ? "member_muted"
              : action === "unmute"
                ? "member_unmuted"
                : action === "ban"
                  ? "member_banned"
                  : action === "unban"
                    ? "member_unbanned"
                    : "role_changed";
          // A ban is community scoped: it does not touch the personal follow
          // graph. Only POST /v2/blocks removes follow edges.
          await appendCommunityAudit(client, {
            communityId,
            actorUserId,
            targetUserId,
            eventType,
            fromRole: targetMembership.role,
            toRole: next.role,
            fromStatus: targetMembership.status,
            toStatus: next.status,
            reasonCode: `action_${action.toLowerCase()}`,
            idempotencyRecordId: recordId,
            requestId,
          });
          // A ban removes the account from the official channel; an unban
          // restores the membership, so it enqueues the matching `add`. Both
          // jobs are no-ops until the community has a provisioned channel.
          if (action === "ban" || action === "unban") {
            await enqueueCommunityChannelSync(client, {
              communityId,
              ownerUserId: targetUserId,
              kind: action === "ban" ? "remove" : "add",
              requestId,
            });
          }
          return Object.freeze({
            community: await readCommunity(client, communityId),
            actorMembership: actor,
            target: Object.freeze({
              membershipId: opaqueIdSchema.parse(target["membership_id"]),
              ...next,
              joinedAt: targetMembership.joinedAt,
              profile: toIdentity({
                public_profile_id: target["public_profile_id"],
                loop_id: target["loop_id"],
                alias: target["alias"],
                avatar_ref: target["avatar_ref"],
              }),
            }),
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async follow(rawInput: FollowCommandInput): Promise<ConnectionRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const targetPublicProfileId = opaqueIdSchema.parse(
          rawInput.targetPublicProfileId,
        );
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findSocialGraphAudit(client, recordId);
          if (replay !== null && replay.targetUserId !== null) {
            // A replay reports the original outcome. A later unfollow or block
            // must not turn an already-succeeded command into a failure.
            const stored = await client.query<{ created_at: Date }>({
              text: `
                select created_at
                from public.follow_edges
                where follower_user_id = $1 and followee_user_id = $2
                limit 1
              `,
              values: [ownerUserId, replay.targetUserId],
            });
            const storedRow = stored.rows[0];
            return Object.freeze({
              profile: await readIdentityByUserId(client, replay.targetUserId),
              createdAt:
                storedRow === undefined
                  ? replay.occurredAt
                  : dateSchema.parse(storedRow.created_at).toISOString(),
              viewerFollows: storedRow !== undefined,
            });
          }
          await requireActiveProfile(client, ownerUserId);
          const target = await resolveTarget(client, {
            viewerUserId: ownerUserId,
            targetPublicProfileId,
            requireDiscoverable: true,
            requireUnblocked: true,
          });
          const inserted = await client.query<{ created_at: Date }>({
            text: `
              insert into public.follow_edges (
                follower_user_id,
                followee_user_id
              )
              values ($1, $2)
              on conflict (follower_user_id, followee_user_id) do nothing
              returning created_at
            `,
            values: [ownerUserId, target.userId],
          });
          await appendSocialGraphAudit(client, {
            actorUserId: ownerUserId,
            eventType: "followed",
            targetUserId: target.userId,
            subjectId: null,
            resultStatus: inserted.rows[0] === undefined ? "replayed" : "added",
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          const existing = await client.query<{ created_at: Date }>({
            text: `
              select created_at
              from public.follow_edges
              where follower_user_id = $1 and followee_user_id = $2
              limit 1
            `,
            values: [ownerUserId, target.userId],
          });
          const createdAt = dateSchema.parse(existing.rows[0]?.created_at);
          return Object.freeze({
            profile: target.profile,
            createdAt: createdAt.toISOString(),
            viewerFollows: true,
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async unfollow(rawInput: FollowCommandInput): Promise<IdentityProjection> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const targetPublicProfileId = opaqueIdSchema.parse(
          rawInput.targetPublicProfileId,
        );
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findSocialGraphAudit(client, recordId);
          if (replay !== null && replay.targetUserId !== null) {
            return readIdentityByUserId(client, replay.targetUserId);
          }
          const target = await resolveTarget(client, {
            viewerUserId: ownerUserId,
            targetPublicProfileId,
            requireDiscoverable: false,
            requireUnblocked: false,
          });
          const removed = await client.query({
            text: `
              delete from public.follow_edges
              where follower_user_id = $1 and followee_user_id = $2
            `,
            values: [ownerUserId, target.userId],
          });
          await appendSocialGraphAudit(client, {
            actorUserId: ownerUserId,
            eventType: "unfollowed",
            targetUserId: target.userId,
            subjectId: null,
            resultStatus: removed.rowCount === 1 ? "removed" : "absent",
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          return target.profile;
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listConnections(
      rawInput: ListConnectionsInput,
    ): Promise<readonly ConnectionRecord[]> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        const following = rawInput.direction === "following";
        const values: unknown[] = [ownerUserId, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(after.lastCreatedAt, after.lastPublicProfileId);
          keyset = `
            and (
              edge.created_at < $3::timestamptz
              or (edge.created_at = $3::timestamptz
                and profile.public_profile_id < $4::uuid)
            )
          `;
        }
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              ${identityColumns},
              edge.created_at,
              exists (
                select 1
                from public.follow_edges as mine
                where mine.follower_user_id = $1
                  and mine.followee_user_id = profile.owner_user_id
              ) as viewer_follows
            from public.follow_edges as edge
            join public.user_profiles as profile
              on profile.owner_user_id = ${
                following ? "edge.followee_user_id" : "edge.follower_user_id"
              }
            join public.loop_users as account
              on account.id = profile.owner_user_id
            where ${following ? "edge.follower_user_id" : "edge.followee_user_id"} = $1
              and not exists (
                select 1
                from public.user_blocks as blocks
                where blocks.kind = 'user'
                  and blocks.owner_user_id = $1
                  and blocks.target_user_id = profile.owner_user_id
              )
              ${keyset}
            order by edge.created_at desc, profile.public_profile_id desc
            limit $2
          `,
          values,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              profile: toIdentity({
                public_profile_id: row["public_profile_id"],
                loop_id: row["loop_id"],
                alias: row["alias"],
                avatar_ref: row["avatar_ref"],
              }),
              createdAt: dateSchema.parse(row["created_at"]).toISOString(),
              viewerFollows: row["viewer_follows"] === true,
            }),
          ),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async countConnections(
      rawOwnerUserId: string,
    ): Promise<ConnectionCountsRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawOwnerUserId);
        const result = await pool.query<{
          following: string;
          followers: string;
        }>({
          text: `
            select
              count(*) filter (where follower_user_id = $1) as following,
              count(*) filter (where followee_user_id = $1) as followers
            from public.follow_edges
            where follower_user_id = $1 or followee_user_id = $1
          `,
          values: [ownerUserId],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new CommunityRepositoryUnavailableError();
        }
        return Object.freeze({
          following: Number.parseInt(row.following, 10),
          followers: Number.parseInt(row.followers, 10),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async blockUser(rawInput: BlockCommandInput): Promise<BlockRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const stableId = opaqueIdSchema.parse(rawInput.stableId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findSocialGraphAudit(client, recordId);
          if (replay !== null && replay.targetUserId !== null) {
            // Rebuild the original result; a later unblock must not turn an
            // already-succeeded block into a 404 or a conflict.
            const stored = await client.query<{
              reason_code: string;
              created_at: Date;
            }>({
              text: `
                select reason_code, created_at
                from public.user_blocks
                where owner_user_id = $1 and kind = 'user' and stable_id = $2
                limit 1
              `,
              values: [ownerUserId, stableId],
            });
            const storedRow = stored.rows[0];
            return Object.freeze({
              kind: "user" as const,
              stableId,
              profile: await readIdentityByUserId(client, replay.targetUserId),
              reasonCode: storedRow?.reason_code ?? "user_request",
              createdAt:
                storedRow === undefined
                  ? replay.occurredAt
                  : dateSchema.parse(storedRow.created_at).toISOString(),
            });
          }
          const target = await resolveTarget(client, {
            viewerUserId: ownerUserId,
            targetPublicProfileId: stableId,
            requireDiscoverable: false,
            requireUnblocked: false,
          });
          {
            await client.query({
              text: `
                insert into public.user_blocks (
                  owner_user_id,
                  kind,
                  stable_id,
                  target_user_id,
                  reason_code
                )
                values ($1, 'user', $2, $3, 'user_request')
                on conflict (owner_user_id, kind, stable_id) do nothing
              `,
              values: [ownerUserId, stableId, target.userId],
            });
            await removeFollowEdges(client, ownerUserId, target.userId);
            await appendSocialGraphAudit(client, {
              actorUserId: ownerUserId,
              eventType: "blocked",
              targetUserId: target.userId,
              subjectId: null,
              resultStatus: "blocked",
              reasonCode: "user_request",
              idempotencyRecordId: recordId,
              requestId,
            });
          }
          const stored = await client.query<{
            reason_code: string;
            created_at: Date;
          }>({
            text: `
              select reason_code, created_at
              from public.user_blocks
              where owner_user_id = $1 and kind = 'user' and stable_id = $2
              limit 1
            `,
            values: [ownerUserId, stableId],
          });
          const row = stored.rows[0];
          if (row === undefined) {
            throw new CommunityRepositoryUnavailableError();
          }
          return Object.freeze({
            kind: "user" as const,
            stableId,
            profile: target.profile,
            reasonCode: row.reason_code,
            createdAt: dateSchema.parse(row.created_at).toISOString(),
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async unblockUser(rawInput: BlockCommandInput): Promise<void> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const stableId = opaqueIdSchema.parse(rawInput.stableId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          if ((await findSocialGraphAudit(client, recordId)) !== null) {
            return;
          }
          const removed = await client.query<{ target_user_id: string | null }>(
            {
              text: `
                delete from public.user_blocks
                where owner_user_id = $1 and kind = 'user' and stable_id = $2
                returning target_user_id
              `,
              values: [ownerUserId, stableId],
            },
          );
          await appendSocialGraphAudit(client, {
            actorUserId: ownerUserId,
            eventType: "unblocked",
            targetUserId: removed.rows[0]?.target_user_id ?? null,
            subjectId: null,
            resultStatus:
              removed.rows[0] === undefined ? "absent" : "unblocked",
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listBlocks(
      rawInput: ListBlocksInput,
    ): Promise<readonly BlockRecord[]> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        const values: unknown[] = [ownerUserId, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(after.lastCreatedAt, after.lastPublicProfileId);
          keyset = `
            and (
              blocks.created_at < $3::timestamptz
              or (blocks.created_at = $3::timestamptz
                and blocks.stable_id < $4::text)
            )
          `;
        }
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              blocks.stable_id,
              blocks.reason_code,
              blocks.created_at,
              ${identityColumns}
            from public.user_blocks as blocks
            left join public.user_profiles as profile
              on profile.owner_user_id = blocks.target_user_id
            left join public.loop_users as account
              on account.id = blocks.target_user_id
            where blocks.owner_user_id = $1
              and blocks.kind = 'user'
              ${keyset}
            order by blocks.created_at desc, blocks.stable_id desc
            limit $2
          `,
          values,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              kind: "user" as const,
              stableId: z.string().min(1).parse(row["stable_id"]),
              profile:
                row["public_profile_id"] === null ||
                row["public_profile_id"] === undefined
                  ? null
                  : toIdentity({
                      public_profile_id: row["public_profile_id"],
                      loop_id: row["loop_id"],
                      alias: row["alias"],
                      avatar_ref: row["avatar_ref"],
                    }),
              reasonCode: z.string().min(1).parse(row["reason_code"]),
              createdAt: dateSchema.parse(row["created_at"]).toISOString(),
            }),
          ),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async countBlocks(rawOwnerUserId: string): Promise<BlockCountsRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawOwnerUserId);
        const result = await pool.query<{ user_count: string }>({
          text: `
            select count(*) as user_count
            from public.user_blocks
            where owner_user_id = $1 and kind = 'user'
          `,
          values: [ownerUserId],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new CommunityRepositoryUnavailableError();
        }
        return Object.freeze({
          user: Number.parseInt(row.user_count, 10),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listMessageRequests(
      rawInput: ListMessageRequestsInput,
    ): Promise<readonly MessageRequestRecord[]> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        const values: unknown[] = [ownerUserId, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(after.lastCreatedAt, after.lastPublicProfileId);
          keyset = `
            and (
              request.created_at < $3::timestamptz
              or (request.created_at = $3::timestamptz
                and request.friend_request_id < $4::uuid)
            )
          `;
        }
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              request.friend_request_id,
              request.created_at,
              request.expires_at,
              ${identityColumns}
            from public.friend_requests as request
            join public.user_profiles as profile
              on profile.owner_user_id = request.requester_user_id
            join public.loop_users as account
              on account.id = request.requester_user_id
            where request.recipient_user_id = $1
              and request.status = 'pending'
              and request.expires_at > clock_timestamp()
              and not exists (
                select 1
                from public.user_blocks as blocks
                where blocks.kind = 'user'
                  and blocks.owner_user_id = $1
                  and blocks.target_user_id = request.requester_user_id
              )
              ${keyset}
            order by request.created_at desc, request.friend_request_id desc
            limit $2
          `,
          values,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              messageRequestId: opaqueIdSchema.parse(row["friend_request_id"]),
              profile: toIdentity({
                public_profile_id: row["public_profile_id"],
                loop_id: row["loop_id"],
                alias: row["alias"],
                avatar_ref: row["avatar_ref"],
              }),
              createdAt: dateSchema.parse(row["created_at"]).toISOString(),
              expiresAt: dateSchema.parse(row["expires_at"]).toISOString(),
            }),
          ),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    /**
     * Send a stranger message request (Decision 0031 revision, 2026-09-08).
     * It writes the frozen V1 `friend_requests` storage and obeys the V1 state
     * machine (one pending row per pair, the seven-day lifetime, the rejection
     * cooldown), but admission is the V2 rule set: an active profile,
     * `privacy_preferences_v2.discoverable`, and no block in either direction.
     * Every ineligible target answers the same non-enumerating NOT_FOUND.
     */
    async sendMessageRequest(
      rawInput: SendMessageRequestInput,
    ): Promise<MessageRequestRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const targetPublicProfileId = opaqueIdSchema.parse(
          rawInput.targetPublicProfileId,
        );
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findSocialGraphAudit(client, recordId);
          if (replay !== null && replay.subjectId !== null) {
            // A replay reports the request the first call created, even after
            // the recipient has decided it.
            return await readMessageRequest(client, replay.subjectId);
          }
          await requireActiveProfile(client, ownerUserId);
          const target = await resolveTarget(client, {
            viewerUserId: ownerUserId,
            targetPublicProfileId,
            requireDiscoverable: true,
            requireUnblocked: true,
          });
          // The same pair lock the V1 sender takes, so two concurrent sends
          // cannot both pass the pending check.
          await client.query({
            text: `
              select id
              from public.loop_users
              where id in ($1, $2)
              order by id
              for update
            `,
            values: [ownerUserId, target.userId],
          });
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
            values: [ownerUserId, target.userId],
          });
          const blocking = await client.query<{
            friendship: boolean;
            pending: boolean;
            cooldown: boolean;
          }>({
            text: `
              select
                exists (
                  select 1
                  from public.friendships
                  where user_id_low = least($1::uuid, $2::uuid)
                    and user_id_high = greatest($1::uuid, $2::uuid)
                ) as friendship,
                exists (
                  select 1
                  from public.friend_requests
                  where pair_user_id_low = least($1::uuid, $2::uuid)
                    and pair_user_id_high = greatest($1::uuid, $2::uuid)
                    and status = 'pending'
                ) as pending,
                exists (
                  select 1
                  from public.friend_requests
                  where pair_user_id_low = least($1::uuid, $2::uuid)
                    and pair_user_id_high = greatest($1::uuid, $2::uuid)
                    and status = 'rejected'
                    and rejection_cooldown_until > clock_timestamp()
                ) as cooldown
            `,
            values: [ownerUserId, target.userId],
          });
          const state = blocking.rows[0];
          if (state === undefined) {
            throw new CommunityRepositoryUnavailableError();
          }
          // An existing friendship, a pending request in either direction, and
          // an active rejection cooldown are all "refresh before deciding
          // again": the caller's view of the pair is stale.
          if (state.friendship || state.pending || state.cooldown) {
            throw new CommunityDataStaleError();
          }
          const inserted = await client.query<{ friend_request_id: string }>({
            text: `
              insert into public.friend_requests (
                requester_user_id,
                recipient_user_id,
                expires_at
              )
              values ($1, $2, clock_timestamp() + $3::interval)
              returning friend_request_id
            `,
            values: [ownerUserId, target.userId, messageRequestLifetimeSql],
          });
          const messageRequestId = opaqueIdSchema.parse(
            inserted.rows[0]?.friend_request_id,
          );
          await appendSocialGraphAudit(client, {
            actorUserId: ownerUserId,
            eventType: "message_request_sent",
            targetUserId: target.userId,
            subjectId: messageRequestId,
            resultStatus: "sent",
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          return await readMessageRequest(client, messageRequestId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async decideMessageRequest(
      rawInput: DecideMessageRequestInput,
    ): Promise<MessageRequestDecisionRecord> {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const messageRequestId = opaqueIdSchema.parse(
          rawInput.messageRequestId,
        );
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const decision = rawInput.decision;
        return await withTransaction(pool, async (client) => {
          const recordId = await claimSocialGraphCommand(client, {
            ownerUserId,
            idempotencyKey,
            requestSha256,
          });
          const replay = await findSocialGraphAudit(client, recordId);
          if (replay !== null) {
            return Object.freeze({
              messageRequestId,
              decision,
              blocked: replay.resultStatus === "reported",
            });
          }
          const locked = await client.query<{
            requester_user_id: string;
            status: string;
            expired: boolean;
          }>({
            text: `
              select
                requester_user_id,
                status,
                expires_at <= clock_timestamp() as expired
              from public.friend_requests
              where friend_request_id = $1 and recipient_user_id = $2
              limit 1
              for update
            `,
            values: [messageRequestId, ownerUserId],
          });
          const row = locked.rows[0];
          if (row === undefined) {
            throw new CommunityNotFoundError();
          }
          if (row.status !== "pending" || row.expired) {
            throw new CommunityDataStaleError();
          }
          const requesterUserId = userIdSchema.parse(row.requester_user_id);
          if (decision === "accept") {
            // A block outranks a message request in both directions: accepting
            // must never quietly create a friendship across one.
            const blocked = await client.query<{ blocked: boolean }>({
              text: `
                select exists (
                  select 1
                  from public.user_blocks as blocks
                  where blocks.kind = 'user'
                    and (
                      (blocks.owner_user_id = $1 and blocks.target_user_id = $2)
                      or (blocks.owner_user_id = $2
                        and blocks.target_user_id = $1)
                    )
                ) as blocked
              `,
              values: [ownerUserId, requesterUserId],
            });
            if (blocked.rows[0]?.blocked === true) {
              throw new CommunityDataStaleError();
            }
          }
          if (decision === "accept") {
            await client.query({
              text: `
                update public.friend_requests
                set
                  status = 'accepted',
                  decided_at = greatest(clock_timestamp(), created_at),
                  updated_at = greatest(clock_timestamp(), updated_at)
                where friend_request_id = $1 and status = 'pending'
              `,
              values: [messageRequestId],
            });
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
                on conflict do nothing
              `,
              values: [ownerUserId, requesterUserId, messageRequestId],
            });
          } else {
            await client.query({
              text: `
                update public.friend_requests
                set
                  status = 'rejected',
                  decided_at = greatest(clock_timestamp(), created_at),
                  rejection_cooldown_until =
                    greatest(clock_timestamp(), created_at) + $2::interval,
                  updated_at = greatest(clock_timestamp(), updated_at)
                where friend_request_id = $1 and status = 'pending'
              `,
              values: [messageRequestId, rejectionCooldownSql],
            });
          }
          let blocked = false;
          if (decision === "report") {
            const requesterProfile = await client.query<{
              public_profile_id: string;
            }>({
              text: `
                select public_profile_id
                from public.user_profiles
                where owner_user_id = $1
                limit 1
              `,
              values: [requesterUserId],
            });
            const stableId = opaqueIdSchema.parse(
              requesterProfile.rows[0]?.public_profile_id,
            );
            await client.query({
              text: `
                insert into public.user_blocks (
                  owner_user_id,
                  kind,
                  stable_id,
                  target_user_id,
                  reason_code
                )
                values ($1, 'user', $2, $3, 'message_request_report')
                on conflict (owner_user_id, kind, stable_id) do nothing
              `,
              values: [ownerUserId, stableId, requesterUserId],
            });
            await removeFollowEdges(client, ownerUserId, requesterUserId);
            blocked = true;
          }
          await appendSocialGraphAudit(client, {
            actorUserId: ownerUserId,
            eventType:
              decision === "accept"
                ? "message_request_accepted"
                : decision === "ignore"
                  ? "message_request_ignored"
                  : "message_request_reported",
            targetUserId: requesterUserId,
            subjectId: messageRequestId,
            resultStatus:
              decision === "accept"
                ? "accepted"
                : decision === "ignore"
                  ? "ignored"
                  : "reported",
            reasonCode: decision === "report" ? "message_request_report" : null,
            idempotencyRecordId: recordId,
            requestId,
          });
          return Object.freeze({ messageRequestId, decision, blocked });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async searchUsers(
      rawInput: SearchUsersInput,
    ): Promise<readonly SearchUserRecord[]> {
      try {
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        const values: unknown[] = [viewerUserId, rawInput.prefix, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(after.lastSearchKey, after.lastPublicProfileId);
          keyset = `
            and (
              profile.alias_search_key collate "C" > $4::text
              or (profile.alias_search_key collate "C" = $4::text
                and profile.public_profile_id > $5::uuid)
            )
          `;
        }
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with search_input as (
              select public.loop_alias_search_key_unicode17_v1($2::text)
                collate "C" as prefix
            )
            select
              ${identityColumns},
              profile.alias_search_key
            from public.user_profiles as profile
            join public.loop_users as account
              on account.id = profile.owner_user_id
            join public.privacy_preferences_v2 as privacy
              on privacy.owner_user_id = profile.owner_user_id
            cross join search_input
            where profile.owner_user_id <> $1
              and privacy.discoverable = true
              and profile.profile_status = 'active'
              and profile.alias is not null
              and profile.alias_search_key collate "C" like
                replace(
                  replace(
                    replace(search_input.prefix, '\\', '\\\\'),
                    '%', '\\%'
                  ),
                  '_', '\\_'
                ) || '%' escape '\\'
              and not exists (
                select 1
                from public.user_blocks as blocks
                where blocks.kind = 'user'
                  and (
                    (blocks.owner_user_id = $1
                      and blocks.target_user_id = profile.owner_user_id)
                    or (blocks.owner_user_id = profile.owner_user_id
                      and blocks.target_user_id = $1)
                  )
              )
              ${keyset}
            order by
              profile.alias_search_key collate "C" asc,
              profile.public_profile_id asc
            limit $3
          `,
          values,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              profile: toIdentity({
                public_profile_id: row["public_profile_id"],
                loop_id: row["loop_id"],
                alias: row["alias"],
                avatar_ref: row["avatar_ref"],
              }),
              searchKey: z.string().min(1).parse(row["alias_search_key"]),
            }),
          ),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async searchCommunities(
      rawInput: SearchCommunitiesInput,
    ): Promise<readonly SearchCommunityRecord[]> {
      try {
        const viewerUserId = userIdSchema.parse(rawInput.viewerUserId);
        const limit = limitSchema.parse(rawInput.limit);
        const values: unknown[] = [viewerUserId, rawInput.prefix, limit];
        let keyset = "";
        const after = rawInput.after;
        if (after !== undefined) {
          values.push(after.lastSearchKey, after.lastCommunityId);
          keyset = `
            and (
              community.name_search_key collate "C" > $4::text
              or (community.name_search_key collate "C" = $4::text
                and community.community_id > $5::uuid)
            )
          `;
        }
        const visibility =
          rawInput.verification === "verified"
            ? `community.verification_status = 'verified'`
            : `(
                community.verification_status = 'verified'
                or exists (
                  select 1
                  from public.community_memberships as viewer
                  where viewer.community_id = community.community_id
                    and viewer.owner_user_id = $1
                    and viewer.status <> 'banned'
                )
              )`;
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with search_input as (
              select
                public.loop_alias_search_key_unicode17_v1($2::text)
                  collate "C" as prefix,
                lower(btrim($2::text)) collate "C" as slug_prefix
            )
            select
              ${communityColumns},
              community.name_search_key,
              exists (
                select 1
                from public.community_memberships as viewer
                where viewer.community_id = community.community_id
                  and viewer.owner_user_id = $1
                  and viewer.status <> 'banned'
              ) as viewer_joined
            from public.communities as community
            cross join search_input
            where ${visibility}
              and (
                community.name_search_key collate "C" like
                  replace(
                    replace(
                      replace(search_input.prefix, '\\', '\\\\'),
                      '%', '\\%'
                    ),
                    '_', '\\_'
                  ) || '%' escape '\\'
                or community.slug collate "C" like
                  replace(
                    replace(
                      replace(search_input.slug_prefix, '\\', '\\\\'),
                      '%', '\\%'
                    ),
                    '_', '\\_'
                  ) || '%' escape '\\'
              )
              ${keyset}
            order by
              community.name_search_key collate "C" asc,
              community.community_id asc
            limit $3
          `,
          values,
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              community: toCommunityRecord({
                community_id: row["community_id"],
                name: row["name"],
                slug: row["slug"],
                description: row["description"],
                logo_ref: row["logo_ref"],
                verification_status: row["verification_status"],
                bound_asset_key: row["bound_asset_key"],
                member_count: row["member_count"],
                config_version: row["config_version"],
                created_at: row["created_at"],
              }),
              searchKey: z.string().min(1).parse(row["name_search_key"]),
              viewerJoined: row["viewer_joined"] === true,
            }),
          ),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async verifyCommunity(rawInput: {
      readonly communityId: string;
      readonly requestId: string;
      readonly reasonCode: string;
    }): Promise<CommunityRecord> {
      try {
        const communityId = opaqueIdSchema.parse(rawInput.communityId);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const reasonCode = z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .parse(rawInput.reasonCode);
        return await withTransaction(pool, async (client) => {
          const current = await readCommunity(client, communityId, true);
          if (current.verificationStatus === "verified") {
            await provisionCommunityChannel(client, {
              communityId,
              memberCap: communityChannelMemberCap,
              requestId,
              mode: "repair",
            });
            return readCommunity(client, communityId);
          }
          await client.query({
            text: `
              update public.communities
              set
                verification_status = 'verified',
                verified_at = clock_timestamp(),
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where community_id = $1 and verification_status <> 'verified'
            `,
            values: [communityId],
          });
          await appendCommunityAudit(client, {
            communityId,
            actorUserId: null,
            targetUserId: null,
            eventType: "community_verified",
            reasonCode,
            idempotencyRecordId: null,
            requestId,
          });
          await provisionCommunityChannel(client, {
            communityId,
            memberCap: communityChannelMemberCap,
            requestId,
          });
          return readCommunity(client, communityId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
