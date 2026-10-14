import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  ConfigurationError,
  loadConfig,
  loadReconciliationWorkerConfig,
} from "../src/config.js";
import type { ReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";
import {
  Launch2LegacyFactoriesInvalidError,
  launch2FactoryEntries,
  launch2IndexerFactories,
} from "../src/features/launch2/launch2-generation.js";
import type {
  Launch2Chain,
  Launch2Repository,
} from "../src/features/launch2/launch2-ports.js";
import {
  runReconciliationWorker,
  type ReconciliationWorkerDatabase,
  type WorkerShutdownSignal,
  type WorkerSignalSource,
} from "../src/worker-runtime.js";
import type { ReconciliationWorker } from "../src/worker.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  instanceFixture,
  launch2NowSeconds,
} from "./helpers/launch2-fakes.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
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
 * Decision 0133: launch2 is configured by the OfficialTax Factory pair
 * (HOOKS_LAUNCH_FACTORY_*) **or** the LoopDynamic pair
 * (LAUNCH2_DYNAMIC_FACTORY_*). A LoopDynamic-only deployment serves the
 * /v2/launch2 routes and runs the launch2_event lane; with neither pair it
 * stays LAUNCH2_FACTORY_NOT_CONFIGURED.
 */

const officialTaxFactory = "0x5555555555555555555555555555555555555555";
const dynamicFactory = "0x7777777777777777777777777777777777777777";
const dynamicCodeHash = `0x${"cd".repeat(32)}`;
const legacyFactory = "0x6a69ba7a5a71c114301e20ef95f62cd83d07d9c0";

const dynamicOnlyApiEnv = Object.freeze({
  V2_MODULES_ENABLED: "launch2",
  LAUNCH_CHAIN_ID: "97",
  LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
  LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: dynamicCodeHash,
});

interface Capability {
  readonly capabilityId: string;
  readonly availability: string;
  readonly reasonCode?: string | null;
}

describe("Decision 0133 launch2 routes with only the LoopDynamic Factory", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    env: Readonly<Record<string, string>>,
    options: { readonly injectChain: boolean },
  ) {
    const repository = createInMemoryLaunch2Repository();
    const instance = instanceFixture({ stage: "upcoming" });
    repository.instances.set(instance.instanceId, instance);
    const app = await buildApp({
      config: s7TestConfig(env),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(options.injectChain
        ? { launch2Chain: createFakeLaunch2Chain(defaultChainState()) }
        : {}),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds({})),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, instance };
  }

  async function capability(app: FastifyInstance): Promise<Capability> {
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ capabilities: Capability[] }>()
      .capabilities.find(
        (item) => item.capabilityId === "launch2",
      ) as Capability;
  }

  it("serves /v2/launch2/instances and its detail (no 503) and reports the capability available", async () => {
    const { app, instance } = await createApp(dynamicOnlyApiEnv, {
      injectChain: true,
    });
    const list = await app.inject({
      method: "GET",
      url: "/v2/launch2/instances",
      headers: s7CommonHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json<{ instances: { instanceId: string }[] }>()
        .instances.map((row) => row.instanceId),
    ).toEqual([instance.instanceId]);
    const detail = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${instance.instanceId}`,
      headers: s7CommonHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    const reported = await capability(app);
    expect(reported.availability).toBe("available");
    expect(reported.reasonCode ?? null).toBeNull();
  });

  it("builds its own chain reader from the launch slot: capability state matches the route gate", async () => {
    const { app } = await createApp(
      {
        ...dynamicOnlyApiEnv,
        LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
      },
      { injectChain: false },
    );
    const reported = await capability(app);
    expect(reported.availability).toBe("available");
    expect(reported.reasonCode ?? null).toBeNull();
  });

  it("still answers LAUNCH2_CHAIN_NOT_CONFIGURED (not the Factory reason) without the launch slot", async () => {
    const { app } = await createApp(dynamicOnlyApiEnv, { injectChain: false });
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch2/instances",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "LAUNCH2_CHAIN_NOT_CONFIGURED" },
    });
    expect(await capability(app)).toMatchObject({
      availability: "unavailable",
      reasonCode: "LAUNCH2_CHAIN_NOT_CONFIGURED",
    });
  });

  it("with neither Factory pair stays 503 LAUNCH2_FACTORY_NOT_CONFIGURED, capability included", async () => {
    const { app } = await createApp(
      { V2_MODULES_ENABLED: "launch2", LAUNCH_CHAIN_ID: "97" },
      { injectChain: false },
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch2/instances",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED" },
    });
    expect(await capability(app)).toMatchObject({
      availability: "unavailable",
      reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED",
    });
  });

  it("a partial LoopDynamic pair refuses boot instead of counting as configured", () => {
    expect(() =>
      s7TestConfig({
        V2_MODULES_ENABLED: "launch2",
        LAUNCH_CHAIN_ID: "97",
        LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
      }),
    ).toThrow(ConfigurationError);
  });
});

describe("Decision 0133 launch2FactoryEntries / launch2IndexerFactories", () => {
  it("lists only the LoopDynamic Factory (+ legacy) without an OfficialTax Factory", () => {
    expect(
      launch2FactoryEntries({ legacy: [], dynamic: dynamicFactory }),
    ).toEqual([{ address: dynamicFactory, generation: "v3", current: false }]);
    expect(
      launch2FactoryEntries({
        current: null,
        legacy: [{ address: legacyFactory, generation: "v2" }],
        dynamic: dynamicFactory.toUpperCase().replace("0X", "0x"),
      }),
    ).toEqual([
      { address: legacyFactory, generation: "v2", current: false },
      { address: dynamicFactory, generation: "v3", current: false },
    ]);
  });

  it("keeps the OfficialTax-first order when both are configured", () => {
    expect(
      launch2FactoryEntries({
        current: officialTaxFactory,
        legacy: [{ address: legacyFactory, generation: "v2" }],
        dynamic: dynamicFactory,
      }),
    ).toEqual([
      { address: officialTaxFactory, generation: "v3", current: true },
      { address: legacyFactory, generation: "v2", current: false },
      { address: dynamicFactory, generation: "v3", current: false },
    ]);
  });

  it("refuses with neither Factory, a legacy entry equal to the LoopDynamic Factory, or the two pairs on one address", () => {
    expect(() => launch2FactoryEntries({ legacy: [] })).toThrow(
      Launch2LegacyFactoriesInvalidError,
    );
    expect(() =>
      launch2FactoryEntries({
        legacy: [{ address: dynamicFactory, generation: "v2" }],
        dynamic: dynamicFactory,
      }),
    ).toThrow(/LAUNCH2_LEGACY_FACTORIES must not list LAUNCH2_DYNAMIC/u);
    expect(() =>
      launch2FactoryEntries({
        current: dynamicFactory,
        legacy: [],
        dynamic: dynamicFactory,
      }),
    ).toThrow(/must differ from HOOKS_LAUNCH_FACTORY_ADDRESS/u);
  });

  it("launch2IndexerFactories: null only with neither pair (legacy alone is not enough)", () => {
    const base = {
      factoryAddress: null,
      factoryCodeHash: null,
      legacyFactories: [{ address: legacyFactory, generation: "v2" as const }],
    };
    expect(launch2IndexerFactories(base)).toBeNull();
    expect(
      launch2IndexerFactories({ ...base, dynamicFactoryAddress: null }),
    ).toBeNull();
    expect(
      launch2IndexerFactories({
        ...base,
        dynamicFactoryAddress: dynamicFactory,
      })?.map((entry) => entry.address),
    ).toEqual([legacyFactory, dynamicFactory]);
  });
});

describe("Decision 0133 worker config with only the LoopDynamic Factory", () => {
  const workerBase = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
    ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
    MARKET_SPARKLINE_WARM_ENABLED: "false",
    VOICE_ROOM_REAPER_ENABLED: "false",
    COMMUNITY_MEMBER_BUY_FEED_ENABLED: "false",
    LAUNCH_CHAIN_ID: "97",
    LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
    LAUNCH2_INDEXER_ENABLED: "true",
  };
  const dynamicEnv = {
    ...workerBase,
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: dynamicCodeHash,
  };

  it("refuses boot when LAUNCH2_LEGACY_FACTORIES lists the LoopDynamic Factory, with or without the OfficialTax one", () => {
    for (const env of [
      dynamicEnv,
      {
        ...dynamicEnv,
        HOOKS_LAUNCH_FACTORY_ADDRESS: officialTaxFactory,
        HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
      },
    ]) {
      expect(() =>
        loadReconciliationWorkerConfig({
          ...env,
          LAUNCH2_LEGACY_FACTORIES: `v2:${dynamicFactory}`,
        }),
      ).toThrow(
        /LAUNCH2_LEGACY_FACTORIES: LAUNCH2_LEGACY_FACTORIES must not list LAUNCH2_DYNAMIC_FACTORY_ADDRESS/u,
      );
    }
    expect(() =>
      loadReconciliationWorkerConfig({
        ...dynamicEnv,
        HOOKS_LAUNCH_FACTORY_ADDRESS: dynamicFactory,
        HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
      }),
    ).toThrow(ConfigurationError);
    expect(
      loadReconciliationWorkerConfig({
        ...dynamicEnv,
        LAUNCH2_LEGACY_FACTORIES: `v2:${legacyFactory}`,
      }).launch2Indexer,
    ).toMatchObject({
      factoryAddress: null,
      dynamicFactoryAddress: dynamicFactory,
      legacyFactories: [{ address: legacyFactory, generation: "v2" }],
    });
  });

  it("the buyback keeper verifies against the LoopDynamic Factory when it is the only one", () => {
    const keeperEnv = {
      ...dynamicEnv,
      LAUNCH2_BUYBACK_KEEPER_ENABLED: "true",
      LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: `0x${"61".repeat(32)}`,
    };
    expect(
      loadReconciliationWorkerConfig(keeperEnv).launch2BuybackKeeper
        ?.factoryAddress,
    ).toBe(dynamicFactory);
    expect(
      loadReconciliationWorkerConfig({
        ...keeperEnv,
        HOOKS_LAUNCH_FACTORY_ADDRESS: officialTaxFactory,
        HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
      }).launch2BuybackKeeper?.factoryAddress,
    ).toBe(officialTaxFactory);
    expect(() =>
      loadReconciliationWorkerConfig({
        ...workerBase,
        LAUNCH2_BUYBACK_KEEPER_ENABLED: "true",
        LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: `0x${"61".repeat(32)}`,
      }),
    ).toThrow(
      /HOOKS_LAUNCH_FACTORY_ADDRESS or LAUNCH2_DYNAMIC_FACTORY_ADDRESS/u,
    );
  });

  it("the faucet reads usd1() from the LoopDynamic Factory when there is no OfficialTax Factory", () => {
    const apiBase = {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      LAUNCH_CHAIN_ID: "97",
    };
    expect(loadConfig(apiBase).testnetFaucet.usd1Source).toBeNull();
    expect(
      loadConfig({
        ...apiBase,
        LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
        LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: dynamicCodeHash,
      }).testnetFaucet.usd1Source,
    ).toEqual({ kind: "factory", factoryAddress: dynamicFactory });
    expect(
      loadConfig({
        ...apiBase,
        HOOKS_LAUNCH_FACTORY_ADDRESS: officialTaxFactory,
        HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
        LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
        LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: dynamicCodeHash,
      }).testnetFaucet.usd1Source,
    ).toEqual({ kind: "factory", factoryAddress: officialTaxFactory });
  });
});

describe("Decision 0133 launch2_event lane with only the LoopDynamic Factory", () => {
  const workerEnv = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
    ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
    MARKET_SPARKLINE_WARM_ENABLED: "false",
    VOICE_ROOM_REAPER_ENABLED: "false",
    COMMUNITY_MEMBER_BUY_FEED_ENABLED: "false",
    LAUNCH_CHAIN_ID: "97",
    LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
    LAUNCH2_INDEXER_ENABLED: "true",
  };

  function fakeLogger(): ReconciliationWorkerLogger {
    return {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
  }

  function fakeSignalSource(): WorkerSignalSource & {
    emit(signal: WorkerShutdownSignal): void;
  } {
    const listeners = new Map<WorkerShutdownSignal, Set<() => void>>();
    return {
      once(signal, listener): void {
        const set = listeners.get(signal) ?? new Set();
        set.add(listener);
        listeners.set(signal, set);
      },
      off(signal, listener): void {
        listeners.get(signal)?.delete(listener);
      },
      emit(signal): void {
        const set = [...(listeners.get(signal) ?? [])];
        listeners.delete(signal);
        for (const listener of set) listener();
      },
    };
  }

  function fakeDatabase(
    launch2: Launch2Repository | undefined,
  ): ReconciliationWorkerDatabase {
    return {
      controlPlane: {} as ReconciliationWorkerDatabase["controlPlane"],
      perpReconciliation:
        {} as ReconciliationWorkerDatabase["perpReconciliation"],
      spotReconciliation:
        {} as ReconciliationWorkerDatabase["spotReconciliation"],
      communityChannelSync:
        {} as ReconciliationWorkerDatabase["communityChannelSync"],
      communityChannelPersonas:
        {} as ReconciliationWorkerDatabase["communityChannelPersonas"],
      spotAgentAuthorizations: {
        expireElapsedPrepared: vi.fn(() =>
          Promise.resolve({ expiredCount: 0 }),
        ),
        retireElapsedAgentIdentities: vi.fn(() =>
          Promise.resolve({ retiredCount: 0 }),
        ),
      },
      ping: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      ...(launch2 === undefined ? {} : { launch2 }),
    };
  }

  function waitingWorker(): ReconciliationWorker {
    return {
      workerId: "33b40904-4487-49cd-8481-7075d9025713",
      runOnce: vi.fn(() => Promise.resolve({ kind: "idle" as const })),
      run: (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    };
  }

  it("runs the lane (not idle) and registers instances of the LoopDynamic Factory (+ legacy)", async () => {
    const logger = fakeLogger();
    const signalSource = fakeSignalSource();
    const registerActivatedInstances = vi.fn(() => {
      // One tick is enough: stop the runtime after the registration call.
      queueMicrotask(() => signalSource.emit("SIGTERM"));
      return Promise.resolve([]);
    });
    const repository = {
      registerActivatedInstances,
      listLaneInstances: vi.fn(() => Promise.resolve([])),
    } as unknown as Launch2Repository;
    const createLaunch2Chain = vi.fn(
      () =>
        ({
          verifyChain: () => Promise.resolve("ok"),
        }) as unknown as Launch2Chain,
    );
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig({
        ...workerEnv,
        LAUNCH2_DYNAMIC_FACTORY_ADDRESS: dynamicFactory,
        LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: dynamicCodeHash,
        LAUNCH2_LEGACY_FACTORIES: `v2:${legacyFactory}`,
      }),
      logger,
      signalSource,
      createDatabase: () => fakeDatabase(repository),
      createWorker: () => waitingWorker(),
      createLaunch2Chain,
    });
    expect(createLaunch2Chain).toHaveBeenCalledWith({
      rpcUrls: ["https://bsc-testnet.example/rpc"],
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "launch2_event",
        factoryAddress: dynamicFactory,
        count: 1,
      }),
      "LOOP launch2_event lane enabled",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "launch2_event" }),
      "LOOP launch2_event lane stays idle",
    );
    expect(registerActivatedInstances).toHaveBeenCalledWith({
      chainId: "eip155:97",
      factories: [
        { address: legacyFactory, generation: "v2" },
        { address: dynamicFactory, generation: "v3" },
      ],
    });
  });

  it("stays idle with LAUNCH2_FACTORY_NOT_CONFIGURED with neither pair (legacy alone is not enough)", async () => {
    const logger = fakeLogger();
    const createLaunch2Chain = vi.fn();
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig({
        ...workerEnv,
        LAUNCH2_LEGACY_FACTORIES: `v2:${legacyFactory}`,
      }),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => fakeDatabase({} as Launch2Repository),
      createWorker: () => ({
        workerId: "33b40904-4487-49cd-8481-7075d9025713",
        runOnce: vi.fn(),
        run: vi.fn(() => Promise.resolve()),
      }),
      createLaunch2Chain,
    });
    expect(createLaunch2Chain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "launch2_event",
        reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED",
      }),
      "LOOP launch2_event lane stays idle",
    );
  });
});
