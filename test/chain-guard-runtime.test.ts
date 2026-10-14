import { describe, expect, it, vi } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import type { Launch2BuybackAttemptRepository } from "../src/features/launch2/launch2-buyback-keeper.js";
import type { Launch2BuybackKeeperChain } from "../src/features/launch2/launch2-buyback-keeper.js";
import type { PerpReconciliationRepository } from "../src/features/perp/perp-reconciliation-contract.js";
import type { SpotReconciliationRepository } from "../src/features/spot/spot-reconciliation-contract.js";
import type { ReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";
import {
  runReconciliationWorker,
  type ReconciliationWorkerDatabase,
  type WorkerShutdownSignal,
  type WorkerSignalSource,
} from "../src/worker-runtime.js";
import {
  createFakeChainGuardChain,
  createInMemoryChainGuardRepository,
} from "./helpers/chain-guard-fakes.js";

/**
 * Decision 0134: worker composition — CHAIN_GUARD_ENABLED registers the
 * lane on the launch slot and hands the signing lanes the hold check; the
 * lane logs incidents with `CHAIN_GUARD_<KIND>` and never logs a key.
 */

const keeperKey = `0x${"61".repeat(32)}`;
const keeperAddress = "0x5f1175ffb0174332d86ff55eb9b8e885ce90e260";
const factory = "0x6a69ba7a5a71c114301e20ef95f62cd83d07d9c0";
const environment = {
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
  HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
  HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
  LAUNCH2_BUYBACK_KEEPER_ENABLED: "true",
  LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: keeperKey,
  CHAIN_GUARD_ENABLED: "true",
  CHAIN_GUARD_USD1_ADDRESS: "0x00000000000000000000000000000000000005d1",
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

function signalSource(): WorkerSignalSource & {
  emit(signal: WorkerShutdownSignal): void;
} {
  const listeners = new Map<WorkerShutdownSignal, (() => void)[]>();
  return {
    once(signal, listener) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    },
    off(signal, listener) {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((entry) => entry !== listener),
      );
    },
    emit(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
      listeners.delete(signal);
    },
  };
}

function database(
  chainGuard: ReturnType<typeof createInMemoryChainGuardRepository> | undefined,
): ReconciliationWorkerDatabase {
  return {
    controlPlane: {} as ReconciliationWorkerDatabase["controlPlane"],
    perpReconciliation: {} as PerpReconciliationRepository,
    spotReconciliation: {} as SpotReconciliationRepository,
    communityChannelSync:
      {} as ReconciliationWorkerDatabase["communityChannelSync"],
    communityChannelPersonas:
      {} as ReconciliationWorkerDatabase["communityChannelPersonas"],
    spotAgentAuthorizations: {
      expireElapsedPrepared: vi.fn(() => Promise.resolve({ expiredCount: 0 })),
      retireElapsedAgentIdentities: vi.fn(() =>
        Promise.resolve({ retiredCount: 0 }),
      ),
    },
    launch2BuybackAttempts: {} as Launch2BuybackAttemptRepository,
    ...(chainGuard === undefined ? {} : { chainGuard }),
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

const keeperChain = {
  keeperAddress,
  chainId: () => Promise.resolve(97),
  factoryKeepers: () =>
    Promise.resolve({
      primary: keeperAddress,
      fallback: `0x${"22".repeat(20)}`,
    }),
} as unknown as Launch2BuybackKeeperChain;

describe("chain guard worker composition (Decision 0134)", () => {
  it("registers the lane, guards the keeper, and logs an incident", async () => {
    const logger = fakeLogger();
    const signals = signalSource();
    const repository = createInMemoryChainGuardRepository();
    const chain = createFakeChainGuardChain({ paused: true });
    chain.state.factory = {
      ...(chain.state.factory as NonNullable<typeof chain.state.factory>),
      factory,
      usd1: environment.CHAIN_GUARD_USD1_ADDRESS,
    };
    const head = chain.head.bind(chain);
    // Stop the worker after the guard's first tick.
    chain.head = () => {
      setTimeout(() => signals.emit("SIGTERM"), 0);
      return head();
    };
    let keeperHold: unknown = "unset";
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(environment),
      logger,
      signalSource: signals,
      createDatabase: () => database(repository),
      createWorker: () => ({
        workerId: "00000000-0000-4000-8000-000000000001",
        runOnce: vi.fn(),
        run: (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve());
          }),
      }),
      createLaunch2BuybackKeeperChain: () => keeperChain,
      createLaunch2BuybackKeeperLane: (options) => {
        keeperHold = options.chainGuardHold;
        return {
          lane: "launch2_buyback_keeper",
          keeper: {
            verifyKeeper: () => Promise.resolve("ok" as const),
            runOnce: vi.fn(),
          },
          runOnce: vi.fn(),
          run: vi.fn(() => Promise.resolve()),
        };
      },
      createChainGuardChain: (input) => {
        expect(input).toEqual({
          rpcUrls: ["https://bsc-testnet.example/rpc"],
          chainReference: 97,
        });
        return chain;
      },
    });
    expect(typeof keeperHold).toBe("function");
    expect(await (keeperHold as () => Promise<unknown>)()).toEqual({
      kind: "held",
      reasonCode: "CHAIN_GUARD_HOLD",
      holdCount: 1,
    });

    expect(vi.mocked(logger.info).mock.calls).toContainEqual([
      expect.objectContaining({
        lane: "chain_guard",
        count: 1,
        confirmations: 5,
      }),
      "LOOP chain guard lane enabled",
    ]);
    expect(vi.mocked(logger.error).mock.calls).toContainEqual([
      expect.objectContaining({
        lane: "chain_guard",
        reasonCode: "CHAIN_GUARD_USD1_PAUSED",
        chainGuardKind: "usd1_paused",
        chainGuardSubject: environment.CHAIN_GUARD_USD1_ADDRESS,
      }),
      "LOOP chain guard incident opened",
    ]);
    expect(vi.mocked(logger.error).mock.calls).toContainEqual([
      expect.objectContaining({
        lane: "launch2_buyback_keeper",
        reasonCode: "CHAIN_GUARD_HOLD",
      }),
      "LOOP chain guard hold engaged; the lane skips its ticks",
    ]);
    const logged = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    expect(logged).not.toContain("61".repeat(32));
  });

  it("sends opened incidents and hold transitions to the configured webhook (Decision 0135)", async () => {
    const logger = fakeLogger();
    const signals = signalSource();
    const repository = createInMemoryChainGuardRepository();
    const chain = createFakeChainGuardChain({ paused: true });
    chain.state.factory = {
      ...(chain.state.factory as NonNullable<typeof chain.state.factory>),
      factory,
      usd1: environment.CHAIN_GUARD_USD1_ADDRESS,
    };
    const head = chain.head.bind(chain);
    chain.head = () => {
      setTimeout(() => signals.emit("SIGTERM"), 0);
      return head();
    };
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    let keeperHold: unknown = null;
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig({
        ...environment,
        CHAIN_GUARD_WEBHOOK_URL: "https://hooks.example.com/loop/secret-path",
      }),
      logger,
      signalSource: signals,
      createDatabase: () => database(repository),
      createWorker: () => ({
        workerId: "00000000-0000-4000-8000-000000000001",
        runOnce: vi.fn(),
        run: (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve());
          }),
      }),
      createLaunch2BuybackKeeperChain: () => keeperChain,
      createLaunch2BuybackKeeperLane: (options) => {
        keeperHold = options.chainGuardHold;
        return {
          lane: "launch2_buyback_keeper",
          keeper: {
            verifyKeeper: () => Promise.resolve("ok" as const),
            runOnce: vi.fn(),
          },
          runOnce: vi.fn(),
          run: vi.fn(() => Promise.resolve()),
        };
      },
      createChainGuardChain: () => chain,
      chainGuardAlertFetch: (url, init) => {
        posted.push({
          url,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return Promise.resolve({ ok: false, status: 500 });
      },
    });
    await (keeperHold as () => Promise<unknown>)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted.map((entry) => [entry.url, entry.body["type"]])).toEqual([
      ["https://hooks.example.com/loop/secret-path", "incident_opened"],
      ["https://hooks.example.com/loop/secret-path", "hold_engaged"],
    ]);
    expect(posted[0]?.body).toMatchObject({
      chainId: "eip155:97",
      kind: "usd1_paused",
      subject: environment.CHAIN_GUARD_USD1_ADDRESS,
    });
    expect(posted[1]?.body).toMatchObject({
      lane: "launch2_buyback_keeper",
      holdCount: 1,
    });
    // A refused delivery is one warn line with the host only.
    const failures = vi
      .mocked(logger.warn)
      .mock.calls.filter(
        ([, message]) => message === "LOOP chain guard alert was not delivered",
      );
    expect(failures).toHaveLength(2);
    expect(failures[0]?.[0]).toMatchObject({
      reasonCode: "CHAIN_GUARD_ALERT_DELIVERY_FAILED",
      chainGuardAlertOutlet: "webhook",
      rpcUrlHost: "hooks.example.com",
      rpcStatus: 500,
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "secret-path",
    );
  });

  it("without the repository the guard idles and the keeper is unguarded", async () => {
    const logger = fakeLogger();
    let keeperOptions: Record<string, unknown> = {};
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(environment),
      logger,
      signalSource: signalSource(),
      createDatabase: () => database(undefined),
      createWorker: () => ({
        workerId: "00000000-0000-4000-8000-000000000001",
        runOnce: vi.fn(),
        run: vi.fn(() => Promise.resolve()),
      }),
      createLaunch2BuybackKeeperChain: () => keeperChain,
      createLaunch2BuybackKeeperLane: (options) => {
        keeperOptions = options;
        return {
          lane: "launch2_buyback_keeper",
          keeper: {
            verifyKeeper: () => Promise.resolve("ok" as const),
            runOnce: vi.fn(),
          },
          runOnce: vi.fn(),
          run: vi.fn(() => Promise.resolve()),
        };
      },
    });
    expect("chainGuardHold" in keeperOptions).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls).toContainEqual([
      expect.objectContaining({
        lane: "chain_guard",
        reasonCode: "CHAIN_GUARD_REPOSITORY_UNAVAILABLE",
      }),
      "LOOP chain guard lane stays idle",
    ]);
  });

  it("is off by default", () => {
    expect(
      loadReconciliationWorkerConfig({
        ...environment,
        CHAIN_GUARD_ENABLED: undefined,
      }).chainGuard,
    ).toBeNull();
    expect(() =>
      loadReconciliationWorkerConfig({
        ...environment,
        CHAIN_GUARD_ENABLED: "yes",
      }),
    ).toThrow(/CHAIN_GUARD_ENABLED/u);
  });
});
