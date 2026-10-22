import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { formatLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
import type {
  Launch2CostTradeRecord,
  Launch2PositionRecord,
} from "../src/features/launch2/launch2-ports.js";
import {
  launch2InstanceDetailResourceSchema,
  launch2PositionPnlProperties,
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
 * Decision 0176 route contract: the optional moving-average cost / PnL
 * keys of `GET /v2/launch2/me/positions` rows and of the instance detail's
 * `viewer` — only with LAUNCH2_PNL_EMIT=on; one trade read per request.
 */

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const pnlKeys = Object.keys(launch2PositionPnlProperties).sort();
const milli = 10n ** 15n;

const curveId = "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a01";
const pricedId = "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a02";
const unpricedId = "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a03";
const quietId = "6f0e0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a04";

function position(instanceId: string): Launch2PositionRecord {
  return {
    instanceId,
    holderAddress: walletAddress,
    nftMintedTokenId: null,
    nftHeld: 0,
    curveBought: (1_200n * wad).toString(),
    curveSold: (200n * wad).toString(),
    cumulativeBought: (1_200n * wad).toString(),
    usd1Spent: (1_200n * milli).toString(),
    usd1Received: (250n * milli).toString(),
    taxUsd1: "0",
    buyCount: 1,
    sellCount: 1,
    snapshotMember: false,
    lastActivityAt: iso(launch2NowSeconds - 100n),
  };
}

function trade(
  instanceId: string,
  source: "curve" | "pool",
  side: "buy" | "sell",
  meme: bigint,
  usd1: bigint,
  block: number,
): Launch2CostTradeRecord {
  return {
    instanceId,
    holderAddress: walletAddress,
    source,
    side,
    memeAmount: meme.toString(),
    usd1Amount: usd1.toString(),
    blockNumber: String(block),
    logIndex: 1,
  };
}

/** Curve: buy 1 200 MEME for 1.2 USD1 (avg 0.001), sell 200 for 0.25. */
function curveTrades(instanceId: string): Launch2CostTradeRecord[] {
  return [
    trade(instanceId, "curve", "buy", 1_200n * wad, 1_200n * milli, 100),
    trade(instanceId, "curve", "sell", 200n * wad, 250n * milli, 101),
  ];
}

describe("V2 launch2 position cost and PnL (Decision 0176)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    repository: InMemoryLaunch2Repository,
    env: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig({ ...launch2Env, ...launch2PoolEnv, ...env }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(
        defaultChainState({
          memeBalance: 15_680n * wad,
          usd1Balance: 990n * wad,
        }),
      ),
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

  function seeded() {
    const repository = createInMemoryLaunch2Repository();
    const curve = priorityInstance({ instanceId: curveId });
    const base = graduatedInstance({ instanceId: pricedId });
    const priced = graduatedInstance({
      instanceId: pricedId,
      pool: {
        ...base.pool,
        tradeCount: "1",
        buyCount: "1",
        lastPriceE18: "625000000000000",
        lastTradeAt: iso(launch2NowSeconds - 20n),
      },
    });
    const unpriced = graduatedInstance({ instanceId: unpricedId });
    const quiet = priorityInstance({ instanceId: quietId });
    for (const record of [curve, priced, unpriced, quiet]) {
      repository.instances.set(record.instanceId, record);
      repository.positions.push(position(record.instanceId));
    }
    repository.costTrades.push(
      ...curveTrades(curveId),
      // Graduated: the curve trades, then a pool buy of 14 680 MEME for
      // 9 USD1 — 15 680 traded = the live balance.
      trade(pricedId, "pool", "buy", 14_680n * wad, 9n * wad, 300),
      ...curveTrades(pricedId),
      // Only 1 000 traded but 15 680 held: transfers → partial.
      ...curveTrades(unpricedId),
    );
    return { repository, curve, priced, unpriced };
  }

  it("omits the cost / PnL keys while LAUNCH2_PNL_EMIT is off (default) and reads no trades", async () => {
    const { repository } = seeded();
    const app = await createApp(repository);
    const rows = (await get(app, "/v2/launch2/me/positions")).json<{
      positions: Record<string, unknown>[];
    }>().positions;
    expect(rows).toHaveLength(4);
    const required =
      launch2PositionsResourceSchema.properties.positions.items.required;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...required].sort());
      for (const key of pnlKeys) expect(row).not.toHaveProperty(key);
    }
    const detail = await get(app, `/v2/launch2/instances/${pricedId}`);
    expect(detail.statusCode).toBe(200);
    const viewer = detail.json<{
      instance: { viewer: Record<string, unknown> };
    }>().instance.viewer;
    for (const key of pnlKeys) expect(viewer).not.toHaveProperty(key);
    expect(repository.listCostTradesCalls).toHaveLength(0);
  });

  it("emits the moving-average cost and PnL per row from one trade read", async () => {
    const { repository } = seeded();
    const app = await createApp(repository, {
      LAUNCH2_PNL_EMIT: "on",
      LAUNCH2_POSITION_VALUE_EMIT: "on",
    });
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ positions: Record<string, unknown>[] }>()
      .positions;
    const required =
      launch2PositionsResourceSchema.properties.positions.items.required;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          ...required,
          ...pnlKeys,
          "priceSource",
          "priceUsd1",
          "valueUsd1",
        ].sort(),
      );
    }
    expect(repository.listCostTradesCalls).toEqual([
      { holderAddresses: [walletAddress], instanceId: null },
    ]);
    const byId = new Map(rows.map((row) => [row["instanceId"], row]));
    // Curve: avg 0.001; 200 sold for 0.25 (cost 0.2) → realized 0.05;
    // 1 000 held at the curve price 0.00004166666625.
    expect(byId.get(curveId)).toMatchObject({
      priceUsd1: "0.00004166666625",
      avgCostUsd1: "0.001",
      costBasisUsd1: "1",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: "-0.95833333375",
      costCoverage: "full",
    });
    // Graduated: cost 1 + 9 = 10 for 15 680 MEME (= memeBalance), priced
    // at the pool's last price — the same price as S280's priceUsd1.
    const avg = (10n * wad * wad) / (15_680n * wad);
    expect(byId.get(pricedId)).toMatchObject({
      memeBalance: "15680",
      priceUsd1: "0.000625",
      avgCostUsd1: formatLaunch2Amount(avg),
      costBasisUsd1: "10",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: formatLaunch2Amount(
        ((625_000_000_000_000n - avg) * 15_680n * wad) / wad,
      ),
      costCoverage: "full",
    });
    // Held more than traded (transfer in): partial; no pool price → no
    // unrealized PnL.
    expect(byId.get(unpricedId)).toMatchObject({
      memeBalance: "15680",
      priceUsd1: null,
      avgCostUsd1: "0.001",
      costBasisUsd1: "1",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: null,
      costCoverage: "partial",
    });
    // A position without any trade: all five null.
    const quiet = byId.get(quietId)!;
    for (const key of pnlKeys) expect(quiet[key]).toBeNull();
  });

  it("adds the same keys to the instance detail's viewer (one trade read for that instance)", async () => {
    const { repository } = seeded();
    const app = await createApp(repository, { LAUNCH2_PNL_EMIT: "on" });
    const detail = await get(app, `/v2/launch2/instances/${curveId}`);
    expect(detail.statusCode).toBe(200);
    const instance = detail.json<{
      instance: Record<string, unknown> & {
        viewer: Record<string, unknown>;
      };
    }>().instance;
    const viewerSchema =
      launch2InstanceDetailResourceSchema.properties.instance.properties.viewer
        .anyOf[0];
    expect(Object.keys(instance.viewer).sort()).toEqual(
      [...viewerSchema.required, ...pnlKeys].sort(),
    );
    expect(instance.viewer).toMatchObject({
      avgCostUsd1: "0.001",
      costBasisUsd1: "1",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: "-0.95833333375",
      costCoverage: "full",
    });
    expect(repository.listCostTradesCalls).toEqual([
      { holderAddresses: [walletAddress], instanceId: curveId },
    ]);
    const quiet = await get(app, `/v2/launch2/instances/${quietId}`);
    const quietViewer = quiet.json<{
      instance: { viewer: Record<string, unknown> };
    }>().instance.viewer;
    for (const key of pnlKeys) expect(quietViewer[key]).toBeNull();
  });

  it("does not read trades for an empty position list", async () => {
    const repository = createInMemoryLaunch2Repository();
    const app = await createApp(repository, { LAUNCH2_PNL_EMIT: "on" });
    const response = await get(app, "/v2/launch2/me/positions");
    expect(response.json()).toEqual({ positions: [], contractVersion: "2.0" });
    expect(repository.listCostTradesCalls).toHaveLength(0);
  });
});
