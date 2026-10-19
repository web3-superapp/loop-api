import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  Launch2ActivityRecord,
  Launch2PoolTradeRecord,
  Launch2TradeRecord,
} from "../src/features/launch2/launch2-ports.js";
import {
  createWalletAccountDirectory,
  projectTraderAccount,
  walletAccountLookupBatchSize,
  type WalletAccountLookup,
  type WalletAccountRecord,
} from "../src/features/profile/wallet-account-directory.js";
import {
  createFakeLaunch2Chain,
  createFakeLaunch2PoolChain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  defaultPoolState,
  graduatedInstance,
  launch2Env,
  launch2NowSeconds,
  launch2PoolEnv,
  wad,
} from "./helpers/launch2-fakes.js";
import {
  walletAddress,
  walletId,
  walletsFake,
} from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  s7AccountId,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0162: launch2 curve trades, own pool trades and the launchpad
 * activity carry the trader's LOOP `account` (MEME trade shape), resolved
 * in one batched, cached lookup under the trade-visibility rule.
 */

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const visible = "0x1111111111111111111111111111111111111111";
const hidden = "0x2222222222222222222222222222222222222222";
const anonymous = "0x3333333333333333333333333333333333333333";
const noProfile = "0x4444444444444444444444444444444444444444";
const otherUser = "0b7c2d1e-3f40-4a5b-8c6d-7e8f9a0b1c2d";

function record(
  address: string,
  overrides: Partial<WalletAccountRecord> = {},
): WalletAccountRecord {
  return {
    address,
    ownerUserId: otherUser,
    publicProfileId: `pp_${address.slice(2, 8)}`,
    alias: `alias-${address.slice(2, 6)}`,
    avatarRef: null,
    tradeVisibility: "everyone",
    ...overrides,
  };
}

const directory: Record<string, WalletAccountRecord> = {
  [visible]: record(visible, { avatarRef: "avatar:preset/fox" }),
  [hidden]: record(hidden, { tradeVisibility: "self" }),
  [noProfile]: record(noProfile, { publicProfileId: null, alias: null }),
  [walletAddress.toLowerCase()]: record(walletAddress.toLowerCase(), {
    ownerUserId: s7AccountId,
    publicProfileId: "pp_self",
    alias: "me",
    tradeVisibility: "self",
  }),
};

function lookupFake() {
  const find = vi.fn((addresses: readonly string[]) =>
    Promise.resolve(
      addresses.flatMap((address) => {
        const row = directory[address];
        return row === undefined ? [] : [row];
      }),
    ),
  );
  const lookup: WalletAccountLookup = { findByAddresses: find };
  return { lookup, find };
}

function trade(
  traderAddress: string,
  index: number,
  overrides: Partial<Launch2TradeRecord> = {},
): Launch2TradeRecord {
  return {
    tradeId: `9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c${String(index).padStart(2, "0")}`,
    side: "buy",
    traderAddress,
    memeAmount: (1_000n * wad).toString(),
    usd1Gross: wad.toString(),
    usd1Net: wad.toString(),
    taxUsd1: "0",
    refundUsd1: "0",
    cumulativeBought: null,
    soldAfter: null,
    tradedAt: iso(launch2NowSeconds - BigInt(index)),
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: String(1_000 - index),
    ...overrides,
  };
}

describe("wallet account directory (Decision 0162)", () => {
  it("hides a self-only trade history from everyone but the owner", () => {
    const row = record(hidden, { tradeVisibility: "self" });
    expect(projectTraderAccount(row, s7AccountId)).toBeNull();
    expect(projectTraderAccount(row, otherUser)).toEqual({
      publicProfileId: row.publicProfileId,
      displayName: row.alias,
      avatarRef: null,
    });
    expect(
      projectTraderAccount(record(noProfile, { publicProfileId: null }), null),
    ).toBeNull();
    expect(projectTraderAccount(null, null)).toBeNull();
  });

  it("looks up a batch once, caches hits and misses for the TTL, case-insensitively", async () => {
    const { lookup, find } = lookupFake();
    let clock = 0;
    const accounts = createWalletAccountDirectory({
      lookup,
      ttlMs: 1_000,
      now: () => clock,
    });
    const first = await accounts.resolve(
      [visible.toUpperCase().replace("0X", "0x"), hidden, anonymous, visible],
      s7AccountId,
    );
    expect(find).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledWith([visible, hidden, anonymous]);
    expect(first.get(visible)).toEqual({
      publicProfileId: directory[visible]?.publicProfileId,
      displayName: directory[visible]?.alias,
      avatarRef: "avatar:preset/fox",
    });
    expect(first.get(hidden)).toBeNull();
    expect(first.get(anonymous)).toBeNull();
    clock = 999;
    await accounts.resolve([visible, anonymous], s7AccountId);
    expect(find).toHaveBeenCalledOnce();
    clock = 1_000;
    await accounts.resolve([visible, "not-an-address"], s7AccountId);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenLastCalledWith([visible]);
  });

  it("splits large batches and degrades a failed lookup to null without caching it", async () => {
    const { lookup, find } = lookupFake();
    const onLookupError = vi.fn();
    const accounts = createWalletAccountDirectory({ lookup, onLookupError });
    const many = Array.from(
      { length: walletAccountLookupBatchSize + 5 },
      (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
    );
    await accounts.resolve(many, null);
    expect(find).toHaveBeenCalledTimes(2);

    const failing: WalletAccountLookup = {
      findByAddresses: vi
        .fn()
        .mockRejectedValueOnce(new Error("database down"))
        .mockResolvedValue([directory[visible]]),
    };
    const degraded = createWalletAccountDirectory({
      lookup: failing,
      onLookupError,
    });
    expect((await degraded.resolve([visible], null)).get(visible)).toBeNull();
    expect(onLookupError).toHaveBeenCalledOnce();
    expect(
      (await degraded.resolve([visible], null)).get(visible),
    ).not.toBeNull();
  });
});

describe("launch2 trader accounts on the routes (Decision 0162)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    repository: ReturnType<typeof createInMemoryLaunch2Repository>,
    lookup: WalletAccountLookup | undefined,
  ) {
    const app = await buildApp({
      config: s7TestConfig({ ...launch2Env, ...launch2PoolEnv }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
        ...(lookup === undefined ? {} : { walletAccounts: lookup }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds()),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  it("adds the account to every recent trade with one lookup per response, cached across requests", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = graduatedInstance();
    repository.instances.set(instance.instanceId, instance);
    repository.trades.set(instance.instanceId, [
      trade(visible, 1),
      trade(hidden, 2),
      trade(anonymous, 3),
      trade(noProfile, 4),
      trade(visible, 5, { side: "sell" }),
    ]);
    const { lookup, find } = lookupFake();
    const app = await createApp(repository, lookup);
    const url = `/v2/launch2/instances/${instance.instanceId}`;
    const response = await get(app, url);
    expect(response.statusCode).toBe(200);
    const trades = response.json<{
      instance: { recentTrades: { traderAddress: string; account: unknown }[] };
    }>().instance.recentTrades;
    expect(trades.map((row) => row.account)).toEqual([
      {
        publicProfileId: directory[visible]?.publicProfileId,
        displayName: directory[visible]?.alias,
        avatarRef: "avatar:preset/fox",
      },
      null,
      null,
      null,
      {
        publicProfileId: directory[visible]?.publicProfileId,
        displayName: directory[visible]?.alias,
        avatarRef: "avatar:preset/fox",
      },
    ]);
    expect(find).toHaveBeenCalledOnce();
    expect(
      (await get(app, url)).json<{ instance: { recentTrades: unknown[] } }>()
        .instance.recentTrades,
    ).toHaveLength(5);
    expect(find).toHaveBeenCalledOnce();
  });

  it("keeps every account null without the lookup", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = graduatedInstance();
    repository.instances.set(instance.instanceId, instance);
    repository.trades.set(instance.instanceId, [trade(visible, 1)]);
    const app = await createApp(repository, undefined);
    const response = await get(
      app,
      `/v2/launch2/instances/${instance.instanceId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ instance: { recentTrades: { account: unknown }[] } }>()
        .instance.recentTrades[0]?.account,
    ).toBeNull();
  });

  it("shows the caller's own account on their pool trades even when trade history is self-only", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = graduatedInstance();
    repository.instances.set(instance.instanceId, instance);
    const pool: Launch2PoolTradeRecord = {
      poolTradeId: "5e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a50",
      side: "buy",
      amountIn: (10n * wad).toString(),
      amountOut: (15_680n * wad).toString(),
      usd1Amount: (10n * wad).toString(),
      memeAmount: (16_000n * wad).toString(),
      taxAmount: (320n * wad).toString(),
      taxToken: "meme",
      priceE18: "625000000000000",
      recipientAddress: walletAddress,
      tradedAt: iso(launch2NowSeconds - 20n),
      transactionHash: `0x${"ab".repeat(32)}`,
      logIndex: 4,
      blockNumber: "136098447",
    };
    repository.poolTrades.set(
      `${instance.instanceId}|${walletAddress.toLowerCase()}`,
      [pool],
    );
    const app = await createApp(repository, lookupFake().lookup);
    const response = await get(
      app,
      `/v2/launch2/instances/${instance.instanceId}/pool/trades?walletId=${walletId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ trades: { account: unknown }[] }>().trades[0]?.account,
    ).toEqual({
      publicProfileId: "pp_self",
      displayName: "me",
      avatarRef: null,
    });
  });

  it("adds the actor's account to the launchpad activity", async () => {
    const repository = createInMemoryLaunch2Repository();
    const base: Launch2ActivityRecord = {
      kind: "curve_buy",
      instanceId: "8d7b8d64-35a6-4cb8-9b8f-2d0e3f6a1c11",
      ticker: "FROG",
      name: "Frog Launch",
      logoUrl: null,
      actor: visible,
      amountUsd1: (20n * wad).toString(10),
      at: iso(launch2NowSeconds - 60n),
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "1000",
      logIndex: 1,
    };
    repository.activity.push(
      base,
      { ...base, actor: hidden, logIndex: 0 },
      {
        ...base,
        kind: "graduated",
        actor: null,
        amountUsd1: null,
        blockNumber: "999",
      },
    );
    const { lookup, find } = lookupFake();
    const app = await createApp(repository, lookup);
    const response = await get(app, "/v2/launch2/overview");
    expect(response.statusCode).toBe(200);
    const rows = response.json<{
      activity: { actor: string | null; account: unknown }[];
    }>().activity;
    expect(rows.map((row) => [row.actor, row.account])).toEqual([
      [
        visible,
        {
          publicProfileId: directory[visible]?.publicProfileId,
          displayName: directory[visible]?.alias,
          avatarRef: "avatar:preset/fox",
        },
      ],
      [hidden, null],
      [null, null],
    ]);
    expect(find).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledWith([visible, hidden]);
  });
});
