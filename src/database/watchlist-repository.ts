import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import {
  InvalidWatchlistContractError,
  WatchlistVersionConflictError,
  emptyWatchlistSnapshot,
  parseWatchlistReplaceRequest,
  parseWatchlistSnapshot,
  watchlistGroupsEqual,
  type WatchlistGroup,
  type WatchlistSnapshot,
} from "../features/watchlist/watchlist-contract.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ownerUserIdSchema = z.string().regex(uuidPattern);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const lockRowSchema = z
  .object({ record_version: z.number().int().min(0) })
  .strict();
const updatedVersionRowSchema = z
  .object({
    record_version: z.number().int().min(1),
    updated_at: validDateSchema,
  })
  .strict();
const snapshotRowSchema = z
  .object({
    record_version: z.number().int().min(0),
    version_updated_at: validDateSchema,
    group_key: z.string().nullable(),
    group_name: z.string().nullable(),
    group_position: z.number().int().min(0).nullable(),
    asset_key: z.string().nullable(),
    item_position: z.number().int().min(0).nullable(),
  })
  .strict()
  .refine((row) => {
    const hasGroup = row.group_key !== null;
    const groupColumnsAgree =
      hasGroup === (row.group_name !== null) &&
      hasGroup === (row.group_position !== null);
    const itemColumnsAgree =
      (row.asset_key === null) === (row.item_position === null);
    return (
      groupColumnsAgree &&
      itemColumnsAgree &&
      (hasGroup || row.asset_key === null)
    );
  });

export interface ReplaceWatchlistRepositoryInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly groups: readonly WatchlistGroup[];
}

export interface WatchlistRepository {
  get(ownerUserId: string): Promise<WatchlistSnapshot>;
  replace(input: ReplaceWatchlistRepositoryInput): Promise<WatchlistSnapshot>;
}

export class WatchlistRepositoryUnavailableError extends Error {
  readonly code = "watchlist_unavailable";

  constructor() {
    super("The Watchlist repository is unavailable");
    this.name = "WatchlistRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new WatchlistRepositoryUnavailableError());
}

export function createUnavailableWatchlistRepository(): WatchlistRepository {
  return Object.freeze({ get: unavailable, replace: unavailable });
}

type DatabaseClient = Pick<Pool | PoolClient, "query">;

function failUnavailable(): never {
  throw new WatchlistRepositoryUnavailableError();
}

function parseOwnerUserId(value: string): string {
  const parsed = ownerUserIdSchema.safeParse(value);
  return parsed.success ? parsed.data : failUnavailable();
}

function parseReplaceInput(
  input: ReplaceWatchlistRepositoryInput,
): ReplaceWatchlistRepositoryInput {
  try {
    const ownerUserId = parseOwnerUserId(input.ownerUserId);
    const request = parseWatchlistReplaceRequest({
      expected_version: input.expectedVersion,
      groups: input.groups,
    });
    return Object.freeze({
      ownerUserId,
      expectedVersion: request.expected_version,
      groups: request.groups,
    });
  } catch (error) {
    if (error instanceof WatchlistRepositoryUnavailableError) {
      throw error;
    }
    if (error instanceof InvalidWatchlistContractError) {
      return failUnavailable();
    }
    return failUnavailable();
  }
}

function parseRows<Row extends QueryResultRow>(
  rows: readonly Row[],
): readonly z.output<typeof snapshotRowSchema>[] {
  try {
    return rows.map((row) => snapshotRowSchema.parse(row));
  } catch {
    return failUnavailable();
  }
}

async function loadSnapshot(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<WatchlistSnapshot> {
  const result = await client.query({
    text: `
      select
        versions.record_version,
        versions.updated_at as version_updated_at,
        groups.group_key,
        groups.name as group_name,
        groups.position as group_position,
        items.asset_key,
        items.position as item_position
      from public.watchlist_versions as versions
      left join public.watchlist_groups as groups
        on groups.owner_user_id = versions.owner_user_id
      left join public.watchlist_items as items
        on items.owner_user_id = groups.owner_user_id
       and items.group_key = groups.group_key
      where versions.owner_user_id = $1
      order by groups.position asc nulls last, items.position asc nulls last
    `,
    values: [ownerUserId],
  });

  if (result.rows.length === 0) {
    return emptyWatchlistSnapshot();
  }

  const rows = parseRows(result.rows);
  const first = rows[0];
  if (first === undefined) {
    return failUnavailable();
  }

  const versionTimestamp = first.version_updated_at.getTime();
  if (
    rows.some(
      (row) =>
        row.record_version !== first.record_version ||
        row.version_updated_at.getTime() !== versionTimestamp,
    )
  ) {
    return failUnavailable();
  }

  const groups: {
    key: string;
    name: string;
    items: { asset_key: string }[];
  }[] = [];
  let currentGroup:
    { key: string; name: string; items: { asset_key: string }[] } | undefined;

  for (const row of rows) {
    if (row.group_key === null) {
      if (rows.length !== 1 || groups.length !== 0) {
        return failUnavailable();
      }
      continue;
    }

    if (row.group_name === null || row.group_position === null) {
      return failUnavailable();
    }

    if (currentGroup?.key !== row.group_key) {
      if (row.group_position !== groups.length) {
        return failUnavailable();
      }
      currentGroup = {
        key: row.group_key,
        name: row.group_name,
        items: [],
      };
      groups.push(currentGroup);
    } else if (
      currentGroup.name !== row.group_name ||
      row.group_position !== groups.length - 1
    ) {
      return failUnavailable();
    }

    if (row.asset_key !== null) {
      if (
        row.item_position === null ||
        row.item_position !== currentGroup.items.length
      ) {
        return failUnavailable();
      }
      currentGroup.items.push({ asset_key: row.asset_key });
    }
  }

  try {
    return parseWatchlistSnapshot({
      version: first.record_version,
      groups,
      updated_at:
        first.record_version === 0
          ? null
          : first.version_updated_at.toISOString(),
    });
  } catch {
    return failUnavailable();
  }
}

async function lockVersionRow(
  client: PoolClient,
  ownerUserId: string,
): Promise<boolean> {
  const result = await client.query({
    text: `
      select record_version
      from public.watchlist_versions
      where owner_user_id = $1
      for update
    `,
    values: [ownerUserId],
  });

  if (result.rows.length === 0) {
    return false;
  }
  if (result.rows.length !== 1) {
    return failUnavailable();
  }
  try {
    lockRowSchema.parse(result.rows[0]);
    return true;
  } catch {
    return failUnavailable();
  }
}

async function ensureLockedVersionRow(
  client: PoolClient,
  ownerUserId: string,
): Promise<void> {
  await client.query({
    text: `
      insert into public.watchlist_versions (owner_user_id)
      values ($1)
      on conflict (owner_user_id) do nothing
    `,
    values: [ownerUserId],
  });

  if (!(await lockVersionRow(client, ownerUserId))) {
    return failUnavailable();
  }
}

async function insertSnapshotRows(
  client: PoolClient,
  ownerUserId: string,
  groups: readonly WatchlistGroup[],
): Promise<void> {
  for (const [groupPosition, group] of groups.entries()) {
    await client.query({
      text: `
        insert into public.watchlist_groups (
          owner_user_id,
          group_key,
          name,
          position
        )
        values ($1, $2, $3, $4)
      `,
      values: [ownerUserId, group.key, group.name, groupPosition],
    });

    for (const [itemPosition, item] of group.items.entries()) {
      await client.query({
        text: `
          insert into public.watchlist_items (
            owner_user_id,
            group_key,
            asset_key,
            position
          )
          values ($1, $2, $3, $4)
        `,
        values: [ownerUserId, group.key, item.asset_key, itemPosition],
      });
    }
  }
}

export function createPostgresWatchlistRepository(
  pool: Pool,
): WatchlistRepository {
  return Object.freeze({
    async get(rawOwnerUserId: string): Promise<WatchlistSnapshot> {
      const ownerUserId = parseOwnerUserId(rawOwnerUserId);
      return loadSnapshot(pool, ownerUserId);
    },

    async replace(
      rawInput: ReplaceWatchlistRepositoryInput,
    ): Promise<WatchlistSnapshot> {
      const input = parseReplaceInput(rawInput);
      const client = await pool.connect();
      let inTransaction = false;

      try {
        await client.query("begin");
        inTransaction = true;

        const rowExists = await lockVersionRow(client, input.ownerUserId);
        if (!rowExists && input.groups.length === 0) {
          await client.query("commit");
          inTransaction = false;
          return emptyWatchlistSnapshot();
        }
        if (!rowExists) {
          await ensureLockedVersionRow(client, input.ownerUserId);
        }

        const current = await loadSnapshot(client, input.ownerUserId);
        if (watchlistGroupsEqual(current.groups, input.groups)) {
          await client.query("commit");
          inTransaction = false;
          return current;
        }

        if (input.expectedVersion !== current.version) {
          throw new WatchlistVersionConflictError();
        }

        await client.query({
          text: `
            delete from public.watchlist_groups
            where owner_user_id = $1
          `,
          values: [input.ownerUserId],
        });
        await insertSnapshotRows(client, input.ownerUserId, input.groups);

        const updated = await client.query({
          text: `
            update public.watchlist_versions
            set
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where owner_user_id = $1
              and record_version = $2
            returning record_version, updated_at
          `,
          values: [input.ownerUserId, current.version],
        });
        if (updated.rows.length !== 1) {
          return failUnavailable();
        }
        try {
          updatedVersionRowSchema.parse(updated.rows[0]);
        } catch {
          return failUnavailable();
        }

        const snapshot = await loadSnapshot(client, input.ownerUserId);
        if (
          snapshot.version !== current.version + 1 ||
          !watchlistGroupsEqual(snapshot.groups, input.groups)
        ) {
          return failUnavailable();
        }

        await client.query("commit");
        inTransaction = false;
        return snapshot;
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("rollback");
          } catch {
            // The original failure remains authoritative and the connection is released.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
