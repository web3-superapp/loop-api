import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  digestPriceAlertCreate,
  notificationEventTypes,
  PRICE_ALERT_CREATE_DIGEST_VERSION,
  PRICE_ALERT_IDEMPOTENCY_SCOPE,
  type NotificationEventType,
  type NotificationPreference,
  type PriceAlertCondition,
  type PriceAlertDefinition,
} from "../features/alerts/alert-contract.js";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const assetKeySchema = z.string().regex(/^[A-Z0-9][A-Z0-9:_-]{0,63}$/);
const decimalSchema = z
  .string()
  .max(96)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const conditionSchema = z.enum([
  "above",
  "at_or_above",
  "below",
  "at_or_below",
]);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const alertRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    create_request_sha256: sha256Schema,
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    expires_at: validDateSchema.nullable(),
    state: z.literal("inactive"),
    deleted_at: validDateSchema.nullable(),
    record_version: z.number().int().positive(),
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict();

const historyRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    alert_id: uuidSchema,
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    value_decimal: decimalSchema,
    source: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    source_fact_ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    observed_at: validDateSchema,
    created_at: validDateSchema,
  })
  .strict();

const createInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    definition: z
      .object({
        asset_key: assetKeySchema,
        condition: conditionSchema,
        threshold_decimal: decimalSchema,
        expires_at: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();

const ownerPaginationSchema = z
  .object({
    ownerUserId: uuidSchema,
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(10_000),
  })
  .strict();

const replaceInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    alertId: uuidSchema,
    expectedVersion: z.number().int().positive(),
    definition: createInputSchema.shape.definition,
  })
  .strict();

const deleteInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    alertId: uuidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

const replacePreferencesInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    expectedVersion: z.number().int().nonnegative(),
    preferences: z
      .array(
        z
          .object({
            event_type: z.enum(notificationEventTypes),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .length(notificationEventTypes.length),
  })
  .strict()
  .superRefine((value, context) => {
    const events = new Set(
      value.preferences.map(({ event_type }) => event_type),
    );
    if (events.size !== notificationEventTypes.length) {
      context.addIssue({
        code: "custom",
        message: "Every notification preference is required exactly once",
      });
    }
  });

const alertReturningColumns = `
  id,
  owner_user_id,
  create_request_sha256,
  asset_key,
  condition,
  threshold_decimal,
  expires_at,
  state,
  deleted_at,
  record_version,
  created_at,
  updated_at
`;

export interface PriceAlertRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly createRequestSha256: string;
  readonly assetKey: string;
  readonly condition: PriceAlertCondition;
  readonly thresholdDecimal: string;
  readonly expiresAt: string | null;
  readonly state: "inactive";
  readonly deletedAt: string | null;
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriceAlertEventRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly alertId: string;
  readonly assetKey: string;
  readonly condition: PriceAlertCondition;
  readonly thresholdDecimal: string;
  readonly valueDecimal: string;
  readonly source: string;
  readonly sourceFactRef: string;
  readonly observedAt: string;
  readonly createdAt: string;
}

export interface NotificationPreferencesRecord {
  readonly recordVersion: number;
  readonly preferences: readonly NotificationPreference[];
}

export interface OwnerPaginationInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface CreatePriceAlertInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly definition: PriceAlertDefinition;
}

export interface ReplacePriceAlertInput {
  readonly ownerUserId: string;
  readonly alertId: string;
  readonly expectedVersion: number;
  readonly definition: PriceAlertDefinition;
}

export interface DeletePriceAlertInput {
  readonly ownerUserId: string;
  readonly alertId: string;
  readonly expectedVersion: number;
}

export interface ReplaceNotificationPreferencesInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly preferences: readonly NotificationPreference[];
}

export interface AlertRepository {
  create(input: CreatePriceAlertInput): Promise<{
    readonly created: boolean;
    readonly alert: PriceAlertRecord;
  }>;
  listOwned(input: OwnerPaginationInput): Promise<{
    readonly records: readonly PriceAlertRecord[];
    readonly nextOffset: number | null;
  }>;
  findOwned(
    ownerUserId: string,
    alertId: string,
  ): Promise<PriceAlertRecord | null>;
  replaceOwned(input: ReplacePriceAlertInput): Promise<PriceAlertRecord | null>;
  softDeleteOwned(input: DeletePriceAlertInput): Promise<boolean>;
  getNotificationPreferences(
    ownerUserId: string,
  ): Promise<NotificationPreferencesRecord>;
  replaceNotificationPreferences(
    input: ReplaceNotificationPreferencesInput,
  ): Promise<NotificationPreferencesRecord>;
  listHistory(input: OwnerPaginationInput): Promise<{
    readonly records: readonly PriceAlertEventRecord[];
    readonly nextOffset: number | null;
  }>;
}

export class AlertIdempotencyConflictError extends Error {
  constructor() {
    super("The alert idempotency key conflicts with another request");
    this.name = "AlertIdempotencyConflictError";
  }
}

export class AlertIdempotencyResourceDeletedError extends Error {
  constructor() {
    super("The resource created by the alert idempotency key was deleted");
    this.name = "AlertIdempotencyResourceDeletedError";
  }
}

export class AlertVersionConflictError extends Error {
  constructor() {
    super("The alert resource version conflicts with the request");
    this.name = "AlertVersionConflictError";
  }
}

export class AlertExpiryNotFutureError extends Error {
  constructor() {
    super("The alert expiry must be in the future");
    this.name = "AlertExpiryNotFutureError";
  }
}

export class AlertRepositoryUnavailableError extends Error {
  constructor() {
    super("The alert repository is unavailable");
    this.name = "AlertRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new AlertRepositoryUnavailableError());
}

export function createUnavailableAlertRepository(): AlertRepository {
  return Object.freeze({
    create: unavailable,
    listOwned: unavailable,
    findOwned: unavailable,
    replaceOwned: unavailable,
    softDeleteOwned: unavailable,
    getNotificationPreferences: unavailable,
    replaceNotificationPreferences: unavailable,
    listHistory: unavailable,
  });
}

function toAlertRecord(value: unknown): PriceAlertRecord {
  const row = alertRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    ownerUserId: row.owner_user_id,
    createRequestSha256: row.create_request_sha256,
    assetKey: row.asset_key,
    condition: row.condition,
    thresholdDecimal: row.threshold_decimal,
    expiresAt: row.expires_at?.toISOString() ?? null,
    state: row.state,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    recordVersion: row.record_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function toHistoryRecord(value: unknown): PriceAlertEventRecord {
  const row = historyRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    ownerUserId: row.owner_user_id,
    alertId: row.alert_id,
    assetKey: row.asset_key,
    condition: row.condition,
    thresholdDecimal: row.threshold_decimal,
    valueDecimal: row.value_decimal,
    source: row.source,
    sourceFactRef: row.source_fact_ref,
    observedAt: row.observed_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  });
}

function defaultPreferences(): readonly NotificationPreference[] {
  return Object.freeze(
    notificationEventTypes.map((eventType) =>
      Object.freeze({ event_type: eventType, enabled: false }),
    ),
  );
}

function normalizePreferences(
  values: ReadonlyMap<NotificationEventType, boolean>,
): readonly NotificationPreference[] {
  return Object.freeze(
    notificationEventTypes.map((eventType) =>
      Object.freeze({
        event_type: eventType,
        enabled: values.get(eventType) ?? false,
      }),
    ),
  );
}

function definitionsEqual(
  record: PriceAlertRecord,
  definition: PriceAlertDefinition,
): boolean {
  return (
    record.assetKey === definition.asset_key &&
    record.condition === definition.condition &&
    record.thresholdDecimal === definition.threshold_decimal &&
    record.expiresAt === definition.expires_at
  );
}

function preferencesEqual(
  left: readonly NotificationPreference[],
  right: readonly NotificationPreference[],
): boolean {
  return notificationEventTypes.every(
    (eventType) =>
      left.find(({ event_type }) => event_type === eventType)?.enabled ===
      right.find(({ event_type }) => event_type === eventType)?.enabled,
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
      throw new AlertRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

type DatabaseClient = Pick<PoolClient, "query">;

async function readOwnedAlert(
  client: DatabaseClient,
  ownerUserId: string,
  alertId: string,
  includeDeleted = false,
): Promise<PriceAlertRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${alertReturningColumns}
      from public.price_alert_definitions
      where owner_user_id = $1
        and id = $2
        ${includeDeleted ? "" : "and deleted_at is null"}
      limit 1
    `,
    values: [ownerUserId, alertId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAlertRecord(row);
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof AlertIdempotencyConflictError ||
    error instanceof AlertIdempotencyResourceDeletedError ||
    error instanceof AlertVersionConflictError ||
    error instanceof AlertExpiryNotFutureError ||
    error instanceof AlertRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new AlertRepositoryUnavailableError();
}

export function createPostgresAlertRepository(pool: Pool): AlertRepository {
  return Object.freeze({
    async create(rawInput: CreatePriceAlertInput) {
      try {
        const input = createInputSchema.parse(rawInput);
        if (input.requestSha256 !== digestPriceAlertCreate(input.definition)) {
          throw new AlertRepositoryUnavailableError();
        }
        return await withTransaction(pool, async (client) => {
          const idempotency = await client.query<{ id: string }>({
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
              PRICE_ALERT_IDEMPOTENCY_SCOPE,
              input.idempotencyKey,
              input.requestSha256,
              PRICE_ALERT_CREATE_DIGEST_VERSION,
            ],
          });
          const idempotencyId = idempotency.rows[0]?.id;
          if (idempotencyId === undefined) {
            throw new AlertIdempotencyConflictError();
          }

          const existing = await client.query<Record<string, unknown>>({
            text: `
              select ${alertReturningColumns}
              from public.price_alert_definitions
              where create_idempotency_record_id = $1
              limit 1
            `,
            values: [idempotencyId],
          });
          const existingRow = existing.rows[0];
          if (existingRow !== undefined) {
            const alert = toAlertRecord(existingRow);
            if (
              alert.ownerUserId !== input.ownerUserId ||
              alert.createRequestSha256 !== input.requestSha256 ||
              !definitionsEqual(alert, input.definition)
            ) {
              throw new AlertIdempotencyConflictError();
            }
            if (alert.deletedAt !== null) {
              throw new AlertIdempotencyResourceDeletedError();
            }
            return Object.freeze({ created: false, alert });
          }

          const inserted = await client.query<Record<string, unknown>>({
            text: `
              insert into public.price_alert_definitions (
                owner_user_id,
                create_idempotency_record_id,
                create_request_sha256,
                asset_key,
                condition,
                threshold_decimal,
                expires_at
              )
              select $1, $2, $3, $4, $5, $6, $7::timestamptz
              where $7::timestamptz is null
                 or $7::timestamptz > clock_timestamp()
              returning ${alertReturningColumns}
            `,
            values: [
              input.ownerUserId,
              idempotencyId,
              input.requestSha256,
              input.definition.asset_key,
              input.definition.condition,
              input.definition.threshold_decimal,
              input.definition.expires_at,
            ],
          });
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new AlertExpiryNotFutureError();
          }
          return Object.freeze({ created: true, alert: toAlertRecord(row) });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listOwned(rawInput: OwnerPaginationInput) {
      try {
        const input = ownerPaginationSchema.parse(rawInput);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${alertReturningColumns}
            from public.price_alert_definitions
            where owner_user_id = $1 and deleted_at is null
            order by created_at desc, id desc
            limit $2 offset $3
          `,
          values: [input.ownerUserId, input.limit + 1, input.offset],
        });
        const records = result.rows.slice(0, input.limit).map(toAlertRecord);
        const candidateNextOffset = input.offset + input.limit;
        return Object.freeze({
          records: Object.freeze(records),
          nextOffset:
            result.rows.length > input.limit && candidateNextOffset <= 10_000
              ? candidateNextOffset
              : null,
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findOwned(rawOwnerUserId: string, rawAlertId: string) {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        const alertId = uuidSchema.parse(rawAlertId);
        return await readOwnedAlert(pool, ownerUserId, alertId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceOwned(rawInput: ReplacePriceAlertInput) {
      try {
        const input = replaceInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Record<string, unknown>>({
            text: `
              select ${alertReturningColumns}
              from public.price_alert_definitions
              where owner_user_id = $1 and id = $2 and deleted_at is null
              for update
            `,
            values: [input.ownerUserId, input.alertId],
          });
          const row = selected.rows[0];
          if (row === undefined) {
            return null;
          }
          const current = toAlertRecord(row);
          if (definitionsEqual(current, input.definition)) {
            return current;
          }
          if (current.recordVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }

          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.price_alert_definitions
              set
                asset_key = $3,
                condition = $4,
                threshold_decimal = $5,
                expires_at = $6::timestamptz,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1
                and id = $2
                and deleted_at is null
                and ($6::timestamptz is null
                  or $6::timestamptz > clock_timestamp())
              returning ${alertReturningColumns}
            `,
            values: [
              input.ownerUserId,
              input.alertId,
              input.definition.asset_key,
              input.definition.condition,
              input.definition.threshold_decimal,
              input.definition.expires_at,
            ],
          });
          const updatedRow = updated.rows[0];
          if (updatedRow === undefined) {
            throw new AlertExpiryNotFutureError();
          }
          return toAlertRecord(updatedRow);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async softDeleteOwned(rawInput: DeletePriceAlertInput) {
      try {
        const input = deleteInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Record<string, unknown>>({
            text: `
              select ${alertReturningColumns}
              from public.price_alert_definitions
              where owner_user_id = $1 and id = $2
              for update
            `,
            values: [input.ownerUserId, input.alertId],
          });
          const row = selected.rows[0];
          if (row === undefined) {
            return false;
          }
          const current = toAlertRecord(row);
          if (current.deletedAt !== null) {
            return false;
          }
          if (current.recordVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }
          await client.query({
            text: `
              update public.price_alert_definitions
              set
                deleted_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                record_version = record_version + 1
              where owner_user_id = $1 and id = $2 and deleted_at is null
            `,
            values: [input.ownerUserId, input.alertId],
          });
          return true;
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async getNotificationPreferences(rawOwnerUserId: string) {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        const result = await pool.query<{
          record_version: number;
          event_type: NotificationEventType | null;
          enabled: boolean | null;
        }>({
          text: `
            select v.record_version, p.event_type, p.enabled
            from public.notification_preference_versions as v
            left join public.notification_preferences as p
              on p.owner_user_id = v.owner_user_id
            where v.owner_user_id = $1
          `,
          values: [ownerUserId],
        });
        if (result.rows.length === 0) {
          return Object.freeze({
            recordVersion: 0,
            preferences: defaultPreferences(),
          });
        }
        const recordVersion = z
          .number()
          .int()
          .nonnegative()
          .parse(result.rows[0]?.record_version);
        const values = new Map<NotificationEventType, boolean>();
        for (const rawRow of result.rows) {
          const row = z
            .object({
              record_version: z.literal(recordVersion),
              event_type: z.enum(notificationEventTypes).nullable(),
              enabled: z.boolean().nullable(),
            })
            .strict()
            .parse(rawRow);
          if (row.event_type !== null && row.enabled !== null) {
            values.set(row.event_type, row.enabled);
          }
        }
        return Object.freeze({
          recordVersion,
          preferences: normalizePreferences(values),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceNotificationPreferences(
      rawInput: ReplaceNotificationPreferencesInput,
    ) {
      try {
        const input = replacePreferencesInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          await client.query({
            text: `
              insert into public.notification_preference_versions (
                owner_user_id,
                record_version
              )
              values ($1, 0)
              on conflict (owner_user_id) do nothing
            `,
            values: [input.ownerUserId],
          });
          const versionResult = await client.query<{ record_version: number }>({
            text: `
              select record_version
              from public.notification_preference_versions
              where owner_user_id = $1
              for update
            `,
            values: [input.ownerUserId],
          });
          const currentVersion = z
            .number()
            .int()
            .nonnegative()
            .parse(versionResult.rows[0]?.record_version);
          const currentRows = await client.query<{
            event_type: NotificationEventType;
            enabled: boolean;
          }>({
            text: `
              select event_type, enabled
              from public.notification_preferences
              where owner_user_id = $1
            `,
            values: [input.ownerUserId],
          });
          const currentValues = new Map<NotificationEventType, boolean>();
          for (const row of currentRows.rows) {
            const parsed = z
              .object({
                event_type: z.enum(notificationEventTypes),
                enabled: z.boolean(),
              })
              .strict()
              .parse(row);
            currentValues.set(parsed.event_type, parsed.enabled);
          }
          const currentPreferences = normalizePreferences(currentValues);
          if (preferencesEqual(currentPreferences, input.preferences)) {
            return Object.freeze({
              recordVersion: currentVersion,
              preferences: currentPreferences,
            });
          }
          if (currentVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }

          await client.query({
            text: `
              delete from public.notification_preferences
              where owner_user_id = $1
            `,
            values: [input.ownerUserId],
          });
          for (const preference of input.preferences) {
            await client.query({
              text: `
                insert into public.notification_preferences (
                  owner_user_id,
                  event_type,
                  enabled
                )
                values ($1, $2, $3)
              `,
              values: [
                input.ownerUserId,
                preference.event_type,
                preference.enabled,
              ],
            });
          }
          const nextVersion = await client.query<{ record_version: number }>({
            text: `
              update public.notification_preference_versions
              set
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where owner_user_id = $1
              returning record_version
            `,
            values: [input.ownerUserId],
          });
          return Object.freeze({
            recordVersion: z
              .number()
              .int()
              .positive()
              .parse(nextVersion.rows[0]?.record_version),
            preferences: Object.freeze(input.preferences),
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listHistory(rawInput: OwnerPaginationInput) {
      try {
        const input = ownerPaginationSchema.parse(rawInput);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              id,
              owner_user_id,
              alert_id,
              asset_key,
              condition,
              threshold_decimal,
              value_decimal,
              source,
              source_fact_ref,
              observed_at,
              created_at
            from public.price_alert_events
            where owner_user_id = $1
            order by created_at desc, id desc
            limit $2 offset $3
          `,
          values: [input.ownerUserId, input.limit + 1, input.offset],
        });
        const records = result.rows.slice(0, input.limit).map(toHistoryRecord);
        const candidateNextOffset = input.offset + input.limit;
        return Object.freeze({
          records: Object.freeze(records),
          nextOffset:
            result.rows.length > input.limit && candidateNextOffset <= 10_000
              ? candidateNextOffset
              : null,
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
