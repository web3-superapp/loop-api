import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import {
  createPostgresMarketCategoryRepository,
  type MarketCategoryRepository,
} from "../src/database/market-category-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0105 against PostgreSQL: `category=meme` candidates are cut in
 * SQL by the requested sort (curve tokens, from their snapshot and trades)
 * and by recency (graduated tokens), never by asset ID.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const testnet = "eip155:97";
const curve = "0x00000000000000000000000000000000000000c1";
const e18 = 10n ** 18n;

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

describe("Decision 0105 meme category candidates on PostgreSQL", () => {
  const databaseName = `loop_s119b_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let categories: MarketCategoryRepository;
  let ownerId: string;
  let addressSeed = 0;
  let tradeSeed = 0;

  async function token(input: {
    readonly symbol: string;
    readonly status: "trading" | "full" | "graduated" | "paused";
    readonly vUsd1?: bigint;
    readonly vToken?: bigint;
    readonly graduatedHoursAgo?: number;
    readonly hidden?: boolean;
  }): Promise<{ memeTokenId: string; assetId: string; address: string }> {
    addressSeed += 1;
    const address = `0x${addressSeed.toString(16).padStart(40, "0")}`;
    const assetId = `${testnet}:${address}`;
    await pool.query({
      text: `
        insert into public.assets (
          asset_id, chain_id, address, symbol, name, decimals, status,
          source_kind, source_block_number, source_verified_at
        ) values ($1, $2, $3, $4, $4 || ' Token', 18, 'pending',
          'chain_call', 1, clock_timestamp())
      `,
      values: [assetId, testnet, address, input.symbol],
    });
    const memeTokenId = randomUUID();
    await pool.query({
      text: `
        insert into public.meme_tokens (
          meme_token_id, chain_id, contract_address, contract_version,
          creator_user_id, name, symbol, metadata_hash, token_address,
          asset_id, status, chain_created_at, v_usd1, v_token,
          graduated_at, pool_address, listing, listing_reason_code,
          listing_changed_at
        ) values ($1, $2, $3, '1.0.0', $4, $5, $5, $6, $7, $8, $9,
          clock_timestamp(), $10, $11,
          case when $12::int is null then null
            else clock_timestamp() - make_interval(hours => $12::int) end,
          case when $9 = 'graduated' then $7 end,
          case when $13 then 'hidden' else 'listed' end,
          case when $13 then 'user_reports' end,
          case when $13 then clock_timestamp() end)
      `,
      values: [
        memeTokenId,
        testnet,
        curve,
        ownerId,
        input.symbol,
        `0x${"1".repeat(64)}`,
        address,
        assetId,
        input.status,
        (input.vUsd1 ?? 6_000n * e18).toString(),
        (input.vToken ?? 1_073_000_000n * e18).toString(),
        input.graduatedHoursAgo ?? null,
        input.hidden === true,
      ],
    });
    return { memeTokenId, assetId, address };
  }

  async function trade(input: {
    readonly memeTokenId: string;
    readonly address: string;
    readonly usd1: bigint;
    readonly priceE18: bigint;
    readonly hoursAgo: number;
  }): Promise<void> {
    tradeSeed += 1;
    await pool.query({
      text: `
        insert into public.meme_trades (
          chain_id, transaction_hash, log_index, block_number, block_hash,
          token_address, meme_token_id, wallet, is_buy, usd1_amount,
          token_amount, fee_usd1, v_usd1_after, v_token_after, sold_after,
          price_after_e18, traded_at
        ) values ($1, $2, 0, $3, $2, $4, $5, $6, true, $7, 1, 0, 1, 1, 0,
          $8, clock_timestamp() - make_interval(hours => $9::int))
      `,
      values: [
        testnet,
        `0x${tradeSeed.toString(16).padStart(64, "0")}`,
        tradeSeed,
        input.address,
        input.memeTokenId,
        `0x${"e".repeat(40)}`,
        input.usd1.toString(),
        input.priceE18.toString(),
        input.hoursAgo,
      ],
    });
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    database = createPostgresDatabase(
      loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        DATABASE_URL: url,
      }),
      { error: () => undefined },
    );
    categories = createPostgresMarketCategoryRepository(pool);
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s119b:${randomUUID()}`,
    );
    ownerId = user.id;
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("cuts curve tokens by the requested sort and graduated tokens by recency", async () => {
    // Prices (1e18-scaled): A ≈ 1.29e13, B ≈ 7.78e12, C = opening ≈ 5.59e12.
    const a = await token({
      symbol: "AAA",
      status: "trading",
      vUsd1: 9_000n * e18,
      vToken: 700_000_000n * e18,
    });
    const b = await token({
      symbol: "BBB",
      status: "full",
      vUsd1: 7_000n * e18,
      vToken: 900_000_000n * e18,
    });
    const c = await token({ symbol: "CCC", status: "trading" });
    // Hidden or paused tokens never compete, however high their price.
    await token({
      symbol: "HID",
      status: "trading",
      vUsd1: 90_000n * e18,
      vToken: 70_000_000n * e18,
      hidden: true,
    });
    await token({
      symbol: "PAU",
      status: "paused",
      vUsd1: 90_000n * e18,
      vToken: 70_000_000n * e18,
    });
    await trade({ ...b, usd1: 500n * e18, priceE18: 1n, hoursAgo: 1 });
    await trade({ ...a, usd1: 10n * e18, priceE18: 1n, hoursAgo: 2 });
    // C traded 30 h ago at 1e12: the largest 24 h change (+459 %).
    await trade({ ...c, usd1: 1n, priceE18: 10n ** 12n, hoursAgo: 30 });
    const g1 = await token({
      symbol: "GOLD",
      status: "graduated",
      graduatedHoursAgo: 48,
    });
    const g2 = await token({
      symbol: "GTWO",
      status: "graduated",
      graduatedHoursAgo: 24,
    });
    const g3 = await token({
      symbol: "GNEW",
      status: "graduated",
      graduatedHoursAgo: 1,
    });

    const cut = async (sort: "marketCap" | "change24h" | "volume24h") => {
      const rows = await categories.listMemeCandidates(2, sort);
      return {
        curve: new Set(
          rows.filter((row) => row.curve !== null).map((row) => row.assetId),
        ),
        graduated: new Set(
          rows
            .filter((row) => (row.graduatedPool ?? null) !== null)
            .map((row) => row.assetId),
        ),
        total: rows.length,
      };
    };
    const byCap = await cut("marketCap");
    expect(byCap.curve).toEqual(new Set([a.assetId, b.assetId]));
    expect(byCap.graduated).toEqual(new Set([g3.assetId, g2.assetId]));
    expect(byCap.total).toBe(4);
    expect((await cut("volume24h")).curve).toEqual(
      new Set([b.assetId, a.assetId]),
    );
    expect((await cut("change24h")).curve).toEqual(
      new Set([c.assetId, a.assetId]),
    );
    // The default is the market-cap cut, as before.
    const fallback = await categories.listMemeCandidates(2);
    expect(
      new Set(
        fallback.filter((row) => row.curve !== null).map((row) => row.assetId),
      ),
    ).toEqual(byCap.curve);
    expect(byCap.graduated.has(g1.assetId)).toBe(false);
    const bySnapshot = (await categories.listMemeCandidates(10)).find(
      (row) => row.assetId === b.assetId,
    );
    expect(bySnapshot?.curve).toMatchObject({
      status: "full",
      vUsd1: (7_000n * e18).toString(),
      volume24hRaw: (500n * e18).toString(),
      price24hAgoE18: null,
    });
  });
});
