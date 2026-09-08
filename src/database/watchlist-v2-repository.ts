import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { assetIdPatternSource } from "../features/chain/chain-contract.js";

/**
 * V2 Watchlist storage (Decision 0033).
 *
 * V1 and V2 are the same owner-bound resource: they share
 * `watchlist_versions.record_version`, so a V2 compare-and-swap sees a V1
 * write and vice versa. They differ only in asset identity — a V1 row stores
 * the opaque `asset_key`, a V2 row stores the canonical lowercase CAIP
 * `asset_id`, and exactly one of the two columns is set per row.
 */

export const watchlistV2MaximumGroups = 20;
export const watchlistV2MaximumItems = 100;
export const watchlistV2GroupKeyPatternSource = "^[a-z0-9][a-z0-9_-]{0,31}$";

const groupKeyPattern = new RegExp(watchlistV2GroupKeyPatternSource);
const assetIdPattern = new RegExp(assetIdPatternSource);

const snapshotRowSchema = z
  .object({
    record_version: z.number().int().min(0),
    version_updated_at: z.date(),
    group_key: z.string().nullable(),
    group_name: z.string().nullable(),
    group_position: z.number().int().min(0).nullable(),
    asset_id: z.string().nullable(),
    item_position: z.number().int().min(0).nullable(),
  })
  .strict();

export interface WatchlistV2Item {
  readonly assetId: string;
}

export interface WatchlistV2Group {
  readonly key: string;
  readonly name: string;
  readonly items: readonly WatchlistV2Item[];
}

export interface WatchlistV2Snapshot {
  readonly version: number;
  readonly groups: readonly WatchlistV2Group[];
  readonly updatedAt: string | null;
}

export interface ReplaceWatchlistV2Input {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly groups: readonly WatchlistV2Group[];
}

export interface WatchlistV2Repository {
  get(ownerUserId: string): Promise<WatchlistV2Snapshot>;
  replace(input: ReplaceWatchlistV2Input): Promise<WatchlistV2Snapshot>;
}

export class WatchlistV2UnavailableError extends Error {
  readonly code = "watchlist_v2_unavailable";

  constructor() {
    super("The V2 Watchlist repository is unavailable");
    this.name = "WatchlistV2UnavailableError";
  }
}

export class WatchlistV2VersionConflictError extends Error {
  readonly code = "watchlist_v2_version_conflict";

  constructor() {
    super("The Watchlist version conflicts with the current resource");
    this.name = "WatchlistV2VersionConflictError";
  }
}

function fail(): never {
  throw new WatchlistV2UnavailableError();
}

export function watchlistV2GroupsEqual(
  left: readonly WatchlistV2Group[],
  right: readonly WatchlistV2Group[],
): boolean {
  return (
    left.length === right.length &&
    left.every((leftGroup, groupIndex) => {
      const rightGroup = right[groupIndex];
      return (
        rightGroup !== undefined &&
        leftGroup.key === rightGroup.key &&
        leftGroup.name === rightGroup.name &&
        leftGroup.items.length === rightGroup.items.length &&
        leftGroup.items.every(
          (item, itemIndex) =>
            item.assetId === rightGroup.items[itemIndex]?.assetId,
        )
      );
    })
  );
}

type DatabaseClient = Pick<Pool | PoolClient, "query">;

async function loadSnapshot(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<WatchlistV2Snapshot> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        versions.record_version,
        versions.updated_at as version_updated_at,
        groups.group_key,
        groups.name as group_name,
        groups.position as group_position,
        items.asset_id,
        items.position as item_position
      from public.watchlist_versions as versions
      left join public.watchlist_groups as groups
        on groups.owner_user_id = versions.owner_user_id
      left join public.watchlist_items as items
        on items.owner_user_id = groups.owner_user_id
       and items.group_key = groups.group_key
       and items.asset_id is not null
      where versions.owner_user_id = $1
      order by groups.position asc nulls last, items.position asc nulls last
    `,
    values: [ownerUserId],
  });

  if (result.rows.length === 0) {
    return Object.freeze({
      version: 0,
      groups: Object.freeze([]),
      updatedAt: null,
    });
  }

  const rows = result.rows.map((row) => snapshotRowSchema.parse(row));
  const first = rows[0] ?? fail();
  const groups: { key: string; name: string; items: WatchlistV2Item[] }[] = [];

  for (const row of rows) {
    if (row.group_key === null) {
      continue;
    }
    if (row.group_name === null) {
      fail();
    }
    let group = groups.find((candidate) => candidate.key === row.group_key);
    if (group === undefined) {
      group = { key: row.group_key, name: row.group_name, items: [] };
      groups.push(group);
    }
    if (row.asset_id !== null) {
      if (!assetIdPattern.test(row.asset_id)) {
        fail();
      }
      group.items.push(Object.freeze({ assetId: row.asset_id }));
    }
  }

  return Object.freeze({
    version: first.record_version,
    groups: Object.freeze(
      groups.map((group) =>
        Object.freeze({
          key: group.key,
          name: group.name,
          items: Object.freeze(group.items),
        }),
      ),
    ),
    updatedAt:
      first.record_version === 0
        ? null
        : first.version_updated_at.toISOString(),
  });
}

function assertReplaceInput(input: ReplaceWatchlistV2Input): void {
  if (input.groups.length > watchlistV2MaximumGroups) {
    fail();
  }
  const groupKeys = new Set<string>();
  let itemCount = 0;
  for (const group of input.groups) {
    if (!groupKeyPattern.test(group.key) || groupKeys.has(group.key)) {
      fail();
    }
    groupKeys.add(group.key);
    const assetIds = new Set<string>();
    for (const item of group.items) {
      if (!assetIdPattern.test(item.assetId) || assetIds.has(item.assetId)) {
        fail();
      }
      assetIds.add(item.assetId);
      itemCount += 1;
    }
  }
  if (itemCount > watchlistV2MaximumItems) {
    fail();
  }
}

export function createPostgresWatchlistV2Repository(
  pool: Pool,
): WatchlistV2Repository {
  return Object.freeze({
    async get(ownerUserId: string): Promise<WatchlistV2Snapshot> {
      return loadSnapshot(pool, ownerUserId);
    },

    async replace(
      input: ReplaceWatchlistV2Input,
    ): Promise<WatchlistV2Snapshot> {
      assertReplaceInput(input);
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("begin");
        inTransaction = true;

        await client.query<Record<string, unknown>>({
          text: `
            insert into public.watchlist_versions (owner_user_id)
            values ($1)
            on conflict (owner_user_id) do nothing
          `,
          values: [input.ownerUserId],
        });
        const locked = await client.query<Record<string, unknown>>({
          text: `
            select record_version
            from public.watchlist_versions
            where owner_user_id = $1
            for update
          `,
          values: [input.ownerUserId],
        });
        if (locked.rows.length !== 1) {
          fail();
        }

        const current = await loadSnapshot(client, input.ownerUserId);
        if (watchlistV2GroupsEqual(current.groups, input.groups)) {
          await client.query("commit");
          inTransaction = false;
          return current;
        }
        if (input.expectedVersion !== current.version) {
          throw new WatchlistV2VersionConflictError();
        }

        // A V2 replacement owns the whole owner-level snapshot: legacy V1
        // rows in the same groups are replaced, not silently merged into a
        // second asset namespace.
        await client.query<Record<string, unknown>>({
          text: `delete from public.watchlist_groups where owner_user_id = $1`,
          values: [input.ownerUserId],
        });

        for (const [groupPosition, group] of input.groups.entries()) {
          await client.query<Record<string, unknown>>({
            text: `
              insert into public.watchlist_groups (
                owner_user_id, group_key, name, position
              )
              values ($1, $2, $3, $4)
            `,
            values: [input.ownerUserId, group.key, group.name, groupPosition],
          });
          for (const [itemPosition, item] of group.items.entries()) {
            await client.query<Record<string, unknown>>({
              text: `
                insert into public.watchlist_items (
                  owner_user_id, group_key, asset_key, asset_id, position
                )
                values ($1, $2, null, $3, $4)
              `,
              values: [
                input.ownerUserId,
                group.key,
                item.assetId,
                itemPosition,
              ],
            });
          }
        }

        const updated = await client.query<Record<string, unknown>>({
          text: `
            update public.watchlist_versions
            set record_version = record_version + 1,
                updated_at = clock_timestamp()
            where owner_user_id = $1 and record_version = $2
            returning record_version
          `,
          values: [input.ownerUserId, current.version],
        });
        if (updated.rows.length !== 1) {
          fail();
        }

        const snapshot = await loadSnapshot(client, input.ownerUserId);
        if (
          snapshot.version !== current.version + 1 ||
          !watchlistV2GroupsEqual(snapshot.groups, input.groups)
        ) {
          fail();
        }
        await client.query("commit");
        inTransaction = false;
        return snapshot;
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("rollback");
          } catch {
            // The original failure stays authoritative.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new WatchlistV2UnavailableError());
}

export function createUnavailableWatchlistV2Repository(): WatchlistV2Repository {
  return Object.freeze({ get: unavailable, replace: unavailable });
}
