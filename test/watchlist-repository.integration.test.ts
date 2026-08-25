import { randomUUID } from "node:crypto";

import pg, {
  type Pool as PgPool,
  type PoolClient,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WatchlistRepositoryUnavailableError,
  createPostgresWatchlistRepository,
  type WatchlistRepository,
} from "../src/database/watchlist-repository.js";
import {
  WatchlistVersionConflictError,
  parseWatchlistReplaceRequest,
  type WatchlistGroup,
} from "../src/features/watchlist/watchlist-contract.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const testPrivyPrefix = "watchlist-test:";
const pool = new Pool({ connectionString: databaseUrl });
let repository: WatchlistRepository;

function groups(
  rawGroups: readonly {
    readonly key: string;
    readonly name: string;
    readonly items: readonly { readonly asset_key: string }[];
  }[],
): readonly WatchlistGroup[] {
  return parseWatchlistReplaceRequest({
    expected_version: 0,
    groups: rawGroups,
  }).groups;
}

const firstGroups = groups([
  {
    key: "favorites",
    name: "Favorites",
    items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
  },
  {
    key: "alts",
    name: "山寨币",
    items: [{ asset_key: "SOL" }],
  },
]);

const secondGroups = groups([
  {
    key: "alts",
    name: "Alt coins",
    items: [{ asset_key: "SOL" }, { asset_key: "ETH" }],
  },
  {
    key: "favorites",
    name: "Favorites",
    items: [{ asset_key: "BTC" }],
  },
]);

async function cleanWatchlistFixtures(): Promise<void> {
  await pool.query({
    text: `
      delete from public.watchlist_versions
      where owner_user_id in (
        select id
        from public.loop_users
        where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `
      delete from public.loop_users
      where privy_user_id like $1
    `,
    values: [`${testPrivyPrefix}%`],
  });
}

async function createOwner(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`${testPrivyPrefix}${label}:${randomUUID()}`],
  });
  const ownerUserId = result.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Watchlist test owner setup failed");
  }
  return ownerUserId;
}

function faultOnItemInsertPool(basePool: PgPool): PgPool {
  return {
    async connect(): Promise<PoolClient> {
      const client = await basePool.connect();
      const guardedQuery = (
        query: string | QueryConfig<unknown[]>,
      ): Promise<QueryResult<QueryResultRow>> => {
        const text = typeof query === "string" ? query : query.text;
        if (text.includes("insert into public.watchlist_items")) {
          throw new Error("injected item insert failure");
        }
        return typeof query === "string"
          ? client.query<QueryResultRow>(query)
          : client.query<QueryResultRow, unknown[]>(query);
      };
      const partialClient: Pick<PoolClient, "query" | "release"> = {
        query: guardedQuery,
        release(error?: Error | boolean): void {
          client.release(error);
        },
      };
      return partialClient as unknown as PoolClient;
    },
  } as unknown as PgPool;
}

describe("PostgreSQL Watchlist repository", () => {
  beforeAll(() => {
    repository = createPostgresWatchlistRepository(pool);
  });

  beforeEach(async () => {
    await cleanWatchlistFixtures();
  });

  afterAll(async () => {
    await cleanWatchlistFixtures();
    await pool.end();
  });

  it("returns a version-zero default without creating a row", async () => {
    const ownerUserId = await createOwner("default");
    const snapshot = await repository.get(ownerUserId);
    const count = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.watchlist_versions
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });

    expect(snapshot).toEqual({ version: 0, groups: [], updated_at: null });
    expect(count.rows[0]?.count).toBe("0");
  });

  it("keeps an initial empty replacement as a no-write version-zero snapshot", async () => {
    const ownerUserId = await createOwner("empty-replacement");

    await expect(
      repository.replace({ ownerUserId, expectedVersion: 0, groups: [] }),
    ).resolves.toEqual({ version: 0, groups: [], updated_at: null });
    const count = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.watchlist_versions
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });
    expect(count.rows[0]?.count).toBe("0");
  });

  it("round-trips groups and items in server-derived positions", async () => {
    const ownerUserId = await createOwner("round-trip");
    const created = await repository.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: firstGroups,
    });
    const read = await repository.get(ownerUserId);
    const positions = await pool.query<{
      group_key: string;
      group_position: number;
      asset_key: string | null;
      item_position: number | null;
    }>({
      text: `
        select
          groups.group_key,
          groups.position as group_position,
          items.asset_key,
          items.position as item_position
        from public.watchlist_groups as groups
        left join public.watchlist_items as items
          on items.owner_user_id = groups.owner_user_id
         and items.group_key = groups.group_key
        where groups.owner_user_id = $1
        order by groups.position, items.position
      `,
      values: [ownerUserId],
    });

    expect(created).toMatchObject({ version: 1, groups: firstGroups });
    expect(created.updated_at).toEqual(expect.any(String));
    expect(read).toEqual(created);
    expect(positions.rows).toEqual([
      {
        group_key: "favorites",
        group_position: 0,
        asset_key: "ETH",
        item_position: 0,
      },
      {
        group_key: "favorites",
        group_position: 0,
        asset_key: "BTC",
        item_position: 1,
      },
      {
        group_key: "alts",
        group_position: 1,
        asset_key: "SOL",
        item_position: 0,
      },
    ]);

    const replaced = await repository.replace({
      ownerUserId,
      expectedVersion: 1,
      groups: secondGroups,
    });
    expect(replaced).toMatchObject({ version: 2, groups: secondGroups });
    expect(await repository.get(ownerUserId)).toEqual(replaced);

    const cleared = await repository.replace({
      ownerUserId,
      expectedVersion: 2,
      groups: [],
    });
    expect(cleared).toMatchObject({ version: 3, groups: [] });
    expect(cleared.updated_at).toEqual(expect.any(String));
  });

  it("returns an identical already-applied snapshot despite a stale expected version", async () => {
    const ownerUserId = await createOwner("retry");
    const created = await repository.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: firstGroups,
    });
    const replayed = await repository.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: firstGroups,
    });

    expect(replayed).toEqual(created);
    const version = await pool.query<{ record_version: number }>({
      text: `
        select record_version
        from public.watchlist_versions
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });
    expect(version.rows[0]?.record_version).toBe(1);
  });

  it("rejects a stale different replacement and preserves owner isolation", async () => {
    const ownerA = await createOwner("owner-a");
    const ownerB = await createOwner("owner-b");
    await repository.replace({
      ownerUserId: ownerA,
      expectedVersion: 0,
      groups: firstGroups,
    });

    await expect(
      repository.replace({
        ownerUserId: ownerA,
        expectedVersion: 0,
        groups: secondGroups,
      }),
    ).rejects.toBeInstanceOf(WatchlistVersionConflictError);
    expect(await repository.get(ownerA)).toMatchObject({
      version: 1,
      groups: firstGroups,
    });
    expect(await repository.get(ownerB)).toEqual({
      version: 0,
      groups: [],
      updated_at: null,
    });

    const ownerBState = await repository.replace({
      ownerUserId: ownerB,
      expectedVersion: 0,
      groups: secondGroups,
    });
    expect(ownerBState).toMatchObject({ version: 1, groups: secondGroups });
    expect(await repository.get(ownerA)).toMatchObject({ groups: firstGroups });
  });

  it("serializes concurrent different snapshots so exactly one wins", async () => {
    const ownerUserId = await createOwner("concurrent-different");
    const results = await Promise.allSettled([
      repository.replace({
        ownerUserId,
        expectedVersion: 0,
        groups: firstGroups,
      }),
      repository.replace({
        ownerUserId,
        expectedVersion: 0,
        groups: secondGroups,
      }),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<WatchlistRepository["replace"]>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.version).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WatchlistVersionConflictError);
    expect(await repository.get(ownerUserId)).toEqual(fulfilled[0]?.value);
  });

  it("coalesces concurrent identical first writes into one version", async () => {
    const ownerUserId = await createOwner("concurrent-identical");
    const [first, second] = await Promise.all([
      repository.replace({
        ownerUserId,
        expectedVersion: 0,
        groups: firstGroups,
      }),
      repository.replace({
        ownerUserId,
        expectedVersion: 0,
        groups: firstGroups,
      }),
    ]);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
  });

  it("rolls back delete and partial insert when replacement fails", async () => {
    const ownerUserId = await createOwner("rollback");
    const original = await repository.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: firstGroups,
    });
    const faultingRepository = createPostgresWatchlistRepository(
      faultOnItemInsertPool(pool),
    );

    await expect(
      faultingRepository.replace({
        ownerUserId,
        expectedVersion: 1,
        groups: secondGroups,
      }),
    ).rejects.toThrow("injected item insert failure");

    expect(await repository.get(ownerUserId)).toEqual(original);
  });

  it("fails closed for malformed inputs and non-contiguous stored positions", async () => {
    await expect(
      repository.get("client-selected-owner"),
    ).rejects.toBeInstanceOf(WatchlistRepositoryUnavailableError);

    const ownerUserId = await createOwner("strict-rows");
    await repository.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: firstGroups,
    });
    await pool.query({
      text: `
        update public.watchlist_items
        set position = 2
        where owner_user_id = $1
          and group_key = 'favorites'
          and asset_key = 'BTC'
      `,
      values: [ownerUserId],
    });

    await expect(repository.get(ownerUserId)).rejects.toBeInstanceOf(
      WatchlistRepositoryUnavailableError,
    );
  });
});
