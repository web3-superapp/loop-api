import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AlertIdempotencyConflictError,
  AlertVersionConflictError,
  createPostgresAlertRepository,
  type AlertRepository,
} from "../src/database/alert-repository.js";
import {
  createPostgresAlertV2Repository,
  type AlertV2Repository,
} from "../src/database/alert-v2-repository.js";
import {
  createPostgresBscIndexerRepository,
  type BscIndexerRepository,
  type IndexedPoolEventInput,
} from "../src/database/bsc-indexer-repository.js";
import {
  createPostgresChainRegistryRepository,
  type ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import {
  createPostgresMarketFactCacheRepository,
  type MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import {
  createPostgresNotificationRepository,
  type NotificationRepository,
} from "../src/database/notification-repository.js";
import { defaultNotificationPreferences } from "../src/features/alerts/notification-contract.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();

const pool = new Pool({ connectionString: databaseUrl });
const testPrivyPrefix = "market-alerts-repository-test:";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const wbnbAssetId = `eip155:56:${wbnb}`;
const usdtAssetId = `eip155:56:${usdt}`;
const poolAddress = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const q96 = 2n ** 96n;

let registry: ChainRegistryRepository;
let indexer: BscIndexerRepository;
let facts: MarketFactCacheRepository;
let alertsV2: AlertV2Repository;
let alertsV1: AlertRepository;
let notifications: NotificationRepository;

async function cleanFixtures(): Promise<void> {
  const owners = `select id from public.loop_users where privy_user_id like $1`;
  await pool.query({
    text: `delete from public.notifications where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.notification_preference_v2_versions where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  // price_alert_events is append-only by trigger; the test fixture is the
  // only writer that may unwind its own rows.
  await pool.query(
    `alter table public.price_alert_events disable trigger price_alert_events_append_only`,
  );
  await pool.query({
    text: `delete from public.price_alert_events where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `alter table public.price_alert_events enable trigger price_alert_events_append_only`,
  );
  await pool.query({
    text: `delete from public.price_alert_definitions where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.idempotency_records where owner_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.communities where created_by_user_id in (${owners})`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query(
    `delete from public.indexer_checkpoints where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_pool_events where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_approvals where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_transfers where chain_id = 'eip155:56'`,
  );
  await pool.query({
    text: `delete from public.market_fact_cache where subject_key = any($1::text[])`,
    values: [[`token:${wbnb}`, "chain:eip155:56"]],
  });
  await pool.query({
    text: `delete from public.pools where chain_id = 'eip155:56' and address = $1`,
    values: [poolAddress],
  });
  await pool.query({
    text: `delete from public.assets where asset_id = any($1::text[])`,
    values: [[wbnbAssetId, usdtAssetId]],
  });
}

async function createOwner(): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
    values: [`${testPrivyPrefix}${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("owner setup failed");
  }
  return id;
}

async function seedPool(): Promise<string> {
  for (const [assetId, address, symbol, name] of [
    [wbnbAssetId, wbnb, "WBNB", "Wrapped BNB"],
    [usdtAssetId, usdt, "USDT", "Tether USD"],
  ] as const) {
    await registry.upsertAsset({
      assetId,
      chainId: bscChainId,
      address,
      symbol,
      name,
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "120000000",
    });
  }
  const record = await registry.upsertPool({
    chainId: bscChainId,
    address: poolAddress,
    token0AssetId: usdtAssetId,
    token1AssetId: wbnbAssetId,
    fee: 500,
    tickSpacing: 10,
    sourceBlockNumber: "120000000",
  });
  return record.poolId;
}

function swap(
  poolId: string,
  blockNumber: number,
  logIndex: number,
  timestamp: string,
  sqrt: bigint,
  amountWbnb: string,
): IndexedPoolEventInput {
  return {
    transactionHash: `0x${blockNumber.toString(16).padStart(63, "0")}${String(logIndex)}`,
    logIndex,
    blockNumber: String(blockNumber),
    blockHash: `0x${"a".repeat(64)}`,
    blockTimestamp: timestamp,
    poolId,
    eventKind: "swap",
    payload: {
      amount0: "1",
      amount1: amountWbnb,
      sqrtPriceX96: sqrt.toString(10),
    },
    amount0: "1",
    amount1: amountWbnb,
    sqrtPriceX96: sqrt.toString(10),
  };
}

const checkpoint = {
  lastBlockNumber: "120000100",
  lastBlockHash: `0x${"b".repeat(64)}`,
  startedFromBlockNumber: "120000000",
};

describe("PostgreSQL market facts, pool lane, V2 alerts, and notifications", () => {
  beforeAll(() => {
    registry = createPostgresChainRegistryRepository(pool);
    indexer = createPostgresBscIndexerRepository(pool);
    facts = createPostgresMarketFactCacheRepository(pool);
    alertsV2 = createPostgresAlertV2Repository(pool);
    alertsV1 = createPostgresAlertRepository(pool);
    notifications = createPostgresNotificationRepository(pool);
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("enforces the migration invariants", async () => {
    const owner = await createOwner();
    await expect(
      pool.query({
        text: `insert into public.notification_preference_v2_versions (owner_user_id) values ($1)`,
        values: [owner],
      }),
    ).resolves.toBeDefined();
    await expect(
      pool.query({
        text: `insert into public.notification_preferences_v2 (owner_user_id, category, enabled) values ($1, 'security.event', false)`,
        values: [owner],
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query({
        text: `
          insert into public.notifications (owner_user_id, type, entity_ref, context_route, payload, dedupe_key)
          values ($1, 'unknown.kind', 'priceAlert:x', 'token', '{}'::jsonb, 'k')
        `,
        values: [owner],
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`
        insert into public.indexed_pool_events (
          chain_id, transaction_hash, log_index, block_number, block_hash, pool_id, event_kind, payload
        )
        values ('eip155:56', '0x${"1".repeat(64)}', 0, 1, '0x${"2".repeat(64)}', gen_random_uuid(), 'swap', '{}'::jsonb)
      `),
    ).rejects.toMatchObject({ code: "23514" });
    const digest = await pool.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint where conname = 'idempotency_records_digest_version_check'
    `);
    expect(String(digest.rows[0]?.definition)).toContain(
      "price_alert_create_v2",
    );
  });

  it("stores and re-reads a Provider fact with its digest and resolves the bound community", async () => {
    await seedPool();
    const stored = await facts.put({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: { tokenAddress: wbnb, pairs: [{ priceUsd: "747.39" }] },
      rawDigest: "a".repeat(64),
      fetchedAt: "2026-09-08T00:00:00.000Z",
      ttlSeconds: 30,
    });
    expect(stored.value).toEqual({
      tokenAddress: wbnb,
      pairs: [{ priceUsd: "747.39" }],
    });
    const updated = await facts.put({
      ...stored,
      rawDigest: "b".repeat(64),
      ttlSeconds: 60,
    });
    expect(updated.rawDigest).toBe("b".repeat(64));
    expect(
      await facts.get(`token:${wbnb}`, "token_pairs", "dexscreener"),
    ).toMatchObject({
      ttlSeconds: 60,
      fetchedAt: "2026-09-08T00:00:00.000Z",
    });
    expect(
      await facts.get(`token:${wbnb}`, "token_pairs", "goplus"),
    ).toBeNull();

    const owner = await createOwner();
    await pool.query({
      text: `
        insert into public.communities (
          name, slug, verification_status, verified_at, reviewed_at, bound_asset_key, created_by_user_id, member_count
        )
        values ('WBNB Holders', $1, 'verified', clock_timestamp(), clock_timestamp(), $2, $3, 12)
      `,
      values: [`wbnb-${randomUUID().slice(0, 8)}`, wbnbAssetId, owner],
    });
    expect(
      await facts.findVerifiedCommunityByAssetId(wbnbAssetId),
    ).toMatchObject({
      name: "WBNB Holders",
      memberCount: 12,
      verificationStatus: "verified",
    });
    expect(await facts.findVerifiedCommunityByAssetId(usdtAssetId)).toBeNull();
  });

  it("commits pool events with their own checkpoint, aggregates candles, and rewinds only its own lane", async () => {
    const poolId = await seedPool();
    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [
        {
          transactionHash: `0x${"9".repeat(64)}`,
          logIndex: 0,
          blockNumber: "120000050",
          blockHash: `0x${"a".repeat(64)}`,
          assetId: wbnbAssetId,
          fromAddress: "0x00000000000000000000000000000000000000a1",
          toAddress: "0x00000000000000000000000000000000000000b2",
          rawValue: "1",
        },
      ],
      checkpoint,
    });
    const committed = await indexer.commitPoolEventSegment({
      chainId: bscChainId,
      events: [
        swap(
          poolId,
          120_000_010,
          0,
          "2026-09-08T00:10:00.000Z",
          q96 * 2n,
          "-1000000000000000000",
        ),
        swap(
          poolId,
          120_000_020,
          1,
          "2026-09-08T00:20:00.000Z",
          q96 * 4n,
          "500000000000000000",
        ),
        swap(
          poolId,
          120_000_030,
          0,
          "2026-09-08T00:59:00.000Z",
          q96,
          "-250000000000000000",
        ),
        swap(
          poolId,
          120_000_040,
          0,
          "2026-09-08T01:05:00.000Z",
          q96 * 3n,
          "1000000000000000000",
        ),
        {
          ...swap(poolId, 120_000_041, 0, "2026-09-08T01:06:00.000Z", q96, "1"),
          eventKind: "mint",
          amount0: "10",
          amount1: "10",
          sqrtPriceX96: null,
          payload: { amount0: "10", amount1: "10" },
        },
      ],
      checkpoint,
    });
    expect(committed.lastBlockNumber).toBe("120000100");
    expect(await indexer.getCheckpoint("pool_event", bscChainId)).toMatchObject(
      { reorgCount: 0 },
    );
    expect(
      await indexer.getCheckpoint("erc20_transfer", bscChainId),
    ).toMatchObject({ reorgCount: 0 });

    const page = await indexer.listPoolSwaps({ poolIds: [poolId], limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.items.map((item) => item.blockNumber)).toEqual([
      "120000040",
      "120000030",
    ]);
    const next = await indexer.listPoolSwaps({
      poolIds: [poolId],
      limit: 2,
      beforeBlockNumber: "120000030",
      beforeLogIndex: 0,
    });
    expect(next.items.map((item) => item.blockNumber)).toEqual([
      "120000020",
      "120000010",
    ]);
    expect(next.items[0]?.amount1).toBe("500000000000000000");

    const buckets = await indexer.aggregateSwapCandles({
      poolId,
      intervalSeconds: 3_600,
      assetIsToken0: false,
      fromTimestamp: "2026-09-08T00:00:00.000Z",
      toTimestamp: "2026-09-08T02:00:00.000Z",
    });
    expect(buckets).toEqual([
      {
        bucketStart: "2026-09-08T00:00:00.000Z",
        openSqrtPriceX96: (q96 * 2n).toString(10),
        closeSqrtPriceX96: q96.toString(10),
        highSqrtPriceX96: (q96 * 4n).toString(10),
        lowSqrtPriceX96: q96.toString(10),
        volumeRaw: "1750000000000000000",
        swapCount: 3,
      },
      {
        bucketStart: "2026-09-08T01:00:00.000Z",
        openSqrtPriceX96: (q96 * 3n).toString(10),
        closeSqrtPriceX96: (q96 * 3n).toString(10),
        highSqrtPriceX96: (q96 * 3n).toString(10),
        lowSqrtPriceX96: (q96 * 3n).toString(10),
        volumeRaw: "1000000000000000000",
        swapCount: 1,
      },
    ]);

    // Reorg rewind of the pool lane from block 120000030.
    const rewound = await indexer.commitPoolEventSegment({
      chainId: bscChainId,
      events: [
        swap(
          poolId,
          120_000_030,
          0,
          "2026-09-08T00:59:00.000Z",
          q96,
          "-250000000000000000",
        ),
      ],
      checkpoint: { ...checkpoint, lastBlockHash: `0x${"c".repeat(64)}` },
      rewindFromBlockNumber: "120000030",
    });
    expect(rewound.reorgCount).toBe(1);
    const rows = await pool.query<{ block_number: string; removed: boolean }>(
      `select block_number::text as block_number, removed from public.indexed_pool_events order by block_number`,
    );
    expect(rows.rows).toEqual([
      { block_number: "120000010", removed: false },
      { block_number: "120000020", removed: false },
      { block_number: "120000030", removed: false },
      { block_number: "120000040", removed: true },
      { block_number: "120000041", removed: true },
    ]);
    const transfers = await pool.query<{ removed: boolean }>(
      `select removed from public.indexed_transfers where chain_id = 'eip155:56'`,
    );
    expect(transfers.rows).toEqual([{ removed: false }]);
    expect(
      await indexer.getCheckpoint("erc20_transfer", bscChainId),
    ).toMatchObject({
      reorgCount: 0,
      lastBlockHash: checkpoint.lastBlockHash,
    });
    const afterRewind = await indexer.aggregateSwapCandles({
      poolId,
      intervalSeconds: 3_600,
      assetIsToken0: false,
      fromTimestamp: "2026-09-08T00:00:00.000Z",
      toTimestamp: "2026-09-08T02:00:00.000Z",
    });
    expect(afterRewind).toHaveLength(1);
  });

  it("creates V2 alerts idempotently in their own namespace and records a trigger with its notification", async () => {
    await seedPool();
    const owner = await createOwner();
    const key = randomUUID();
    const definition = {
      assetId: wbnbAssetId,
      condition: "at_or_above" as const,
      threshold: "700",
      expiresAt: null,
    };
    const created = await alertsV2.create({
      ownerUserId: owner,
      idempotencyKey: key,
      requestSha256: "1".repeat(64),
      definition,
    });
    expect(created.created).toBe(true);
    expect(created.alert).toMatchObject({
      state: "active",
      recordVersion: 1,
      assetId: wbnbAssetId,
    });
    const replay = await alertsV2.create({
      ownerUserId: owner,
      idempotencyKey: key,
      requestSha256: "1".repeat(64),
      definition,
    });
    expect(replay.created).toBe(false);
    expect(replay.alert.alertId).toBe(created.alert.alertId);
    await expect(
      alertsV2.create({
        ownerUserId: owner,
        idempotencyKey: key,
        requestSha256: "2".repeat(64),
        definition: { ...definition, threshold: "800" },
      }),
    ).rejects.toBeInstanceOf(AlertIdempotencyConflictError);

    // The frozen V1 surface never sees a V2 row.
    const v1 = await alertsV1.listOwned({
      ownerUserId: owner,
      limit: 10,
      offset: 0,
    });
    expect(v1.records).toEqual([]);
    expect(await alertsV1.findOwned(owner, created.alert.alertId)).toBeNull();

    const evaluable = await alertsV2.listEvaluable({
      limit: 10,
      excludeIds: [],
    });
    expect(evaluable.map((alert) => alert.alertId)).toContain(
      created.alert.alertId,
    );
    expect(
      (
        await alertsV2.listEvaluable({
          limit: 10,
          excludeIds: [created.alert.alertId],
        })
      ).map((alert) => alert.alertId),
    ).not.toContain(created.alert.alertId);
    await alertsV2.markEvaluated(
      [created.alert.alertId],
      "2026-09-08T00:00:01.000Z",
    );
    expect(
      await alertsV2.findOwned(owner, created.alert.alertId),
    ).toMatchObject({
      lastEvaluatedAt: "2026-09-08T00:00:01.000Z",
    });

    const trigger = await alertsV2.recordTrigger({
      alertId: created.alert.alertId,
      ownerUserId: owner,
      valueDecimal: "747.39",
      source: "dexscreener",
      sourceFactRef: "dexscreener:0x172fcd41e0913e95784454622d1c3724f546f849",
      observedAt: "2026-09-08T00:00:02.000Z",
      notification: {
        type: "trade.priceAlert",
        entityRef: `priceAlert:${created.alert.alertId}`,
        contextRoute: "token",
        contextParams: { assetId: wbnbAssetId },
        payload: { observedValue: "747.39", source: "dexscreener" },
        dedupeKey: `trade.priceAlert:${created.alert.alertId}:1`,
      },
    });
    expect(trigger.outcome).toBe("triggered");
    expect(trigger.notificationId).not.toBeNull();
    expect(
      await alertsV2.findOwned(owner, created.alert.alertId),
    ).toMatchObject({
      state: "triggered",
      recordVersion: 2,
    });
    const again = await alertsV2.recordTrigger({
      alertId: created.alert.alertId,
      ownerUserId: owner,
      valueDecimal: "748",
      source: "dexscreener",
      sourceFactRef: "dexscreener:x",
      observedAt: "2026-09-08T00:00:03.000Z",
      notification: null,
    });
    expect(again).toEqual({
      outcome: "already_triggered",
      eventId: null,
      notificationId: null,
    });
    const events = await pool.query<{
      asset_id: string;
      asset_key: string | null;
    }>({
      text: `select asset_id, asset_key from public.price_alert_events where owner_user_id = $1`,
      values: [owner],
    });
    expect(events.rows).toEqual([{ asset_id: wbnbAssetId, asset_key: null }]);
    expect(
      (await alertsV1.listHistory({ ownerUserId: owner, limit: 10, offset: 0 }))
        .records,
    ).toEqual([]);

    // Re-arm, then a repeat inside the dedupe window collapses the notification.
    const rearmed = await alertsV2.replaceOwned({
      ownerUserId: owner,
      alertId: created.alert.alertId,
      expectedVersion: 2,
      definition: { ...definition, threshold: "710" },
    });
    expect(rearmed).toMatchObject({
      state: "active",
      triggeredAt: null,
      recordVersion: 3,
    });
    await expect(
      alertsV2.replaceOwned({
        ownerUserId: owner,
        alertId: created.alert.alertId,
        expectedVersion: 2,
        definition: { ...definition, threshold: "720" },
      }),
    ).rejects.toBeInstanceOf(AlertVersionConflictError);
    const repeated = await alertsV2.recordTrigger({
      alertId: created.alert.alertId,
      ownerUserId: owner,
      valueDecimal: "749",
      source: "dexscreener",
      sourceFactRef: "dexscreener:x",
      observedAt: "2026-09-08T00:00:04.000Z",
      notification: {
        type: "trade.priceAlert",
        entityRef: `priceAlert:${created.alert.alertId}`,
        contextRoute: "token",
        contextParams: { assetId: wbnbAssetId },
        payload: { observedValue: "749" },
        dedupeKey: `trade.priceAlert:${created.alert.alertId}:1`,
      },
    });
    expect(repeated.outcome).toBe("triggered");
    expect(repeated.notificationId).toBeNull();

    const feed = await notifications.listFeed({
      ownerUserId: owner,
      limit: 10,
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.unreadCount).toBe(1);
    expect(feed.items[0]).toMatchObject({
      type: "trade.priceAlert",
      contextRoute: "token",
      contextParams: { assetId: wbnbAssetId },
      payload: { observedValue: "747.39", source: "dexscreener" },
      source: "dexscreener",
      observedAt: "2026-09-08T00:00:02.000Z",
      readAt: null,
    });
    const read = await notifications.markRead(
      owner,
      feed.items[0]?.notificationId ?? "",
    );
    expect(read?.readAt).not.toBeNull();
    const readAgain = await notifications.markRead(
      owner,
      feed.items[0]?.notificationId ?? "",
    );
    expect(readAgain?.readAt).toBe(read?.readAt);
    expect(
      (await notifications.listFeed({ ownerUserId: owner, limit: 10 }))
        .unreadCount,
    ).toBe(0);
    expect(
      await notifications.markRead(
        await createOwner(),
        feed.items[0]?.notificationId ?? "",
      ),
    ).toBeNull();

    expect(
      await alertsV2.softDeleteOwned({
        ownerUserId: owner,
        alertId: created.alert.alertId,
        expectedVersion: 4,
      }),
    ).toBe(true);
    expect(await alertsV2.findOwned(owner, created.alert.alertId)).toBeNull();
  });

  it("compare-and-swaps the nine optional preferences and never stores security.event", async () => {
    const owner = await createOwner();
    const initial = await notifications.getPreferences(owner);
    expect(initial).toEqual({
      recordVersion: 0,
      updatedAt: null,
      values: defaultNotificationPreferences,
    });
    expect(
      await notifications.isCategoryEnabled(owner, "trade.priceAlert"),
    ).toBe(true);
    expect(await notifications.isCategoryEnabled(owner, "community.all")).toBe(
      false,
    );

    const values = {
      ...defaultNotificationPreferences,
      "trade.priceAlert": false,
      "community.all": true,
    };
    const replaced = await notifications.replacePreferences({
      ownerUserId: owner,
      expectedVersion: 0,
      values,
    });
    expect(replaced.recordVersion).toBe(1);
    expect(replaced.values).toEqual(values);
    expect(
      await notifications.isCategoryEnabled(owner, "trade.priceAlert"),
    ).toBe(false);
    const identical = await notifications.replacePreferences({
      ownerUserId: owner,
      expectedVersion: 7,
      values,
    });
    expect(identical.recordVersion).toBe(1);
    await expect(
      notifications.replacePreferences({
        ownerUserId: owner,
        expectedVersion: 0,
        values: { ...values, "mining.weight": false },
      }),
    ).rejects.toBeInstanceOf(AlertVersionConflictError);
    const stored = await pool.query<{ category: string }>({
      text: `select category from public.notification_preferences_v2 where owner_user_id = $1 order by category`,
      values: [owner],
    });
    expect(stored.rows.map((row) => row.category)).not.toContain(
      "security.event",
    );
    expect(stored.rows).toHaveLength(9);
  });
});
