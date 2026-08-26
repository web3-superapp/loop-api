import { describe, expect, it, vi } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import type { PerpReconciliationRepository } from "../src/features/perp/perp-reconciliation-contract.js";
import type { ReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";
import type { SpotAgentLifecycleWorker } from "../src/spot-agent-lifecycle-worker.js";
import type { ReconciliationWorker } from "../src/worker.js";
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
) {
  return loadReconciliationWorkerConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: reconciliationReadsEnabled
      ? "true"
      : "false",
    SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED:
      spotAgentLifecycleMaintenanceEnabled ? "true" : "false",
    ...(reconciliationReadsEnabled
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

  it("handles repeated shutdown signals once and closes after abort", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const logger = fakeLogger();
    const signalSource = fakeSignalSource();
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              resolve();
            },
            { once: true },
          );
        }),
    );

    const runtime = runReconciliationWorker({
      config: workerConfig(),
      logger,
      signalSource,
      createDatabase: () => database,
      createWorker: () => fakeWorker(run),
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    await runtime;

    expect(events).toEqual(["ping", "abort", "close"]);
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
