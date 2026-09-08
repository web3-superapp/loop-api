import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  defaultNotificationPreferences,
  notificationCategories,
  optionalNotificationCategories,
  type NotificationCategory,
  type OptionalNotificationCategory,
} from "../features/alerts/notification-contract.js";
import {
  AlertRepositoryUnavailableError,
  AlertVersionConflictError,
} from "./alert-repository.js";

/**
 * Context notification feed and V2 notification preferences (Decision 0034).
 *
 * Notifications are written only by server-side producers (today: the alert
 * evaluator lane inside `alert-v2-repository.recordTrigger`). This repository
 * reads the feed, acknowledges reads, and stores the nine optional
 * preferences; `security.event` never has a row.
 */

const uuidSchema = z.string().uuid();
const dateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const notificationRowSchema = z
  .object({
    notification_id: uuidSchema,
    owner_user_id: uuidSchema,
    type: z.enum(notificationCategories),
    entity_ref: z.string().min(3).max(200),
    context_route: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    context_params: z.record(z.string(), z.string()),
    payload: z.record(z.string(), z.string().nullable()),
    dedupe_key: z.string().min(1).max(200),
    source: z.string().nullable(),
    observed_at: dateSchema.nullable(),
    read_at: dateSchema.nullable(),
    created_at: dateSchema,
  })
  .strict();

export interface NotificationRecord {
  readonly notificationId: string;
  readonly ownerUserId: string;
  readonly type: NotificationCategory;
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly contextParams: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, string | null>>;
  readonly dedupeKey: string;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface ListNotificationsInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly before?: {
    readonly createdAt: string;
    readonly notificationId: string;
  };
}

export interface NotificationPage {
  readonly items: readonly NotificationRecord[];
  readonly hasMore: boolean;
  readonly unreadCount: number;
}

export type NotificationPreferenceValues = Readonly<
  Record<OptionalNotificationCategory, boolean>
>;

export interface NotificationPreferencesV2Record {
  readonly recordVersion: number;
  readonly updatedAt: string | null;
  readonly values: NotificationPreferenceValues;
}

export interface ReplaceNotificationPreferencesV2Input {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly values: NotificationPreferenceValues;
}

export interface NotificationRepository {
  listFeed(input: ListNotificationsInput): Promise<NotificationPage>;
  /**
   * Newest-first notifications of one category for the security summary
   * (Decision 0037); bounded by `limit`, never paginated.
   */
  listRecentByType(input: {
    readonly ownerUserId: string;
    readonly type: NotificationCategory;
    readonly limit: number;
  }): Promise<readonly NotificationRecord[]>;
  /** Idempotent: an already-read notification is returned unchanged. */
  markRead(
    ownerUserId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  getPreferences(ownerUserId: string): Promise<NotificationPreferencesV2Record>;
  replacePreferences(
    input: ReplaceNotificationPreferencesV2Input,
  ): Promise<NotificationPreferencesV2Record>;
  /** Preference lookup for a producer; defaults apply when no row exists. */
  isCategoryEnabled(
    ownerUserId: string,
    category: OptionalNotificationCategory,
  ): Promise<boolean>;
}

const notificationColumns = `
  notification_id, owner_user_id, type, entity_ref, context_route,
  context_params, payload, dedupe_key, source, observed_at, read_at, created_at
`;

function mapNotification(value: unknown): NotificationRecord {
  const row = notificationRowSchema.parse(value);
  return Object.freeze({
    notificationId: row.notification_id,
    ownerUserId: row.owner_user_id,
    type: row.type,
    entityRef: row.entity_ref,
    contextRoute: row.context_route,
    contextParams: Object.freeze({ ...row.context_params }),
    payload: Object.freeze({ ...row.payload }),
    dedupeKey: row.dedupe_key,
    source: row.source,
    observedAt: row.observed_at?.toISOString() ?? null,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

function normalizeValues(
  stored: ReadonlyMap<OptionalNotificationCategory, boolean>,
): NotificationPreferenceValues {
  const values: Record<string, boolean> = {};
  for (const category of optionalNotificationCategories) {
    values[category] =
      stored.get(category) ?? defaultNotificationPreferences[category];
  }
  return Object.freeze(values);
}

function valuesEqual(
  left: NotificationPreferenceValues,
  right: NotificationPreferenceValues,
): boolean {
  return optionalNotificationCategories.every(
    (category) => left[category] === right[category],
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
    error instanceof AlertVersionConflictError ||
    error instanceof AlertRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new AlertRepositoryUnavailableError();
}

async function readStoredValues(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
): Promise<{
  readonly recordVersion: number;
  readonly updatedAt: string | null;
  readonly values: NotificationPreferenceValues;
}> {
  const version = await client.query<{
    record_version: number;
    updated_at: Date;
  }>({
    text: `
      select record_version, updated_at
      from public.notification_preference_v2_versions
      where owner_user_id = $1
    `,
    values: [ownerUserId],
  });
  const versionRow = version.rows[0];
  if (versionRow === undefined) {
    return Object.freeze({
      recordVersion: 0,
      updatedAt: null,
      values: normalizeValues(new Map()),
    });
  }
  const rows = await client.query<{ category: string; enabled: boolean }>({
    text: `
      select category, enabled
      from public.notification_preferences_v2
      where owner_user_id = $1
    `,
    values: [ownerUserId],
  });
  const stored = new Map<OptionalNotificationCategory, boolean>();
  for (const row of rows.rows) {
    const parsed = z
      .object({
        category: z.enum(optionalNotificationCategories),
        enabled: z.boolean(),
      })
      .strict()
      .parse(row);
    stored.set(parsed.category, parsed.enabled);
  }
  return Object.freeze({
    recordVersion: z
      .number()
      .int()
      .nonnegative()
      .parse(versionRow.record_version),
    updatedAt: dateSchema.parse(versionRow.updated_at).toISOString(),
    values: normalizeValues(stored),
  });
}

export function createPostgresNotificationRepository(
  pool: Pool,
): NotificationRepository {
  const repository: NotificationRepository = {
    async listFeed(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const [page, unread] = await Promise.all([
          pool.query<Record<string, unknown>>({
            text: `
              select ${notificationColumns}
              from public.notifications
              where owner_user_id = $1
                and (
                  $2::timestamptz is null
                  or created_at < $2::timestamptz
                  or (created_at = $2::timestamptz and notification_id < $3::uuid)
                )
              order by created_at desc, notification_id desc
              limit $4
            `,
            values: [
              ownerUserId,
              input.before?.createdAt ?? null,
              input.before?.notificationId ?? null,
              input.limit + 1,
            ],
          }),
          pool.query<{ unread: number }>({
            text: `
              select count(*)::int as unread
              from public.notifications
              where owner_user_id = $1 and read_at is null
            `,
            values: [ownerUserId],
          }),
        ]);
        const rows = page.rows.map(mapNotification);
        return Object.freeze({
          items: Object.freeze(rows.slice(0, input.limit)),
          hasMore: rows.length > input.limit,
          unreadCount: z.number().int().min(0).parse(unread.rows[0]?.unread),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listRecentByType(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const type = z.enum(notificationCategories).parse(input.type);
        const limit = z.number().int().min(1).max(50).parse(input.limit);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${notificationColumns}
            from public.notifications
            where owner_user_id = $1 and type = $2
            order by created_at desc, notification_id desc
            limit $3
          `,
          values: [ownerUserId, type, limit],
        });
        return Object.freeze(result.rows.map(mapNotification));
      } catch (error) {
        return translate(error);
      }
    },

    async markRead(ownerUserId, notificationId) {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            update public.notifications
            set read_at = coalesce(read_at, clock_timestamp())
            where owner_user_id = $1 and notification_id = $2
            returning ${notificationColumns}
          `,
          values: [
            uuidSchema.parse(ownerUserId),
            uuidSchema.parse(notificationId),
          ],
        });
        const row = result.rows[0];
        return row === undefined ? null : mapNotification(row);
      } catch (error) {
        return translate(error);
      }
    },

    async getPreferences(ownerUserId) {
      try {
        return await readStoredValues(pool, uuidSchema.parse(ownerUserId));
      } catch (error) {
        return translate(error);
      }
    },

    async replacePreferences(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        return await withTransaction(pool, async (client) => {
          await client.query({
            text: `
              insert into public.notification_preference_v2_versions (owner_user_id, record_version)
              values ($1, 0)
              on conflict (owner_user_id) do nothing
            `,
            values: [ownerUserId],
          });
          await client.query({
            text: `
              select record_version
              from public.notification_preference_v2_versions
              where owner_user_id = $1
              for update
            `,
            values: [ownerUserId],
          });
          const current = await readStoredValues(client, ownerUserId);
          if (valuesEqual(current.values, input.values)) {
            return current;
          }
          if (current.recordVersion !== input.expectedVersion) {
            throw new AlertVersionConflictError();
          }
          await client.query({
            text: `delete from public.notification_preferences_v2 where owner_user_id = $1`,
            values: [ownerUserId],
          });
          for (const category of optionalNotificationCategories) {
            await client.query({
              text: `
                insert into public.notification_preferences_v2 (owner_user_id, category, enabled)
                values ($1, $2, $3)
              `,
              values: [ownerUserId, category, input.values[category]],
            });
          }
          const bumped = await client.query<{
            record_version: number;
            updated_at: Date;
          }>({
            text: `
              update public.notification_preference_v2_versions
              set record_version = record_version + 1, updated_at = clock_timestamp()
              where owner_user_id = $1
              returning record_version, updated_at
            `,
            values: [ownerUserId],
          });
          const row = bumped.rows[0];
          if (row === undefined) {
            throw new AlertRepositoryUnavailableError();
          }
          return Object.freeze({
            recordVersion: z
              .number()
              .int()
              .positive()
              .parse(row.record_version),
            updatedAt: dateSchema.parse(row.updated_at).toISOString(),
            values: Object.freeze({ ...input.values }),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async isCategoryEnabled(ownerUserId, category) {
      try {
        const stored = await readStoredValues(
          pool,
          uuidSchema.parse(ownerUserId),
        );
        return stored.values[category];
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

export function createUnavailableNotificationRepository(): NotificationRepository {
  return Object.freeze({
    listFeed: unavailable,
    listRecentByType: unavailable,
    markRead: unavailable,
    getPreferences: unavailable,
    replacePreferences: unavailable,
    isCategoryEnabled: unavailable,
  });
}
