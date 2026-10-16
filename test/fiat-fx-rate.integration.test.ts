import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresFiatFxRateRepository } from "../src/database/fiat-fx-rate-repository.js";
import { createPostgresWalletNetWorthSnapshotRepository } from "../src/database/wallet-networth-snapshot-repository.js";
import { createFiatFxRateLane } from "../src/fiat-fx-rate-worker.js";
import { createWalletNetWorthHistoryService } from "../src/features/wallet/wallet-networth-history.js";
import { createFrankfurterFiatFxProvider } from "../src/integrations/fx/frankfurter-adapter.js";
import type { ProviderFetch } from "../src/integrations/market/provider-http.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0149 on PostgreSQL (migration 000088), in a throwaway database:
 * the table's constraints, the lane writing through the real repository
 * (upsert per provider date, a failed fetch writes nothing), the history
 * `fiat` block (fresh / stale / null), and the migration's down step.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const hourMs = 3_600_000;
const defaultUrl = "https://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY";

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

function fetchAnswering(status: number, body: string): ProviderFetch {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    });
}

describe("Decision 0149 fiat FX rates on PostgreSQL", () => {
  const databaseName = `loop_s206_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;

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

  it("refuses rows outside the constraints", async () => {
    const insert = (values: readonly unknown[]) =>
      pool.query(
        `insert into public.fiat_fx_rates
           (base, quote, source, provider_as_of, rate, fetched_at, quality)
         values ($1, $2, $3, $4, $5, now(), $6)`,
        values as unknown[],
      );
    for (const bad of [
      ["USD", "CNY", "ecb", "2026-10-15", "0", "fresh"],
      ["USD", "CNY", "ecb", "2026-10-15", "-1", "fresh"],
      ["USD", "CNY", "ecb", "2026-10-15", "1000.01", "fresh"],
      ["USD", "CNY", "ecb", "2026-10-15", "7", "partial"],
      ["usd", "CNY", "ecb", "2026-10-15", "7", "fresh"],
      ["USD", "USD", "ecb", "2026-10-15", "1", "fresh"],
      ["USD", "CNY", "ECB", "2026-10-15", "7", "fresh"],
    ]) {
      await expect(insert(bad), bad.join(",")).rejects.toMatchObject({
        code: "23514",
      });
    }
    const count = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.fiat_fx_rates",
    );
    expect(count.rows[0]?.n).toBe("0");
  });

  it("writes through the lane, upserts per provider date, and keeps the row on a failed fetch", async () => {
    const repository = createPostgresFiatFxRateRepository(pool);
    expect(
      await repository.readLatest({ base: "USD", quote: "CNY" }),
    ).toBeNull();
    let now = new Date("2026-10-16T04:00:00.000Z");
    let body = '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.6910}';
    let status = 200;
    const lane = createFiatFxRateLane({
      repository,
      provider: createFrankfurterFiatFxProvider({
        url: defaultUrl,
        base: "USD",
        quote: "CNY",
        fetch: (input, init) => fetchAnswering(status, body)(input, init),
      }),
      refreshMs: hourMs,
      now: () => now,
    });
    expect(await lane.runOnce()).toMatchObject({ written: true });
    expect(await repository.readLatest({ base: "USD", quote: "CNY" })).toEqual({
      base: "USD",
      quote: "CNY",
      rate: "6.691",
      source: "ecb",
      providerAsOf: "2026-10-15",
      fetchedAt: "2026-10-16T04:00:00.000Z",
      quality: "fresh",
    });

    // The next hour, same provider date: one row, refreshed fetch time.
    now = new Date("2026-10-16T05:00:00.000Z");
    expect(await lane.runOnce()).toMatchObject({ written: true });
    const rows = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.fiat_fx_rates",
    );
    expect(rows.rows[0]?.n).toBe("1");
    expect(
      (await repository.readLatest({ base: "USD", quote: "CNY" }))?.fetchedAt,
    ).toBe("2026-10-16T05:00:00.000Z");

    // Malformed (rate 0) and non-200 answers write nothing.
    now = new Date("2026-10-16T06:00:00.000Z");
    body = '{"date":"2026-10-16","base":"USD","quote":"CNY","rate":0}';
    expect(await lane.runOnce()).toMatchObject({
      written: false,
      reasonCode: "FIAT_FX_PROVIDER_RESPONSE_MALFORMED",
    });
    status = 503;
    expect(await lane.runOnce()).toMatchObject({
      written: false,
      reasonCode: "FIAT_FX_PROVIDER_REQUEST_REJECTED",
    });
    expect(await repository.readLatest({ base: "USD", quote: "CNY" })).toEqual(
      expect.objectContaining({
        rate: "6.691",
        fetchedAt: "2026-10-16T05:00:00.000Z",
      }),
    );

    // A new provider date becomes the latest row.
    status = 200;
    body = '[{"date":"2026-10-16","base":"USD","quote":"CNY","rate":6.6866}]';
    expect(await lane.runOnce()).toMatchObject({ written: true });
    expect(await repository.readLatest({ base: "USD", quote: "CNY" })).toEqual(
      expect.objectContaining({ rate: "6.6866", providerAsOf: "2026-10-16" }),
    );
    await pool.query("truncate public.fiat_fx_rates");
  });

  it("publishes fiat fresh within 26 h, stale after, and null without a row", async () => {
    const created = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s206:${randomUUID()}`],
    );
    const owner = created.rows[0]!.id;
    const wallet = await pool.query<{ wallet_id: string }>(
      `insert into public.account_wallets (owner_user_id, address, kind, status)
       values ($1, $2, 'external', 'active') returning wallet_id::text`,
      [owner, `0x${randomUUID().replaceAll("-", "")}${"0".repeat(8)}`],
    );
    const walletId = wallet.rows[0]!.wallet_id;
    const rates = createPostgresFiatFxRateRepository(pool);
    let now = new Date("2026-10-16T12:00:00.000Z");
    const service = createWalletNetWorthHistoryService({
      wallets: createPostgresAccountWalletRepository(pool),
      snapshots: createPostgresWalletNetWorthSnapshotRepository(pool),
      measure: () =>
        Promise.resolve({
          netWorthUsd: "1234.5678",
          quality: "fresh" as const,
          unavailableCount: 0,
          asOf: now.toISOString(),
        }),
      fiatRates: rates,
      now: () => now,
    });
    const read = () =>
      service.getHistory({
        principal: { userId: owner },
        walletId,
        range: "1d",
        signal: new AbortController().signal,
      });

    expect((await read()).fiat).toBeNull();

    await rates.recordRate({
      base: "USD",
      quote: "CNY",
      rate: "6.691",
      source: "ecb",
      providerAsOf: "2026-10-15",
      fetchedAt: "2026-10-16T04:00:00.000Z",
      quality: "fresh",
    });
    // 1234.5678 × 6.691 = 8260.4931498 → 8260.49
    expect((await read()).fiat).toEqual({
      currency: "CNY",
      rate: "6.691",
      amount: "8260.49",
      source: "ecb",
      asOf: "2026-10-15",
      fetchedAt: "2026-10-16T04:00:00.000Z",
      quality: "fresh",
    });

    now = new Date(Date.parse("2026-10-16T04:00:00.000Z") + 26 * hourMs);
    expect((await read()).fiat?.quality).toBe("fresh");
    now = new Date(Date.parse("2026-10-16T04:00:00.000Z") + 26 * hourMs + 1);
    expect((await read()).fiat).toMatchObject({
      quality: "stale",
      rate: "6.691",
      amount: "8260.49",
    });
    await pool.query("truncate public.fiat_fx_rates");
  });

  it("rolls back 000088 and up again", async () => {
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    const steps =
      migrations.length - migrations.indexOf("000088_fiat_fx_rates.ts");
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
      "select to_regclass('public.fiat_fx_rates') as relation",
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
      "select indexdef from pg_indexes where indexname = 'fiat_fx_rates_latest_idx'",
    );
    expect(index.rows[0]?.indexdef).toContain(
      "(base, quote, provider_as_of DESC, fetched_at DESC)",
    );
  });
});
