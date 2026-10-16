import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { launch2DynamicReasonMessagesZh } from "../src/features/launch2/launch2-dynamic.js";
import {
  loopDynamicHookAbi,
  loopRouterAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  launch2DynamicClaimIntentResourceSchema,
  launch2DynamicClaimReportResourceSchema,
  launch2DynamicPoolResourceSchema,
  launch2DynamicRewardsResourceSchema,
  launch2PoolQuoteSchema,
} from "../src/routes/v2/launch2-schemas.js";
import {
  createFakeLaunch2DynamicChain,
  defaultDynamicState,
  dynamicPoolIdFor,
  graduatedDynamicInstance,
  launch2DynamicHook,
  launch2DynamicHookS209,
  launch2LoopRouter,
  type FakeLaunch2DynamicState,
} from "./helpers/launch2-dynamic-fakes.js";
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
  launch2WritesEnv,
  priorityInstance,
  wad,
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
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0131 route contract: the LoopDynamic Hook kind — GET
 * …/dynamic-pool (every instance answers its hookKind), GET
 * …/dynamic-pool/rewards, POST …/dynamic-pool/claim/{prepare,report}, and
 * the LoopDynamic branch of …/pool/quote and …/pool/trade/prepare
 * (LoopRouter.swapExactInput, exactIn only). OfficialTax answers are
 * unchanged.
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

describe("V2 launch2 LoopDynamic routes (Decision 0131)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly repository?: InMemoryLaunch2Repository;
      readonly dynamic?: FakeLaunch2DynamicState | null;
      readonly writes?: boolean;
      readonly allowance?: bigint;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryLaunch2Repository();
    const dynamic =
      options.dynamic === undefined ? defaultDynamicState() : options.dynamic;
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2PoolEnv,
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
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launch2DynamicChain:
        dynamic === null ? null : createFakeLaunch2DynamicChain(dynamic),
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
    return { app, repository, dynamic };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });
  const post = (
    app: FastifyInstance,
    url: string,
    payload: unknown,
    key: string = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: s7CommandHeaders({ "idempotency-key": key }),
      payload: payload as Record<string, unknown>,
    });

  function seeded(record = graduatedDynamicInstance()) {
    const repository = createInMemoryLaunch2Repository();
    repository.instances.set(record.instanceId, record);
    return { repository, record };
  }

  function expectSchemaKeys(
    value: Record<string, unknown>,
    schema: { readonly required: readonly string[] },
  ) {
    expect(Object.keys(value).sort()).toEqual([...schema.required].sort());
  }

  it("answers hookKind for every instance: officialTax not_applicable, LoopDynamic not_graduated", async () => {
    const official = graduatedInstance();
    const upcoming = priorityInstance({
      addresses: {
        ...priorityInstance().addresses,
        hook: "0x0000000000000000000000000000000000000000",
      },
      poolHookKind: "loopDynamic",
    });
    const repository = createInMemoryLaunch2Repository();
    repository.instances.set(official.instanceId, official);
    repository.instances.set(upcoming.instanceId, upcoming);
    const { app } = await createApp({ repository });
    const a = await get(
      app,
      `/v2/launch2/instances/${official.instanceId}/dynamic-pool`,
    );
    expect(a.statusCode).toBe(200);
    const body = a.json<{ dynamicPool: Record<string, unknown> }>();
    expectSchemaKeys(body, launch2DynamicPoolResourceSchema);
    expectSchemaKeys(
      body.dynamicPool,
      launch2DynamicPoolResourceSchema.properties.dynamicPool,
    );
    expect(body.dynamicPool).toMatchObject({
      hookKind: "officialTax",
      status: "not_applicable",
      hook: null,
      armed: null,
      candleSeconds: 300,
    });
    const b = await get(
      app,
      `/v2/launch2/instances/${upcoming.instanceId}/dynamic-pool`,
    );
    expect(b.json()).toMatchObject({
      dynamicPool: { hookKind: "loopDynamic", status: "not_graduated" },
    });
  });

  it("reads the bound Hook at one block with the viewer's weight", async () => {
    const { repository, record } = seeded();
    repository.dynamicSummaries.set(record.instanceId, {
      roundCount: 3,
      closedRoundCount: 2,
      allocatedUsd1: (30n * wad).toString(),
      claimedUsd1: (12n * wad).toString(),
      extraFeesUsd1: (70n * wad).toString(),
      baseSellFeesUsd1: (4n * wad).toString(),
      buyFeesMeme: (1_000n * wad).toString(),
      buyFeesUsd1: "0",
      lastRound: null,
    });
    const { app } = await createApp({ repository });
    const response = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool?walletId=${walletId}`,
    );
    expect(response.statusCode).toBe(200);
    const pool = response.json<{ dynamicPool: Record<string, unknown> }>()
      .dynamicPool;
    expectSchemaKeys(
      pool,
      launch2DynamicPoolResourceSchema.properties.dynamicPool,
    );
    expect(pool).toMatchObject({
      hookKind: "loopDynamic",
      status: "active",
      hook: launch2DynamicHook,
      router: launch2LoopRouter,
      routingPolicy: "open",
      priceTiming: "POST_SWAP",
      buyTaxBps: 200,
      baseSellTaxBps: 200,
      excludeBuybackFromRewards: true,
      armed: true,
      currentRoundId: "3",
      rollPending: false,
      currentDropWad: "0.3",
      currentDropBps: 3000,
      // Decision 0144: an uncapped S193 Hook.
      maxDynamicFeeWad: "0",
      maxDynamicFeeBps: 0,
      currentDynamicTaxBps: 3000,
      roundCloseRule: "closeAtOrAboveOpen",
      armedAfterRoll: true,
      potUsd1: "45",
      carryUsd1: "40",
      roundExtraFeesUsd1: "5",
      roundTotalBuyWeightUsd1: "100",
      reservedRewardsUsd1: "10",
      priceUsd1: "0.000625",
      viewer: {
        walletId,
        currentRoundWeightUsd1: "25",
        // Decision 0146: nothing indexed for the wallet yet.
        indexedCurrentRoundWeightUsd1: "0",
        weightReconciled: false,
      },
      currentRoundBuyers: { roundId: "3", buyerCount: 0, buyers: [] },
      summary: {
        roundCount: 3,
        closedRoundCount: 2,
        allocatedUsd1: "30",
        claimedUsd1: "12",
        dynamicFeesUsd1: "70",
        baseSellFeesUsd1: "4",
        buyFeesMeme: "1000",
      },
      basis: { blockNumber: "6000" },
    });
  });

  it("lists the armed round's buyers by merged weight and reconciles the viewer with buyWeight (Decision 0146)", async () => {
    const { repository, record } = seeded();
    const aggregator = `0x${"a9".repeat(20)}`;
    const at = new Date(1_799_000_100_000).toISOString();
    // Chain: buyWeight(3, wallet) = 25 (fake Hook). Projection: the wallet
    // got 20 by delivery and 5 forwarded by an aggregator that kept 1.
    repository.dynamicRoundBuyers.set(`${record.instanceId}|3`, [
      {
        address: walletAddress,
        weightUsd1: (25n * wad).toString(),
        creditedUsd1: (20n * wad).toString(),
        movedInUsd1: (5n * wad).toString(),
        movedOutUsd1: "0",
        creditCount: 2,
        attributions: ["delivery", "moved"],
        lastCreditedAt: at,
      },
      {
        address: aggregator,
        weightUsd1: (1n * wad).toString(),
        creditedUsd1: (6n * wad).toString(),
        movedInUsd1: "0",
        movedOutUsd1: (5n * wad).toString(),
        creditCount: 1,
        attributions: ["delivery"],
        lastCreditedAt: at,
      },
    ]);
    const { app } = await createApp({ repository });
    const url = `/v2/launch2/instances/${record.instanceId}/dynamic-pool?walletId=${walletId}`;
    let pool = (await get(app, url)).json<{
      dynamicPool: Record<string, unknown>;
    }>().dynamicPool;
    expect(pool["currentRoundBuyers"]).toEqual({
      roundId: "3",
      buyerCount: 2,
      buyers: [
        {
          address: walletAddress,
          weightUsd1: "25",
          creditedUsd1: "20",
          movedInUsd1: "5",
          movedOutUsd1: "0",
          creditCount: 2,
          attributions: ["delivery", "moved"],
          lastCreditedAt: at,
        },
        {
          address: aggregator,
          weightUsd1: "1",
          creditedUsd1: "6",
          movedInUsd1: "0",
          movedOutUsd1: "5",
          creditCount: 1,
          attributions: ["delivery"],
          lastCreditedAt: at,
        },
      ],
    });
    expect(pool["viewer"]).toEqual({
      walletId,
      currentRoundWeightUsd1: "25",
      indexedCurrentRoundWeightUsd1: "25",
      weightReconciled: true,
    });
    // The index lags (or diverges): the projection still has 20.
    repository.dynamicRoundBuyers.set(`${record.instanceId}|3`, [
      {
        address: walletAddress,
        weightUsd1: (20n * wad).toString(),
        creditedUsd1: (20n * wad).toString(),
        movedInUsd1: "0",
        movedOutUsd1: "0",
        creditCount: 1,
        attributions: ["delivery"],
        lastCreditedAt: at,
      },
    ]);
    pool = (await get(app, url)).json<{
      dynamicPool: Record<string, unknown>;
    }>().dynamicPool;
    expect(pool["viewer"]).toEqual({
      walletId,
      currentRoundWeightUsd1: "25",
      indexedCurrentRoundWeightUsd1: "20",
      weightReconciled: false,
    });
  });

  it("fails closed: no LoopRouter configured, Hook not indexed, Hook not trusting the router", async () => {
    const { repository, record } = seeded();
    const unindexed = graduatedDynamicInstance({ dynamicPool: null });
    repository.instances.set(unindexed.instanceId, unindexed);
    const none = await createApp({ repository, dynamic: null });
    const off = await get(
      none.app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
    );
    expect(off.statusCode).toBe(503);
    expect(Object.keys(off.json<object>()).sort()).toEqual(errorKeys);
    expect(off.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      // Decision 0132: the registry's Hook kind rides on dependency 503s.
      detailsSafe: {
        reasonCode: "LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED",
        hookKind: "loopDynamic",
      },
    });
    const { app } = await createApp({ repository });
    const pending = await get(
      app,
      `/v2/launch2/instances/${unindexed.instanceId}/dynamic-pool`,
    );
    expect(pending.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED",
        hookKind: "loopDynamic",
      },
    });
    expect(Object.keys(pending.json<object>()).sort()).toEqual(errorKeys);
    const foreignRead = await createApp({
      repository,
      dynamic: defaultDynamicState({
        hook: { trustedRouter: "0x1212121212121212121212121212121212121212" },
      }),
    });
    const foreignPool = await get(
      foreignRead.app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
    );
    expect(foreignPool.statusCode).toBe(503);
    const down = await createApp({
      repository,
      dynamic: { ...defaultDynamicState(), failRead: true },
    });
    const downPool = await get(
      down.app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
    );
    expect(downPool.statusCode).toBe(503);
    expect(downPool.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "LAUNCH2_CHAIN_READ_FAILED",
        hookKind: "loopDynamic",
      },
    });
    expect(foreignPool.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH",
        hookKind: "loopDynamic",
      },
    });
    const foreign = await createApp({
      repository,
      dynamic: defaultDynamicState({
        hook: { trustedRouter: "0x1212121212121212121212121212121212121212" },
      }),
    });
    const mismatch = await get(
      foreign.app,
      `/v2/launch2/instances/${record.instanceId}/pool/quote?walletId=${walletId}&side=buy&mode=exactIn&amount=10`,
    );
    expect(mismatch.statusCode).toBe(503);
    expect(mismatch.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH" },
    });
  });

  const quoteUrl = (id: string, query: string) =>
    `/v2/launch2/instances/${id}/pool/quote?walletId=${walletId}&${query}`;

  it("refuses exactOut with 422 LAUNCH2_EXACT_OUT_UNSUPPORTED before any chain read", async () => {
    const { repository, record } = seeded();
    const { app, dynamic } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(record.instanceId, "side=buy&mode=exactOut&amount=10"),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "LAUNCH2_EXACT_OUT_UNSUPPORTED" },
    });
    expect(dynamic?.swaps).toHaveLength(0);
    const prepared = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      {
        walletId,
        side: "sell",
        mode: "exactOut",
        amount: "1",
        slippageBps: 50,
      },
    );
    expect(prepared.statusCode).toBe(422);
    expect(prepared.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_EXACT_OUT_UNSUPPORTED" },
    });
  });

  it("quotes a buy through LoopRouter with the 2 % MEME buy fee and the reward weight", async () => {
    const { repository, record } = seeded();
    const { app, dynamic } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(
        record.instanceId,
        "side=buy&mode=exactIn&amount=10&slippageBps=100",
      ),
    );
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ quote: Record<string, unknown> }>().quote;
    expectSchemaKeys(quote, {
      required: [...launch2PoolQuoteSchema.required, "dynamic"],
    });
    expect(quote).toMatchObject({
      side: "buy",
      mode: "exactIn",
      amountIn: "10",
      expectedOut: "15680",
      minOut: "15523.2",
      taxBps: 200,
      taxAmount: "320",
      taxToken: "meme",
      taxUsd1: "0",
      router: launch2LoopRouter,
      poolId: record.graduation?.poolId,
      dynamic: {
        hookKind: "loopDynamic",
        hook: launch2DynamicHook,
        priceTiming: "POST_SWAP",
        baseTaxBps: 200,
        baseTaxAmount: "320",
        dynamicTaxBps: 0,
        dynamicTaxAmount: "0",
        armed: true,
        roundId: "3",
        rewardWeight: "10",
      },
    });
    const call = dynamic!.swaps[0]!;
    expect(call.from).toBe(walletAddress);
    expect(call.neutralHook).toBeNull();
    expect(call.override).toEqual({
      token: memeUsd1,
      balance: 10n * wad,
      allowance: 10n * wad,
    });
    const decoded = decodeFunctionData({
      abi: loopRouterAbi,
      data: call.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("swapExactInput");
    expect(
      (decoded.args[0] as { readonly hooks: string }).hooks.toLowerCase(),
    ).toBe(launch2DynamicHook);
    expect(decoded.args.slice(1, 4)).toEqual([true, 10n * wad, 0n]);
  });

  it("quotes an S209 Hook's buy fee from the USD1 input (Decision 0152)", async () => {
    const base = graduatedDynamicInstance();
    const poolId = dynamicPoolIdFor(
      base.addresses.meme,
      launch2DynamicHookS209,
    );
    const record = graduatedDynamicInstance({
      dynamicPool: { hook: launch2DynamicHookS209, poolId, boundBlock: "4000" },
      graduation: {
        ...(base.graduation as NonNullable<typeof base.graduation>),
        poolId,
      },
    });
    const { repository } = seeded(record);
    const { app } = await createApp({
      repository,
      dynamic: defaultDynamicState({ hook: { poolId } }),
    });
    const response = await get(
      app,
      quoteUrl(
        record.instanceId,
        "side=buy&mode=exactIn&amount=10&slippageBps=100",
      ),
    );
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ quote: Record<string, unknown> }>().quote;
    // 10 USD1: 0.2 USD1 fee, 9.8 swapped → 15,680 MEME, untaxed.
    expect(quote).toMatchObject({
      amountIn: "10",
      expectedOut: "15680",
      taxBps: 200,
      taxAmount: "0.2",
      taxToken: "usd1",
      taxUsd1: "0.2",
      dynamic: {
        hook: launch2DynamicHookS209,
        baseTaxBps: 200,
        baseTaxAmount: "0.2",
        baseTaxToken: "usd1",
        // The weight is what the buyer paid.
        rewardWeight: "10",
      },
    });
    const pool = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool?walletId=${walletId}`,
    );
    expect(pool.statusCode).toBe(200);
    expect(
      pool.json<{ dynamicPool: Record<string, unknown> }>().dynamicPool,
    ).toMatchObject({ buyFeeToken: "usd1", buyTaxBps: 200 });
  });

  it("refuses a Hook whose address bits are neither generation (Decision 0152)", async () => {
    const odd = `0x${"c".repeat(36)}20cc`;
    const base = graduatedDynamicInstance();
    const poolId = dynamicPoolIdFor(base.addresses.meme, odd);
    const record = graduatedDynamicInstance({
      dynamicPool: { hook: odd, poolId, boundBlock: "4000" },
      graduation: {
        ...(base.graduation as NonNullable<typeof base.graduation>),
        poolId,
      },
    });
    const { repository } = seeded(record);
    const { app } = await createApp({
      repository,
      dynamic: defaultDynamicState({ hook: { poolId } }),
    });
    const response = await get(
      app,
      quoteUrl(record.instanceId, "side=buy&mode=exactIn&amount=10"),
    );
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).toContain("HOOK_MISMATCH");
  });

  it("splits a sell's fee into the 2 % base and the dynamic fee from a neutral simulation", async () => {
    const { repository, record } = seeded();
    const { app, dynamic } = await createApp({ repository });
    const response = await get(
      app,
      quoteUrl(record.instanceId, "side=sell&mode=exactIn&amount=160000"),
    );
    expect(response.statusCode).toBe(200);
    // 160,000 MEME = 100 USD1 gross; base 2 = 2; dynamic 30 % of 98 = 29.4.
    expect(response.json()).toMatchObject({
      quote: {
        side: "sell",
        expectedOut: "68.6",
        taxBps: 200,
        taxAmount: "31.4",
        taxToken: "usd1",
        taxUsd1: "31.4",
        dynamic: {
          baseTaxAmount: "2",
          dynamicTaxBps: 3000,
          dynamicTaxAmount: "29.4",
          rewardWeight: "0",
        },
      },
    });
    expect(dynamic!.swaps.map((call) => call.neutralHook)).toEqual([
      null,
      launch2DynamicHook,
    ]);
  });

  it("caps the dynamic sell fee at min(drop, maxDynamicFeeWad) in the read model and the quote (Decision 0144)", async () => {
    const { repository, record } = seeded();
    const cap = (2n * wad) / 10n;
    for (const [drop, maxDynamicFeeWad, bps, capText, dynamicTaxAmount] of [
      [(13n * wad) / 100n, cap, 1300, "0.2", "12.74"],
      [(6n * wad) / 10n, cap, 2000, "0.2", "19.6"],
      [(6n * wad) / 10n, 0n, 6000, "0", "58.8"],
    ] as const) {
      const { app } = await createApp({
        repository,
        dynamic: defaultDynamicState({ dropWad: drop, maxDynamicFeeWad }),
      });
      const pool = (
        await get(
          app,
          `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
        )
      ).json<{ dynamicPool: Record<string, unknown> }>().dynamicPool;
      expect(pool).toMatchObject({
        currentDropBps: Number((drop * 10_000n) / wad),
        maxDynamicFeeWad: capText,
        maxDynamicFeeBps: Number((maxDynamicFeeWad * 10_000n) / wad),
        currentDynamicTaxBps: bps,
      });
      // 160,000 MEME = 100 USD1 gross; base 2; dynamic = 98 × min(drop, cap).
      const quote = await get(
        app,
        quoteUrl(record.instanceId, "side=sell&mode=exactIn&amount=160000"),
      );
      expect(quote.statusCode).toBe(200);
      expect(quote.json()).toMatchObject({
        quote: { dynamic: { dynamicTaxBps: bps, dynamicTaxAmount } },
      });
    }
  });

  it("answers a pre-S193 Hook's close rule (Decision 0144)", async () => {
    const { repository, record } = seeded();
    const { app } = await createApp({
      repository,
      dynamic: defaultDynamicState({
        hook: { roundCloseRule: "closeAboveOpen", maxDynamicFeeWad: 0n },
      }),
    });
    const response = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dynamicPool: { roundCloseRule: "closeAboveOpen", maxDynamicFeeBps: 0 },
    });
  });

  it("answers the round state after a pending roll: an armed round over an empty candle ends (Decision 0144)", async () => {
    const { repository, record } = seeded();
    for (const [rule, after] of [
      ["closeAtOrAboveOpen", false],
      ["closeAboveOpen", true],
    ] as const) {
      const { app } = await createApp({
        repository,
        // The last recorded candle ended two candles ago, flat: a roll is pending.
        dynamic: defaultDynamicState({
          hook: {
            candleId: launch2NowSeconds / 300n - 2n,
            roundCloseRule: rule,
          },
        }),
      });
      const pool = (
        await get(
          app,
          `/v2/launch2/instances/${record.instanceId}/dynamic-pool`,
        )
      ).json<{ dynamicPool: Record<string, unknown> }>().dynamicPool;
      expect(pool).toMatchObject({
        armed: true,
        rollPending: true,
        armedAfterRoll: after,
        roundCloseRule: rule,
      });
    }
  });

  it("maps Hook errors to reason codes (UnauthorizedRouter, Busy)", async () => {
    const { repository, record } = seeded();
    for (const [name, status, reasonCode] of [
      ["UnauthorizedRouter", 422, "LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED"],
      ["UnsupportedSwap", 422, "LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED"],
      ["Busy", 409, "LAUNCH2_DYNAMIC_HOOK_BUSY"],
    ] as const) {
      const { app } = await createApp({
        repository,
        dynamic: defaultDynamicState({ swapRevert: name }),
      });
      const response = await get(
        app,
        quoteUrl(record.instanceId, "side=buy&mode=exactIn&amount=1"),
      );
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ detailsSafe: { reasonCode } });
    }
  });

  it("prepares LoopRouter.swapExactInput with an exact approve to LoopRouter", async () => {
    const { repository, record } = seeded();
    const { app } = await createApp({ repository });
    const response = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      {
        walletId,
        side: "buy",
        mode: "exactIn",
        amount: "10",
        slippageBps: 100,
      },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      launch2Intent: Record<string, unknown> & {
        calldata: { to: string; data: string };
        approval: { spender: string; token: string; amount: string } | null;
      };
      quote: Record<string, unknown>;
    }>();
    expect(body.launch2Intent["kind"]).toBe("pool_buy");
    expect(body.launch2Intent["contractAddress"]).toBe(launch2LoopRouter);
    expect(body.launch2Intent.calldata.to).toBe(launch2LoopRouter);
    expect(body.launch2Intent.approval).toMatchObject({
      token: memeUsd1,
      spender: launch2LoopRouter,
      amount: "10",
    });
    const decoded = decodeFunctionData({
      abi: loopRouterAbi,
      data: body.launch2Intent.calldata.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("swapExactInput");
    // minOut = 15,680 × 0.99; deadline = now + 180 s (Decision 0126).
    expect(decoded.args.slice(1, 4)).toEqual([
      true,
      10n * wad,
      15_523_200_000_000_000_000_000n,
    ]);
    expect(decoded.args[5]).toBe(launch2NowSeconds + 180n);
    expect(body.quote).toMatchObject({ dynamic: { rewardWeight: "10" } });
  });

  it("lists the wallet's reward rounds with the projected claimable amount", async () => {
    const { repository, record } = seeded();
    const row = (roundId: string, extra: Record<string, unknown>) => ({
      roundId,
      hook: launch2DynamicHook,
      closed: true,
      startCandle: "100",
      endCandle: "104",
      carriedInUsd1: "0",
      extraFeesUsd1: (60n * wad).toString(),
      totalBuyWeightUsd1: (300n * wad).toString(),
      allocationUsd1: (30n * wad).toString(),
      weightUsd1: (100n * wad).toString(),
      creditedUsd1: (100n * wad).toString(),
      movedInUsd1: "0",
      movedOutUsd1: "0",
      entries: [],
      claimedAmountUsd1: null,
      claimTransactionHash: null,
      claimedAt: null,
      activatedAt: new Date(1_799_000_000_000).toISOString(),
      closedAt: new Date(1_799_001_200_000).toISOString(),
      ...extra,
    });
    repository.dynamicRewards.set(`${record.instanceId}|${walletAddress}`, [
      row("3", {
        closed: false,
        endCandle: null,
        allocationUsd1: null,
        closedAt: null,
      }),
      row("2", {
        creditedUsd1: (90n * wad).toString(),
        movedInUsd1: (15n * wad).toString(),
        movedOutUsd1: (5n * wad).toString(),
        entries: [
          {
            direction: "out",
            attribution: "moved",
            counterparty: `0x${"c3".repeat(20)}`,
            amountUsd1: (5n * wad).toString(),
            transactionHash: `0x${"02".repeat(32)}`,
            logIndex: 9,
            blockNumber: "5002",
            creditedAt: new Date(1_799_000_300_000).toISOString(),
          },
          {
            direction: "in",
            attribution: "moved",
            counterparty: `0x${"a9".repeat(20)}`,
            amountUsd1: (15n * wad).toString(),
            transactionHash: `0x${"01".repeat(32)}`,
            logIndex: 7,
            blockNumber: "5001",
            creditedAt: new Date(1_799_000_200_000).toISOString(),
          },
          {
            direction: "in",
            attribution: "loopRouter",
            counterparty: null,
            amountUsd1: (90n * wad).toString(),
            transactionHash: `0x${"00".repeat(31)}01`,
            logIndex: 3,
            blockNumber: "5000",
            creditedAt: new Date(1_799_000_100_000).toISOString(),
          },
        ],
      }),
      row("1", {
        claimedAmountUsd1: (5n * wad).toString(),
        claimTransactionHash: `0x${"ab".repeat(32)}`,
        claimedAt: new Date(1_799_002_000_000).toISOString(),
      }),
    ]);
    const { app } = await createApp({ repository });
    const response = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool/rewards?walletId=${walletId}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{ rounds: Record<string, unknown>[] }>();
    expectSchemaKeys(body, launch2DynamicRewardsResourceSchema);
    expect(body).toMatchObject({
      hookKind: "loopDynamic",
      claimableUsd1: "10",
      claimedUsd1: "5",
    });
    expect(body.rounds.map((round) => round["status"])).toEqual([
      "open",
      "claimable",
      "claimed",
    ]);
    expect(body.rounds[1]).toMatchObject({
      claimableUsd1: "10",
      allocationUsd1: "30",
      // Decision 0146: 90 + 15 − 5 = 100.
      weightUsd1: "100",
      creditedUsd1: "90",
      movedInUsd1: "15",
      movedOutUsd1: "5",
    });
    expect(
      (body.rounds[1]!["credits"] as Record<string, unknown>[]).map(
        (credit) => [
          credit["direction"],
          credit["attribution"],
          credit["amountUsd1"],
        ],
      ),
    ).toEqual([
      ["out", "moved", "5"],
      ["in", "moved", "15"],
      ["in", "loopRouter", "90"],
    ]);
    expect(body.rounds[0]!["credits"]).toEqual([]);
    const missing = await get(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool/rewards`,
    );
    expect(missing.statusCode).toBe(400);
  });

  it("prepares claim(roundId) on the bound Hook, then records the reported hash", async () => {
    const { repository, record } = seeded();
    const { app, dynamic } = await createApp({ repository });
    const response = await post(
      app,
      `/v2/launch2/instances/${record.instanceId}/dynamic-pool/claim/prepare`,
      { walletId, roundId: "2" },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      launch2Intent: {
        intentId: string;
        kind: string;
        calldata: { to: string; data: string };
        approval: unknown;
      };
      claim: Record<string, unknown>;
    }>();
    expectSchemaKeys(body, launch2DynamicClaimIntentResourceSchema);
    expect(body.launch2Intent.kind).toBe("dynamic_claim");
    expect(body.launch2Intent.calldata.to).toBe(launch2DynamicHook);
    expect(body.launch2Intent.approval).toBeNull();
    const decoded = decodeFunctionData({
      abi: loopDynamicHookAbi,
      data: body.launch2Intent.calldata.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([2n]);
    expect(body.claim).toEqual({
      roundId: "2",
      hook: launch2DynamicHook,
      claimableUsd1: "12",
    });
    expect(dynamic?.claims).toEqual([{ roundId: 2n, wallet: walletAddress }]);

    const txHash = `0x${"cd".repeat(32)}`;
    const reportUrl = `/v2/launch2/instances/${record.instanceId}/dynamic-pool/claim/report`;
    const first = await post(app, reportUrl, {
      intentId: body.launch2Intent.intentId,
      transactionHash: txHash,
    });
    expect(first.statusCode).toBe(200);
    const report = first.json<{
      dynamicClaimReport: Record<string, unknown>;
    }>();
    expectSchemaKeys(report, launch2DynamicClaimReportResourceSchema);
    expect(report.dynamicClaimReport).toMatchObject({
      roundId: "2",
      transactionHash: txHash,
      status: "submitted",
      amountUsd1: null,
    });
    repository.dynamicClaims.set(
      `${record.instanceId}|${txHash}|2|${walletAddress}`,
      {
        amountUsd1: (12n * wad).toString(),
        blockNumber: "6010",
        claimedAt: new Date(1_800_000_100_000).toISOString(),
      },
    );
    const again = await post(app, reportUrl, {
      walletId,
      roundId: "2",
      intentId: body.launch2Intent.intentId,
      transactionHash: txHash,
    });
    expect(again.json()).toMatchObject({
      dynamicClaimReport: {
        status: "confirmed",
        amountUsd1: "12",
        blockNumber: "6010",
      },
    });
    const conflict = await post(app, reportUrl, {
      intentId: body.launch2Intent.intentId,
      transactionHash: `0x${"ee".repeat(32)}`,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "RESOURCE_CONFLICT",
      detailsSafe: {
        reasonCode: "LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT",
      },
    });
    const wrongRound = await post(app, reportUrl, {
      roundId: "1",
      intentId: body.launch2Intent.intentId,
      transactionHash: txHash,
    });
    expect(wrongRound.statusCode).toBe(404);
    const unknown = await post(app, reportUrl, {
      intentId: "5c1c7a3e-2f4b-4f1e-9a51-1b7d3c2e8f90",
      transactionHash: txHash,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND" },
    });
  });

  it("refuses claims: OfficialTax instance, round not closed, already claimed, nothing to claim", async () => {
    const official = graduatedInstance();
    const { repository, record } = seeded();
    repository.instances.set(official.instanceId, official);
    const claimUrl = (id: string) =>
      `/v2/launch2/instances/${id}/dynamic-pool/claim/prepare`;
    const base = await createApp({ repository });
    const notApplicable = await post(base.app, claimUrl(official.instanceId), {
      walletId,
      roundId: "1",
    });
    expect(notApplicable.statusCode).toBe(422);
    expect(notApplicable.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE" },
    });
    const future = await post(base.app, claimUrl(record.instanceId), {
      walletId,
      roundId: "9",
    });
    expect(future.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_ROUND_INVALID" },
    });
    for (const [claim, status, code, reasonCode] of [
      [
        { status: "reverted", errorName: "RoundNotClosed" },
        409,
        "DATA_STALE",
        "LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED",
      ],
      [
        { status: "reverted", errorName: "AlreadyClaimed" },
        409,
        "RESOURCE_CONFLICT",
        "LAUNCH2_DYNAMIC_ALREADY_CLAIMED",
      ],
      [
        { status: "ok", amount: 0n },
        409,
        "INSUFFICIENT_BALANCE",
        "LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM",
      ],
    ] as const) {
      const { app } = await createApp({
        repository,
        dynamic: defaultDynamicState({ claim }),
      });
      const response = await post(app, claimUrl(record.instanceId), {
        walletId,
        roundId: "2",
      });
      expect(response.statusCode).toBe(status);
      expect(Object.keys(response.json<object>()).sort()).toEqual(errorKeys);
      expect(response.json()).toMatchObject({
        code,
        detailsSafe: { reasonCode },
      });
    }
  });

  it("publishes zh-CN copy for every LoopDynamic reason code", () => {
    for (const [code, text] of Object.entries(launch2DynamicReasonMessagesZh)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/u);
      expect(text.length).toBeGreaterThan(3);
    }
  });
});
