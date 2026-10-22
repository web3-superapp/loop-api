import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  Launch2PositionRecord,
  Launch2PublicPoolTradeRecord,
} from "../src/features/launch2/launch2-ports.js";
import {
  launch2PositionsResourceSchema,
  launch2RecentPoolTradesResourceSchema,
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
import { walletAddress, walletsFake } from "./helpers/launch-service-fakes.js";
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
 * Decision 0174 route contract: the optional `priceUsd1` / `valueUsd1` /
 * `priceSource` keys of `GET /v2/launch2/me/positions` rows (only with
 * LAUNCH2_POSITION_VALUE_EMIT=on; curve price before graduation, the
 * pool's last price after, null when there is none) and the public
 * `GET /v2/launch2/instances/{id}/pool/recent-trades`.
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
const valueKeys = ["priceSource", "priceUsd1", "valueUsd1"];

function position(
  instanceId: string,
  overrides: Partial<Launch2PositionRecord> = {},
): Launch2PositionRecord {
  return {
    instanceId,
    holderAddress: walletAddress,
    nftMintedTokenId: null,
    nftHeld: 0,
    curveBought: (1_200n * wad).toString(),
    curveSold: (200n * wad).toString(),
    cumulativeBought: (1_200n * wad).toString(),
    usd1Spent: (1n * wad).toString(),
    usd1Received: "0",
    taxUsd1: "0",
    buyCount: 2,
    sellCount: 1,
    snapshotMember: false,
    lastActivityAt: iso(launch2NowSeconds - 100n),
    ...overrides,
  };
}

function publicTrade(
  index: number,
  overrides: Partial<Launch2PublicPoolTradeRecord> = {},
): Launch2PublicPoolTradeRecord {
  return {
    side: index % 2 === 0 ? "buy" : "sell",
    memeAmount: (16_000n * wad).toString(),
    usd1Amount: (10n * wad).toString(),
    priceE18: "625000000000000",
    walletAddress: "0x1234567890abcdef1234567890abcdef1234abcd",
    tradedAt: iso(launch2NowSeconds - BigInt(10 + index)),
    transactionHash: `0x${index.toString(16).padStart(2, "0").repeat(32)}`,
    logIndex: 3,
    blockNumber: String(136_098_447 - index),
    ...overrides,
  };
}

describe("V2 launch2 position value and public pool trades (Decision 0174)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    repository: InMemoryLaunch2Repository,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly chain?: FakeLaunch2ChainState;
      readonly now?: () => Date;
    } = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2PoolEnv,
        ...options.env,
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(
        options.chain ??
          defaultChainState({
            memeBalance: 15_680n * wad,
            usd1Balance: 990n * wad,
          }),
      ),
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds()),
      walletIntentNow:
        options.now ?? (() => new Date(Number(launch2NowSeconds) * 1000)),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  const get = (
    app: FastifyInstance,
    url: string,
    headers: Record<string, string> = s7CommonHeaders(),
  ) => app.inject({ method: "GET", url, headers });

  function seededPositions() {
    const repository = createInMemoryLaunch2Repository();
    const curve = priorityInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a01",
    });
    const priced = graduatedInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a02",
    });
    const pricedWithPool = graduatedInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a02",
      pool: {
        ...priced.pool,
        tradeCount: "1",
        buyCount: "1",
        lastPriceE18: "625000000000000",
        lastTradeAt: iso(launch2NowSeconds - 20n),
      },
    });
    const unpriced = graduatedInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a03",
    });
    for (const record of [curve, pricedWithPool, unpriced]) {
      repository.instances.set(record.instanceId, record);
      repository.positions.push(position(record.instanceId));
    }
    return { repository, curve, priced: pricedWithPool, unpriced };
  }

  it("omits the price and value keys while LAUNCH2_POSITION_VALUE_EMIT is off (default)", async () => {
    const { repository } = seededPositions();
    const app = await createApp(repository);
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ positions: Record<string, unknown>[] }>()
      .positions;
    expect(rows).toHaveLength(3);
    const required =
      launch2PositionsResourceSchema.properties.positions.items.required;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...required].sort());
      for (const key of valueKeys) expect(row).not.toHaveProperty(key);
    }
    // Every instance in one repository read (no per-instance lookups).
    expect(repository.getInstancesCalls).toHaveLength(1);
    expect([...repository.getInstancesCalls[0]!].sort()).toEqual([
      "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a01",
      "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a02",
      "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a03",
    ]);
  });

  it("prices curve rows at the curve price × net and graduated rows at the pool's last price × balance", async () => {
    const { repository, curve, priced, unpriced } = seededPositions();
    const app = await createApp(repository, {
      env: { LAUNCH2_POSITION_VALUE_EMIT: "on" },
    });
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ positions: Record<string, unknown>[] }>()
      .positions;
    const required =
      launch2PositionsResourceSchema.properties.positions.items.required;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [...required, ...valueKeys].sort(),
      );
    }
    const byId = new Map(rows.map((row) => [row["instanceId"], row]));
    // Curve: 41666666250000 / 1e18 per MEME × (1200 − 200) MEME.
    expect(byId.get(curve.instanceId)).toMatchObject({
      stage: "priority",
      priceUsd1: "0.00004166666625",
      valueUsd1: "0.04166666625",
      priceSource: "curve",
      memeBalance: null,
    });
    // Graduated: 0.000625 × 15680 (the live balance, not curve.net).
    expect(byId.get(priced.instanceId)).toMatchObject({
      stage: "graduated",
      memeBalance: "15680",
      priceUsd1: "0.000625",
      valueUsd1: "9.8",
      priceSource: "pool",
    });
    // Graduated without a pool trade: no price, never estimated.
    expect(byId.get(unpriced.instanceId)).toMatchObject({
      stage: "graduated",
      memeBalance: "15680",
      priceUsd1: null,
      valueUsd1: null,
      priceSource: null,
    });
  });

  it("keeps the price but no value when the graduated balance cannot be read, and treats a zero price as none", async () => {
    const repository = createInMemoryLaunch2Repository();
    const base = graduatedInstance();
    const record = graduatedInstance({
      pool: { ...base.pool, lastPriceE18: "625000000000000" },
    });
    const zero = priorityInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a09",
      priceE18: "0",
    });
    repository.instances.set(record.instanceId, record);
    repository.instances.set(zero.instanceId, zero);
    repository.positions.push(
      position(record.instanceId),
      position(zero.instanceId),
    );
    const chain = defaultChainState();
    chain.failBalances = true;
    const app = await createApp(repository, {
      env: { LAUNCH2_POSITION_VALUE_EMIT: "on" },
      chain,
    });
    const rows = (await get(app, "/v2/launch2/me/positions")).json<{
      positions: Record<string, unknown>[];
    }>().positions;
    expect(rows[0]).toMatchObject({
      balanceStatus: "unavailable",
      memeBalance: null,
      priceUsd1: "0.000625",
      valueUsd1: null,
      priceSource: "pool",
    });
    expect(rows[1]).toMatchObject({
      priceUsd1: null,
      valueUsd1: null,
      priceSource: null,
    });
  });

  it("answers an empty position list without reading instances", async () => {
    const repository = createInMemoryLaunch2Repository();
    const app = await createApp(repository, {
      env: { LAUNCH2_POSITION_VALUE_EMIT: "on" },
    });
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.json()).toEqual({ positions: [], contractVersion: "2.0" });
    expect(repository.getInstancesCalls).toHaveLength(0);
  });

  it("lists the public pool trades without a Bearer token, masked and capped", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = graduatedInstance();
    repository.instances.set(record.instanceId, record);
    repository.recentPoolTrades.set(
      record.instanceId,
      Array.from({ length: 60 }, (_, index) =>
        publicTrade(index, index === 1 ? { walletAddress: null } : {}),
      ),
    );
    const app = await createApp(repository);
    const url = `/v2/launch2/instances/${record.instanceId}/pool/recent-trades`;
    const anonymous = s7CommonHeaders({ authorization: undefined });
    const response = await get(app, url, anonymous);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=10");
    const body = response.json<{
      items: Record<string, unknown>[];
      observedAt: string;
    }>();
    expect(Object.keys(body).sort()).toEqual(
      [...launch2RecentPoolTradesResourceSchema.required].sort(),
    );
    expect(body.items).toHaveLength(20);
    expect(body.observedAt).toBe(iso(launch2NowSeconds));
    expect(body.items[0]).toEqual({
      txHash: `0x${"00".repeat(32)}`,
      blockNumber: "136098447",
      at: iso(launch2NowSeconds - 10n),
      side: "buy",
      memeAmount: "16000",
      usd1Amount: "10",
      priceUsd1: "0.000625",
      wallet: "0x1234…abcd",
    });
    expect(body.items[1]).toMatchObject({ side: "sell", wallet: null });
    // The raw address never appears.
    expect(response.body).not.toContain("1234567890abcdef");

    const fifty = await get(app, `${url}?limit=50`, anonymous);
    expect(fifty.statusCode).toBe(200);
    expect(fifty.json<{ items: unknown[] }>().items).toHaveLength(50);
    for (const limit of ["51", "0", "abc"]) {
      const refused = await get(app, `${url}?limit=${limit}`, anonymous);
      expect(refused.statusCode, limit).toBe(400);
      expect(Object.keys(refused.json<object>()).sort()).toEqual(errorKeys);
      expect(refused.headers["cache-control"]).toBe("no-store");
    }
    // A Bearer token is accepted and ignored.
    expect((await get(app, url)).statusCode).toBe(200);
  });

  it("reuses one answer for 10 s and answers [] before graduation, 404 for an unknown instance", async () => {
    const repository = createInMemoryLaunch2Repository();
    const graduated = graduatedInstance();
    const curve = priorityInstance({
      instanceId: "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a05",
    });
    repository.instances.set(graduated.instanceId, graduated);
    repository.instances.set(curve.instanceId, curve);
    repository.recentPoolTrades.set(graduated.instanceId, [publicTrade(0)]);
    repository.recentPoolTrades.set(curve.instanceId, [publicTrade(0)]);
    let nowMs = Number(launch2NowSeconds) * 1000;
    const app = await createApp(repository, { now: () => new Date(nowMs) });
    const anonymous = s7CommonHeaders({ authorization: undefined });
    const url = `/v2/launch2/instances/${graduated.instanceId}/pool/recent-trades`;
    const first = (await get(app, url, anonymous)).json<{
      items: unknown[];
      observedAt: string;
    }>();
    expect(first.items).toHaveLength(1);
    repository.recentPoolTrades.set(graduated.instanceId, [
      publicTrade(0),
      publicTrade(1),
    ]);
    nowMs += 9_000;
    const cached = (await get(app, url, anonymous)).json<{
      items: unknown[];
      observedAt: string;
    }>();
    expect(cached).toEqual(first);
    nowMs += 2_000;
    const fresh = (await get(app, url, anonymous)).json<{
      items: unknown[];
      observedAt: string;
    }>();
    expect(fresh.items).toHaveLength(2);
    expect(fresh.observedAt).not.toBe(first.observedAt);

    const before = await get(
      app,
      `/v2/launch2/instances/${curve.instanceId}/pool/recent-trades`,
      anonymous,
    );
    expect(before.statusCode).toBe(200);
    expect(before.json<{ items: unknown[] }>().items).toEqual([]);

    const missing = await get(
      app,
      "/v2/launch2/instances/6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4aff/pool/recent-trades",
      anonymous,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ detailsSafe: unknown }>().detailsSafe).toEqual({
      reasonCode: "LAUNCH2_INSTANCE_NOT_FOUND",
    });
    // The LOOP read headers stay required.
    const bare = await app.inject({ method: "GET", url });
    expect(bare.statusCode).toBe(400);
  });

  it("answers 429 RATE_LIMITED with Retry-After above the per-visitor ceiling", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = graduatedInstance();
    repository.instances.set(record.instanceId, record);
    const app = await createApp(repository, {
      env: { PUBLIC_RATE_LIMIT_PER_MINUTE: "10" },
    });
    const anonymous = s7CommonHeaders({ authorization: undefined });
    const url = `/v2/launch2/instances/${record.instanceId}/pool/recent-trades`;
    for (let index = 0; index < 10; index += 1) {
      expect((await get(app, url, anonymous)).statusCode).toBe(200);
    }
    const limited = await get(app, url, anonymous);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^[1-9][0-9]?$/u);
    expect(limited.headers["cache-control"]).toBe("no-store");
    const error = limited.json<Record<string, unknown>>();
    expect(Object.keys(error).sort()).toEqual(errorKeys);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });
});
