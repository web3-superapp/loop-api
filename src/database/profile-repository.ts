import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import {
  defaultPrivacyValues,
  defaultProfileValues,
  parsePrivacyValues,
  parseProfileValues,
  privacyValuesEqual,
  profileValuesEqual,
  type PrivacyValues,
  type ProfileValues,
} from "../features/profile/profile-contract.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumRecordVersion = 2_147_483_647;

const ownerUserIdSchema = z.string().regex(canonicalUuidPattern);
const expectedVersionSchema = z.number().int().min(0).max(maximumRecordVersion);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const ownerLockRowSchema = z.object({ id: ownerUserIdSchema }).strict();

const rawProfileRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    alias: z.string().nullable(),
    avatar_ref: z.string().nullable(),
    record_version: z.number().int().min(1).max(maximumRecordVersion),
    updated_at: dateSchema,
  })
  .strict();

const rawPrivacyRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    discoverable: z.boolean(),
    copy_trade_visibility: z.string(),
    record_version: z.number().int().min(1).max(maximumRecordVersion),
    updated_at: dateSchema,
  })
  .strict();

const replaceProfileInputSchema = z
  .object({
    ownerUserId: ownerUserIdSchema,
    expectedVersion: expectedVersionSchema,
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

export interface ProfileRecord {
  readonly ownerUserId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface PrivacyRecord {
  readonly ownerUserId: string;
  readonly discoverable: boolean;
  readonly copyTradeVisibility: PrivacyValues["copy_trade_visibility"];
  readonly version: number;
  readonly updatedAt: string;
}

export interface ReplaceProfileRecordInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly profile: ProfileValues;
}

export interface ReplacePrivacyRecordInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly privacy: PrivacyValues;
}

export interface ProfileRepository {
  getProfile(ownerUserId: string): Promise<ProfileRecord | null>;
  replaceProfile(
    input: ReplaceProfileRecordInput,
  ): Promise<ProfileRecord | null>;
  getPrivacy(ownerUserId: string): Promise<PrivacyRecord | null>;
  replacePrivacy(
    input: ReplacePrivacyRecordInput,
  ): Promise<PrivacyRecord | null>;
}

export class ProfileRepositoryVersionConflictError extends Error {
  readonly code = "profile_repository_version_conflict";

  constructor() {
    super("The stored Profile resource version conflicts");
    this.name = "ProfileRepositoryVersionConflictError";
  }
}

export class ProfileRepositoryUnavailableError extends Error {
  readonly code = "profile_repository_unavailable";

  constructor() {
    super("The Profile repository is unavailable");
    this.name = "ProfileRepositoryUnavailableError";
  }
}

function parseReplaceProfileInput(
  value: ReplaceProfileRecordInput,
): ReplaceProfileRecordInput {
  const parsed = replaceProfileInputSchema.parse(value);
  return Object.freeze({
    ownerUserId: parsed.ownerUserId,
    expectedVersion: parsed.expectedVersion,
    profile: parseProfileValues(parsed.profile),
  });
}

function parseReplacePrivacyInput(
  value: ReplacePrivacyRecordInput,
): ReplacePrivacyRecordInput {
  const parsed = replacePrivacyInputSchema.parse(value);
  return Object.freeze({
    ownerUserId: parsed.ownerUserId,
    expectedVersion: parsed.expectedVersion,
    privacy: parsePrivacyValues(parsed.privacy),
  });
}

function toProfileRecord(value: unknown): ProfileRecord {
  const row = rawProfileRowSchema.parse(value);
  const profile = parseProfileValues({
    alias: row.alias,
    avatar_ref: row.avatar_ref,
  });
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    alias: profile.alias,
    avatarRef: profile.avatar_ref,
    version: row.record_version,
    updatedAt: row.updated_at.toISOString(),
  });
}

function toPrivacyRecord(value: unknown): PrivacyRecord {
  const row = rawPrivacyRowSchema.parse(value);
  const privacy = parsePrivacyValues({
    discoverable: row.discoverable,
    copy_trade_visibility: row.copy_trade_visibility,
  });
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    discoverable: privacy.discoverable,
    copyTradeVisibility: privacy.copy_trade_visibility,
    version: row.record_version,
    updatedAt: row.updated_at.toISOString(),
  });
}

function profileRecordValues(record: ProfileRecord): ProfileValues {
  return Object.freeze({
    alias: record.alias,
    avatar_ref: record.avatarRef,
  });
}

function privacyRecordValues(record: PrivacyRecord): PrivacyValues {
  return Object.freeze({
    discoverable: record.discoverable,
    copy_trade_visibility: record.copyTradeVisibility,
  });
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
      throw new ProfileRepositoryUnavailableError();
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
  const row = result.rows[0];
  const parsed = ownerLockRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.id !== ownerUserId) {
    throw new ProfileRepositoryUnavailableError();
  }
}

async function readProfile(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<ProfileRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select owner_user_id, alias, avatar_ref, record_version, updated_at
      from public.user_profiles
      where owner_user_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toProfileRecord(row);
}

async function readPrivacy(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<PrivacyRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        owner_user_id,
        discoverable,
        copy_trade_visibility,
        record_version,
        updated_at
      from public.privacy_preferences
      where owner_user_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toPrivacyRecord(row);
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof ProfileRepositoryVersionConflictError ||
    error instanceof ProfileRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new ProfileRepositoryUnavailableError();
}

export function createUnavailableProfileRepository(): ProfileRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ProfileRepositoryUnavailableError());
  return Object.freeze({
    getProfile: unavailable,
    replaceProfile: unavailable,
    getPrivacy: unavailable,
    replacePrivacy: unavailable,
  });
}

export function createPostgresProfileRepository(pool: Pool): ProfileRepository {
  return Object.freeze({
    async getProfile(rawOwnerUserId: string): Promise<ProfileRecord | null> {
      try {
        const ownerUserId = ownerUserIdSchema.parse(rawOwnerUserId);
        return await readProfile(pool, ownerUserId, false);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceProfile(
      rawInput: ReplaceProfileRecordInput,
    ): Promise<ProfileRecord | null> {
      try {
        const input = parseReplaceProfileInput(rawInput);
        return await withTransaction(pool, async (client) => {
          await lockOwner(client, input.ownerUserId);
          const current = await readProfile(client, input.ownerUserId, true);

          if (current === null) {
            if (input.expectedVersion === 0) {
              const inserted = await client.query<Record<string, unknown>>({
                text: `
                  insert into public.user_profiles (
                    owner_user_id,
                    alias,
                    avatar_ref,
                    record_version
                  )
                  values ($1, $2, $3, 1)
                  returning
                    owner_user_id,
                    alias,
                    avatar_ref,
                    record_version,
                    updated_at
                `,
                values: [
                  input.ownerUserId,
                  input.profile.alias,
                  input.profile.avatar_ref,
                ],
              });
              const row = inserted.rows[0];
              if (row === undefined) {
                throw new ProfileRepositoryUnavailableError();
              }
              return toProfileRecord(row);
            }

            if (profileValuesEqual(defaultProfileValues, input.profile)) {
              return null;
            }
            throw new ProfileRepositoryVersionConflictError();
          }

          if (profileValuesEqual(profileRecordValues(current), input.profile)) {
            return current;
          }
          if (input.expectedVersion !== current.version) {
            throw new ProfileRepositoryVersionConflictError();
          }

          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.user_profiles
              set
                alias = $2,
                avatar_ref = $3,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1 and record_version = $4
              returning
                owner_user_id,
                alias,
                avatar_ref,
                record_version,
                updated_at
            `,
            values: [
              input.ownerUserId,
              input.profile.alias,
              input.profile.avatar_ref,
              input.expectedVersion,
            ],
          });
          const row = updated.rows[0];
          if (row === undefined) {
            throw new ProfileRepositoryVersionConflictError();
          }
          return toProfileRecord(row);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getPrivacy(rawOwnerUserId: string): Promise<PrivacyRecord | null> {
      try {
        const ownerUserId = ownerUserIdSchema.parse(rawOwnerUserId);
        return await readPrivacy(pool, ownerUserId, false);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replacePrivacy(
      rawInput: ReplacePrivacyRecordInput,
    ): Promise<PrivacyRecord | null> {
      try {
        const input = parseReplacePrivacyInput(rawInput);
        return await withTransaction(pool, async (client) => {
          await lockOwner(client, input.ownerUserId);
          const current = await readPrivacy(client, input.ownerUserId, true);

          if (current === null) {
            if (input.expectedVersion === 0) {
              const inserted = await client.query<Record<string, unknown>>({
                text: `
                  insert into public.privacy_preferences (
                    owner_user_id,
                    discoverable,
                    copy_trade_visibility,
                    record_version
                  )
                  values ($1, $2, $3, 1)
                  returning
                    owner_user_id,
                    discoverable,
                    copy_trade_visibility,
                    record_version,
                    updated_at
                `,
                values: [
                  input.ownerUserId,
                  input.privacy.discoverable,
                  input.privacy.copy_trade_visibility,
                ],
              });
              const row = inserted.rows[0];
              if (row === undefined) {
                throw new ProfileRepositoryUnavailableError();
              }
              return toPrivacyRecord(row);
            }

            if (privacyValuesEqual(defaultPrivacyValues, input.privacy)) {
              return null;
            }
            throw new ProfileRepositoryVersionConflictError();
          }

          if (privacyValuesEqual(privacyRecordValues(current), input.privacy)) {
            return current;
          }
          if (input.expectedVersion !== current.version) {
            throw new ProfileRepositoryVersionConflictError();
          }

          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.privacy_preferences
              set
                discoverable = $2,
                copy_trade_visibility = $3,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1 and record_version = $4
              returning
                owner_user_id,
                discoverable,
                copy_trade_visibility,
                record_version,
                updated_at
            `,
            values: [
              input.ownerUserId,
              input.privacy.discoverable,
              input.privacy.copy_trade_visibility,
              input.expectedVersion,
            ],
          });
          const row = updated.rows[0];
          if (row === undefined) {
            throw new ProfileRepositoryVersionConflictError();
          }
          return toPrivacyRecord(row);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
