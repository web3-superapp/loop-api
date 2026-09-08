import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { assetIdPatternSource } from "../features/chain/chain-contract.js";
import {
  notificationCategories,
  type NotificationCategory,
} from "../features/alerts/notification-contract.js";
import {
  AlertExpiryNotFutureError,
  AlertIdempotencyConflictError,
  AlertIdempotencyResourceDeletedError,
  AlertRepositoryUnavailableError,
  AlertVersionConflictError,
} from "./alert-repository.js";

/**
 * V2 price alerts keyed by canonical asset ID (Decision 0034).
 *
 * V1 rows (`asset_key`, always `inactive`) and V2 rows (`asset_id`, `active`
 * or `triggered`) share the table but never the namespace: every query here
 * filters `asset_id is not null`, and the V1 repository filters the opposite.
 * A trigger writes the append-only event, flips the definition to
 * `triggered`, and inserts the context notification in one transaction.
 */

export const PRICE_ALERT_V2_CREATE_DIGEST_VERSION = "price_alert_create_v2";
export const PRICE_ALERT_V2_IDEMPOTENCY_SCOPE = "price_alert_create_v2";

export const priceAlertV2Conditions = Object.freeze([
  "above",
  "at_or_above",
  "below",
  "at_or_below",
] as const);
export type PriceAlertV2Condition = (typeof priceAlertV2Conditions)[number];

export const priceAlertV2States = Object.freeze([
  "active",
  "triggered",
] as const);
export type PriceAlertV2State = (typeof priceAlertV2States)[number];

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const assetIdSchema = z.string().regex(new RegExp(assetIdPatternSource));
const decimalSchema = z
  .string()
  .max(96)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const conditionSchema = z.enum(priceAlertV2Conditions);
const dateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const rowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    create_request_sha256: sha256Schema,
    asset_id: assetIdSchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    expires_at: dateSchema.nullable(),
    state: z.enum(priceAlertV2States),
    triggered_at: dateSchema.nullable(),
    last_evaluated_at: dateSchema.nullable(),
    deleted_at: dateSchema.nullable(),
    record_version: z.number().int().positive(),
    created_at: dateSchema,
    updated_at: dateSchema,
  })
  .strict();

export interface PriceAlertV2Definition {
  readonly assetId: string;
  readonly condition: PriceAlertV2Condition;
  readonly threshold: string;
  readonly expiresAt: string | null;
}

export interface PriceAlertV2Record extends PriceAlertV2Definition {
  readonly alertId: string;
  readonly ownerUserId: string;
  readonly createRequestSha256: string;
  readonly state: PriceAlertV2State;
  readonly triggeredAt: string | null;
  readonly lastEvaluatedAt: string | null;
  readonly deletedAt: string | null;
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePriceAlertV2Input {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly definition: PriceAlertV2Definition;
}

export interface ListPriceAlertsV2Input {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly before?: {
    readonly createdAt: string;
    readonly alertId: string;
  };
}

export interface PriceAlertV2Page {
  readonly items: readonly PriceAlertV2Record[];
  readonly hasMore: boolean;
}

export interface ReplacePriceAlertV2Input {
  readonly ownerUserId: string;
  readonly alertId: string;
  readonly expectedVersion: number;
  readonly definition: PriceAlertV2Definition;
}

export interface DeletePriceAlertV2Input {
  readonly ownerUserId: string;
  readonly alertId: string;
  readonly expectedVersion: number;
}

export interface TriggerNotificationInput {
  readonly type: NotificationCategory;
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly contextParams: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, string | null>>;
  readonly dedupeKey: string;
}

export interface RecordPriceAlertTriggerInput {
  readonly alertId: string;
  readonly ownerUserId: string;
  readonly valueDecimal: string;
  readonly source: string;
  readonly sourceFactRef: string;
  readonly observedAt: string;
  /** `null` when the owner disabled `trade.priceAlert`; the event is still recorded. */
  readonly notification: TriggerNotificationInput | null;
}

export interface RecordPriceAlertTriggerResult {
  readonly outcome: "triggered" | "already_triggered";
  readonly eventId: string | null;
  /** `null` when suppressed by preference or collapsed by the dedupe key. */
  readonly notificationId: string | null;
}

export interface AlertV2Repository {
  create(input: CreatePriceAlertV2Input): Promise<{
    readonly created: boolean;
    readonly alert: PriceAlertV2Record;
  }>;
  listOwned(input: ListPriceAlertsV2Input): Promise<PriceAlertV2Page>;
  findOwned(
    ownerUserId: string,
    alertId: string,
  ): Promise<PriceAlertV2Record | null>;
  replaceOwned(
    input: ReplacePriceAlertV2Input,
  ): Promise<PriceAlertV2Record | null>;
  softDeleteOwned(input: DeletePriceAlertV2Input): Promise<boolean>;
  /**
   * Active, unexpired, undeleted V2 alerts across owners for the evaluator
   * lane, least recently evaluated first. `excludeIds` lets one tick page
   * through the set without re-reading alerts it already handled.
   */
  listEvaluable(input: {
    readonly limit: number;
    readonly excludeIds: readonly string[];
  }): Promise<readonly PriceAlertV2Record[]>;
  markEvaluated(
    alertIds: readonly string[],
    evaluatedAt: string,
  ): Promise<void>;
  recordTrigger(
    input: RecordPriceAlertTriggerInput,
  ): Promise<RecordPriceAlertTriggerResult>;
}

const columns = `
  id, owner_user_id, create_request_sha256, asset_id, condition,
  threshold_decimal, expires_at, state, triggered_at, last_evaluated_at,
  deleted_at, record_version, created_at, updated_at
`;

function mapRow(value: unknown): PriceAlertV2Record {
  const row = rowSchema.parse(value);
  return Object.freeze({
    alertId: row.id,
    ownerUserId: row.owner_user_id,
    createRequestSha256: row.create_request_sha256,
    assetId: row.asset_id,
    condition: row.condition,
    threshold: row.threshold_decimal,
    expiresAt: row.expires_at?.toISOString() ?? null,
    state: row.state,
    triggeredAt: row.triggered_at?.toISOString() ?? null,
    lastEvaluatedAt: row.last_evaluated_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    recordVersion: row.record_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function definitionsEqual(
  record: PriceAlertV2Record,
  definition: PriceAlertV2Definition,
): boolean {
  return (
    record.assetId === definition.assetId &&
    record.condition === definition.condition &&
    record.threshold === definition.threshold &&
    record.expiresAt === definition.expiresAt
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

function translate(error: unknown): never {
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

const createInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    definition: z
      .object({
        assetId: assetIdSchema,
        condition: conditionSchema,
        threshold: decimalSchema,
        expiresAt: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();

export function createPostgresAlertV2Repository(pool: Pool): AlertV2Repository {
  const repository: AlertV2Repository = {
    async create(rawInput) {
      try {
        const input = createInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const idempotency = await client.query<{ id: string }>({
            text: `
              insert into public.idempotency_records (
                owner_user_id, scope, idempotency_key, key_source,
                request_sha256, digest_version
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
              PRICE_ALERT_V2_IDEMPOTENCY_SCOPE,
              input.idempotencyKey,
              input.requestSha256,
              PRICE_ALERT_V2_CREATE_DIGEST_VERSION,
            ],
          });
          const idempotencyId = idempotency.rows[0]?.id;
          if (idempotencyId === undefined) {
            throw new AlertIdempotencyConflictError();
          }
          const existing = await client.query<Record<string, unknown>>({
            text: `
              select ${columns}
              from public.price_alert_definitions
              where create_idempotency_record_id = $1 and asset_id is not null
              limit 1
            `,
            values: [idempotencyId],
          });
          const existingRow = existing.rows[0];
          if (existingRow !== undefined) {
            const alert = mapRow(existingRow);
            if (
              alert.ownerUserId !== input.ownerUserId ||
              alert.createRequestSha256 !== input.requestSha256
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
                owner_user_id, create_idempotency_record_id, create_request_sha256,
                asset_id, condition, threshold_decimal, expires_at, state
              )
              select $1, $2, $3, $4, $5, $6, $7::timestamptz, 'active'
              where $7::timestamptz is null or $7::timestamptz > clock_timestamp()
              returning ${columns}
            `,
            values: [
              input.ownerUserId,
              idempotencyId,
              input.requestSha256,
              input.definition.assetId,
              input.definition.condition,
              input.definition.threshold,
              input.definition.expiresAt,
            ],
          });
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new AlertExpiryNotFutureError();
          }
          return Object.freeze({ created: true, alert: mapRow(row) });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listOwned(input) {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${columns}
            from public.price_alert_definitions
            where owner_user_id = $1
              and asset_id is not null
              and deleted_at is null
              and (
                $2::timestamptz is null
                or created_at < $2::timestamptz
                or (created_at = $2::timestamptz and id < $3::uuid)
              )
            order by created_at desc, id desc
            limit $4
          `,
          values: [
            uuidSchema.parse(input.ownerUserId),
            input.before?.createdAt ?? null,
            input.before?.alertId ?? null,
            input.limit + 1,
          ],
        });
        const rows = result.rows.map(mapRow);
        return Object.freeze({
          items: Object.freeze(rows.slice(0, input.limit)),
          hasMore: rows.length > input.limit,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async findOwned(ownerUserId, alertId) {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${columns}
            from public.price_alert_definitions
            where owner_user_id = $1 and id = $2
              and asset_id is not null and deleted_at is null
            limit 1
          `,
          values: [uuidSchema.parse(ownerUserId), uuidSchema.parse(alertId)],
        });
        const row = result.rows[0];
        return row === undefined ? null : mapRow(row);
      } catch (error) {
        return translate(error);
      }
    },

    async replaceOwned(input) {
      try {
        const definition = createInputSchema.shape.definition.parse(
          input.definition,
        );
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Record<string, unknown>>({
            text: `
              select ${columns}
              from public.price_alert_definitions
              where owner_user_id = $1 and id = $2
                and asset_id is not null and deleted_at is null
              for update
            `,
            values: [
              uuidSchema.parse(input.ownerUserId),
              uuidSchema.parse(input.alertId),
            ],
          });
          const row = selected.rows[0];
          if (row === undefined) {
            return null;
          }
          const current = mapRow(row);
          if (
            definitionsEqual(current, definition) &&
            current.state === "active"
          ) {
            return current;
          }
          if (current.recordVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }
          // A replacement re-arms the alert: the trigger record stays in
          // price_alert_events, the definition returns to `active`.
          const updated = await client.query<Record<string, unknown>>({
            text: `
              update public.price_alert_definitions
              set asset_id = $3, condition = $4, threshold_decimal = $5,
                  expires_at = $6::timestamptz, state = 'active',
                  triggered_at = null, record_version = record_version + 1,
                  updated_at = clock_timestamp()
              where owner_user_id = $1 and id = $2 and deleted_at is null
                and ($6::timestamptz is null or $6::timestamptz > clock_timestamp())
              returning ${columns}
            `,
            values: [
              input.ownerUserId,
              input.alertId,
              definition.assetId,
              definition.condition,
              definition.threshold,
              definition.expiresAt,
            ],
          });
          const updatedRow = updated.rows[0];
          if (updatedRow === undefined) {
            throw new AlertExpiryNotFutureError();
          }
          return mapRow(updatedRow);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async softDeleteOwned(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Record<string, unknown>>({
            text: `
              select ${columns}
              from public.price_alert_definitions
              where owner_user_id = $1 and id = $2 and asset_id is not null
              for update
            `,
            values: [
              uuidSchema.parse(input.ownerUserId),
              uuidSchema.parse(input.alertId),
            ],
          });
          const row = selected.rows[0];
          if (row === undefined) {
            return false;
          }
          const current = mapRow(row);
          if (current.deletedAt !== null) {
            return false;
          }
          if (current.recordVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }
          await client.query({
            text: `
              update public.price_alert_definitions
              set deleted_at = clock_timestamp(), updated_at = clock_timestamp(),
                  record_version = record_version + 1
              where owner_user_id = $1 and id = $2 and deleted_at is null
            `,
            values: [input.ownerUserId, input.alertId],
          });
          return true;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listEvaluable(input) {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${columns}
            from public.price_alert_definitions
            where asset_id is not null
              and deleted_at is null
              and state = 'active'
              and (expires_at is null or expires_at > clock_timestamp())
              and not (id = any($2::uuid[]))
            order by last_evaluated_at asc nulls first, created_at asc, id asc
            limit $1
          `,
          values: [input.limit, [...input.excludeIds]],
        });
        return Object.freeze(result.rows.map(mapRow));
      } catch (error) {
        return translate(error);
      }
    },

    async markEvaluated(alertIds, evaluatedAt) {
      if (alertIds.length === 0) {
        return;
      }
      try {
        await pool.query({
          text: `
            update public.price_alert_definitions
            set last_evaluated_at = $2::timestamptz
            where id = any($1::uuid[]) and asset_id is not null
          `,
          values: [[...alertIds], evaluatedAt],
        });
      } catch (error) {
        return translate(error);
      }
    },

    async recordTrigger(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const flipped = await client.query<Record<string, unknown>>({
            text: `
              update public.price_alert_definitions
              set state = 'triggered', triggered_at = clock_timestamp(),
                  last_evaluated_at = clock_timestamp(),
                  record_version = record_version + 1,
                  updated_at = clock_timestamp()
              where id = $1 and owner_user_id = $2 and asset_id is not null
                and deleted_at is null and state = 'active'
              returning ${columns}
            `,
            values: [
              uuidSchema.parse(input.alertId),
              uuidSchema.parse(input.ownerUserId),
            ],
          });
          const row = flipped.rows[0];
          if (row === undefined) {
            return Object.freeze({
              outcome: "already_triggered" as const,
              eventId: null,
              notificationId: null,
            });
          }
          const alert = mapRow(row);
          const event = await client.query<{ id: string }>({
            text: `
              insert into public.price_alert_events (
                owner_user_id, alert_id, asset_id, condition, threshold_decimal,
                value_decimal, source, source_fact_ref, observed_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
              returning id
            `,
            values: [
              alert.ownerUserId,
              alert.alertId,
              alert.assetId,
              alert.condition,
              alert.threshold,
              decimalSchema.parse(input.valueDecimal),
              input.source,
              input.sourceFactRef,
              input.observedAt,
            ],
          });
          const eventId = event.rows[0]?.id;
          if (eventId === undefined) {
            throw new AlertRepositoryUnavailableError();
          }
          let notificationId: string | null = null;
          if (input.notification !== null) {
            const notification = await client.query<{
              notification_id: string;
            }>({
              text: `
                insert into public.notifications (
                  owner_user_id, type, entity_ref, context_route, context_params,
                  payload, dedupe_key, source, observed_at
                )
                values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::timestamptz)
                on conflict (owner_user_id, dedupe_key) do nothing
                returning notification_id
              `,
              values: [
                alert.ownerUserId,
                z.enum(notificationCategories).parse(input.notification.type),
                input.notification.entityRef,
                input.notification.contextRoute,
                JSON.stringify(input.notification.contextParams),
                JSON.stringify(input.notification.payload),
                input.notification.dedupeKey,
                input.source,
                input.observedAt,
              ],
            });
            notificationId = notification.rows[0]?.notification_id ?? null;
          }
          return Object.freeze({
            outcome: "triggered" as const,
            eventId,
            notificationId,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}

function unavailable(): Promise<never> {
  return Promise.reject(new AlertRepositoryUnavailableError());
}

export function createUnavailableAlertV2Repository(): AlertV2Repository {
  return Object.freeze({
    create: unavailable,
    listOwned: unavailable,
    findOwned: unavailable,
    replaceOwned: unavailable,
    softDeleteOwned: unavailable,
    listEvaluable: unavailable,
    markEvaluated: unavailable,
    recordTrigger: unavailable,
  });
}
