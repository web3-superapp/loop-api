import type { ReconciliationWorkerConfig } from "./config.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseConfig,
  type PostgresDatabaseLogger,
} from "./database/database.js";
import type { ReconciliationControlPlane } from "./features/reconciliation/reconciliation-service.js";
import type {
  ReconciliationWorkerLogFields,
  ReconciliationWorkerLogger,
} from "./reconciliation-worker-logger.js";
import {
  createReconciliationWorker,
  type CreateReconciliationWorkerOptions,
  type ReconciliationWorker,
} from "./worker.js";

export type WorkerShutdownSignal = "SIGINT" | "SIGTERM";

export interface WorkerSignalSource {
  readonly once: (signal: WorkerShutdownSignal, listener: () => void) => void;
  readonly off: (signal: WorkerShutdownSignal, listener: () => void) => void;
}

export interface ReconciliationWorkerDatabase {
  readonly controlPlane: ReconciliationControlPlane;
  readonly ping: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export type ReconciliationWorkerDatabaseFactory = (
  config: PostgresDatabaseConfig,
  logger: PostgresDatabaseLogger,
) => ReconciliationWorkerDatabase;

export type ReconciliationWorkerFactory = (
  options: CreateReconciliationWorkerOptions,
) => ReconciliationWorker;

export interface RunReconciliationWorkerOptions {
  readonly config: ReconciliationWorkerConfig;
  readonly logger: ReconciliationWorkerLogger;
  readonly signalSource?: WorkerSignalSource;
  readonly createDatabase?: ReconciliationWorkerDatabaseFactory;
  readonly createWorker?: ReconciliationWorkerFactory;
}

const processSignalSource: WorkerSignalSource = {
  once(signal, listener): void {
    process.once(signal, listener);
  },
  off(signal, listener): void {
    process.off(signal, listener);
  },
};

export const processWorkerSignalSource: WorkerSignalSource =
  Object.freeze(processSignalSource);

/**
 * Owns only process lifecycle composition. Provider reads remain constrained by
 * the registry selected by `createReconciliationWorker`; this runtime never
 * imports an HTTP app, signer, executor, or provider mutation adapter.
 */
export async function runReconciliationWorker(
  options: RunReconciliationWorkerOptions,
): Promise<void> {
  const signalSource = options.signalSource ?? processWorkerSignalSource;
  const databaseFactory = options.createDatabase ?? createPostgresDatabase;
  const workerFactory = options.createWorker ?? createReconciliationWorker;
  const controller = new AbortController();
  let database: ReconciliationWorkerDatabase | undefined;
  let workerId: string | undefined;
  const registeredSignals: WorkerShutdownSignal[] = [];

  const logFields = (): ReconciliationWorkerLogFields =>
    workerId === undefined ? {} : { workerId };
  const shutdownHandlers = new Map<WorkerShutdownSignal, () => void>();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    shutdownHandlers.set(signal, () => {
      if (controller.signal.aborted) {
        return;
      }

      options.logger.info(
        { ...logFields(), signal },
        "LOOP reconciliation worker shutdown requested",
      );
      controller.abort();
    });
  }

  try {
    database = databaseFactory(options.config, options.logger);
    for (const [signal, handler] of shutdownHandlers) {
      signalSource.once(signal, handler);
      registeredSignals.push(signal);
    }

    await database.ping();
    if (controller.signal.aborted) {
      return;
    }

    const worker = workerFactory({
      controlPlane: database.controlPlane,
      onInfrastructureBackoff: (event) => {
        options.logger.warn(
          { ...logFields(), ...event },
          "LOOP reconciliation worker infrastructure retry scheduled",
        );
      },
    });
    workerId = worker.workerId;
    options.logger.info(
      { ...logFields(), environment: options.config.nodeEnv },
      "LOOP reconciliation worker started",
    );
    await worker.run(controller.signal);
  } finally {
    for (const signal of registeredSignals) {
      const handler = shutdownHandlers.get(signal);
      if (handler !== undefined) {
        signalSource.off(signal, handler);
      }
    }

    if (database !== undefined) {
      await database.close();
      options.logger.info(logFields(), "LOOP reconciliation worker stopped");
    }
  }
}
