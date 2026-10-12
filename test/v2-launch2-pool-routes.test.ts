import type { FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
import { launch2PoolId } from "../src/features/launch2/launch2-pool.js";
import { officialPoolRouterAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  launch2InstanceDetailResourceSchema,
  launch2IntentResourceSchema,
  launch2PoolQuoteSchema,
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
  launch2PoolManager,
  launch2PoolRouter,
  launch2WritesEnv,
  priorityInstance,
  wad,
  type FakeLaunch2PoolState,
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
  memeUsd1,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7IdempotencyKey,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0124 route contract: GET …/pool/quote and POST …/pool/trade/
 * prepare on a graduated instance (official Uniswap v4 pool through
 * OfficialPoolRouter), their 503 / 422 / 409 branches, the wire shapes the
 * OpenAPI schemas publish, and the `pool` block of the instance detail.
 */

const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

/** Decoded ABI args with addresses lower-cased (viem checksums them). */
function lowered(value: unknown): unknown {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowered);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, lowered(entry)]),
    );
  }
  return value;
}

function expectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  for (const key of required) {
    expect(Object.hasOwn(value, key), key).toBe(true);
  }
}

describe("V2 launch2 official-pool routes (Decision 0124)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly repository?: InMemoryLaunch2Repository;
      readonly pool?: FakeLaunch2PoolState | null;
      readonly writes?: boolean;
      readonly allowance?: bigint;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryLaunch2Repository();
    const pool = options.pool === undefined ? defaultPoolState() : options.pool;
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...(pool === null ? {} : launch2PoolEnv),
        ...(options.writes === false ? {} : launch2WritesEnv),
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      launch2PoolChain: pool === null ? null : createFakeLaunch2PoolChain(pool),
      launchChainReadClient: createFakeMemeSlotClient(
        defaultMemeFunds({
          usd1Allowance: options.allowance ?? 0n,
          tokenAllowance: options.allowance ?? 0n,
        }),
      ),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, repository, pool };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });
  const post = (
    app: FastifyInstance,
    url: string,
    payload: unknown,
    key = s7IdempotencyKey(),
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: s7CommandHeaders({ "idempotency-key": key }),
      payload: payload as Record<string, unknown>,
    });

  function seeded(record = graduatedInstance()) {
    const repository = createInMemoryLaunch2Repository();
    repository.instances.set(record.instanceId, record);
    return { repository, record };
  }

  const quoteUrl = (id: string, query: string) =>
    `/v2/launch2/instances/${id}/pool/quote?walletId=${walletId}&${query}`;

  it("answers 503 POOL_ROUTER_NOT_CONFIGURED without the router pair", async () => {
    const { repository, record } = seeded();
    const { app } = await createApp({ repository, pool: null });
    const quote = await get(
      app,
      quoteUrl(record.instanceId, "side=buy&mode=exactIn&amount=10"),
    );
    expect(quote.statusCode).toBe(503);
    expect(Object.keys(quote.json<object>()).sort()).toEqual(errorKeys);
    expect(quote.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "POOL_ROUTER_NOT_CONFIGURED" },
    });
    const prepared = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      { walletId, side: "buy", mode: "exactIn", amount: "10", slippageBps: 50 },
    );
    expect(prepared.statusCode).toBe(503);
    expect(prepared.json()).toMatchObject({
      detailsSafe: { reasonCode: "POOL_ROUTER_NOT_CONFIGURED" },
    });
    // The detail still shows the pool, without a router.
    const detail = await get(app, `/v2/launch2/instances/${record.instanceId}`);
    expect(
      detail.json<{ instance: { pool: { router: string | null } } }>().instance
        .pool.router,
    ).toBeNull();
  });

  it("quotes an exact-input buy by simulating swapExactIn from the wallet with the USD1 balance and allowance overridden", async () => {
    const { repository, record } = seeded();
    const { app, pool } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(
        record.instanceId,
        "side=buy&mode=exactIn&amount=10&slippageBps=100",
      ),
    );
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ quote: Record<string, unknown> }>().quote;
    expectKeys(quote, launch2PoolQuoteSchema.required);
    const gross = 10n * wad * 1_600n;
    const net = gross - (gross * 200n) / 10_000n;
    expect(quote).toMatchObject({
      instanceId: record.instanceId,
      walletId,
      venue: "official_pool",
      side: "buy",
      mode: "exactIn",
      stage: "graduated",
      requestedAmount: "10",
      amountIn: "10",
      maxIn: "10",
      expectedOut: "15680",
      minOut: "15523.2",
      slippageBps: 100,
      taxBps: 200,
      taxAmount: "320",
      taxToken: "meme",
      taxUsd1: "0",
      priceBeforeUsd1: "0.000625",
      averagePriceUsd1: "0.000637755102040816",
      balance: { usd1: "1000", meme: "2000000" },
      exceedsBalance: false,
      router: launch2PoolRouter,
      poolId: record.graduation?.poolId,
      zeroForOne: true,
      deadline: new Date(Number(launch2NowSeconds + 60n) * 1000).toISOString(),
      expiresAt: new Date(Number(launch2NowSeconds + 60n) * 1000).toISOString(),
      quotedAtBlock: "5000",
      basis: { blockNumber: "5000" },
    });
    expect(parseLaunch2Amount(quote["expectedOut"])).toBe(net);
    const key = quote["poolKey"] as {
      currency0: string;
      currency1: string;
      fee: number;
      tickSpacing: number;
      hooks: string;
    };
    expect(key).toEqual({
      currency0: memeUsd1,
      currency1: record.addresses.meme,
      fee: 2500,
      tickSpacing: 60,
      hooks: record.addresses.hook,
    });
    expect(launch2PoolId(key)).toBe(record.graduation?.poolId);
    // The simulation: swapExactIn(key, true, 10e18, 0, wallet, deadline)
    // from the wallet, USD1 balance + allowance overridden to the amount.
    expect(pool?.calls).toHaveLength(1);
    const call = pool!.calls[0]!;
    expect(call.from).toBe(walletAddress);
    expect(call.override).toEqual({
      token: memeUsd1,
      balance: 10n * wad,
      allowance: 10n * wad,
    });
    const decoded = decodeFunctionData({
      abi: officialPoolRouterAbi,
      data: call.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("swapExactIn");
    expect(lowered(decoded.args.slice(1))).toEqual([
      true,
      10n * wad,
      0n,
      walletAddress,
      launch2NowSeconds + 60n,
    ]);
  });

  it("quotes an exact-output sell with the exact tax and maxIn rounded up", async () => {
    const { repository, record } = seeded();
    const { app, pool } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(
        record.instanceId,
        "side=sell&mode=exactOut&amount=49&slippageBps=50",
      ),
    );
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ quote: Record<string, unknown> }>().quote;
    // 49 USD1 net + ceil(49 × 200 / 9800) = 1 tax → 50 gross = 80,000 MEME.
    expect(quote).toMatchObject({
      side: "sell",
      mode: "exactOut",
      amountIn: "80000",
      maxIn: "80400",
      expectedOut: "49",
      minOut: "49",
      taxAmount: "1",
      taxToken: "usd1",
      taxUsd1: "1",
      zeroForOne: false,
      exceedsBalance: false,
    });
    const call = pool!.calls[0]!;
    expect(call.override).toEqual({
      token: record.addresses.meme,
      balance: 2n ** 128n,
      allowance: 2n ** 128n,
    });
    const decoded = decodeFunctionData({
      abi: officialPoolRouterAbi,
      data: call.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("swapExactOut");
    expect(decoded.args.slice(1, 4)).toEqual([false, 49n * wad, 2n ** 128n]);
    // Over the wallet's balance: still quoted, flagged.
    const large = await get(
      app,
      quoteUrl(record.instanceId, "side=sell&mode=exactOut&amount=2000"),
    );
    expect(
      large.json<{ quote: { exceedsBalance: boolean } }>().quote.exceedsBalance,
    ).toBe(true);
  });

  it("refuses a non-graduated instance with 422 POOL_NOT_GRADUATED and validates the query", async () => {
    const repository = createInMemoryLaunch2Repository();
    const priority = priorityInstance();
    repository.instances.set(priority.instanceId, priority);
    const { app } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(priority.instanceId, "side=buy&mode=exactIn&amount=1"),
    );
    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json<object>()).sort()).toEqual(errorKeys);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "POOL_NOT_GRADUATED", stage: "priority" },
    });
    const prepared = await post(
      app,
      `/v2/launch2/instances/${priority.instanceId}/pool/trade/prepare`,
      { walletId, side: "buy", mode: "exactIn", amount: "1", slippageBps: 0 },
    );
    expect(prepared.statusCode).toBe(422);
    expect(prepared.json()).toMatchObject({
      detailsSafe: { reasonCode: "POOL_NOT_GRADUATED" },
    });
    for (const query of [
      "side=hold&mode=exactIn&amount=1",
      "side=buy&mode=exact&amount=1",
      "side=buy&mode=exactIn&amount=1.0000000000000000001",
      "side=buy&mode=exactIn&amount=1&slippageBps=5001",
    ]) {
      const bad = await get(app, quoteUrl(priority.instanceId, query));
      expect(bad.statusCode, query).toBe(400);
    }
    const zero = await get(
      app,
      quoteUrl(graduatedRecordId(repository), "side=buy&mode=exactIn&amount=0"),
    );
    expect(zero.statusCode).toBe(422);
    expect(zero.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_AMOUNT_INVALID" },
    });
  });

  function graduatedRecordId(repository: InMemoryLaunch2Repository): string {
    const record = graduatedInstance();
    repository.instances.set(record.instanceId, record);
    return record.instanceId;
  }

  it("maps simulation reverts to 422 reason codes, never a fixture", async () => {
    const { repository, record } = seeded();
    const pool = defaultPoolState();
    const { app } = await createApp({ repository, pool });
    const url = quoteUrl(record.instanceId, "side=buy&mode=exactOut&amount=1");
    const cases: [FakeLaunch2PoolState["simulation"], string, string?][] = [
      [
        { status: "reverted", errorName: "InsufficientOutput" },
        "POOL_INSUFFICIENT_LIQUIDITY",
      ],
      [
        { status: "reverted", errorName: "InvalidSwapDelta" },
        "POOL_QUOTE_ZERO",
      ],
      [
        { status: "reverted", errorName: "InvalidAmount" },
        "LAUNCH2_AMOUNT_INVALID",
      ],
      [
        { status: "reverted", errorName: "ProtocolFeeChanged" },
        "POOL_QUOTE_UNAVAILABLE",
        "ProtocolFeeChanged",
      ],
      [
        { status: "reverted", errorName: null },
        "POOL_QUOTE_UNAVAILABLE",
        "UNKNOWN",
      ],
      [
        { status: "override_unsupported" },
        "POOL_QUOTE_UNAVAILABLE",
        "STATE_OVERRIDE_UNSUPPORTED",
      ],
      [{ status: "ok", returned: 0n }, "POOL_QUOTE_ZERO"],
    ];
    for (const [simulation, reasonCode, revertReason] of cases) {
      pool.simulation = simulation;
      const response = await get(app, url);
      expect(response.statusCode, reasonCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        detailsSafe: {
          reasonCode,
          ...(revertReason === undefined ? {} : { revertReason }),
        },
      });
    }
  });

  it("fails closed (503) on a router code mismatch, a PoolManager mismatch, a PoolKey mismatch, and a chain read failure", async () => {
    const { repository, record } = seeded();
    const pool = defaultPoolState();
    const { app } = await createApp({ repository, pool });
    const url = quoteUrl(record.instanceId, "side=buy&mode=exactIn&amount=1");
    const expectReason = async (reasonCode: string) => {
      const response = await get(app, url);
      expect(response.statusCode, reasonCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode },
      });
    };
    pool.routerCheck = {
      status: "unavailable",
      reasonCode: "POOL_ROUTER_CODE_MISMATCH",
    };
    await expectReason("POOL_ROUTER_CODE_MISMATCH");
    pool.routerCheck = { status: "ok", poolManager: launch2PoolManager };
    pool.hookPoolManager = "0x7777777777777777777777777777777777777777";
    await expectReason("POOL_ROUTER_MANAGER_MISMATCH");
    pool.hookPoolManager = launch2PoolManager;
    pool.currency0 = record.addresses.meme;
    await expectReason("POOL_KEY_MISMATCH");
    pool.currency0 = null;
    // A recorded pool id that is not keccak256(key).
    repository.instances.set(record.instanceId, {
      ...record,
      graduation: {
        ...(record.graduation as NonNullable<typeof record.graduation>),
        poolId: `0x${"12".repeat(32)}`,
      },
    });
    await expectReason("POOL_KEY_MISMATCH");
    repository.instances.set(record.instanceId, record);
    pool.failRead = true;
    await expectReason("LAUNCH2_CHAIN_READ_FAILED");
    expect(pool.calls).toHaveLength(0);
  });

  it("prepares an exact-input buy: the router call, an exact USD1 approve, the simulation with the allowance overridden, and the quote; replays it", async () => {
    const { repository, record } = seeded();
    const { app, pool } = await createApp({ repository });
    const url = `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`;
    const body = {
      walletId,
      side: "buy",
      mode: "exactIn",
      amount: "10",
      slippageBps: 100,
    };
    const created = await post(app, url, body);
    expect(created.statusCode).toBe(201);
    const payload = created.json<{
      launch2Intent: Record<string, unknown>;
      quote: Record<string, unknown>;
      contractVersion: string;
    }>();
    expect(payload.contractVersion).toBe("2.0");
    const intent = payload.launch2Intent;
    expectKeys(
      intent,
      launch2IntentResourceSchema.properties.launch2Intent.required,
    );
    expectKeys(payload.quote, launch2PoolQuoteSchema.required);
    expect(intent).toMatchObject({
      kind: "pool_buy",
      state: "prepared",
      contractAddress: launch2PoolRouter,
      amountIn: "10",
      expectedOut: "15680",
      minOut: "15523.2",
      taxUsd1: "0",
      refundUsd1: "0",
      calldata: { to: launch2PoolRouter, value: "0" },
      simulation: { status: "passed", reasonCode: null },
      signing: { mode: "device_eth_send_transaction", allowed: true },
      approval: {
        token: memeUsd1,
        spender: launch2PoolRouter,
        amount: "10",
      },
      unsignedTransaction: {
        chainId: 97,
        to: launch2PoolRouter,
        value: "0x0",
        gas: "0x34bc0",
        nonce: "0x8",
      },
    });
    expect(payload.quote).toMatchObject({
      venue: "official_pool",
      expectedOut: "15680",
      minOut: "15523.2",
    });
    const decoded = decodeFunctionData({
      abi: officialPoolRouterAbi,
      data: (intent["calldata"] as { data: `0x${string}` }).data,
    });
    expect(decoded.functionName).toBe("swapExactIn");
    expect(lowered(decoded.args)).toEqual([
      {
        currency0: memeUsd1,
        currency1: record.addresses.meme,
        fee: 2500,
        tickSpacing: 60,
        hooks: record.addresses.hook,
      },
      true,
      10n * wad,
      15_523_200_000_000_000_000_000n,
      walletAddress,
      // Decision 0126: the trade deadline (default 180 s), not the quote TTL.
      launch2NowSeconds + 180n,
    ]);
    const tradeDeadline = new Date(
      Number(launch2NowSeconds + 180n) * 1000,
    ).toISOString();
    expect(intent["deadline"]).toBe(tradeDeadline);
    expect(intent["expiresAt"]).toBe(tradeDeadline);
    expect(payload.quote["deadline"]).toBe(tradeDeadline);
    expect(payload.quote["expiresAt"]).toBe(tradeDeadline);
    // Re-simulated at the prepare: the quote pass (full override) and the
    // signable call (allowance only), both encoding the trade deadline.
    expect(pool!.calls).toHaveLength(2);
    for (const call of pool!.calls) {
      const args = decodeFunctionData({
        abi: officialPoolRouterAbi,
        data: call.data as `0x${string}`,
      }).args;
      expect(args.at(-1)).toBe(launch2NowSeconds + 180n);
    }
    // Quote simulation, then the prepare's: allowance overridden, real
    // balance (the approve is pending).
    expect(pool!.calls.at(-1)?.override).toEqual({
      token: memeUsd1,
      balance: null,
      allowance: 10n * wad,
    });
    expect(pool!.estimates.at(-1)?.data).toBe(
      (intent["calldata"] as { data: string }).data,
    );
    expect(JSON.stringify(payload)).not.toMatch(/signature|privateKey/iu);
    // Idempotent replay: the same intent and the stored quote.
    const replay = await post(app, url, body);
    expect(replay.statusCode).toBe(201);
    const again = replay.json<typeof payload>();
    expect(again.launch2Intent["intentId"]).toBe(intent["intentId"]);
    expect(again.quote).toEqual(payload.quote);
    expect(repository.builds.count).toBe(1);
    // Same key, other body: idempotency conflict.
    const conflict = await post(
      app,
      url,
      { ...body, amount: "11" },
      s7IdempotencyKey(),
    );
    expect(conflict.statusCode).toBe(409);
  });

  it("prepares an exact-output sell with swapExactOut and a MEME approve for maxIn; refuses a short balance and a reverted simulation is not signable", async () => {
    const { repository, record } = seeded();
    const pool = defaultPoolState();
    const { app } = await createApp({ repository, pool });
    const url = `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`;
    const created = await post(app, url, {
      walletId,
      side: "sell",
      mode: "exactOut",
      amount: "49",
      slippageBps: 50,
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json<{ launch2Intent: Record<string, unknown> }>()
      .launch2Intent;
    expect(intent).toMatchObject({
      kind: "pool_sell",
      amountIn: "80400",
      expectedOut: "49",
      minOut: "49",
      taxUsd1: "1",
      approval: { token: record.addresses.meme, amount: "80400" },
    });
    const decoded = decodeFunctionData({
      abi: officialPoolRouterAbi,
      data: (intent["calldata"] as { data: `0x${string}` }).data,
    });
    expect(decoded.functionName).toBe("swapExactOut");
    expect(lowered(decoded.args.slice(1, 5))).toEqual([
      false,
      49n * wad,
      80_400n * wad,
      walletAddress,
    ]);
    // More MEME than the wallet holds.
    const short = await post(
      app,
      url,
      {
        walletId,
        side: "sell",
        mode: "exactIn",
        amount: "3000000",
        slippageBps: 0,
      },
      s7IdempotencyKey("b"),
    );
    expect(short.statusCode).toBe(409);
    expect(short.json()).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      detailsSafe: {
        reasonCode: "LAUNCH2_MEME_BALANCE_INSUFFICIENT",
        maxAmountIn: "2000000",
        requiredAmountIn: "3000000",
        balanceMeme: "2000000",
      },
    });
    // The quote passes, the prepare's own simulation (real balance,
    // allowance overridden) reverts: prepared, but not signable.
    pool.prepareReverts = true;
    const reverted = await post(
      app,
      url,
      { walletId, side: "buy", mode: "exactIn", amount: "5", slippageBps: 0 },
      s7IdempotencyKey("c"),
    );
    expect(reverted.statusCode).toBe(201);
    expect(
      reverted.json<{ launch2Intent: Record<string, unknown> }>().launch2Intent,
    ).toMatchObject({
      simulation: {
        status: "reverted",
        reasonCode: "LAUNCH2_SIMULATION_REVERTED",
      },
      signing: {
        allowed: false,
        reasonCode: "LAUNCH2_SIMULATION_REVERTED",
      },
    });
  });

  it("keeps the prepare 503 while BSC writes are disabled", async () => {
    const { repository, record } = seeded();
    const { app } = await createApp({ repository, writes: false });
    const response = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      { walletId, side: "buy", mode: "exactIn", amount: "1", slippageBps: 0 },
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_WRITES_DISABLED" },
    });
  });

  it("skips the approve when the allowance covers the input", async () => {
    const { repository, record } = seeded();
    const { app } = await createApp({ repository, allowance: 10n ** 30n });
    const response = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      { walletId, side: "buy", mode: "exactIn", amount: "1", slippageBps: 0 },
    );
    expect(response.statusCode).toBe(201);
    const intent = response.json<{ launch2Intent: Record<string, unknown> }>()
      .launch2Intent;
    expect(intent["approval"]).toBeNull();
    expect(intent["unsignedTransaction"]).toMatchObject({ nonce: "0x7" });
  });

  it("details the official pool of a graduated instance (and null before)", async () => {
    const record = graduatedInstance({
      pool: {
        tradeCount: "3",
        buyCount: "2",
        sellCount: "1",
        buyVolumeUsd1: (150n * wad).toString(10),
        sellVolumeUsd1: (40n * wad).toString(10),
        volume24hUsd1: (190n * wad).toString(10),
        taxUsd1: ((8n * wad) / 10n).toString(10),
        taxMeme: (4_800n * wad).toString(10),
        lastPriceE18: "625000000000000",
        lastTradeAt: new Date(
          Number(launch2NowSeconds - 30n) * 1000,
        ).toISOString(),
        // Decision 0127: one of the two buys was a buyback (100 USD1).
        userTradeCount: "2",
        userBuyVolumeUsd1: (50n * wad).toString(10),
        userSellVolumeUsd1: (40n * wad).toString(10),
      },
    });
    const { repository } = seeded(record);
    const priority = priorityInstance();
    repository.instances.set(priority.instanceId, priority);
    const { app } = await createApp({ repository });
    const detail = await get(app, `/v2/launch2/instances/${record.instanceId}`);
    expect(detail.statusCode).toBe(200);
    const instance = detail.json<{ instance: Record<string, unknown> }>()
      .instance;
    expectKeys(
      instance,
      launch2InstanceDetailResourceSchema.properties.instance.required,
    );
    expect(instance["pool"]).toEqual({
      poolId: record.graduation?.poolId,
      router: launch2PoolRouter,
      tradeCount: "3",
      buyCount: "2",
      sellCount: "1",
      buyVolumeUsd1: "150",
      sellVolumeUsd1: "40",
      volume24hUsd1: "190",
      taxUsd1: "0.8",
      taxMeme: "4800",
      lastPriceUsd1: "0.000625",
      lastTradeAt: new Date(
        Number(launch2NowSeconds - 30n) * 1000,
      ).toISOString(),
      userTradeCount: "2",
      userBuyVolumeUsd1: "50",
      userSellVolumeUsd1: "40",
    });
    const before = await get(
      app,
      `/v2/launch2/instances/${priority.instanceId}`,
    );
    expect(
      before.json<{ instance: Record<string, unknown> }>().instance["pool"],
    ).toBeNull();
  });
});
