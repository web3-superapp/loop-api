import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { launch2DynamicReasonMessagesZh } from "../src/features/launch2/launch2-dynamic.js";
import {
  createFakeLaunch2DynamicChain,
  defaultDynamicState,
  graduatedDynamicInstance,
  launch2DynamicFactory,
  launch2DynamicFactoryEnv,
  launch2DynamicHook,
  launch2LegacyDynamicFactory,
  launch2LegacyLoopRouter,
  launch2LegacyRouterRegistry,
  launch2LoopRouter,
  launch2RouterRegistry,
  type FakeLaunch2DynamicState,
} from "./helpers/launch2-dynamic-fakes.js";
import {
  createFakeLaunch2Chain,
  createFakeLaunch2PoolChain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  defaultPoolState,
  launch2Env,
  launch2NowSeconds,
  launch2PoolEnv,
  launch2WritesEnv,
} from "./helpers/launch2-fakes.js";
import { walletId, walletsFake } from "./helpers/launch-service-fakes.js";
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
 * Decision 0153: a LoopDynamic instance is checked against — and trades
 * through — its **own Factory's** LoopRouter / registry, read from the
 * Factory's getters. Only trusted Factories (LAUNCH2_DYNAMIC_FACTORY_ADDRESS
 * and the v3 entries of LAUNCH2_LEGACY_FACTORIES) qualify; the current
 * Factory's chain routing must equal the configuration.
 */

const legacyHookState = {
  trustedRouter: launch2LegacyLoopRouter,
  routerRegistry: launch2LegacyRouterRegistry,
};

describe("LoopDynamic router resolved per Factory (Decision 0153)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly records?: readonly ReturnType<typeof graduatedDynamicInstance>[];
      readonly dynamic?: FakeLaunch2DynamicState;
      readonly env?: Record<string, string>;
    } = {},
  ) {
    const repository = createInMemoryLaunch2Repository();
    for (const record of options.records ?? []) {
      repository.instances.set(record.instanceId, record);
    }
    const dynamic = options.dynamic ?? defaultDynamicState();
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2PoolEnv,
        ...launch2WritesEnv,
        ...launch2DynamicFactoryEnv,
        ...options.env,
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
      launch2DynamicChain: createFakeLaunch2DynamicChain(dynamic),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds()),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, dynamic };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });
  const poolUrl = (id: string) => `/v2/launch2/instances/${id}/dynamic-pool`;
  const quoteUrl = (id: string) =>
    `/v2/launch2/instances/${id}/pool/quote?walletId=${walletId}&side=buy&mode=exactIn&amount=10`;

  function legacyInstance() {
    return graduatedDynamicInstance({
      instanceId: "00000000-0000-4000-8000-00000000d05e",
      factoryAddress: launch2LegacyDynamicFactory,
    });
  }

  it("passes a current-Factory instance whose chain routing equals the configuration", async () => {
    const record = graduatedDynamicInstance();
    const { app, dynamic } = await createApp({ records: [record] });
    const response = await get(app, poolUrl(record.instanceId));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dynamicPool: {
        router: launch2LoopRouter,
        routerRegistry: launch2RouterRegistry,
      },
    });
    expect(dynamic.factoryReads).toEqual([launch2DynamicFactory]);
    expect(dynamic.routerChecks).toEqual([launch2LoopRouter]);
  });

  it("passes a legacy-Factory instance and quotes / prepares through its own LoopRouter", async () => {
    const record = legacyInstance();
    const { app, dynamic } = await createApp({
      records: [record],
      dynamic: defaultDynamicState({ hook: legacyHookState }),
    });
    const pool = await get(app, poolUrl(record.instanceId));
    expect(pool.statusCode).toBe(200);
    expect(pool.json()).toMatchObject({
      dynamicPool: {
        status: "active",
        hook: launch2DynamicHook,
        router: launch2LegacyLoopRouter,
        routerRegistry: launch2LegacyRouterRegistry,
        // The legacy Hook (bits 0x10C4) charges its buy fee in MEME.
        buyFeeToken: "meme",
      },
    });
    const quote = await get(app, quoteUrl(record.instanceId));
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({
      quote: { router: launch2LegacyLoopRouter },
    });
    expect(dynamic.routerChecks).toContain(launch2LegacyLoopRouter);
    expect(dynamic.routerChecks).not.toContain(launch2LoopRouter);
    expect(dynamic.swaps.length).toBeGreaterThan(0);
    for (const swap of dynamic.swaps) {
      expect(swap.router).toBe(launch2LegacyLoopRouter);
    }
    const prepare = await app.inject({
      method: "POST",
      url: `/v2/launch2/instances/${record.instanceId}/pool/trade/prepare`,
      headers: s7CommandHeaders({ "idempotency-key": randomUUID() }),
      payload: {
        walletId,
        side: "buy",
        mode: "exactIn",
        amount: "10",
        slippageBps: 100,
      },
    });
    expect(prepare.statusCode).toBe(201);
    const intent = prepare.json<{
      launch2Intent: {
        contractAddress: string;
        calldata: { to: string };
        approval: { spender: string; token: string } | null;
      };
    }>().launch2Intent;
    // The swap intent must hit the instance's own (old) router.
    expect(intent.contractAddress).toBe(launch2LegacyLoopRouter);
    expect(intent.calldata.to).toBe(launch2LegacyLoopRouter);
    expect(intent.approval).toMatchObject({
      token: memeUsd1,
      spender: launch2LegacyLoopRouter,
    });
    // One Factory read and one loopHook read for every request (cache).
    expect(dynamic.factoryReads).toEqual([launch2LegacyDynamicFactory]);
    expect(dynamic.factoryHookReads).toEqual([launch2LegacyDynamicFactory]);
    // The instance detail names the instance's own router.
    const detail = await get(app, `/v2/launch2/instances/${record.instanceId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      instance: { pool: { router: launch2LegacyLoopRouter } },
    });
  });

  it("refuses an instance of a Factory outside the trusted list with LAUNCH2_DYNAMIC_FACTORY_UNKNOWN", async () => {
    const foreign = graduatedDynamicInstance({
      factoryAddress: "0x9999999999999999999999999999999999999999",
    });
    const { app, dynamic } = await createApp({
      records: [foreign],
      dynamic: defaultDynamicState({
        factoryRoutings: {
          "0x9999999999999999999999999999999999999999": {
            router: launch2LoopRouter,
            routerRegistry: launch2RouterRegistry,
            hookDeploymentFactory: launch2LoopRouter,
          },
        },
      }),
    });
    for (const url of [
      poolUrl(foreign.instanceId),
      quoteUrl(foreign.instanceId),
    ]) {
      const response = await get(app, url);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_FACTORY_UNKNOWN" },
      });
    }
    // Never asked the chain about an untrusted Factory.
    expect(dynamic.factoryReads).toEqual([]);
    const detail = await get(
      app,
      `/v2/launch2/instances/${foreign.instanceId}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      instance: { pool: { router: null } },
    });
  });

  it("refuses a listed Factory without LoopDynamic getters (reverts) with LAUNCH2_DYNAMIC_FACTORY_UNKNOWN", async () => {
    const record = legacyInstance();
    const { app } = await createApp({
      records: [record],
      dynamic: defaultDynamicState({
        hook: legacyHookState,
        factoryRoutings: {},
      }),
    });
    const response = await get(app, poolUrl(record.instanceId));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_FACTORY_UNKNOWN" },
    });
  });

  it("refuses the current Factory when its chain router / registry differ from the configuration", async () => {
    const record = graduatedDynamicInstance();
    const other = "0x1212121212121212121212121212121212121212";
    const wrongRouter = await createApp({
      records: [record],
      dynamic: defaultDynamicState({
        hook: { trustedRouter: other },
        factoryRoutings: {
          [launch2DynamicFactory]: {
            router: other,
            routerRegistry: launch2RouterRegistry,
            hookDeploymentFactory: other,
          },
        },
      }),
    });
    for (const url of [
      poolUrl(record.instanceId),
      quoteUrl(record.instanceId),
    ]) {
      const response = await get(wrongRouter.app, url);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_ROUTER_MISMATCH" },
      });
    }
    const wrongRegistry = await createApp({
      records: [record],
      env: { LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS: other },
    });
    const response = await get(wrongRegistry.app, poolUrl(record.instanceId));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_ROUTER_MISMATCH" },
    });
    // A legacy Factory's registry is not compared with the env.
    const legacy = legacyInstance();
    const legacyApp = await createApp({
      records: [legacy],
      dynamic: defaultDynamicState({ hook: legacyHookState }),
      env: { LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS: launch2RouterRegistry },
    });
    expect(
      (await get(legacyApp.app, poolUrl(legacy.instanceId))).statusCode,
    ).toBe(200);
  });

  it("keeps HOOK_MISMATCH when the Hook does not match its own Factory", async () => {
    const record = legacyInstance();
    // A legacy instance whose Hook trusts the current router / registry.
    const crossed = await createApp({ records: [record] });
    const a = await get(crossed.app, poolUrl(record.instanceId));
    expect(a.statusCode).toBe(503);
    expect(a.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH" },
    });
    // The right router, the wrong registry.
    const registry = await createApp({
      records: [record],
      dynamic: defaultDynamicState({
        hook: { trustedRouter: launch2LegacyLoopRouter },
      }),
    });
    expect(
      (await get(registry.app, poolUrl(record.instanceId))).json(),
    ).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH" },
    });
    // The Factory's loopHook(launchId) is another Hook (not deployed by it).
    const notDeployed = await createApp({
      records: [record],
      dynamic: defaultDynamicState({
        hook: legacyHookState,
        factoryHook: `0x${"d".repeat(36)}10c4`,
      }),
    });
    const b = await get(notDeployed.app, poolUrl(record.instanceId));
    expect(b.statusCode).toBe(503);
    expect(b.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH" },
    });
    // Its router is never verified nor its Hook read.
    expect(notDeployed.dynamic.routerChecks).toEqual([]);
  });

  it("caches a Factory's routing (no re-read) but never a failed read", async () => {
    const record = graduatedDynamicInstance();
    const dynamic = defaultDynamicState({ failFactoryRead: true });
    const { app } = await createApp({ records: [record], dynamic });
    const down = await get(app, poolUrl(record.instanceId));
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_CHAIN_READ_FAILED" },
    });
    dynamic.failFactoryRead = false;
    for (let index = 0; index < 3; index += 1) {
      expect((await get(app, poolUrl(record.instanceId))).statusCode).toBe(200);
    }
    expect((await get(app, quoteUrl(record.instanceId))).statusCode).toBe(200);
    expect(dynamic.factoryReads).toEqual([
      launch2DynamicFactory,
      launch2DynamicFactory,
    ]);
    expect(dynamic.factoryHookReads).toEqual([launch2DynamicFactory]);
  });

  it("publishes zh-CN copy for the new reason codes", () => {
    expect(
      launch2DynamicReasonMessagesZh.LAUNCH2_DYNAMIC_FACTORY_UNKNOWN,
    ).toBeTruthy();
    expect(
      launch2DynamicReasonMessagesZh.LAUNCH2_DYNAMIC_ROUTER_MISMATCH,
    ).toBeTruthy();
  });

  it("parses the trusted legacy LoopDynamic Factories and legacy router hashes for the API", () => {
    const base = {
      ...launch2Env,
      LAUNCH2_DYNAMIC_FACTORY_ADDRESS: launch2DynamicFactory,
      LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: `0x${"5d".repeat(32)}`,
    };
    const config = s7TestConfig({
      ...base,
      LAUNCH2_LEGACY_FACTORIES:
        "v2:0x6A69bA7a5A71C114301E20eF95f62Cd83d07D9c0,v3:0xd05E704349B386D298A623DDC2aDD968AcE48c4D",
      LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES: ` 0x${"AB".repeat(32)} , 0x${"cd".repeat(32)}`,
    });
    expect(config.launch2.dynamicLegacyFactories).toEqual([
      "0xd05e704349b386d298a623ddc2add968ace48c4d",
    ]);
    expect(config.launch2.dynamicLegacyRouterCodeHashes).toEqual([
      `0x${"ab".repeat(32)}`,
      `0x${"cd".repeat(32)}`,
    ]);
    const blank = s7TestConfig(base);
    expect(blank.launch2.dynamicLegacyFactories).toEqual([]);
    expect(blank.launch2.dynamicLegacyRouterCodeHashes).toEqual([]);
    expect(() =>
      s7TestConfig({
        ...base,
        LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES: "0x1234",
      }),
    ).toThrow(/LAUNCH2_DYNAMIC_LEGACY_ROUTER_CODE_HASHES/u);
    expect(() =>
      s7TestConfig({
        ...base,
        LAUNCH2_LEGACY_FACTORIES: `v3:${launch2DynamicFactory}`,
      }),
    ).toThrow(/LAUNCH2_LEGACY_FACTORIES/u);
  });
});
