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
import { createPostgresMemeRepository } from "../src/database/meme-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import type { MemeRepository } from "../src/features/meme/meme-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { fixtureBlockHash, memeCurveAddress } from "./helpers/meme-fixtures.js";

/**
 * Decision 0142 against PostgreSQL: migration 000083's indexes, the list
 * row's 24-hour volume window boundary, and the weekly best trades
 * (average-cost basis, positive only, window, removed logs, mapped and
 * visible accounts only, hidden tokens, ordering, limit).
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const chainId = "eip155:97" as const;
const now = "2026-10-15T12:00:00.000Z";
const nowMs = Date.parse(now);
const weekAgo = new Date(nowMs - 7 * 86_400_000).toISOString();
const e18 = 10n ** 18n;

function at(offsetSeconds: number): string {
  return new Date(nowMs + offsetSeconds * 1000).toISOString();
}

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

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

describe("Decision 0142 MEME list volume and weekly best trades on PostgreSQL", () => {
  const databaseName = `loop_s187a_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let repository: MemeRepository;
  let creatorId: string;
  let logIndex = 0;
  const profiles = new Map<number, { profileId: string; loopId: string }>();

  async function account(
    walletNumber: number,
    options: { readonly alias?: string; readonly tradesHidden?: boolean } = {},
  ): Promise<string> {
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s187a:${randomUUID()}`,
    );
    if (options.alias !== undefined) {
      await createPostgresProfileV2Repository(pool).activateProfile({
        ownerUserId: user.id,
        idempotencyKey: randomUUID(),
        requestSha256: profileActivationDigest(
          { alias: options.alias, avatarRef: null, interests: [] },
          "2.0",
        ),
        requestId: randomUUID(),
        profile: { alias: options.alias, avatarRef: null, interests: [] },
      });
      const row = await pool.query<{
        public_profile_id: string;
        loop_id: string;
      }>({
        text: `select p.public_profile_id, u.loop_id from public.user_profiles p
          join public.loop_users u on u.id = p.owner_user_id where p.owner_user_id = $1`,
        values: [user.id],
      });
      profiles.set(walletNumber, {
        profileId: row.rows[0]?.public_profile_id ?? "",
        loopId: row.rows[0]?.loop_id ?? "",
      });
    }
    if (options.tradesHidden === true) {
      await pool.query({
        text: `insert into public.privacy_preferences_v2 (owner_user_id, trade_history_visibility)
          values ($1, 'self')
          on conflict (owner_user_id) do update set trade_history_visibility = 'self'`,
        values: [user.id],
      });
    }
    await pool.query({
      text: `insert into public.account_wallets (owner_user_id, address, kind, is_active) values ($1, $2, 'external', true)`,
      values: [user.id, wallet(walletNumber)],
    });
    return user.id;
  }

  async function token(
    symbol: string,
    options: { readonly listing?: "listed" | "hidden" } = {},
  ): Promise<string> {
    const memeTokenId = randomUUID();
    const address = `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
    await pool.query({
      text: `insert into public.meme_tokens (
          meme_token_id, chain_id, contract_address, contract_version, creator_user_id,
          name, symbol, metadata_hash, token_address, status, created_block,
          chain_created_at, holder_count, listing, listing_reason_code, listing_changed_at)
        values ($1, $2, $3, '1.0.0', $4, $5, $5, $6, $7, 'trading', 100, $8, 3, $9,
          case when $9 = 'hidden' then 'spam' end,
          case when $9 = 'hidden' then clock_timestamp() end)`,
      values: [
        memeTokenId,
        chainId,
        memeCurveAddress,
        creatorId,
        symbol,
        `0x${"cd".repeat(32)}`,
        address,
        at(-30 * 86_400),
        options.listing ?? "listed",
      ],
    });
    return memeTokenId;
  }

  async function trade(input: {
    readonly memeTokenId: string;
    readonly walletNumber: number;
    readonly isBuy: boolean;
    readonly usd1: bigint;
    readonly tokens: bigint;
    readonly tradedAt: string;
    readonly removed?: boolean;
  }): Promise<void> {
    logIndex += 1;
    await pool.query({
      text: `insert into public.meme_trades (
          chain_id, transaction_hash, log_index, block_number, block_hash, token_address,
          meme_token_id, wallet, is_buy, usd1_amount, token_amount, fee_usd1,
          v_usd1_after, v_token_after, sold_after, price_after_e18, traded_at, removed)
        select $1, $2, $3::integer, $3::bigint, $4, t.token_address, t.meme_token_id, $5, $6, $7, $8, 0,
          1, 1, 0, 0, $9, $10
        from public.meme_tokens t where t.meme_token_id = $11`,
      values: [
        chainId,
        `0x${logIndex.toString(16).padStart(64, "0")}`,
        logIndex,
        fixtureBlockHash(BigInt(logIndex)),
        wallet(input.walletNumber),
        input.isBuy,
        input.usd1.toString(),
        input.tokens.toString(),
        input.tradedAt,
        input.removed ?? false,
        input.memeTokenId,
      ],
    });
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
    database = createPostgresDatabase(
      loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        DATABASE_URL: url,
      }),
      { error: () => undefined },
    );
    repository = createPostgresMemeRepository(pool);
    creatorId = await account(99, { alias: "creator" });
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("migration 000083 creates the three covering indexes", async () => {
    const result = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'meme_trades'
        and indexname in ('meme_trades_token_volume_idx', 'meme_trades_sell_window_idx', 'meme_trades_wallet_buy_idx')
        order by indexname`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      "meme_trades_sell_window_idx",
      "meme_trades_token_volume_idx",
      "meme_trades_wallet_buy_idx",
    ]);
  });

  it("sums buys and sells of the last 24 hours, excluding the window start and removed logs", async () => {
    const id = await token("VOLA");
    // Exactly now − 24 h: outside (the window start is exclusive).
    await trade({
      memeTokenId: id,
      walletNumber: 1,
      isBuy: true,
      usd1: 1000n * e18,
      tokens: 1n,
      tradedAt: at(-86_400),
    });
    // One second inside, a sell, and a trade at now: all counted.
    await trade({
      memeTokenId: id,
      walletNumber: 1,
      isBuy: true,
      usd1: 2n * e18,
      tokens: 1n,
      tradedAt: at(-86_399),
    });
    await trade({
      memeTokenId: id,
      walletNumber: 1,
      isBuy: false,
      usd1: 3n * e18,
      tokens: 1n,
      tradedAt: at(-60),
    });
    await trade({
      memeTokenId: id,
      walletNumber: 1,
      isBuy: true,
      usd1: 5n * e18 + 5n * (e18 / 10n),
      tokens: 1n,
      tradedAt: now,
    });
    // Reorged out: never counted.
    await trade({
      memeTokenId: id,
      walletNumber: 1,
      isBuy: true,
      usd1: 700n * e18,
      tokens: 1n,
      tradedAt: at(-30),
      removed: true,
    });
    const expected = (10n * e18 + 5n * (e18 / 10n)).toString();
    const stats = await repository.tokenStats({ memeTokenId: id, now });
    expect(stats.volume24hRaw).toBe(expected);
    const [row] = await repository.listTokensByIds({
      memeTokenIds: [id],
      now,
    });
    expect(row?.volume24hRaw).toBe(expected);
    expect(row?.holderCount).toBe(3);
    expect(row?.chainCreatedAt).toBe(at(-30 * 86_400));
    const listed = await repository.listTokens({
      chainId,
      contractAddress: memeCurveAddress,
      tab: "new",
      limit: 50,
      after: null,
      now,
    });
    expect(listed.find((item) => item.memeTokenId === id)?.volume24hRaw).toBe(
      expected,
    );
  });

  it("ranks realized gains at the average buy cost: positive, mapped, visible, in the window", async () => {
    await pool.query(`delete from public.meme_trades`);
    const frog = await token("FROG");
    const toad = await token("TOAD");
    const hidden = await token("HIDE", { listing: "hidden" });
    await account(10, { alias: "alice" });
    await account(11, { alias: "bob" });
    await account(12, { alias: "carol" });
    await account(13, { alias: "dave" });
    await account(14, { alias: "erin", tradesHidden: true });
    await account(15); // an account without a public profile
    await account(16, { alias: "gina" });
    // 20 (no account at all) is anonymous.

    // alice FROG: buys 100 @ 10 and 100 @ 30 → average 0.2; sells 100 for 35
    // in the window → 35 − 20 = 15. An older sale (8 days ago) and a
    // removed sale in the window do not count.
    const tokensOf = (n: bigint) => n * e18;
    await trade({
      memeTokenId: frog,
      walletNumber: 10,
      isBuy: true,
      usd1: tokensOf(10n),
      tokens: tokensOf(100n),
      tradedAt: at(-20 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 10,
      isBuy: true,
      usd1: tokensOf(30n),
      tokens: tokensOf(100n),
      tradedAt: at(-10 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 10,
      isBuy: false,
      usd1: tokensOf(500n),
      tokens: tokensOf(10n),
      tradedAt: at(-8 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 10,
      isBuy: false,
      usd1: tokensOf(35n),
      tokens: tokensOf(100n),
      tradedAt: at(-3600),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 10,
      isBuy: false,
      usd1: tokensOf(900n),
      tokens: tokensOf(10n),
      tradedAt: at(-1800),
      removed: true,
    });
    // alice TOAD: buys 10 @ 1, sells 10 for 2 → 1 (the same user may rank twice).
    await trade({
      memeTokenId: toad,
      walletNumber: 10,
      isBuy: true,
      usd1: tokensOf(1n),
      tokens: tokensOf(10n),
      tradedAt: at(-5 * 86_400),
    });
    await trade({
      memeTokenId: toad,
      walletNumber: 10,
      isBuy: false,
      usd1: tokensOf(2n),
      tokens: tokensOf(10n),
      tradedAt: at(-4 * 86_400),
    });
    // bob FROG: buys 100 @ 10, sells 50 for 30 in two sales → 30 − 5 = 25.
    await trade({
      memeTokenId: frog,
      walletNumber: 11,
      isBuy: true,
      usd1: tokensOf(10n),
      tokens: tokensOf(100n),
      tradedAt: at(-6 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 11,
      isBuy: false,
      usd1: tokensOf(10n),
      tokens: tokensOf(25n),
      tradedAt: at(-2 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 11,
      isBuy: false,
      usd1: tokensOf(20n),
      tokens: tokensOf(25n),
      tradedAt: at(-60),
    });
    // carol: buys only → never listed.
    await trade({
      memeTokenId: frog,
      walletNumber: 12,
      isBuy: true,
      usd1: tokensOf(50n),
      tokens: tokensOf(100n),
      tradedAt: at(-3600),
    });
    // dave: sells at a loss → not listed.
    await trade({
      memeTokenId: frog,
      walletNumber: 13,
      isBuy: true,
      usd1: tokensOf(50n),
      tokens: tokensOf(100n),
      tradedAt: at(-3 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 13,
      isBuy: false,
      usd1: tokensOf(20n),
      tokens: tokensOf(100n),
      tradedAt: at(-3600),
    });
    // erin (trade history hidden), wallet 15 (no profile), wallet 20
    // (anonymous): large gains, never listed.
    for (const walletNumber of [14, 15, 20]) {
      await trade({
        memeTokenId: frog,
        walletNumber,
        isBuy: true,
        usd1: tokensOf(1n),
        tokens: tokensOf(100n),
        tradedAt: at(-3 * 86_400),
      });
      await trade({
        memeTokenId: frog,
        walletNumber,
        isBuy: false,
        usd1: tokensOf(1000n),
        tokens: tokensOf(100n),
        tradedAt: at(-3600),
      });
    }
    // gina: a hidden token's gain is left out; a sale with no buy has no cost basis.
    await trade({
      memeTokenId: hidden,
      walletNumber: 16,
      isBuy: true,
      usd1: tokensOf(1n),
      tokens: tokensOf(100n),
      tradedAt: at(-3 * 86_400),
    });
    await trade({
      memeTokenId: hidden,
      walletNumber: 16,
      isBuy: false,
      usd1: tokensOf(800n),
      tokens: tokensOf(100n),
      tradedAt: at(-3600),
    });
    await trade({
      memeTokenId: toad,
      walletNumber: 16,
      isBuy: false,
      usd1: tokensOf(700n),
      tokens: tokensOf(100n),
      tradedAt: at(-3600),
    });
    // gina FROG: raw 10 USD1 for 3 raw tokens, sells 1 for 5 → cost
    // ceil(10 / 3) = 4 → realized 1 raw. A buy after `until` is ignored.
    await trade({
      memeTokenId: frog,
      walletNumber: 16,
      isBuy: true,
      usd1: 10n,
      tokens: 3n,
      tradedAt: at(-2 * 86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 16,
      isBuy: false,
      usd1: 5n,
      tokens: 1n,
      tradedAt: at(-86_400),
    });
    await trade({
      memeTokenId: frog,
      walletNumber: 16,
      isBuy: true,
      usd1: tokensOf(1000n),
      tokens: 1n,
      tradedAt: at(60),
    });

    const ranked = await repository.rankBestTrades({
      chainId,
      contractAddress: memeCurveAddress,
      since: weekAgo,
      until: now,
      limit: 10,
    });
    expect(
      ranked.map((item) => [item.alias, item.symbol, item.realizedRaw]),
    ).toEqual([
      ["bob", "FROG", (25n * e18).toString()],
      ["alice", "FROG", (15n * e18).toString()],
      ["alice", "TOAD", (1n * e18).toString()],
      ["gina", "FROG", "1"],
    ]);
    expect(ranked[0]).toMatchObject({
      wallet: wallet(11),
      memeTokenId: frog,
      publicProfileId: profiles.get(11)?.profileId,
      loopId: profiles.get(11)?.loopId,
      imageMediaId: null,
      avatarRef: null,
    });
    expect(ranked[0]?.loopId).toMatch(/^LOOP-/u);

    const top = await repository.rankBestTrades({
      chainId,
      contractAddress: memeCurveAddress,
      since: weekAgo,
      until: now,
      limit: 2,
    });
    expect(top.map((item) => item.alias)).toEqual(["bob", "alice"]);

    // A narrower window drops alice's TOAD sale (4 days ago) and bob's first sale.
    const recent = await repository.rankBestTrades({
      chainId,
      contractAddress: memeCurveAddress,
      since: at(-86_400),
      until: now,
      limit: 10,
    });
    expect(
      recent.map((item) => [item.alias, item.symbol, item.realizedRaw]),
    ).toEqual([
      ["bob", "FROG", (20n * e18 - (25n * e18) / 10n).toString()],
      ["alice", "FROG", (15n * e18).toString()],
    ]);

    // Another contract sees nothing.
    expect(
      await repository.rankBestTrades({
        chainId,
        contractAddress: wallet(0xfff),
        since: weekAgo,
        until: now,
        limit: 10,
      }),
    ).toEqual([]);
  });
});
