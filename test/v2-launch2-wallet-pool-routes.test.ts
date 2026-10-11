import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  Launch2PoolTradeRecord,
  Launch2PositionRecord,
} from "../src/features/launch2/launch2-ports.js";
import {
  launch2InstanceDetailResourceSchema,
  launch2PoolTradesResourceSchema,
  launch2PositionsResourceSchema,
} from "../src/routes/v2/launch2-schemas.js";
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
  priorityInstance,
  wad,
  type FakeLaunch2ChainState,
  type InMemoryLaunch2Repository,
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
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0126 route contract: the wallet's live MEME / USD1 balances on
 * the instance detail `viewer` and on `GET /v2/launch2/me/positions`
 * (graduated only, ≤ 15 s cache, fail closed to `unavailable`), the
 * wallet's own attributed pool-trade count, and
 * `GET /v2/launch2/instances/{id}/pool/trades`.
 */

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

function position(instanceId: string): Launch2PositionRecord {
  return {
    instanceId,
    holderAddress: walletAddress,
    nftMintedTokenId: null,
    nftHeld: 0,
    curveBought: (1_000n * wad).toString(),
    curveSold: "0",
    cumulativeBought: (1_000n * wad).toString(),
    usd1Spent: (1n * wad).toString(),
    usd1Received: "0",
    taxUsd1: "0",
    buyCount: 1,
    sellCount: 0,
    snapshotMember: false,
    lastActivityAt: iso(launch2NowSeconds - 100n),
  };
}

function poolTrade(
  overrides: Partial<Launch2PoolTradeRecord> = {},
): Launch2PoolTradeRecord {
  return {
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
    ...overrides,
  };
}

describe("V2 launch2 wallet balances and own pool trades (Decision 0126)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    repository: InMemoryLaunch2Repository,
    chain: FakeLaunch2ChainState = defaultChainState({
      memeBalance: 15_680n * wad,
      usd1Balance: 990n * wad,
    }),
  ) {
    const app = await buildApp({
      config: s7TestConfig({ ...launch2Env, ...launch2PoolEnv }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(chain),
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds()),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, chain };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  it("adds the live balances and the own pool-trade count to a graduated viewer, cached", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = graduatedInstance();
    repository.instances.set(record.instanceId, record);
    repository.poolTrades.set(`${record.instanceId}|${walletAddress}`, [
      poolTrade(),
      poolTrade({
        poolTradeId: "6e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a51",
        tradedAt: iso(launch2NowSeconds - 200n),
      }),
    ]);
    const { app, chain } = await createApp(repository);
    const response = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}?walletId=${walletId}`,
    );
    expect(response.statusCode).toBe(200);
    const viewer = response.json<{ instance: { viewer: object } }>().instance
      .viewer as Record<string, unknown>;
    const viewerSchema =
      launch2InstanceDetailResourceSchema.properties.instance.properties.viewer
        .anyOf[0];
    expect(Object.keys(viewer).sort()).toEqual(
      [...viewerSchema.required].sort(),
    );
    expect(viewer).toMatchObject({
      walletId,
      memeBalance: "15680",
      usd1Balance: "990",
      balanceStatus: "available",
      balanceReasonCode: null,
      balanceBlockNumber: "5000",
      poolTradeCount: "2",
      lastPoolTradeAt: iso(launch2NowSeconds - 20n),
    });
    // The second answer within 15 s reuses the read.
    await get(
      app,
      `/v2/launch2/instances/${record.instanceId}?walletId=${walletId}`,
    );
    expect(chain.balanceReads).toBe(1);
  });

  it("keeps the balances null before graduation and fails closed when the read fails", async () => {
    const repository = createInMemoryLaunch2Repository();
    const priority = priorityInstance();
    const graduated = graduatedInstance();
    repository.instances.set(priority.instanceId, priority);
    repository.instances.set(graduated.instanceId, graduated);
    const chain = defaultChainState();
    chain.failBalances = true;
    const { app } = await createApp(repository, chain);
    const before = await get(
      app,
      `/v2/launch2/instances/${priority.instanceId}?walletId=${walletId}`,
    );
    expect(
      before.json<{ instance: { viewer: object } }>().instance.viewer,
    ).toMatchObject({
      memeBalance: null,
      usd1Balance: null,
      balanceStatus: "not_graduated",
      balanceReasonCode: null,
      balanceBlockNumber: null,
      poolTradeCount: "0",
      lastPoolTradeAt: null,
    });
    expect(chain.balanceReads).toBe(0);
    const failed = await get(
      app,
      `/v2/launch2/instances/${graduated.instanceId}?walletId=${walletId}`,
    );
    expect(failed.statusCode).toBe(200);
    expect(
      failed.json<{ instance: { viewer: object } }>().instance.viewer,
    ).toMatchObject({
      memeBalance: null,
      usd1Balance: null,
      balanceStatus: "unavailable",
      balanceReasonCode: "LAUNCH2_CHAIN_READ_FAILED",
    });
  });

  it("lists positions with balances on graduated rows only", async () => {
    const repository = createInMemoryLaunch2Repository();
    const priority = priorityInstance();
    const graduated = graduatedInstance();
    repository.instances.set(priority.instanceId, priority);
    repository.instances.set(graduated.instanceId, graduated);
    repository.positions.push(
      position(graduated.instanceId),
      position(priority.instanceId),
    );
    repository.poolTrades.set(`${graduated.instanceId}|${walletAddress}`, [
      poolTrade(),
    ]);
    const { app } = await createApp(repository);
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ positions: Record<string, unknown>[] }>()
      .positions;
    const required =
      launch2PositionsResourceSchema.properties.positions.items.required;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...required].sort());
    }
    expect(rows[0]).toMatchObject({
      instanceId: graduated.instanceId,
      stage: "graduated",
      memeBalance: "15680",
      usd1Balance: "990",
      balanceStatus: "available",
      poolTradeCount: "1",
      lastPoolTradeAt: iso(launch2NowSeconds - 20n),
    });
    expect(rows[1]).toMatchObject({
      instanceId: priority.instanceId,
      memeBalance: null,
      balanceStatus: "not_graduated",
      poolTradeCount: "0",
      lastPoolTradeAt: null,
    });
  });

  it("lists the wallet's own pool trades, newest first, and validates the query", async () => {
    const repository = createInMemoryLaunch2Repository();
    const graduated = graduatedInstance();
    const priority = priorityInstance();
    repository.instances.set(graduated.instanceId, graduated);
    repository.instances.set(priority.instanceId, priority);
    repository.poolTrades.set(`${graduated.instanceId}|${walletAddress}`, [
      poolTrade(),
      poolTrade({
        poolTradeId: "6e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a51",
        side: "sell",
        amountIn: (80_400n * wad).toString(),
        amountOut: (49n * wad).toString(),
        usd1Amount: (50n * wad).toString(),
        memeAmount: (80_400n * wad).toString(),
        taxAmount: (1n * wad).toString(),
        taxToken: "usd1",
        tradedAt: iso(launch2NowSeconds - 200n),
        transactionHash: `0x${"cd".repeat(32)}`,
        blockNumber: "136098143",
      }),
    ]);
    const { app } = await createApp(repository);
    const url = `/v2/launch2/instances/${graduated.instanceId}/pool/trades`;
    const response = await get(app, `${url}?walletId=${walletId}&limit=10`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [...launch2PoolTradesResourceSchema.required].sort(),
    );
    expect(body).toMatchObject({
      instanceId: graduated.instanceId,
      walletId,
      poolTradeCount: "2",
      lastPoolTradeAt: iso(launch2NowSeconds - 20n),
      contractVersion: "2.0",
    });
    expect(body["trades"]).toEqual([
      {
        poolTradeId: "5e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a50",
        side: "buy",
        inputToken: "usd1",
        outputToken: "meme",
        amountIn: "10",
        amountOut: "15680",
        usd1Amount: "10",
        memeAmount: "16000",
        taxAmount: "320",
        taxToken: "meme",
        priceUsd1: "0.000625",
        recipientAddress: walletAddress,
        tradedAt: iso(launch2NowSeconds - 20n),
        transactionHash: `0x${"ab".repeat(32)}`,
        logIndex: 4,
        blockNumber: "136098447",
      },
      expect.objectContaining({
        side: "sell",
        inputToken: "meme",
        outputToken: "usd1",
        amountIn: "80400",
        amountOut: "49",
        taxToken: "usd1",
      }),
    ]);
    const one = await get(app, `${url}?walletId=${walletId}&limit=1`);
    expect(one.json<{ trades: unknown[] }>().trades).toHaveLength(1);
    // Before graduation: an empty list, not an error.
    const empty = await get(
      app,
      `/v2/launch2/instances/${priority.instanceId}/pool/trades?walletId=${walletId}`,
    );
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      poolTradeCount: "0",
      lastPoolTradeAt: null,
      trades: [],
    });
    // walletId is required; limit 1..50; another account's wallet is 404.
    for (const query of [
      "",
      `?walletId=${walletId}&limit=0`,
      `?walletId=${walletId}&limit=51`,
      "?walletId=not-a-wallet",
    ]) {
      const bad = await get(app, `${url}${query}`);
      expect(bad.statusCode, query).toBe(400);
      expect(Object.keys(bad.json<object>()).sort()).toEqual(errorKeys);
    }
    const foreign = await get(
      app,
      `${url}?walletId=7e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a52`,
    );
    expect(foreign.statusCode).toBe(404);
    expect(Object.keys(foreign.json<object>()).sort()).toEqual(errorKeys);
    const missing = await get(
      app,
      `/v2/launch2/instances/8e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a53/pool/trades?walletId=${walletId}`,
    );
    expect(missing.statusCode).toBe(404);
  });
});
