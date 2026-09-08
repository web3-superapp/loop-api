import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AccountWalletNotFoundError,
  AccountWalletObservationEmptyError,
  AccountWalletVersionConflictError,
  createPostgresAccountWalletRepository,
  type AccountWalletRepository,
} from "../src/database/account-wallet-repository.js";
import {
  createPostgresBscIndexerRepository,
  indexedTransferInsertBatchSize,
  type BscIndexerRepository,
} from "../src/database/bsc-indexer-repository.js";
import {
  createPostgresChainRegistryRepository,
  type ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import {
  createPostgresWatchlistV2Repository,
  WatchlistV2VersionConflictError,
  type WatchlistV2Repository,
} from "../src/database/watchlist-v2-repository.js";
import { createPostgresWatchlistRepository } from "../src/database/watchlist-repository.js";
import {
  parseWatchlistReplaceRequest,
  WatchlistVersionConflictError,
} from "../src/features/watchlist/watchlist-contract.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const pool = new Pool({ connectionString: databaseUrl });
const testPrivyPrefix = "chain-wallet-repository-test:";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const usd1 = "0x00000000000000000000000000000000000000d4";
const usd1AssetId = `eip155:56:${usd1}`;
const walletA = "0x00000000000000000000000000000000000000a1";
const walletB = "0x00000000000000000000000000000000000000b2";
const counterparty = "0x00000000000000000000000000000000000000c3";

let registry: ChainRegistryRepository;
let wallets: AccountWalletRepository;
let indexer: BscIndexerRepository;
let watchlistV2: WatchlistV2Repository;

async function cleanFixtures(): Promise<void> {
  await pool.query(
    `delete from public.indexer_checkpoints where chain_id = 'eip155:56'`,
  );
  await pool.query(
    `delete from public.indexed_transfers where chain_id = 'eip155:56'`,
  );
  await pool.query({
    text: `
      delete from public.wallet_balance_snapshots
      where wallet_id in (
        select wallet_id from public.account_wallets
        where owner_user_id in (
          select id from public.loop_users where privy_user_id like $1
        )
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `
      delete from public.watchlist_versions
      where owner_user_id in (
        select id from public.loop_users where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `
      delete from public.account_wallets
      where owner_user_id in (
        select id from public.loop_users where privy_user_id like $1
      )
    `,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.loop_users where privy_user_id like $1`,
    values: [`${testPrivyPrefix}%`],
  });
  await pool.query({
    text: `delete from public.assets where asset_id = any($1::text[])`,
    values: [[wbnbAssetId, usd1AssetId]],
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

describe("PostgreSQL chain registry, wallet, indexer, and V2 watchlist", () => {
  beforeAll(() => {
    registry = createPostgresChainRegistryRepository(pool);
    wallets = createPostgresAccountWalletRepository(pool);
    indexer = createPostgresBscIndexerRepository(pool);
    watchlistV2 = createPostgresWatchlistV2Repository(pool);
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("upserts an asset and keeps its on-chain observation block", async () => {
    const created = await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });
    expect(created).toMatchObject({
      assetId: wbnbAssetId,
      symbol: "WBNB",
      decimals: 18,
      status: "pending",
      sourceKind: "chain_call",
      sourceBlockNumber: "43000000",
    });

    const updated = await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB Token",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000500",
    });
    expect(updated.sourceBlockNumber).toBe("43000500");

    await expect(registry.getAsset(wbnbAssetId)).resolves.toMatchObject({
      name: "Wrapped BNB Token",
    });
    const readable = await registry.listReadableAssets(bscChainId);
    expect(readable.map((asset) => asset.assetId)).toContain(
      "eip155:56:native",
    );
    expect(readable.map((asset) => asset.assetId)).toContain(wbnbAssetId);
  });

  it("projects the Privy inventory, archives removed wallets, and keeps one active", async () => {
    const ownerUserId = await createOwner();
    const first = await wallets.sync({
      ownerUserId,
      observed: [
        { address: walletA, kind: "embedded", providerWalletId: "wallet_1" },
        { address: walletB, kind: "external", providerWalletId: null },
      ],
    });
    expect(first).toHaveLength(2);
    expect(first.filter((wallet) => wallet.isActive)).toHaveLength(1);
    const active = first.find((wallet) => wallet.isActive);
    expect(active?.kind).toBe("embedded");

    const second = await wallets.sync({
      ownerUserId,
      observed: [
        { address: walletA, kind: "embedded", providerWalletId: "wallet_1" },
      ],
    });
    const archived = second.find((wallet) => wallet.address === walletB);
    expect(archived?.status).toBe("archived");
    expect(archived?.isActive).toBe(false);
    expect(second.find((wallet) => wallet.address === walletA)?.walletId).toBe(
      active?.walletId,
    );
  });

  it("compare-and-swaps the active wallet and rejects a stale expectation", async () => {
    const ownerUserId = await createOwner();
    const inventory = await wallets.sync({
      ownerUserId,
      observed: [
        { address: walletA, kind: "embedded", providerWalletId: "wallet_1" },
        { address: walletB, kind: "external", providerWalletId: null },
      ],
    });
    const activeWalletId = inventory.find((wallet) => wallet.isActive)
      ?.walletId as string;
    const otherWalletId = inventory.find((wallet) => !wallet.isActive)
      ?.walletId as string;

    const switched = await wallets.setActive({
      ownerUserId,
      walletId: otherWalletId,
      expectedActiveWalletId: activeWalletId,
    });
    expect(switched.find((wallet) => wallet.isActive)?.walletId).toBe(
      otherWalletId,
    );

    await expect(
      wallets.setActive({
        ownerUserId,
        walletId: activeWalletId,
        expectedActiveWalletId: activeWalletId,
      }),
    ).rejects.toBeInstanceOf(AccountWalletVersionConflictError);

    await expect(
      wallets.setActive({
        ownerUserId,
        walletId: randomUUID(),
        expectedActiveWalletId: otherWalletId,
      }),
    ).rejects.toBeInstanceOf(AccountWalletNotFoundError);
  });

  it("commits a segment and its checkpoint atomically and rewinds a reorg", async () => {
    await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });

    const transfer = {
      transactionHash: `0x${"7".repeat(64)}`,
      logIndex: 0,
      blockNumber: "1000",
      blockHash: `0x${"a".repeat(64)}`,
      assetId: wbnbAssetId,
      fromAddress: counterparty,
      toAddress: walletA,
      rawValue: "1500000000000000000",
    };

    const checkpoint = await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [transfer, transfer],
      checkpoint: {
        lastBlockNumber: "1000",
        lastBlockHash: `0x${"a".repeat(64)}`,
        startedFromBlockNumber: "900",
      },
    });
    expect(checkpoint).toMatchObject({
      lastBlockNumber: "1000",
      reorgCount: 0,
    });

    const page = await indexer.listWalletTransfers({
      chainId: bscChainId,
      address: walletA,
      assetIds: [wbnbAssetId],
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      rawValue: "1500000000000000000",
      removed: false,
    });

    const pending = await indexer.sumPendingIncoming({
      chainId: bscChainId,
      address: walletA,
      assetIds: [wbnbAssetId],
      confirmedThroughBlockNumber: "990",
    });
    expect(pending).toEqual([
      { assetId: wbnbAssetId, rawValue: "1500000000000000000" },
    ]);

    const rewound = await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers: [],
      checkpoint: {
        lastBlockNumber: "1000",
        lastBlockHash: `0x${"b".repeat(64)}`,
        startedFromBlockNumber: "900",
      },
      rewindFromBlockNumber: "936",
    });
    expect(rewound.reorgCount).toBe(1);
    const afterReorg = await indexer.listWalletTransfers({
      chainId: bscChainId,
      address: walletA,
      assetIds: [wbnbAssetId],
      limit: 10,
    });
    expect(afterReorg.items[0]?.removed).toBe(true);
  });

  it("commits a segment wider than one insert batch atomically", async () => {
    await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });

    const segmentSize = indexedTransferInsertBatchSize * 2 + 1;
    const transfers = Array.from({ length: segmentSize }, (_unused, index) => ({
      transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
      logIndex: 0,
      blockNumber: String(2000 + index),
      blockHash: `0x${"a".repeat(64)}`,
      assetId: wbnbAssetId,
      fromAddress: counterparty,
      toAddress: walletA,
      rawValue: "1",
    }));

    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers,
      checkpoint: {
        lastBlockNumber: String(2000 + segmentSize),
        lastBlockHash: `0x${"a".repeat(64)}`,
        startedFromBlockNumber: "2000",
      },
    });

    const stored = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.indexed_transfers where chain_id = 'eip155:56'`,
    );
    expect(stored.rows[0]?.count).toBe(String(segmentSize));

    // A replay of the same segment stays idempotent across batch boundaries.
    await indexer.commitTransferSegment({
      chainId: bscChainId,
      transfers,
      checkpoint: {
        lastBlockNumber: String(2000 + segmentSize),
        lastBlockHash: `0x${"a".repeat(64)}`,
        startedFromBlockNumber: "2000",
      },
    });
    const replayed = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.indexed_transfers where chain_id = 'eip155:56'`,
    );
    expect(replayed.rows[0]?.count).toBe(String(segmentSize));
  });

  it("shares the record version with the frozen V1 watchlist", async () => {
    await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });
    const ownerUserId = await createOwner();
    const watchlistV1 = createPostgresWatchlistRepository(pool);

    const v1Snapshot = await watchlistV1.replace({
      ownerUserId,
      expectedVersion: 0,
      groups: parseWatchlistReplaceRequest({
        expected_version: 0,
        groups: [
          { key: "legacy", name: "Legacy", items: [{ asset_key: "BTC" }] },
        ],
      }).groups,
    });
    expect(v1Snapshot.version).toBe(1);

    // A V2 write must observe the V1 version, not a private counter.
    await expect(
      watchlistV2.replace({
        ownerUserId,
        expectedVersion: 0,
        groups: [
          { key: "mining", name: "Mining", items: [{ assetId: wbnbAssetId }] },
        ],
      }),
    ).rejects.toBeInstanceOf(WatchlistV2VersionConflictError);

    const v2Snapshot = await watchlistV2.replace({
      ownerUserId,
      expectedVersion: 1,
      groups: [
        { key: "mining", name: "Mining", items: [{ assetId: wbnbAssetId }] },
      ],
    });
    expect(v2Snapshot).toMatchObject({
      version: 2,
      groups: [
        {
          key: "mining",
          name: "Mining",
          items: [{ assetId: wbnbAssetId }],
        },
      ],
    });

    // The frozen V1 projection keeps its exact shape and simply no longer
    // lists rows it cannot represent.
    const v1After = await watchlistV1.get(ownerUserId);
    expect(v1After.version).toBe(2);
    expect(v1After.groups).toEqual([
      { key: "mining", name: "Mining", items: [] },
    ]);

    // The frozen V1 write must refuse rather than delete the V2 rows.
    await expect(
      watchlistV1.replace({
        ownerUserId,
        expectedVersion: 2,
        groups: parseWatchlistReplaceRequest({
          expected_version: 2,
          groups: [
            { key: "legacy", name: "Legacy", items: [{ asset_key: "ETH" }] },
          ],
        }).groups,
      }),
    ).rejects.toBeInstanceOf(WatchlistVersionConflictError);

    const survived = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.watchlist_items
        where owner_user_id = $1 and asset_id is not null
      `,
      values: [ownerUserId],
    });
    expect(survived.rows[0]?.count).toBe("1");
    expect((await watchlistV2.get(ownerUserId)).version).toBe(2);

    const idempotent = await watchlistV2.replace({
      ownerUserId,
      expectedVersion: 99,
      groups: [
        { key: "mining", name: "Mining", items: [{ assetId: wbnbAssetId }] },
      ],
    });
    expect(idempotent.version).toBe(2);
  });

  it("refuses to archive an inventory when the observation is empty", async () => {
    const ownerUserId = await createOwner();
    await wallets.sync({
      ownerUserId,
      observed: [
        { address: walletA, kind: "embedded", providerWalletId: "wallet_1" },
      ],
    });

    await expect(
      wallets.sync({ ownerUserId, observed: [] }),
    ).rejects.toBeInstanceOf(AccountWalletObservationEmptyError);

    const kept = await wallets.list(ownerUserId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ status: "active", isActive: true });

    // An account that genuinely has no wallet yet is not a Provider failure.
    const fresh = await createOwner();
    await expect(
      wallets.sync({ ownerUserId: fresh, observed: [] }),
    ).resolves.toEqual([]);
  });

  it("records a balance snapshot per wallet, asset, and block", async () => {
    await registry.upsertAsset({
      assetId: wbnbAssetId,
      chainId: bscChainId,
      address: wbnb,
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "43000000",
    });
    const ownerUserId = await createOwner();
    const inventory = await wallets.sync({
      ownerUserId,
      observed: [
        { address: walletA, kind: "embedded", providerWalletId: "wallet_1" },
      ],
    });
    const walletId = inventory[0]?.walletId as string;

    for (const rawValue of ["1", "2"]) {
      await wallets.recordBalanceSnapshot({
        walletId,
        assetId: wbnbAssetId,
        blockNumber: "43000100",
        blockHash: `0x${"c".repeat(64)}`,
        rawValue,
      });
    }

    const rows = await pool.query<{ count: string; raw_value: string }>({
      text: `
        select count(*)::text as count, max(raw_value)::text as raw_value
        from public.wallet_balance_snapshots
        where wallet_id = $1
      `,
      values: [walletId],
    });
    expect(rows.rows[0]).toEqual({ count: "1", raw_value: "2" });
  });
});
