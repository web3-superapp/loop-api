import type { Pool, QueryResult } from "pg";
import { z } from "zod";

import {
  parseAliasSearchPrefix,
  parseCommunicationGroupId,
  parseGroupAlias,
  parseOpaqueAliasId,
  parseStreamChannelId,
  type GroupAliasProjectionState,
} from "../features/identity/alias-contract.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownerUserIdSchema = z.string().regex(canonicalUuidPattern);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const avatarReferenceSchema = z
  .string()
  .regex(/^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/);

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

const publicAliasRowSchema = z
  .object({
    public_profile_id: z.string().regex(canonicalUuidPattern),
    alias: z.string(),
    avatar_ref: avatarReferenceSchema.nullable(),
  })
  .strict();

const communicationGroupRowSchema = z
  .object({
    group_id: z.string().regex(canonicalUuidPattern),
    stream_channel_id: z.string(),
    created_at: dateSchema,
  })
  .strict();

const groupAliasRowSchema = z
  .object({
    group_alias_id: z.string().regex(canonicalUuidPattern),
    group_id: z.string().regex(canonicalUuidPattern),
    owner_user_id: z.string().regex(canonicalUuidPattern),
    alias: z.string(),
    projection_state: z.enum(["pending", "confirmed"]),
    created_at: dateSchema,
    confirmed_at: dateSchema.nullable(),
  })
  .strict();

export interface PublicAliasRecord {
  readonly publicProfileId: string;
  readonly alias: string;
  readonly avatarRef: string | null;
}

export interface CommunicationGroupRecord {
  readonly groupId: string;
  readonly streamChannelId: string;
  readonly createdAt: string;
}

export interface GroupAliasRecord {
  readonly groupAliasId: string;
  readonly groupId: string;
  readonly ownerUserId: string;
  readonly alias: string;
  readonly projectionState: GroupAliasProjectionState;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

export interface SearchPublicAliasesInput {
  readonly requesterUserId: string;
  readonly aliasPrefix: string;
  readonly limit: number;
}

export interface ReserveGroupAliasInput {
  readonly groupId: string;
  readonly ownerUserId: string;
  readonly alias: string;
}

export interface ConfirmGroupAliasProjectionInput {
  readonly groupAliasId: string;
  readonly groupId: string;
  readonly ownerUserId: string;
}

export interface SearchGroupAliasesInput {
  readonly groupId: string;
  readonly requesterUserId: string;
  readonly aliasPrefix: string;
  readonly limit: number;
}

export interface AliasDirectoryRepository {
  searchPublicAliases(
    input: SearchPublicAliasesInput,
  ): Promise<readonly PublicAliasRecord[]>;
  resolveCommunicationGroup(
    streamChannelId: string,
  ): Promise<CommunicationGroupRecord>;
  findCommunicationGroup(
    groupId: string,
  ): Promise<CommunicationGroupRecord | null>;
  findGroupAlias(
    groupId: string,
    ownerUserId: string,
  ): Promise<GroupAliasRecord | null>;
  reserveGroupAlias(input: ReserveGroupAliasInput): Promise<GroupAliasRecord>;
  confirmGroupAliasProjection(
    input: ConfirmGroupAliasProjectionInput,
  ): Promise<GroupAliasRecord>;
  searchGroupAliases(
    input: SearchGroupAliasesInput,
  ): Promise<readonly GroupAliasRecord[]>;
}

export class AliasDirectoryRepositoryUnavailableError extends Error {
  constructor() {
    super("The alias directory repository is unavailable");
    this.name = "AliasDirectoryRepositoryUnavailableError";
  }
}

export class GroupAliasImmutableRepositoryError extends Error {
  constructor() {
    super("The group alias is immutable");
    this.name = "GroupAliasImmutableRepositoryError";
  }
}

export class GroupAliasUnavailableRepositoryError extends Error {
  constructor() {
    super("The group alias is unavailable");
    this.name = "GroupAliasUnavailableRepositoryError";
  }
}

function toPublicAliasRecord(value: unknown): PublicAliasRecord {
  const row = publicAliasRowSchema.parse(value);
  return Object.freeze({
    publicProfileId: row.public_profile_id,
    alias: parseGroupAlias(row.alias),
    avatarRef: row.avatar_ref,
  });
}

function toCommunicationGroupRecord(value: unknown): CommunicationGroupRecord {
  const row = communicationGroupRowSchema.parse(value);
  return Object.freeze({
    groupId: row.group_id,
    streamChannelId: parseStreamChannelId(row.stream_channel_id),
    createdAt: row.created_at.toISOString(),
  });
}

function toGroupAliasRecord(value: unknown): GroupAliasRecord {
  const row = groupAliasRowSchema.parse(value);
  return Object.freeze({
    groupAliasId: row.group_alias_id,
    groupId: row.group_id,
    ownerUserId: row.owner_user_id,
    alias: parseGroupAlias(row.alias),
    projectionState: row.projection_state,
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
  });
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof AliasDirectoryRepositoryUnavailableError ||
    error instanceof GroupAliasImmutableRepositoryError ||
    error instanceof GroupAliasUnavailableRepositoryError
  ) {
    throw error;
  }
  throw new AliasDirectoryRepositoryUnavailableError();
}

async function readGroupAlias(
  client: DatabaseClient,
  groupId: string,
  ownerUserId: string,
): Promise<GroupAliasRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        group_alias_id,
        group_id,
        owner_user_id,
        alias,
        projection_state,
        created_at,
        confirmed_at
      from public.group_alias_reservations
      where group_id = $1 and owner_user_id = $2
      limit 1
    `,
    values: [groupId, ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toGroupAliasRecord(row);
}

export function createUnavailableAliasDirectoryRepository(): AliasDirectoryRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new AliasDirectoryRepositoryUnavailableError());
  return Object.freeze({
    searchPublicAliases: unavailable,
    resolveCommunicationGroup: unavailable,
    findCommunicationGroup: unavailable,
    findGroupAlias: unavailable,
    reserveGroupAlias: unavailable,
    confirmGroupAliasProjection: unavailable,
    searchGroupAliases: unavailable,
  });
}

export function createPostgresAliasDirectoryRepository(
  pool: Pool,
): AliasDirectoryRepository {
  return Object.freeze({
    async searchPublicAliases(
      rawInput: SearchPublicAliasesInput,
    ): Promise<readonly PublicAliasRecord[]> {
      try {
        const requesterUserId = ownerUserIdSchema.parse(
          rawInput.requesterUserId,
        );
        const aliasPrefix = parseAliasSearchPrefix(rawInput.aliasPrefix);
        const limit = z.number().int().min(1).max(21).parse(rawInput.limit);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with search_input as (
              select public.loop_alias_search_key_unicode17_v1($2::text)
                collate "C" as prefix
            )
            select
              profile.public_profile_id,
              profile.alias,
              profile.avatar_ref
            from public.user_profiles as profile
            join public.privacy_preferences as privacy
              on privacy.owner_user_id = profile.owner_user_id
            cross join search_input
            where profile.owner_user_id <> $1
              and privacy.discoverable = true
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
          values: [requesterUserId, aliasPrefix, limit],
        });
        return Object.freeze(result.rows.map(toPublicAliasRecord));
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async resolveCommunicationGroup(
      rawStreamChannelId: string,
    ): Promise<CommunicationGroupRecord> {
      try {
        const streamChannelId = parseStreamChannelId(rawStreamChannelId);
        const inserted = await pool.query<Record<string, unknown>>({
          text: `
            insert into public.communication_groups (
              stream_channel_type,
              stream_channel_id
            )
            values ('messaging', $1)
            on conflict (stream_channel_type, stream_channel_id) do nothing
            returning group_id, stream_channel_id, created_at
          `,
          values: [streamChannelId],
        });
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          return toCommunicationGroupRecord(insertedRow);
        }

        const existing = await pool.query<Record<string, unknown>>({
          text: `
            select group_id, stream_channel_id, created_at
            from public.communication_groups
            where stream_channel_type = 'messaging'
              and stream_channel_id = $1
            limit 1
          `,
          values: [streamChannelId],
        });
        const row = existing.rows[0];
        if (row === undefined) {
          throw new AliasDirectoryRepositoryUnavailableError();
        }
        return toCommunicationGroupRecord(row);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findCommunicationGroup(
      rawGroupId: string,
    ): Promise<CommunicationGroupRecord | null> {
      try {
        const groupId = parseCommunicationGroupId(rawGroupId);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select group_id, stream_channel_id, created_at
            from public.communication_groups
            where group_id = $1 and stream_channel_type = 'messaging'
            limit 1
          `,
          values: [groupId],
        });
        const row = result.rows[0];
        return row === undefined ? null : toCommunicationGroupRecord(row);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findGroupAlias(
      rawGroupId: string,
      rawOwnerUserId: string,
    ): Promise<GroupAliasRecord | null> {
      try {
        const groupId = parseCommunicationGroupId(rawGroupId);
        const ownerUserId = ownerUserIdSchema.parse(rawOwnerUserId);
        return await readGroupAlias(pool, groupId, ownerUserId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async reserveGroupAlias(
      rawInput: ReserveGroupAliasInput,
    ): Promise<GroupAliasRecord> {
      try {
        const groupId = parseCommunicationGroupId(rawInput.groupId);
        const ownerUserId = ownerUserIdSchema.parse(rawInput.ownerUserId);
        const alias = parseGroupAlias(rawInput.alias);
        const inserted = await pool.query<Record<string, unknown>>({
          text: `
            insert into public.group_alias_reservations (
              group_id,
              owner_user_id,
              alias
            )
            values ($1, $2, $3)
            on conflict do nothing
            returning
              group_alias_id,
              group_id,
              owner_user_id,
              alias,
              projection_state,
              created_at,
              confirmed_at
          `,
          values: [groupId, ownerUserId, alias],
        });
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          return toGroupAliasRecord(insertedRow);
        }

        const existing = await readGroupAlias(pool, groupId, ownerUserId);
        if (existing === null) {
          throw new GroupAliasUnavailableRepositoryError();
        }
        if (existing.alias !== alias) {
          throw new GroupAliasImmutableRepositoryError();
        }
        return existing;
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async confirmGroupAliasProjection(
      rawInput: ConfirmGroupAliasProjectionInput,
    ): Promise<GroupAliasRecord> {
      try {
        const groupAliasId = parseOpaqueAliasId(rawInput.groupAliasId);
        const groupId = parseCommunicationGroupId(rawInput.groupId);
        const ownerUserId = ownerUserIdSchema.parse(rawInput.ownerUserId);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            update public.group_alias_reservations
            set
              projection_state = 'confirmed',
              confirmed_at = coalesce(
                group_alias_reservations.confirmed_at,
                greatest(
                  statement_timestamp(),
                  group_alias_reservations.updated_at
                )
              ),
              updated_at = greatest(
                statement_timestamp(),
                group_alias_reservations.updated_at
              )
            where group_alias_id = $1
              and group_id = $2
              and owner_user_id = $3
            returning
              group_alias_id,
              group_id,
              owner_user_id,
              alias,
              projection_state,
              created_at,
              confirmed_at
          `,
          values: [groupAliasId, groupId, ownerUserId],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new AliasDirectoryRepositoryUnavailableError();
        }
        return toGroupAliasRecord(row);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async searchGroupAliases(
      rawInput: SearchGroupAliasesInput,
    ): Promise<readonly GroupAliasRecord[]> {
      try {
        const groupId = parseCommunicationGroupId(rawInput.groupId);
        const requesterUserId = ownerUserIdSchema.parse(
          rawInput.requesterUserId,
        );
        const aliasPrefix = parseAliasSearchPrefix(rawInput.aliasPrefix);
        const limit = z.number().int().min(1).max(100).parse(rawInput.limit);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with search_input as (
              select public.loop_alias_search_key_unicode17_v1($3::text)
                collate "C" as prefix
            )
            select
              member.group_alias_id,
              member.group_id,
              member.owner_user_id,
              member.alias,
              member.projection_state,
              member.created_at,
              member.confirmed_at
            from public.group_alias_reservations as member
            cross join search_input
            where member.group_id = $1
              and member.owner_user_id <> $2
              and member.projection_state = 'confirmed'
              and member.alias_search_key collate "C" like
                replace(
                  replace(
                    replace(search_input.prefix, '\\', '\\\\'),
                    '%', '\\%'
                  ),
                  '_', '\\_'
                ) || '%' escape '\\'
            order by
              member.alias_search_key collate "C" asc,
              member.group_alias_id asc
            limit $4
          `,
          values: [groupId, requesterUserId, aliasPrefix, limit],
        });
        return Object.freeze(result.rows.map(toGroupAliasRecord));
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
