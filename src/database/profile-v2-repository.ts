import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import {
  defaultPrivacyV2Values,
  defaultProfileV2Values,
  maximumRecordVersion,
  parseLoopIdValue,
  parsePrivacyV2Values,
  parseProfileV2ActivationValues,
  parseProfileV2Values,
  privacyFriendGateValues,
  privacyFriendRequestsValues,
  privacyV2ValuesEqual,
  profileActivationDigestVersion,
  profileInterestValues,
  profileStatusValues,
  profileV2ValuesEqual,
  type PrivacyV2Values,
  type ProfileV2Values,
} from "../features/profile/profile-v2-contract.js";
import {
  privacyV2RecordValues,
  ProfileV2IdempotencyConflictError,
  ProfileV2RepositoryUnavailableError,
  ProfileV2VersionConflictError,
  profileV2RecordValues,
  type ActivateProfileV2RecordInput,
  type PrivacyV2Record,
  type ProfileV2Record,
  type ProfileV2Repository,
  type ReplacePrivacyV2RecordInput,
  type ReplaceProfileV2RecordInput,
} from "../features/profile/profile-v2-repository.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ownerUserIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const expectedVersionSchema = z.number().int().min(0).max(maximumRecordVersion);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const rawProfileRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    loop_id: z.string(),
    alias: z.string().nullable(),
    avatar_ref: z.string().nullable(),
    bio: z.string().nullable(),
    interests: z.array(z.enum(profileInterestValues)).nullable(),
    profile_status: z.enum(profileStatusValues).nullable(),
    activated_at: dateSchema.nullable(),
    record_version: z
      .number()
      .int()
      .min(1)
      .max(maximumRecordVersion)
      .nullable(),
    updated_at: dateSchema.nullable(),
  })
  .strict();

const rawPrivacyRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    discoverable: z.boolean(),
    anonymous_mode: z.boolean(),
    total_assets_visibility: z.string(),
    mining_power_visibility: z.string(),
    communities_visibility: z.string(),
    trade_history_visibility: z.string(),
    record_version: z.number().int().min(1).max(maximumRecordVersion),
    updated_at: dateSchema,
  })
  .strict();

const rawSocialGatesRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    friend_requests: z.enum(privacyFriendRequestsValues),
    group_invites: z.enum(privacyFriendGateValues),
    direct_messages: z.enum(privacyFriendGateValues),
  })
  .strict();

type SocialGatesRow = z.infer<typeof rawSocialGatesRowSchema>;

interface PrivacyParts {
  readonly privacy: z.infer<typeof rawPrivacyRowSchema> | null;
  readonly social: SocialGatesRow | null;
}

const rawCommandRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    request_sha256: sha256Schema,
    request_digest_version: z.literal(profileActivationDigestVersion),
  })
  .strict();

const replaceProfileInputSchema = z
  .object({
    ownerUserId: ownerUserIdSchema,
    expectedVersion: expectedVersionSchema,
    profile: z.unknown(),
  })
  .strict();

const activateProfileInputSchema = z
  .object({
    ownerUserId: ownerUserIdSchema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    requestId: uuidV4Schema,
    profile: z.unknown(),
  })
  .strict();

const replacePrivacyInputSchema = z
  .object({
    ownerUserId: ownerUserIdSchema,
    expectedVersion: expectedVersionSchema,
    privacy: z.unknown(),
  })
  .strict();

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

const profileColumns = `
  users.id as owner_user_id,
  users.loop_id,
  profiles.alias,
  profiles.avatar_ref,
  profiles.bio,
  profiles.interests,
  profiles.profile_status,
  profiles.activated_at,
  profiles.record_version,
  profiles.updated_at
`;

function toProfileRecord(value: unknown): ProfileV2Record {
  const row = rawProfileRowSchema.parse(value);
  const loopId = parseLoopIdValue(row.loop_id);
  if (row.record_version === null) {
    return Object.freeze({
      ownerUserId: row.owner_user_id,
      loopId,
      ...defaultProfileV2Values,
      profileStatus: "pending",
      activatedAt: null,
      version: 0,
      updatedAt: null,
    });
  }
  if (
    row.profile_status === null ||
    row.updated_at === null ||
    row.interests === null
  ) {
    throw new ProfileV2RepositoryUnavailableError();
  }
  // V1 may have stored an avatar reference outside the V2 preset catalog;
  // reads stay tolerant so the shared column is never silently rewritten.
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    loopId,
    alias: row.alias,
    avatarRef: row.avatar_ref,
    bio: row.bio,
    interests: Object.freeze([...row.interests]),
    profileStatus: row.profile_status,
    activatedAt: row.activated_at?.toISOString() ?? null,
    version: row.record_version,
    updatedAt: row.updated_at.toISOString(),
  });
}

/**
 * Compose the resource from its two relations. A missing
 * `privacy_preferences_v2` row contributes the fail-closed presentation
 * defaults and version 0; a missing `social_privacy_preferences` row
 * contributes the open social defaults (Decision 0070). Both missing is the
 * pure default and is reported as `null`.
 */
function toPrivacyRecord(
  ownerUserId: string,
  parts: PrivacyParts,
): PrivacyV2Record | null {
  if (parts.privacy === null && parts.social === null) {
    return null;
  }
  if (
    (parts.privacy !== null && parts.privacy.owner_user_id !== ownerUserId) ||
    (parts.social !== null && parts.social.owner_user_id !== ownerUserId)
  ) {
    throw new ProfileV2RepositoryUnavailableError();
  }
  const row = parts.privacy;
  const social = parts.social;
  const privacy = parsePrivacyV2Values({
    discoverable: row?.discoverable ?? defaultPrivacyV2Values.discoverable,
    anonymousMode: row?.anonymous_mode ?? defaultPrivacyV2Values.anonymousMode,
    visibility:
      row === null
        ? defaultPrivacyV2Values.visibility
        : {
            totalAssets: row.total_assets_visibility,
            miningPower: row.mining_power_visibility,
            communities: row.communities_visibility,
            tradeHistory: row.trade_history_visibility,
          },
    friendRequests:
      social?.friend_requests ?? defaultPrivacyV2Values.friendRequests,
    groupInvites: social?.group_invites ?? defaultPrivacyV2Values.groupInvites,
    directMessages:
      social?.direct_messages ?? defaultPrivacyV2Values.directMessages,
  });
  return Object.freeze({
    ownerUserId,
    ...privacy,
    version: row?.record_version ?? 0,
    updatedAt: row?.updated_at.toISOString() ?? null,
  });
}

function socialGatesEqual(
  social: SocialGatesRow | null,
  privacy: PrivacyV2Values,
): boolean {
  return (
    (social?.friend_requests ?? defaultPrivacyV2Values.friendRequests) ===
      privacy.friendRequests &&
    (social?.group_invites ?? defaultPrivacyV2Values.groupInvites) ===
      privacy.groupInvites &&
    (social?.direct_messages ?? defaultPrivacyV2Values.directMessages) ===
      privacy.directMessages
  );
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
      throw new ProfileV2RepositoryUnavailableError();
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
    throw new ProfileV2RepositoryUnavailableError();
  }
}

/**
 * Owner-serialized read. Writers lock the `loop_users` row first, so the
 * outer join needs no row lock (PostgreSQL forbids FOR UPDATE on the
 * nullable side of an outer join).
 */
async function readProfile(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<ProfileV2Record | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${profileColumns}
      from public.loop_users as users
      left join public.user_profiles as profiles
        on profiles.owner_user_id = users.id
      where users.id = $1
      limit 1
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toProfileRecord(row);
}

async function readPrivacyParts(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<PrivacyParts> {
  const lock = forUpdate ? "for update" : "";
  const privacy = await client.query<Record<string, unknown>>({
    text: `
      select
        owner_user_id,
        discoverable,
        anonymous_mode,
        total_assets_visibility,
        mining_power_visibility,
        communities_visibility,
        trade_history_visibility,
        record_version,
        updated_at
      from public.privacy_preferences_v2
      where owner_user_id = $1
      limit 1
      ${lock}
    `,
    values: [ownerUserId],
  });
  const social = await client.query<Record<string, unknown>>({
    text: `
      select
        owner_user_id,
        friend_requests,
        group_invites,
        direct_messages
      from public.social_privacy_preferences
      where owner_user_id = $1
      limit 1
      ${lock}
    `,
    values: [ownerUserId],
  });
  const privacyRow = privacy.rows[0];
  const socialRow = social.rows[0];
  return Object.freeze({
    privacy:
      privacyRow === undefined ? null : rawPrivacyRowSchema.parse(privacyRow),
    social:
      socialRow === undefined ? null : rawSocialGatesRowSchema.parse(socialRow),
  });
}

async function readPrivacy(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<PrivacyV2Record | null> {
  return toPrivacyRecord(
    ownerUserId,
    await readPrivacyParts(client, ownerUserId, forUpdate),
  );
}

/**
 * Commit the social gates when they differ from what the admission checks
 * currently read. No row plus the open defaults is left as no row: a missing
 * row already means exactly that (Decision 0070).
 */
async function writeSocialGates(
  client: DatabaseClient,
  ownerUserId: string,
  social: SocialGatesRow | null,
  privacy: PrivacyV2Values,
): Promise<void> {
  if (socialGatesEqual(social, privacy)) {
    return;
  }
  const result = await client.query({
    text: `
      insert into public.social_privacy_preferences (
        owner_user_id,
        friend_requests,
        group_invites,
        direct_messages
      )
      values ($1, $2, $3, $4)
      on conflict (owner_user_id) do update
      set
        friend_requests = excluded.friend_requests,
        group_invites = excluded.group_invites,
        direct_messages = excluded.direct_messages,
        record_version = public.social_privacy_preferences.record_version + 1,
        updated_at = greatest(
          clock_timestamp(),
          public.social_privacy_preferences.updated_at
        )
      where public.social_privacy_preferences.record_version < $5
    `,
    values: [
      ownerUserId,
      privacy.friendRequests,
      privacy.groupInvites,
      privacy.directMessages,
      maximumRecordVersion,
    ],
  });
  if (result.rowCount !== 1) {
    throw new ProfileV2VersionConflictError();
  }
}

async function requireProfile(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<ProfileV2Record> {
  const record = await readProfile(client, ownerUserId);
  if (record === null) {
    throw new ProfileV2RepositoryUnavailableError();
  }
  return record;
}

async function insertProfile(
  client: DatabaseClient,
  ownerUserId: string,
  profile: ProfileV2Values,
  activate: boolean,
): Promise<ProfileV2Record> {
  await client.query({
    text: `
      with command_time as (
        select clock_timestamp() as occurred_at
      )
      insert into public.user_profiles (
        owner_user_id,
        alias,
        avatar_ref,
        bio,
        interests,
        profile_status,
        activated_at,
        record_version,
        created_at,
        updated_at
      )
      select
        $1,
        $2,
        $3,
        $4,
        $5::text[],
        case when $6::boolean then 'active' else 'pending' end,
        case when $6::boolean then occurred_at else null end,
        1,
        occurred_at,
        occurred_at
      from command_time
    `,
    values: [
      ownerUserId,
      profile.alias,
      profile.avatarRef,
      profile.bio,
      [...profile.interests],
      activate,
    ],
  });
  return requireProfile(client, ownerUserId);
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof ProfileV2VersionConflictError ||
    error instanceof ProfileV2IdempotencyConflictError ||
    error instanceof ProfileV2RepositoryUnavailableError
  ) {
    throw error;
  }
  throw new ProfileV2RepositoryUnavailableError();
}

export function createPostgresProfileV2Repository(
  pool: Pool,
): ProfileV2Repository {
  return Object.freeze({
    async getProfile(rawOwnerUserId: string): Promise<ProfileV2Record | null> {
      try {
        const ownerUserId = ownerUserIdSchema.parse(rawOwnerUserId);
        return await readProfile(pool, ownerUserId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceProfile(
      rawInput: ReplaceProfileV2RecordInput,
    ): Promise<ProfileV2Record> {
      try {
        const parsed = replaceProfileInputSchema.parse(rawInput);
        const profile = parseProfileV2Values(parsed.profile);
        return await withTransaction(pool, async (client) => {
          await lockOwner(client, parsed.ownerUserId);
          const current = await requireProfile(client, parsed.ownerUserId);

          if (current.version === 0) {
            if (parsed.expectedVersion === 0) {
              return insertProfile(client, parsed.ownerUserId, profile, false);
            }
            if (profileV2ValuesEqual(defaultProfileV2Values, profile)) {
              return current;
            }
            throw new ProfileV2VersionConflictError();
          }

          if (profileV2ValuesEqual(profileV2RecordValues(current), profile)) {
            return current;
          }
          if (parsed.expectedVersion !== current.version) {
            throw new ProfileV2VersionConflictError();
          }

          const updated = await client.query({
            text: `
              update public.user_profiles
              set
                alias = $2,
                avatar_ref = $3,
                bio = $4,
                interests = $5::text[],
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1 and record_version = $6
            `,
            values: [
              parsed.ownerUserId,
              profile.alias,
              profile.avatarRef,
              profile.bio,
              [...profile.interests],
              parsed.expectedVersion,
            ],
          });
          if (updated.rowCount !== 1) {
            throw new ProfileV2VersionConflictError();
          }
          return requireProfile(client, parsed.ownerUserId);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async activateProfile(
      rawInput: ActivateProfileV2RecordInput,
    ): Promise<ProfileV2Record> {
      try {
        const parsed = activateProfileInputSchema.parse(rawInput);
        const activation = parseProfileV2ActivationValues(parsed.profile);
        return await withTransaction(pool, async (client) => {
          await client.query({
            text: `
              select pg_advisory_xact_lock(
                hashtextextended('loop:v2:profile-activation:' || $1, 0)
              )
            `,
            values: [parsed.idempotencyKey],
          });
          const existingCommand = await client.query<Record<string, unknown>>({
            text: `
              select owner_user_id, request_sha256, request_digest_version
              from public.profile_activation_commands
              where command_kind = 'activate' and idempotency_key = $1
              for update
            `,
            values: [parsed.idempotencyKey],
          });
          const commandRow = existingCommand.rows[0];
          if (commandRow !== undefined) {
            const command = rawCommandRowSchema.parse(commandRow);
            if (
              command.owner_user_id !== parsed.ownerUserId ||
              command.request_sha256 !== parsed.requestSha256
            ) {
              throw new ProfileV2IdempotencyConflictError();
            }
            return requireProfile(client, parsed.ownerUserId);
          }

          await lockOwner(client, parsed.ownerUserId);
          const current = await requireProfile(client, parsed.ownerUserId);
          let result: ProfileV2Record;
          let resultStatus: "activated" | "already_active";
          if (current.version === 0) {
            result = await insertProfile(
              client,
              parsed.ownerUserId,
              { ...activation, bio: null },
              true,
            );
            resultStatus = "activated";
          } else if (current.profileStatus === "pending") {
            const updated = await client.query({
              text: `
                update public.user_profiles
                set
                  alias = $2,
                  avatar_ref = $3,
                  interests = $4::text[],
                  profile_status = 'active',
                  activated_at = clock_timestamp(),
                  record_version = record_version + 1,
                  updated_at = clock_timestamp()
                where owner_user_id = $1
                  and record_version = $5
                  and profile_status = 'pending'
              `,
              values: [
                parsed.ownerUserId,
                activation.alias,
                activation.avatarRef,
                [...activation.interests],
                current.version,
              ],
            });
            if (updated.rowCount !== 1) {
              throw new ProfileV2VersionConflictError();
            }
            result = await requireProfile(client, parsed.ownerUserId);
            resultStatus = "activated";
          } else {
            result = current;
            resultStatus = "already_active";
          }

          await client.query({
            text: `
              insert into public.profile_activation_commands (
                owner_user_id,
                command_kind,
                idempotency_key,
                request_digest_version,
                request_sha256,
                request_id,
                result_status,
                result_record_version
              )
              values ($1, 'activate', $2, $3, $4, $5, $6, $7)
            `,
            values: [
              parsed.ownerUserId,
              parsed.idempotencyKey,
              profileActivationDigestVersion,
              parsed.requestSha256,
              parsed.requestId,
              resultStatus,
              result.version,
            ],
          });
          return result;
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getPrivacy(rawOwnerUserId: string): Promise<PrivacyV2Record | null> {
      try {
        const ownerUserId = ownerUserIdSchema.parse(rawOwnerUserId);
        return await readPrivacy(pool, ownerUserId, false);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replacePrivacy(
      rawInput: ReplacePrivacyV2RecordInput,
    ): Promise<PrivacyV2Record | null> {
      try {
        const parsed = replacePrivacyInputSchema.parse(rawInput);
        const privacy = parsePrivacyV2Values(parsed.privacy);
        return await withTransaction(pool, async (client) => {
          await lockOwner(client, parsed.ownerUserId);
          const parts = await readPrivacyParts(
            client,
            parsed.ownerUserId,
            true,
          );
          const current = toPrivacyRecord(parsed.ownerUserId, parts);
          const values = [
            parsed.ownerUserId,
            privacy.discoverable,
            privacy.anonymousMode,
            privacy.visibility.totalAssets,
            privacy.visibility.miningPower,
            privacy.visibility.communities,
            privacy.visibility.tradeHistory,
          ];

          if (parts.privacy === null) {
            // No committed resource version yet (a social-only row still
            // reads as version 0). Version 0 creates the resource; any other
            // expectation only passes as an identical retry.
            if (parsed.expectedVersion === 0) {
              await client.query({
                text: `
                  insert into public.privacy_preferences_v2 (
                    owner_user_id,
                    discoverable,
                    anonymous_mode,
                    total_assets_visibility,
                    mining_power_visibility,
                    communities_visibility,
                    trade_history_visibility,
                    record_version
                  )
                  values ($1, $2, $3, $4, $5, $6, $7, 1)
                `,
                values,
              });
              await writeSocialGates(
                client,
                parsed.ownerUserId,
                parts.social,
                privacy,
              );
              return readPrivacy(client, parsed.ownerUserId, false);
            }
            if (
              privacyV2ValuesEqual(
                current === null
                  ? defaultPrivacyV2Values
                  : privacyV2RecordValues(current),
                privacy,
              )
            ) {
              return current;
            }
            throw new ProfileV2VersionConflictError();
          }
          if (current === null) {
            throw new ProfileV2RepositoryUnavailableError();
          }

          if (privacyV2ValuesEqual(privacyV2RecordValues(current), privacy)) {
            return current;
          }
          if (parsed.expectedVersion !== current.version) {
            throw new ProfileV2VersionConflictError();
          }

          const updated = await client.query({
            text: `
              update public.privacy_preferences_v2
              set
                discoverable = $2,
                anonymous_mode = $3,
                total_assets_visibility = $4,
                mining_power_visibility = $5,
                communities_visibility = $6,
                trade_history_visibility = $7,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1 and record_version = $8
            `,
            values: [...values, parsed.expectedVersion],
          });
          if (updated.rowCount !== 1) {
            throw new ProfileV2VersionConflictError();
          }
          await writeSocialGates(
            client,
            parsed.ownerUserId,
            parts.social,
            privacy,
          );
          return readPrivacy(client, parsed.ownerUserId, false);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
