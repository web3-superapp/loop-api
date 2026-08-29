import { describe, expect, it, vi } from "vitest";

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
