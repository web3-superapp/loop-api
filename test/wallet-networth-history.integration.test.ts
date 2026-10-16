import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresAccountWalletRepository } from "../src/database/account-wallet-repository.js";
import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { createPostgresWalletNetWorthSnapshotRepository } from "../src/database/wallet-networth-snapshot-repository.js";
import type { AssetPriceFact } from "../src/features/market/market-fact-service.js";
import { createWalletNetWorthHistoryService } from "../src/features/wallet/wallet-networth-history.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import { createWalletNetWorthSnapshotLane } from "../src/wallet-networth-snapshot-worker.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0145 on PostgreSQL (migration 000085), in a throwaway database:
 * the lane's candidate selection (device session or balance read in the
 * last 30 days, active wallets only, once per slot), snapshot writes with
 * quality (partial, never a zero for an unvalued wallet), the per-range
 * downsampling, the 24 h change, high / low, "current without history",
 * ownership (404), and the migration's down step.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const hourMs = 3_600_000;

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

const nativeAsset: AssetRecord = Object.freeze({
  assetId: "eip155:56:native",
  chainId: "eip155:56",
  address: null,
  symbol: "BNB",
  name: "BNB",
  decimals: 18,
  status: "verified",
  sourceKind: "chain_native",
  sourceBlockNumber: null,
  sourceVerifiedAt: null,
  updatedAt: "2026-10-15T00:00:00.000Z",
});

function priceFact(priceUsd: string | null): AssetPriceFact {
  return {
    fact: {
      value: priceUsd === null ? null : ({} as never),
      fetchedAt: priceUsd === null ? null : new Date().toISOString(),
      quality: priceUsd === null ? "unavailable" : "fresh",
      reasonCode: priceUsd === null ? "MARKET_PAIR_NOT_FOUND" : null,
      source: "dexscreener",
    } as unknown as AssetPriceFact["fact"],
    pair:
      priceUsd === null
        ? null
        : ({
            priceUsd,
            priceChangeH24: "1",
          } as unknown as AssetPriceFact["pair"]),
    proxyAsset: null,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("Decision 0145 wallet net worth history on PostgreSQL", () => {
  const databaseName = `loop_s199_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;

  async function user(): Promise<string> {
    const created = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s199:${randomUUID()}`],
    );
    return created.rows[0]!.id;
  }

  async function wallet(
    ownerUserId: string,
    status: "active" | "archived" = "active",
  ): Promise<{ readonly walletId: string; readonly address: string }> {
    const address = `0x${randomUUID().replaceAll("-", "")}${"0".repeat(8)}`;
    const created = await pool.query<{ wallet_id: string }>(
      `insert into public.account_wallets (owner_user_id, address, kind, status)
       values ($1, $2, 'external', $3) returning wallet_id::text`,
      [ownerUserId, address, status],
    );
    return { walletId: created.rows[0]!.wallet_id, address };
  }

  async function deviceSession(
    ownerUserId: string,
    hoursAgo: number,
  ): Promise<void> {
    await pool.query({
      text: `
        with observed as (
          select clock_timestamp() - ($2::int * interval '1 hour') as at
        )
        insert into public.device_sessions (
          owner_user_id, bootstrap_idempotency_key, bootstrap_request_sha256,
          device_id, client_platform, client_version, status, created_at,
          last_seen_at
        )
        select $1, $3, $4, $5, 'ios', '1.2.3', 'active', observed.at, observed.at
        from observed
      `,
      values: [
        ownerUserId,
        hoursAgo,
        randomUUID(),
        createHash("sha256").update(randomUUID()).digest("hex"),
        randomUUID(),
      ],
    });
  }

  async function balanceRead(walletId: string, daysAgo: number): Promise<void> {
    await pool.query({
      text: `
        insert into public.wallet_balance_snapshots
          (wallet_id, asset_id, block_number, block_hash, raw_value, observed_at)
        values ($1, 'eip155:56:native', $2, $3, 0,
          clock_timestamp() - ($4::int * interval '1 day'))
      `,
      values: [
        walletId,
        Math.floor(Math.random() * 1_000_000),
        `0x${"a".repeat(64)}`,
        daysAgo,
      ],
    });
  }

  async function seed(
    walletId: string,
    rows: readonly {
      readonly at: Date;
      readonly usd: string;
      readonly quality?: string;
    }[],
  ): Promise<void> {
    for (const row of rows) {
      await pool.query(
        `insert into public.wallet_networth_snapshots (wallet_id, at, net_worth_usd, quality)
         values ($1, $2, $3, $4)`,
        [walletId, row.at.toISOString(), row.usd, row.quality ?? "fresh"],
      );
    }
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("writes one snapshot per recently active wallet per slot, with quality, never a zero for an unvalued wallet", async () => {
    const repository = createPostgresWalletNetWorthSnapshotRepository(pool);
    const loggedIn = await user();
    const loggedInWallet = await wallet(loggedIn);
    await deviceSession(loggedIn, 2);
    const reader = await user();
    const readerWallet = await wallet(reader);
    await balanceRead(readerWallet.walletId, 3);
    const dormant = await user();
    const dormantWallet = await wallet(dormant);
    await deviceSession(dormant, 24 * 40);
    await balanceRead(dormantWallet.walletId, 40);
    const archivedOwner = await user();
    const archivedWallet = await wallet(archivedOwner, "archived");
    await deviceSession(archivedOwner, 1);
    const unpricedOwner = await user();
    const unpricedWallet = await wallet(unpricedOwner);
    await deviceSession(unpricedOwner, 1);
    const failingOwner = await user();
    const failingWallet = await wallet(failingOwner);
    await deviceSession(failingOwner, 1);

    // Two assets: native always readable, a token unreadable for the reader
    // wallet (partial); nothing readable for the unpriced wallet.
    const token: AssetRecord = {
      ...nativeAsset,
      assetId: "eip155:56:0x00000000000000000000000000000000000000c1",
      address: "0x00000000000000000000000000000000000000c1",
      symbol: "TKN",
      status: "pending",
    };
    const readClient: Pick<BscReadClient, "readBalances"> = {
      readBalances: (address, items) => {
        if (address === failingWallet.address) {
          return Promise.reject(new Error("rpc down"));
        }
        return Promise.resolve({
          head: {
            blockNumber: 1n,
            blockHash: `0x${"1".repeat(64)}`,
            observedAt: new Date().toISOString(),
          },
          balances: items.map((item) => ({
            assetId: item.assetId,
            rawValue:
              address === readerWallet.address && item.address !== null
                ? null
                : 2_000_000_000_000_000_000n,
            reasonCode:
              address === readerWallet.address && item.address !== null
                ? "BSC_BALANCE_CALL_FAILED"
                : null,
          })),
        } as never);
      },
    };
    const passes: unknown[] = [];
    const lane = createWalletNetWorthSnapshotLane({
      repository,
      listAssets: () => Promise.resolve([nativeAsset, token]),
      readPrices: () => Promise.resolve([priceFact("600"), priceFact("0.5")]),
      // The unvalued wallet: no balance of any row could be read.
      readClient: {
        readBalances: (address, items) =>
          address === unpricedWallet.address
            ? Promise.resolve({
                head: {
                  blockNumber: 1n,
                  blockHash: `0x${"1".repeat(64)}`,
                  observedAt: new Date().toISOString(),
                },
                balances: items.map((item) => ({
                  assetId: item.assetId,
                  rawValue: null,
                  reasonCode: "BSC_BALANCE_CALL_FAILED",
                })),
              } as never)
            : readClient.readBalances(address, items),
      },
      intervalMs: hourMs,
      batchSize: 2,
      onPass: (result) => passes.push(result),
    });
    const first = await lane.runOnce();
    expect(first).toMatchObject({
      candidateCount: 4,
      writtenCount: 2,
      unvaluedCount: 1,
      failedCount: 1,
      priceReadFailed: false,
    });
    const slot = new Date(
      Math.floor(Date.now() / hourMs) * hourMs,
    ).toISOString();
    expect(first["at"]).toBe(slot);
    const written = await pool.query<{
      wallet_id: string;
      net_worth_usd: string;
      quality: string;
      at: Date;
    }>(
      "select wallet_id::text, net_worth_usd::text, quality, at from public.wallet_networth_snapshots order by net_worth_usd desc",
    );
    expect(
      written.rows.map((row) => [
        row.wallet_id,
        row.net_worth_usd,
        row.quality,
        row.at.toISOString(),
      ]),
    ).toEqual([
      // 2 BNB × 600 + 2 TKN × 0.5
      [loggedInWallet.walletId, "1201", "fresh", slot],
      // TKN unreadable: partial, the BNB part only
      [readerWallet.walletId, "1200", "partial", slot],
    ]);
    for (const absent of [
      dormantWallet,
      archivedWallet,
      unpricedWallet,
      failingWallet,
    ]) {
      expect(written.rows.map((row) => row.wallet_id)).not.toContain(
        absent.walletId,
      );
    }
    // The same slot again: written wallets are no longer candidates.
    const second = await lane.runOnce();
    expect(second).toMatchObject({ candidateCount: 2, writtenCount: 0 });
    expect(passes).toHaveLength(2);
    // The insert keeps an existing (wallet_id, at).
    expect(
      await repository.recordSnapshots([
        {
          walletId: loggedInWallet.walletId,
          at: slot,
          netWorthUsd: "1",
          quality: "fresh",
        },
      ]),
    ).toBe(0);
    await pool.query("truncate public.wallet_networth_snapshots");
  });

  it("downsamples per range, computes the 24 h change and high / low, and answers current without history", async () => {
    const owner = await user();
    const target = await wallet(owner);
    const stranger = await user();
    const repository = createPostgresWalletNetWorthSnapshotRepository(pool);
    const now = new Date("2026-10-15T12:20:00.000Z");
    const topOfHour = new Date("2026-10-15T12:00:00.000Z").getTime();
    let live: string | null = "150";
    const service = createWalletNetWorthHistoryService({
      wallets: createPostgresAccountWalletRepository(pool),
      snapshots: repository,
      measure: () =>
        Promise.resolve(
          live === null
            ? null
            : {
                netWorthUsd: live,
                quality: "fresh" as const,
                unavailableCount: 0,
                asOf: now.toISOString(),
              },
        ),
      fiatRates: null,
      now: () => now,
    });
    const read = (range: string) =>
      service.getHistory({
        principal: { userId: owner },
        walletId: target.walletId,
        range,
        signal: new AbortController().signal,
      });

    // No history yet: current alone.
    const empty = await read("1d");
    expect(empty).toMatchObject({
      range: "1d",
      points: [],
      current: { netWorthUsd: "150", quality: "fresh", origin: "live" },
      change24h: null,
      high: { netWorthUsd: "150" },
      low: { netWorthUsd: "150" },
      fiat: null,
      source: "dexscreener",
      contractVersion: "2.0",
    });

    // 40 days of hourly snapshots: value = hours ago (so older is larger),
    // except a partial dip 3 h ago that is kept in points but not in low.
    const rows: { at: Date; usd: string; quality?: string }[] = [];
    for (let hoursAgo = 0; hoursAgo < 40 * 24; hoursAgo += 1) {
      rows.push({
        at: new Date(topOfHour - hoursAgo * hourMs),
        usd: hoursAgo === 3 ? "0.5" : String(100 + hoursAgo),
        ...(hoursAgo === 3 ? { quality: "partial" } : {}),
      });
    }
    await pool.query({
      text: `insert into public.wallet_networth_snapshots (wallet_id, at, net_worth_usd, quality)
             select $1, unnest($2::timestamptz[]), unnest($3::numeric[]), unnest($4::text[])`,
      values: [
        target.walletId,
        rows.map((row) => row.at.toISOString()),
        rows.map((row) => row.usd),
        rows.map((row) => row.quality ?? "fresh"),
      ],
    });

    const day = await read("1d");
    // (now − 24 h, now]: 24 hourly slots, oldest first.
    expect(day.points).toHaveLength(24);
    expect(day.points[0]).toEqual({
      at: new Date(topOfHour - 23 * hourMs).toISOString(),
      netWorthUsd: "123",
      quality: "fresh",
    });
    expect(day.points.at(-1)).toEqual({
      at: new Date(topOfHour).toISOString(),
      netWorthUsd: "100",
      quality: "fresh",
    });
    expect(day.points.at(-4)).toMatchObject({
      netWorthUsd: "0.5",
      quality: "partial",
    });
    // Baseline: the newest snapshot at or before 2026-10-14T12:20 → 12:00
    // (24 h ago, value 124). 150 − 124 = 26, 26 / 124 = 20.9677 %.
    expect(day.change24h).toEqual({
      usd: "26",
      pct: "20.9677",
      baselineAt: new Date(topOfHour - 24 * hourMs).toISOString(),
    });
    expect(day.high).toEqual({
      at: now.toISOString(),
      netWorthUsd: "150",
    });
    expect(day.low).toEqual({
      at: new Date(topOfHour).toISOString(),
      netWorthUsd: "100",
    });

    const week = await read("7d");
    // 4 h slots (UTC 0/4/8/…) over (now − 7 d, now]: the partial slot at the
    // window start, 41 full slots, and today's open 12:00 slot = 43, each
    // the slot's last snapshot.
    expect(week.points).toHaveLength(43);
    for (const point of week.points.slice(0, -1)) {
      expect(new Date(point.at).getUTCHours() % 4).toBe(3);
    }
    expect(week.points.at(-1)?.at).toBe(new Date(topOfHour).toISOString());

    const month = await read("30d");
    // Daily slots: the partial first day, 29 full days, and today = 31.
    expect(month.points).toHaveLength(31);
    for (const point of month.points.slice(0, -1)) {
      expect(new Date(point.at).getUTCHours()).toBe(23);
    }
    // Today's slot ends at the newest snapshot.
    expect(month.points.at(-1)?.at).toBe(new Date(topOfHour).toISOString());
    expect(month.high).toMatchObject({
      netWorthUsd: String(100 + 30 * 24 - 1),
    });

    const half = await read("180d");
    // 40 days of data in 3-day slots: 14 slots (the epoch-aligned edges).
    expect(half.points.length).toBeGreaterThanOrEqual(14);
    expect(half.points.length).toBeLessThanOrEqual(15);
    const year = await read("360d");
    expect(year.points.length).toBeGreaterThanOrEqual(6);
    expect(year.points.length).toBeLessThanOrEqual(7);
    for (const result of [day, week, month, half, year]) {
      expect(result.points.length).toBeLessThanOrEqual(120);
      const ats = result.points.map((point) => point.at);
      expect([...ats].sort()).toEqual(ats);
    }

    // The live read is unavailable: the newest snapshot, at best stale.
    live = null;
    const fallback = await read("1d");
    expect(fallback.current).toEqual({
      netWorthUsd: "100",
      at: new Date(topOfHour).toISOString(),
      quality: "stale",
      origin: "snapshot",
    });
    // Baseline relative to the snapshot's own time: 24 h before 12:00.
    expect(fallback.change24h).toMatchObject({ usd: "-24" });

    // Not the caller's wallet: 404, nothing about it.
    const foreign = await rejection(
      service.getHistory({
        principal: { userId: stranger },
        walletId: target.walletId,
        range: "1d",
        signal: new AbortController().signal,
      }),
    );
    expect(foreign).toBeInstanceOf(V2ApiError);
    expect(foreign).toMatchObject({ code: "NOT_FOUND" });
  });

  it("has no 24 h change when the only older snapshot is more than 48 h old", async () => {
    const owner = await user();
    const target = await wallet(owner);
    const now = new Date("2026-10-15T12:20:00.000Z");
    await seed(target.walletId, [
      { at: new Date("2026-10-12T12:00:00.000Z"), usd: "10" },
      { at: new Date("2026-10-15T12:00:00.000Z"), usd: "12" },
    ]);
    const service = createWalletNetWorthHistoryService({
      wallets: createPostgresAccountWalletRepository(pool),
      snapshots: createPostgresWalletNetWorthSnapshotRepository(pool),
      measure: null,
      fiatRates: null,
      now: () => now,
    });
    const result = await service.getHistory({
      principal: { userId: owner },
      walletId: target.walletId,
      range: "7d",
      signal: new AbortController().signal,
    });
    expect(result.change24h).toBeNull();
    expect(result.fiat).toBeNull();
    expect(result.current).toMatchObject({
      netWorthUsd: "12",
      origin: "snapshot",
    });
  });

  it("answers 503 WALLET_NETWORTH_HISTORY_UNAVAILABLE when the table cannot be read", async () => {
    const owner = await user();
    const target = await wallet(owner);
    const broken = new Pool({ connectionString: url });
    const repository = createPostgresWalletNetWorthSnapshotRepository(broken);
    await broken.end();
    const service = createWalletNetWorthHistoryService({
      wallets: createPostgresAccountWalletRepository(pool),
      snapshots: repository,
      measure: null,
      fiatRates: null,
    });
    const error = await rejection(
      service.getHistory({
        principal: { userId: owner },
        walletId: target.walletId,
        range: "1d",
        signal: new AbortController().signal,
      }),
    );
    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "WALLET_NETWORTH_HISTORY_UNAVAILABLE" },
    });
  });

  it("rolls back 000085 and up again", async () => {
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    const steps =
      migrations.length -
      migrations.indexOf("000085_wallet_networth_snapshots.ts");
    expect(steps).toBeGreaterThanOrEqual(1);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "down",
      count: steps,
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const gone = await pool.query(
      "select to_regclass('public.wallet_networth_snapshots') as relation",
    );
    expect(gone.rows[0]).toEqual({ relation: null });
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    const index = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'wallet_networth_snapshots_recent_idx'",
    );
    expect(index.rows[0]?.indexdef).toContain("(wallet_id, at DESC)");
  });
});
