import type { ReconciliationWorkerConfig } from "./config.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseConfig,
  type PostgresDatabaseLogger,
} from "./database/database.js";
import type { ControlPlaneRepository } from "./database/control-plane-repository.js";
import type { SpotAgentAuthorizationRepository } from "./database/spot-agent-authorization-repository.js";
import type { PerpReconciliationRepository } from "./features/perp/perp-reconciliation-contract.js";
import type { ReconciliationControlPlane } from "./features/reconciliation/reconciliation-service.js";
import type { SpotReconciliationRepository } from "./features/spot/spot-reconciliation-contract.js";
import {
  createIssuanceQuotaRetentionWorker,
  type CreateIssuanceQuotaRetentionWorkerOptions,
  type IssuanceQuotaRetentionWorker,
} from "./issuance-quota-retention-worker.js";
import { createReconciliationWorkerReaders } from "./reconciliation-worker-readers.js";
import type {
  ReconciliationWorkerLogFields,
  ReconciliationWorkerLogger,
} from "./reconciliation-worker-logger.js";
import {
  createSpotAgentLifecycleWorker,
  type CreateSpotAgentLifecycleWorkerOptions,
  type SpotAgentLifecycleWorker,
} from "./spot-agent-lifecycle-worker.js";
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
  readonly controlPlane: ReconciliationControlPlane &
    Pick<
      ControlPlaneRepository,
      "consumeIssuanceQuota" | "deleteExpiredIssuanceQuotaRecords"
    >;
  readonly perpReconciliation: PerpReconciliationRepository;
  readonly spotReconciliation: SpotReconciliationRepository;
  readonly spotAgentAuthorizations: Pick<
    SpotAgentAuthorizationRepository,
    "expireElapsedPrepared" | "retireElapsedAgentIdentities"
  >;
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

export type SpotAgentLifecycleWorkerFactory = (
  options: CreateSpotAgentLifecycleWorkerOptions,
) => SpotAgentLifecycleWorker;

export type IssuanceQuotaRetentionWorkerFactory = (
  options: CreateIssuanceQuotaRetentionWorkerOptions,
) => IssuanceQuotaRetentionWorker;

export interface RunReconciliationWorkerOptions {
  readonly config: ReconciliationWorkerConfig;
  readonly logger: ReconciliationWorkerLogger;
  readonly signalSource?: WorkerSignalSource;
  readonly createDatabase?: ReconciliationWorkerDatabaseFactory;
  readonly createWorker?: ReconciliationWorkerFactory;
  readonly createLifecycleWorker?: SpotAgentLifecycleWorkerFactory;
  readonly createQuotaRetentionWorker?: IssuanceQuotaRetentionWorkerFactory;
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
  const lifecycleWorkerFactory =
    options.createLifecycleWorker ?? createSpotAgentLifecycleWorker;
  const quotaRetentionWorkerFactory =
    options.createQuotaRetentionWorker ?? createIssuanceQuotaRetentionWorker;
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

    const readers = createReconciliationWorkerReaders({
      config: options.config,
      database,
    });
    const onInfrastructureBackoff: NonNullable<
      CreateReconciliationWorkerOptions["onInfrastructureBackoff"]
    > = (event) => {
      options.logger.warn(
        { ...logFields(), ...event },
        "LOOP reconciliation worker infrastructure retry scheduled",
      );
    };
    const worker = workerFactory({
      controlPlane: database.controlPlane,
      readers,
      onInfrastructureBackoff,
    });
    const spotWorker =
      options.config.hyperliquidSpotReconciliationReads === null
        ? null
        : workerFactory({
            controlPlane: database.spotReconciliation,
            readers,
            workerId: worker.workerId,
            onInfrastructureBackoff,
          });
    if (spotWorker !== null && spotWorker.workerId !== worker.workerId) {
      throw new Error("Spot reconciliation worker identity mismatch");
    }
    const lifecycleWorker = options.config.spotAgentLifecycleMaintenanceEnabled
      ? lifecycleWorkerFactory({
          maintenance: database.spotAgentAuthorizations,
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        })
      : null;
    const quotaRetentionWorker = options.config.issuanceRateRecordCleanupEnabled
      ? quotaRetentionWorkerFactory({
          maintenance: database.controlPlane,
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        })
      : null;
    workerId = worker.workerId;
    options.logger.info(
      { ...logFields(), environment: options.config.nodeEnv },
      "LOOP reconciliation worker started",
    );
    const loops = [
      Promise.resolve().then(() => worker.run(controller.signal)),
      ...(spotWorker === null
        ? []
        : [Promise.resolve().then(() => spotWorker.run(controller.signal))]),
      ...(lifecycleWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              lifecycleWorker.run(controller.signal),
            ),
          ]),
      ...(quotaRetentionWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              quotaRetentionWorker.run(controller.signal),
            ),
          ]),
    ];

    try {
      await Promise.all(loops);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(loops);
      throw error;
    }
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
