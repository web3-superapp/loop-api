import type { Launch2Repository } from "../src/features/launch2/launch2-ports.js";
import type {
  Launch2PublicationRepository,
  Launch2PublisherChain,
} from "../src/features/launch2/launch2-snapshot-publisher.js";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import type { PerpReconciliationRepository } from "../src/features/perp/perp-reconciliation-contract.js";
import type { SpotReconciliationRepository } from "../src/features/spot/spot-reconciliation-contract.js";
import type { IssuanceQuotaRetentionWorker } from "../src/issuance-quota-retention-worker.js";
import type { ReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";
import type { SpotAgentLifecycleWorker } from "../src/spot-agent-lifecycle-worker.js";
import type {
  CreateReconciliationWorkerOptions,
  ReconciliationWorker,
} from "../src/worker.js";
import {
  runReconciliationWorker,
  type ReconciliationWorkerDatabase,
  type WorkerShutdownSignal,
  type WorkerSignalSource,
} from "../src/worker-runtime.js";
import type { ChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import type {
  BscIndexerRepository,
  BscIndexerWalletSetRepository,
} from "../src/database/bsc-indexer-repository.js";
import type {
  BscIndexerWorker,
  CreateBscIndexerWorkerOptions,
} from "../src/bsc-indexer-worker.js";
import type { BscPoolIndexerWorker } from "../src/bsc-pool-indexer-worker.js";
import { createUnavailableBscReadClient } from "../src/integrations/bsc/rpc-client.js";
import type { MarketFactCacheRepository } from "../src/database/market-fact-cache-repository.js";
import type { WatchlistV2Repository } from "../src/database/watchlist-v2-repository.js";
import type { CreateMarketSparklineWarmWorkerOptions } from "../src/market-sparkline-warm-worker.js";
import type { CreateVoiceRoomReaperWorkerOptions } from "../src/voice-room-reaper-worker.js";
import { createUnavailableStreamCallGateway } from "../src/integrations/stream/call-gateway.js";
import type { CreateMemberBuyFeedWorkerOptions } from "../src/community-member-buy-feed-worker.js";
import { createUnavailableStreamCommunityChannelGateway } from "../src/integrations/stream/channel-gateway.js";
import type {
  HooksLaunchExecutor,
  HooksLaunchExecutorChain,
  HooksLaunchExecutorRepository,
} from "../src/features/launch/hooks-launch-executor.js";
import type { createHooksLaunchExecutorLane as createHooksLaunchExecutorLaneType } from "../src/hooks-launch-executor-worker.js";
import { HooksLaunchExecutorChainRefusedError } from "../src/integrations/launch/hooks-launch-executor-chain.js";

const workerId = "33b40904-4487-49cd-8481-7075d9025713";

interface TestSignalSource extends WorkerSignalSource {
  readonly emit: (signal: WorkerShutdownSignal) => void;
}

function workerConfig(
  reconciliationReadsEnabled = false,
  spotAgentLifecycleMaintenanceEnabled = false,
  spotReconciliationReadsEnabled = false,
  issuanceRateRecordCleanupEnabled = false,
) {
  return loadReconciliationWorkerConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: reconciliationReadsEnabled
      ? "true"
      : "false",
    HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED:
      spotReconciliationReadsEnabled ? "true" : "false",
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED:
      spotAgentLifecycleMaintenanceEnabled ? "true" : "false",
    ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: issuanceRateRecordCleanupEnabled
      ? "true"
      : "false",
    ...(reconciliationReadsEnabled || spotReconciliationReadsEnabled
      ? { HYPERLIQUID_INFO_QUOTA_HMAC_SECRET: "q".repeat(32) }
      : {}),
  });
}

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

function fakeSignalSource(): TestSignalSource {
  const listeners = new Map<WorkerShutdownSignal, Set<() => void>>();

  return {
    once(signal, listener): void {
      const signalListeners = listeners.get(signal) ?? new Set();
      signalListeners.add(listener);
      listeners.set(signal, signalListeners);
    },
    off(signal, listener): void {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal): void {
      const signalListeners = [...(listeners.get(signal) ?? [])];
      listeners.delete(signal);
      for (const listener of signalListeners) {
        listener();
      }
    },
  };
}

function fakeDatabase(events: string[]): ReconciliationWorkerDatabase {
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
    ping: vi.fn(() => {
      events.push("ping");
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      events.push("close");
      return Promise.resolve();
    }),
  };
}

function fakeWorker(run: ReconciliationWorker["run"]): ReconciliationWorker {
  return {
    workerId,
    runOnce: vi.fn(() => Promise.resolve({ kind: "idle" as const })),
    run,
  };
}

function fakeLifecycleWorker(
  run: SpotAgentLifecycleWorker["run"],
): SpotAgentLifecycleWorker {
  return {
    runOnce: vi.fn(() =>
      Promise.resolve({
        kind: "completed" as const,
        expiredPreparedCount: 0,
        retiredAgentIdentityCount: 0,
      }),
    ),
    run,
  };
}

function fakeQuotaRetentionWorker(
  run: IssuanceQuotaRetentionWorker["run"],
): IssuanceQuotaRetentionWorker {
  return {
    runOnce: vi.fn(() =>
      Promise.resolve({
        kind: "completed" as const,
        batchCount: 1,
        deletedCount: 0,
      }),
    ),
    run,
  };
}

describe("reconciliation worker runtime", () => {
  // The runtime installs the process-wide keep-alive dispatcher (S93b); put
  // the test process's own dispatcher back after each run.
  const originalDispatcher = getGlobalDispatcher();
  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  it("configures the outbound keep-alive before it touches the database (Decision 0088 ruling 1, S93b)", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    await runReconciliationWorker({
      config: workerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      configureOutboundKeepAlive: () => {
        events.push("keep-alive");
      },
      createDatabase: () => database,
      createWorker: () =>
        fakeWorker(
          vi.fn(() => {
            events.push("run");
            return Promise.resolve();
          }),
        ),
    });
    expect(events).toEqual(["keep-alive", "ping", "run", "close"]);
  });

  it("installs the 60 s keep-alive dispatcher by default", async () => {
    const before = getGlobalDispatcher();
    await runReconciliationWorker({
      config: workerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => fakeDatabase([]),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
    });
    const after = getGlobalDispatcher();
    expect(after).not.toBe(before);
    expect(after.constructor.name).toBe("Agent");
  });

  it("checks readiness before creating and running the worker", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();

    await runReconciliationWorker({
      config: workerConfig(),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => {
        events.push("create-worker");
        return fakeWorker(
          vi.fn(() => {
            events.push("run");
            return Promise.resolve();
          }),
        );
      },
    });

    expect(events).toEqual(["ping", "create-worker", "run", "close"]);
    expect(logger.info).toHaveBeenCalledWith(
      { workerId, environment: "test" },
      "LOOP reconciliation worker started",
    );
    expect(logger.info).toHaveBeenLastCalledWith(
      { workerId },
      "LOOP reconciliation worker stopped",
    );
  });

  it("passes the explicit atomic Hyperliquid registry only when enabled", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);

    await runReconciliationWorker({
      config: workerConfig(true),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: (options) => {
        const handler = options.readers?.find("hyperliquid", "perp_intent");
        expect(handler?.mode).toBe("atomic_domain");
        expect(
          handler?.mode === "atomic_domain" ? typeof handler.run : "missing",
        ).toBe("function");
        return fakeWorker(vi.fn(() => Promise.resolve()));
      },
    });

    expect(events).toEqual(["ping", "close"]);
  });

  it("keeps the independent Spot reconciliation worker default-closed", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    Object.defineProperty(database, "spotReconciliation", {
      configurable: true,
      get: () => {
        throw new Error("disabled Spot repository must not be accessed");
      },
    });
    const createWorker = vi.fn<
      (options: CreateReconciliationWorkerOptions) => ReconciliationWorker
    >(() => fakeWorker(vi.fn(() => Promise.resolve())));

    await runReconciliationWorker({
      config: workerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker,
    });

    expect(createWorker).toHaveBeenCalledOnce();
    const genericOptions = createWorker.mock.calls[0]?.[0];
    expect(genericOptions?.controlPlane).toBe(database.controlPlane);
    expect(
      genericOptions?.readers?.find("hyperliquid", "spot_intent"),
    ).toBeUndefined();
    expect(events).toEqual(["ping", "close"]);
  });

  it("creates a fenced Spot worker with the generic worker identity and shared registry", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const createdOptions: CreateReconciliationWorkerOptions[] = [];
    const runSignals: AbortSignal[] = [];

    await runReconciliationWorker({
      config: workerConfig(false, false, true),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: (options) => {
        const index = createdOptions.push(options) - 1;
        return fakeWorker(
          vi.fn((signal: AbortSignal) => {
            runSignals.push(signal);
            events.push(index === 0 ? "run-generic" : "run-spot");
            return Promise.resolve();
          }),
        );
      },
    });

    expect(createdOptions).toHaveLength(2);
    const genericOptions = createdOptions[0];
    const spotOptions = createdOptions[1];
    expect(genericOptions?.controlPlane).toBe(database.controlPlane);
    expect(genericOptions?.workerId).toBeUndefined();
    expect(spotOptions?.controlPlane).toBe(database.spotReconciliation);
    expect(spotOptions?.workerId).toBe(workerId);
    expect(spotOptions?.readers).toBe(genericOptions?.readers);
    const spotHandler = spotOptions?.readers?.find(
      "hyperliquid",
      "spot_intent",
    );
    expect(spotHandler?.mode).toBe("atomic_domain");
    expect(
      spotHandler?.mode === "atomic_domain"
        ? typeof spotHandler.run
        : "missing",
    ).toBe("function");
    expect(
      spotOptions?.readers?.find("hyperliquid", "perp_intent"),
    ).toBeUndefined();
    expect(runSignals).toHaveLength(2);
    expect(runSignals[1]).toBe(runSignals[0]);
    expect(events).toEqual(["ping", "run-generic", "run-spot", "close"]);
  });

  it("fails closed before either loop runs when the Spot worker identity diverges", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const genericRun = vi.fn(() => Promise.resolve());
    const spotRun = vi.fn(() => Promise.resolve());
    let workerIndex = 0;

    await expect(
      runReconciliationWorker({
        config: workerConfig(false, false, true),
        logger: fakeLogger(),
        signalSource: fakeSignalSource(),
        createDatabase: () => database,
        createWorker: () => {
          if (workerIndex++ === 0) {
            return fakeWorker(genericRun);
          }

          return {
            ...fakeWorker(spotRun),
            workerId: "10d15c5c-d334-4ff6-bdad-eebefef02137",
          };
        },
      }),
    ).rejects.toThrowError(/Spot reconciliation worker identity mismatch/);

    expect(genericRun).not.toHaveBeenCalled();
    expect(spotRun).not.toHaveBeenCalled();
    expect(events).toEqual(["ping", "close"]);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("runs the database-only Spot Agent lifecycle loop only when enabled", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();
    const lifecycleRun = vi.fn(() => {
      events.push("run-lifecycle");
      return Promise.resolve();
    });

    await runReconciliationWorker({
      config: workerConfig(false, true),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () =>
        fakeWorker(
          vi.fn(() => {
            events.push("run-reconciliation");
            return Promise.resolve();
          }),
        ),
      createLifecycleWorker: (options) => {
        expect(options.maintenance).toBe(database.spotAgentAuthorizations);
        options.onInfrastructureBackoff?.({
          reasonCode: "spot_agent_identity_retirement_unavailable",
          consecutiveFailureCount: 2,
          retryDelayMs: 2_000,
        });
        return fakeLifecycleWorker(lifecycleRun);
      },
    });

    expect(events).toEqual([
      "ping",
      "run-reconciliation",
      "run-lifecycle",
      "close",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        reasonCode: "spot_agent_identity_retirement_unavailable",
        consecutiveFailureCount: 2,
        retryDelayMs: 2_000,
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );
  });

  it("does not construct or access Spot Agent lifecycle maintenance when disabled", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    Object.defineProperty(database, "spotAgentAuthorizations", {
      configurable: true,
      get: () => {
        throw new Error("disabled lifecycle port must not be accessed");
      },
    });
    const createLifecycleWorker = vi.fn();

    await runReconciliationWorker({
      config: workerConfig(false, false),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createLifecycleWorker,
    });

    expect(createLifecycleWorker).not.toHaveBeenCalled();
    expect(events).toEqual(["ping", "close"]);
  });

  it("runs default-policy quota retention only when its worker gate is enabled", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();
    const retentionRun = vi.fn(() => {
      events.push("run-quota-retention");
      return Promise.resolve();
    });

    await runReconciliationWorker({
      config: workerConfig(false, false, false, true),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () =>
        fakeWorker(
          vi.fn(() => {
            events.push("run-reconciliation");
            return Promise.resolve();
          }),
        ),
      createQuotaRetentionWorker: (options) => {
        expect(options.maintenance).toBe(database.controlPlane);
        options.onInfrastructureBackoff?.({
          reasonCode: "issuance_quota_retention_unavailable",
          consecutiveFailureCount: 3,
          retryDelayMs: 4_000,
        });
        return fakeQuotaRetentionWorker(retentionRun);
      },
    });

    expect(events).toEqual([
      "ping",
      "run-reconciliation",
      "run-quota-retention",
      "close",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        reasonCode: "issuance_quota_retention_unavailable",
        consecutiveFailureCount: 3,
        retryDelayMs: 4_000,
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );
  });

  it("does not construct quota retention when cleanup is paused", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const createQuotaRetentionWorker = vi.fn();

    await runReconciliationWorker({
      config: workerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createQuotaRetentionWorker,
    });

    expect(createQuotaRetentionWorker).not.toHaveBeenCalled();
    expect(events).toEqual(["ping", "close"]);
  });

  it("aborts and awaits reconciliation before close after quota retention fails", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const failure = new Error("private quota row must not be logged");
    const reconciliationRun = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            events.push("reconciliation-aborted");
            resolve();
          };
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener("abort", finish, { once: true });
        }),
    );

    await expect(
      runReconciliationWorker({
        config: workerConfig(false, false, false, true),
        logger: fakeLogger(),
        signalSource: fakeSignalSource(),
        createDatabase: () => database,
        createWorker: () => fakeWorker(reconciliationRun),
        createQuotaRetentionWorker: () =>
          fakeQuotaRetentionWorker(vi.fn(() => Promise.reject(failure))),
      }),
    ).rejects.toBe(failure);

    expect(events).toEqual(["ping", "reconciliation-aborted", "close"]);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("handles repeated shutdown signals once and closes after abort", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();
    const signalSource = fakeSignalSource();
    const runLoop = (label: "reconciliation" | "quota-retention") =>
      vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push(`${label}-aborted`);
                resolve();
              },
              { once: true },
            );
          }),
      );
    const run = runLoop("reconciliation");
    const quotaRetentionRun = runLoop("quota-retention");

    const runtime = runReconciliationWorker({
      config: workerConfig(false, false, false, true),
      logger,
      signalSource,
      createDatabase: () => database,
      createWorker: () => fakeWorker(run),
      createQuotaRetentionWorker: () =>
        fakeQuotaRetentionWorker(quotaRetentionRun),
    });
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
      expect(quotaRetentionRun).toHaveBeenCalledOnce();
    });

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    await runtime;

    expect(events[0]).toBe("ping");
    expect(events).toContain("reconciliation-aborted");
    expect(events).toContain("quota-retention-aborted");
    expect(events.at(-1)).toBe("close");
    expect(logger.info).toHaveBeenCalledWith(
      { workerId, signal: "SIGTERM" },
      "LOOP reconciliation worker shutdown requested",
    );
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter(
          ([, message]) =>
            message === "LOOP reconciliation worker shutdown requested",
        ),
    ).toHaveLength(1);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the database once when the worker fails", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const failure = new Error("provider payload must not be logged");

    await expect(
      runReconciliationWorker({
        config: workerConfig(),
        logger: fakeLogger(),
        signalSource: fakeSignalSource(),
        createDatabase: () => database,
        createWorker: () => fakeWorker(vi.fn(() => Promise.reject(failure))),
      }),
    ).rejects.toBe(failure);

    expect(database.close).toHaveBeenCalledOnce();
  });

  it("aborts and awaits the sibling loop before closing after a lifecycle failure", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const lifecycleFailure = new Error(
      "private lifecycle database detail must not be logged",
    );
    const reconciliationRun = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("reconciliation-aborted");
              resolve();
            },
            { once: true },
          );
        }),
    );

    await expect(
      runReconciliationWorker({
        config: workerConfig(false, true),
        logger: fakeLogger(),
        signalSource: fakeSignalSource(),
        createDatabase: () => database,
        createWorker: () => fakeWorker(reconciliationRun),
        createLifecycleWorker: () =>
          fakeLifecycleWorker(vi.fn(() => Promise.reject(lifecycleFailure))),
      }),
    ).rejects.toBe(lifecycleFailure);

    expect(events).toEqual(["ping", "reconciliation-aborted", "close"]);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it.each(["generic", "spot"] as const)(
    "aborts the sibling and closes once when the %s reconciliation loop fails",
    async (failingLoop) => {
      const events: string[] = [];
      const database = fakeDatabase(events);
      const failure = new Error(`${failingLoop} private failure`);
      let workerIndex = 0;

      await expect(
        runReconciliationWorker({
          config: workerConfig(false, false, true),
          logger: fakeLogger(),
          signalSource: fakeSignalSource(),
          createDatabase: () => database,
          createWorker: () => {
            const loop = workerIndex++ === 0 ? "generic" : "spot";
            return fakeWorker(
              vi.fn((signal: AbortSignal) => {
                events.push(`${loop}-started`);
                if (loop === failingLoop) {
                  return Promise.reject(failure);
                }
                return new Promise<void>((resolve) => {
                  const finish = () => {
                    events.push(`${loop}-aborted`);
                    resolve();
                  };
                  if (signal.aborted) {
                    finish();
                    return;
                  }
                  signal.addEventListener("abort", finish, { once: true });
                });
              }),
            );
          },
        }),
      ).rejects.toBe(failure);

      const sibling = failingLoop === "generic" ? "spot" : "generic";
      expect(events).toContain("generic-started");
      expect(events).toContain("spot-started");
      expect(events).toContain(`${sibling}-aborted`);
      expect(events.at(-1)).toBe("close");
      expect(database.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["generic", "spot", "lifecycle"] as const)(
    "aborts every sibling before close when all loops run and %s fails",
    async (failingLoop) => {
      const events: string[] = [];
      const database = fakeDatabase(events);
      const failure = new Error(`${failingLoop} private failure`);
      let workerIndex = 0;
      const runLoop = (loop: "generic" | "spot" | "lifecycle") =>
        vi.fn((signal: AbortSignal) => {
          events.push(`${loop}-started`);
          if (loop === failingLoop) {
            return Promise.reject(failure);
          }

          return new Promise<void>((resolve) => {
            const finish = () => {
              events.push(`${loop}-aborted`);
              resolve();
            };
            if (signal.aborted) {
              finish();
              return;
            }
            signal.addEventListener("abort", finish, { once: true });
          });
        });

      await expect(
        runReconciliationWorker({
          config: workerConfig(false, true, true),
          logger: fakeLogger(),
          signalSource: fakeSignalSource(),
          createDatabase: () => database,
          createWorker: () => {
            const loop = workerIndex++ === 0 ? "generic" : "spot";
            return fakeWorker(runLoop(loop));
          },
          createLifecycleWorker: () =>
            fakeLifecycleWorker(runLoop("lifecycle")),
        }),
      ).rejects.toBe(failure);

      for (const loop of ["generic", "spot", "lifecycle"] as const) {
        expect(events).toContain(`${loop}-started`);
        if (loop !== failingLoop) {
          expect(events).toContain(`${loop}-aborted`);
        }
      }
      expect(events.at(-1)).toBe("close");
      expect(database.close).toHaveBeenCalledOnce();
    },
  );

  it("closes the database without creating a worker when readiness fails", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const readinessFailure = new Error("database detail must not escape");
    vi.mocked(database.ping).mockRejectedValueOnce(readinessFailure);
    const createWorker = vi.fn(() => fakeWorker(vi.fn()));

    await expect(
      runReconciliationWorker({
        config: workerConfig(),
        logger: fakeLogger(),
        signalSource: fakeSignalSource(),
        createDatabase: () => database,
        createWorker,
      }),
    ).rejects.toBe(readinessFailure);

    expect(createWorker).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("maps infrastructure backoff to sanitized structured fields", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();

    await runReconciliationWorker({
      config: workerConfig(),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: (options) =>
        fakeWorker(
          vi.fn(() => {
            options.onInfrastructureBackoff?.({
              reasonCode: "control_plane_unavailable",
              consecutiveFailureCount: 3,
              retryDelayMs: 4_000,
            });
            return Promise.resolve();
          }),
        ),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        workerId,
        reasonCode: "control_plane_unavailable",
        consecutiveFailureCount: 3,
        retryDelayMs: 4_000,
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );
  });
});

describe("market sparkline warm lane composition (Decision 0074)", () => {
  function laneConfig(overrides: Readonly<Record<string, string>> = {}) {
    return loadReconciliationWorkerConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
      ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
      ...overrides,
    });
  }

  function laneDatabase(events: string[]) {
    const watchlistsV2 = {} as WatchlistV2Repository;
    return {
      database: {
        ...fakeDatabase(events),
        chainRegistry: {} as ChainRegistryRepository,
        marketFacts: {} as MarketFactCacheRepository,
        watchlistsV2,
      } satisfies ReconciliationWorkerDatabase,
      watchlistsV2,
    };
  }

  it("runs the lane with the worker's GeckoTerminal share when the Provider is enabled", async () => {
    const events: string[] = [];
    const { database, watchlistsV2 } = laneDatabase(events);
    const createMarketSparklineWarmWorker = vi.fn(
      (options: CreateMarketSparklineWarmWorkerOptions) => {
        expect(options).toMatchObject({
          chainId: "eip155:56",
          intervalMs: 4_000,
          sparklineTtlSeconds: 300,
          poolRevalidationSeconds: 3_600,
        });
        expect(options.watchlist).toBe(watchlistsV2);
        expect(options.cache).toBe(database.marketFacts);
        expect(options.facts.candlesProviderEnabled).toBe(true);
        return {
          workerId,
          lane: "market_sparkline_warm" as const,
          runOnce: vi.fn(() =>
            Promise.resolve({ kind: "idle" as const, skippedFreshCount: 0 }),
          ),
          run: () => {
            events.push("run-sparkline-warm");
            return Promise.resolve();
          },
        };
      },
    );

    await runReconciliationWorker({
      config: laneConfig({ MARKET_PROVIDER_GECKOTERMINAL_ENABLED: "true" }),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () =>
        fakeWorker(
          vi.fn(() => {
            events.push("run-reconciliation");
            return Promise.resolve();
          }),
        ),
      createMarketSparklineWarmWorker,
    });

    expect(createMarketSparklineWarmWorker).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "ping",
      "run-reconciliation",
      "run-sparkline-warm",
      "close",
    ]);
  });

  it("leaves the lane out and says so once when the OHLCV Provider is disabled", async () => {
    const events: string[] = [];
    const { database } = laneDatabase(events);
    const logger = fakeLogger();
    const createMarketSparklineWarmWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig(),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createMarketSparklineWarmWorker,
    });

    expect(createMarketSparklineWarmWorker).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        lane: "market_sparkline_warm",
        reasonCode: "MARKET_PROVIDER_GECKOTERMINAL_DISABLED",
      },
      "LOOP market sparkline warm lane stays idle: the OHLCV Provider is disabled",
    );
    expect(events).toEqual(["ping", "close"]);
  });

  it("does not construct the lane when its switch is off", async () => {
    const events: string[] = [];
    const { database } = laneDatabase(events);
    const logger = fakeLogger();
    const createMarketSparklineWarmWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig({
        MARKET_PROVIDER_GECKOTERMINAL_ENABLED: "true",
        MARKET_SPARKLINE_WARM_ENABLED: "false",
      }),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createMarketSparklineWarmWorker,
    });

    expect(createMarketSparklineWarmWorker).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "market_sparkline_warm" }),
      expect.anything(),
    );
    expect(events).toEqual(["ping", "close"]);
  });
});

describe("BSC transfer lane composition (Decision 0075)", () => {
  function indexerConfig() {
    return loadReconciliationWorkerConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
      ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
      MARKET_SPARKLINE_WARM_ENABLED: "false",
      BSC_INDEXER_ENABLED: "true",
      BSC_RPC_URLS: "https://rpc-a.example/",
      BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE: "150",
    });
  }

  function indexerFactories() {
    const createBscIndexerWorker = vi.fn<
      (options: CreateBscIndexerWorkerOptions) => BscIndexerWorker
    >((): BscIndexerWorker => ({
      workerId,
      lane: "erc20_transfer",
      runOnce: vi.fn(),
      backfillApprovalCoverageOnce: vi.fn(),
      run: () => Promise.resolve(),
    }));
    const createBscPoolIndexerWorker = vi.fn(
      (): BscPoolIndexerWorker =>
        ({
          workerId,
          lane: "pool_event",
          runOnce: vi.fn(),
          run: () => Promise.resolve(),
        }) as unknown as BscPoolIndexerWorker,
    );
    return { createBscIndexerWorker, createBscPoolIndexerWorker };
  }

  it("hands the lane the active-wallet source and the configured topic chunk size", async () => {
    expect(indexerConfig().bscIndexer).toEqual({
      startBlockNumber: null,
      walletTopicChunkSize: 150,
    });
    const events: string[] = [];
    const walletSet: BscIndexerWalletSetRepository = {
      listActiveWalletAddresses: vi.fn(() => Promise.resolve([])),
    };
    const factories = indexerFactories();

    await runReconciliationWorker({
      config: indexerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => ({
        ...fakeDatabase(events),
        chainRegistry: {} as ChainRegistryRepository,
        bscIndexer: {} as BscIndexerRepository,
        bscIndexerWallets: walletSet,
      }),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createBscReadClient: () => createUnavailableBscReadClient(),
      ...factories,
    });

    expect(factories.createBscIndexerWorker).toHaveBeenCalledTimes(1);
    const options = factories.createBscIndexerWorker.mock.calls[0]?.[0];
    expect(options?.walletSet).toBe(walletSet);
    expect(options?.walletTopicChunkSize).toBe(150);
  });

  it("keeps the transfer lane off rather than scanning every log when the wallet source is missing", async () => {
    const events: string[] = [];
    const factories = indexerFactories();

    await runReconciliationWorker({
      config: indexerConfig(),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => ({
        ...fakeDatabase(events),
        chainRegistry: {} as ChainRegistryRepository,
        bscIndexer: {} as BscIndexerRepository,
      }),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createBscReadClient: () => createUnavailableBscReadClient(),
      ...factories,
    });

    expect(factories.createBscIndexerWorker).not.toHaveBeenCalled();
    // The pool lane does not depend on the wallet set (Decision 0034).
    expect(factories.createBscPoolIndexerWorker).toHaveBeenCalledTimes(1);
  });
});

describe("voice_room_reaper lane composition (Decision 0094)", () => {
  function laneConfig(overrides: Readonly<Record<string, string>> = {}) {
    return loadReconciliationWorkerConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
      ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
      MARKET_SPARKLINE_WARM_ENABLED: "false",
      ...overrides,
    });
  }

  const streamPair = {
    STREAM_API_KEY: "stream-key-for-test",
    STREAM_API_SECRET: "stream-secret-for-test",
  };

  function laneDatabase(events: string[]) {
    return {
      ...fakeDatabase(events),
      voiceRoomReaper: {
        listLiveVoiceRoomsForReaper: vi.fn(() => Promise.resolve([])),
        endVoiceRoomByReaper: vi.fn(),
      },
    } satisfies ReconciliationWorkerDatabase;
  }

  it("runs the lane with the configured interval and the Stream pair", async () => {
    const events: string[] = [];
    const database = laneDatabase(events);
    const createVoiceRoomCallGateway = vi.fn(
      createUnavailableStreamCallGateway,
    );
    const createVoiceRoomReaperWorker = vi.fn(
      (options: CreateVoiceRoomReaperWorkerOptions) => {
        expect(options.intervalMs).toBe(30_000);
        return {
          runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
          run: async (signal: AbortSignal) => {
            await options.service.runOnce(signal);
            events.push("run-voice-room-reaper");
          },
        };
      },
    );

    await runReconciliationWorker({
      config: laneConfig({
        ...streamPair,
        VOICE_ROOM_REAPER_INTERVAL_MS: "30000",
      }),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createVoiceRoomReaperWorker,
      createVoiceRoomCallGateway,
    });

    expect(createVoiceRoomCallGateway).toHaveBeenCalledWith({
      apiKey: "stream-key-for-test",
      apiSecret: "stream-secret-for-test",
    });
    expect(
      database.voiceRoomReaper.listLiveVoiceRoomsForReaper,
    ).toHaveBeenCalledWith({ limit: 50 });
    expect(events).toEqual(["ping", "run-voice-room-reaper", "close"]);
  });

  it("leaves the lane out and says so once without the Stream pair", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const createVoiceRoomReaperWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig(),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => laneDatabase(events),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createVoiceRoomReaperWorker,
    });

    expect(createVoiceRoomReaperWorker).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        lane: "voice_room_reaper",
        reasonCode: "VOICE_ROOM_REAPER_STREAM_NOT_CONFIGURED",
      },
      "LOOP voice room reaper lane stays idle: Stream is not configured",
    );
    expect(events).toEqual(["ping", "close"]);
  });

  it("does not construct the lane when its switch is off", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const createVoiceRoomReaperWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig({ ...streamPair, VOICE_ROOM_REAPER_ENABLED: "false" }),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => laneDatabase(events),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createVoiceRoomReaperWorker,
    });

    expect(createVoiceRoomReaperWorker).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "voice_room_reaper" }),
      expect.anything(),
    );
    expect(events).toEqual(["ping", "close"]);
  });

  it("logs an ended room with its reason code and the Stream outcome", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const voiceRoomId = "0f0e0d0c-0b0a-4908-8706-000000000001";
    const callId = `loop_voice_${"b".repeat(32)}`;
    const database = {
      ...fakeDatabase(events),
      voiceRoomReaper: {
        listLiveVoiceRoomsForReaper: vi.fn(() =>
          Promise.resolve([
            {
              voiceRoomId,
              callId,
              provisionState: "provisioned" as const,
              createdAt: "2026-10-07T00:00:00.000Z",
              lastActivityAt: "2026-10-07T00:00:00.000Z",
              nonHostJoinedCount: 0,
              databaseNow: "2026-10-08T00:00:00.000Z",
            },
          ]),
        ),
        endVoiceRoomByReaper: vi.fn(() =>
          Promise.resolve({ outcome: "ended" as const, callId }),
        ),
      },
    } satisfies ReconciliationWorkerDatabase;

    await runReconciliationWorker({
      config: laneConfig(streamPair),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      // The unavailable gateway cannot confirm the end.
      createVoiceRoomCallGateway: createUnavailableStreamCallGateway,
      createVoiceRoomReaperWorker: (options) => ({
        runOnce: (signal) => options.service.runOnce(signal),
        run: async (signal) => {
          await options.service.runOnce(signal);
        },
      }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "voice_room_reaper",
        voiceRoomId,
        reasonCode: "STREAM_CALL_END_UNCONFIRMED",
        detailReasonCode: "VOICE_ROOM_MAX_AGE_ENDED",
      }),
      "LOOP voice room reaper could not confirm the Stream call end",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "voice_room_reaper",
        voiceRoomId,
        reasonCode: "VOICE_ROOM_MAX_AGE_ENDED",
        providerSyncStatus: "unconfirmed",
      }),
      "LOOP voice room reaper ended a room",
    );
  });
});

describe("community_member_buy_feed lane composition (Decision 0097)", () => {
  function laneConfig(overrides: Readonly<Record<string, string>> = {}) {
    return loadReconciliationWorkerConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED: "false",
      ISSUANCE_RATE_RECORD_CLEANUP_ENABLED: "false",
      MARKET_SPARKLINE_WARM_ENABLED: "false",
      VOICE_ROOM_REAPER_ENABLED: "false",
      ...overrides,
    });
  }

  const streamPair = {
    STREAM_API_KEY: "stream-key-for-test",
    STREAM_API_SECRET: "stream-secret-for-test",
  };

  function laneDatabase(events: string[]) {
    return {
      ...fakeDatabase(events),
      memberBuyFeed: {
        readPoolEventCheckpoint: vi.fn(() => Promise.resolve("100")),
        readCursor: vi.fn(() => Promise.resolve(null)),
        initializeCursor: vi.fn((_chainId: string, position) =>
          Promise.resolve(position),
        ),
        advanceCursor: vi.fn(() => Promise.resolve()),
        listCandidates: vi.fn(() => Promise.resolve([])),
        recordEvent: vi.fn(() => Promise.resolve()),
        settleEvent: vi.fn(() => Promise.resolve()),
      },
    } satisfies ReconciliationWorkerDatabase;
  }

  it("runs the lane with the configured interval and its own Stream pair", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const database = laneDatabase(events);
    const createMemberBuyFeedGateway = vi.fn(
      createUnavailableStreamCommunityChannelGateway,
    );
    const createMemberBuyFeedWorker = vi.fn(
      (options: CreateMemberBuyFeedWorkerOptions) => {
        expect(options.intervalMs).toBe(20_000);
        return {
          runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
          run: async (signal: AbortSignal) => {
            await options.service.runOnce(signal);
            events.push("run-member-buy-feed");
          },
        };
      },
    );

    await runReconciliationWorker({
      config: laneConfig({
        ...streamPair,
        COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS: "20000",
      }),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => database,
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createMemberBuyFeedWorker,
      createMemberBuyFeedGateway,
    });

    expect(createMemberBuyFeedGateway).toHaveBeenCalledWith({
      apiKey: "stream-key-for-test",
      apiSecret: "stream-secret-for-test",
    });
    expect(database.memberBuyFeed.initializeCursor).toHaveBeenCalledWith(
      "eip155:56",
      { blockNumber: "100", logIndex: 2_147_483_647 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "community_member_buy_feed",
        reasonCode: "MEMBER_BUY_FEED_CURSOR_INITIALIZED",
        blockNumber: "100",
      }),
      "LOOP member buy feed cursor initialized at the indexer checkpoint",
    );
    expect(events).toEqual(["ping", "run-member-buy-feed", "close"]);
  });

  it("leaves the lane out and says so once without the Stream pair", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const createMemberBuyFeedWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig(),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => laneDatabase(events),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createMemberBuyFeedWorker,
    });

    expect(createMemberBuyFeedWorker).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        lane: "community_member_buy_feed",
        reasonCode: "MEMBER_BUY_FEED_STREAM_NOT_CONFIGURED",
      },
      "LOOP member buy feed lane stays idle: Stream is not configured",
    );
    expect(events).toEqual(["ping", "close"]);
  });

  it("does not construct the lane when its switch is off", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const createMemberBuyFeedWorker = vi.fn();

    await runReconciliationWorker({
      config: laneConfig({
        ...streamPair,
        COMMUNITY_MEMBER_BUY_FEED_ENABLED: "false",
      }),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => laneDatabase(events),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createMemberBuyFeedWorker,
    });

    expect(createMemberBuyFeedWorker).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: "community_member_buy_feed" }),
      expect.anything(),
    );
  });
});

describe("hooks_launch_executor lane (Decision 0112)", () => {
  const executorEnvironment = {
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
    HOOKS_LAUNCH_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
    HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
    HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: `0x${"42".repeat(32)}`,
  };

  it("builds the lane from the launch slot RPC, the Factory pair and the lease", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const repository = {} as HooksLaunchExecutorRepository;
    const repositoryFactory = vi.fn(() => repository);
    const chain = {
      executorAddress: "0x2222222222222222222222222222222222222222",
    } as HooksLaunchExecutorChain;
    const createHooksLaunchExecutorChain = vi.fn(() => chain);
    const createHooksLaunchExecutorLane = vi.fn(
      (options: Parameters<typeof createHooksLaunchExecutorLaneType>[0]) => {
        expect(options.repository).toBe(repository);
        expect(options.chain).toBe(chain);
        expect(options.executorId).toMatch(/^hooks-executor:/u);
        return {
          lane: "hooks_launch_executor",
          executor: {} as HooksLaunchExecutor,
          runOnce: vi.fn(),
          run: vi.fn(() => {
            events.push("run-hooks-executor");
            return Promise.resolve();
          }),
        };
      },
    );

    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(executorEnvironment),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => ({
        ...fakeDatabase(events),
        hooksLaunchExecutor: repositoryFactory,
      }),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createHooksLaunchExecutorChain,
      createHooksLaunchExecutorLane,
    });

    expect(createHooksLaunchExecutorChain).toHaveBeenCalledWith({
      privateKey: `0x${"42".repeat(32)}`,
      factoryAddress: "0x1111111111111111111111111111111111111111",
      rpcUrls: ["https://bsc-testnet.example/rpc"],
    });
    expect(repositoryFactory).toHaveBeenCalledWith(120);
    expect(events).toEqual(["ping", "run-hooks-executor", "close"]);
    const enabled = vi
      .mocked(logger.info)
      .mock.calls.find(
        ([, message]) => message === "LOOP hooks launch executor enabled",
      );
    expect(enabled?.[0]).toMatchObject({
      lane: "hooks_launch_executor",
      executorAddress: "0x2222222222222222222222222222222222222222",
      confirmations: 3,
    });
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "42".repeat(32),
    );
  });

  it("stays idle with a reason when the chain client refuses", async () => {
    const events: string[] = [];
    const logger = fakeLogger();
    const createHooksLaunchExecutorLane = vi.fn();
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(executorEnvironment),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => ({
        ...fakeDatabase(events),
        hooksLaunchExecutor: vi.fn(),
      }),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createHooksLaunchExecutorChain: () => {
        throw new HooksLaunchExecutorChainRefusedError(
          "HOOKS_EXECUTOR_RPC_NOT_CONFIGURED",
        );
      },
      createHooksLaunchExecutorLane,
    });
    expect(createHooksLaunchExecutorLane).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        lane: "hooks_launch_executor",
        reasonCode: "HOOKS_EXECUTOR_RPC_NOT_CONFIGURED",
      },
      "LOOP hooks launch executor stays idle",
    );
  });

  it("does not construct anything while the switch is off", async () => {
    const createHooksLaunchExecutorChain = vi.fn();
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig({
        ...executorEnvironment,
        HOOKS_LAUNCH_EXECUTOR_ENABLED: "off",
      }),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => fakeDatabase([]),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createHooksLaunchExecutorChain,
    });
    expect(createHooksLaunchExecutorChain).not.toHaveBeenCalled();
  });
});

describe("launch2_snapshot_publisher lane (Decision 0118)", () => {
  const publisherEnvironment = {
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
    LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: "true",
    LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `0x${"51".repeat(32)},0x${"52".repeat(32)}`,
    HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: `0x${"42".repeat(32)}`,
  };

  it("refuses boot with a single signer key", () => {
    expect(() =>
      loadReconciliationWorkerConfig({
        ...publisherEnvironment,
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `0x${"51".repeat(32)}`,
      }),
    ).toThrow(/LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS/u);
    expect(() =>
      loadReconciliationWorkerConfig({
        ...publisherEnvironment,
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: "",
      }),
    ).toThrow(/LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS/u);
  });

  it("builds the lane with the executor key as submitter and never logs a key", async () => {
    const logger = fakeLogger();
    const createLaunch2PublisherChain = vi.fn(
      () =>
        ({
          submitterAddress: "0x2222222222222222222222222222222222222222",
          chainId: () => Promise.resolve(56),
        }) as unknown as Launch2PublisherChain,
    );
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(publisherEnvironment),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => ({
        ...fakeDatabase([]),
        launch2: {} as Launch2Repository,
        launch2Publications: {} as Launch2PublicationRepository,
      }),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createLaunch2PublisherChain,
      createLaunch2SnapshotPublisherLane: (options) => {
        expect(options.signers.map((signer) => signer.address)).toHaveLength(2);
        expect(options.policy).toMatchObject({
          chainId: "eip155:97",
          confirmations: 12,
          maxGasPriceWei: 20_000_000_000n,
        });
        return {
          lane: "launch2_snapshot_publisher",
          publisher: { runOnce: vi.fn() },
          runOnce: vi.fn(),
          run: vi.fn(() => Promise.resolve()),
        };
      },
    });
    expect(createLaunch2PublisherChain).toHaveBeenCalledWith({
      privateKey: `0x${"42".repeat(32)}`,
      rpcUrls: ["https://bsc-testnet.example/rpc"],
    });
    const enabled = vi
      .mocked(logger.info)
      .mock.calls.find(
        ([, message]) => message === "LOOP launch2 snapshot publisher enabled",
      );
    expect(enabled?.[0]).toMatchObject({
      lane: "launch2_snapshot_publisher",
      executorAddress: "0x2222222222222222222222222222222222222222",
      confirmations: 12,
      count: 2,
    });
    const logged = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
    ]);
    for (const secret of ["42", "51", "52"]) {
      expect(logged).not.toContain(secret.repeat(32));
    }
  });

  it("stays idle with a reason without the repositories, and is absent while off", async () => {
    const logger = fakeLogger();
    const createLaunch2PublisherChain = vi.fn();
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig(publisherEnvironment),
      logger,
      signalSource: fakeSignalSource(),
      createDatabase: () => fakeDatabase([]),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createLaunch2PublisherChain,
    });
    expect(createLaunch2PublisherChain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        lane: "launch2_snapshot_publisher",
        reasonCode: "LAUNCH2_REPOSITORY_UNAVAILABLE",
      },
      "LOOP launch2 snapshot publisher stays idle",
    );
    const off = vi.fn();
    await runReconciliationWorker({
      config: loadReconciliationWorkerConfig({
        ...publisherEnvironment,
        LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: "false",
      }),
      logger: fakeLogger(),
      signalSource: fakeSignalSource(),
      createDatabase: () => fakeDatabase([]),
      createWorker: () => fakeWorker(vi.fn(() => Promise.resolve())),
      createLaunch2PublisherChain: off,
    });
    expect(off).not.toHaveBeenCalled();
  });
});
