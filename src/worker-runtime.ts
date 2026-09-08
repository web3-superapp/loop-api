import {
  createBscIndexerWorker,
  type BscIndexerWorker,
  type CreateBscIndexerWorkerOptions,
} from "./bsc-indexer-worker.js";
import {
  createBscPoolIndexerWorker,
  type BscPoolIndexerWorker,
  type CreateBscPoolIndexerWorkerOptions,
} from "./bsc-pool-indexer-worker.js";
import {
  createAlertEvaluatorWorker,
  type AlertEvaluatorWorker,
  type CreateAlertEvaluatorWorkerOptions,
} from "./alert-evaluator-worker.js";
import type { AlertV2Repository } from "./database/alert-v2-repository.js";
import type { MarketFactCacheRepository } from "./database/market-fact-cache-repository.js";
import type { NotificationRepository } from "./database/notification-repository.js";
import { createMarketFactService } from "./features/market/market-fact-service.js";
import { createMarketProviders } from "./integrations/market/provider-factory.js";
import type { ReconciliationWorkerConfig } from "./config.js";
import type { BscIndexerRepository } from "./database/bsc-indexer-repository.js";
import type { ChainRegistryRepository } from "./database/chain-registry-repository.js";
import { bscChainId } from "./features/chain/chain-contract.js";
import {
  createBscReadClient,
  type BscReadClient,
} from "./integrations/bsc/rpc-client.js";
import {
  createCommunityChannelSyncWorker,
  type CommunityChannelSyncWorker,
  type CreateCommunityChannelSyncWorkerOptions,
} from "./community-channel-sync-worker.js";
import { createStreamCommunityChannelGateway } from "./integrations/stream/channel-gateway.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseConfig,
  type PostgresDatabaseLogger,
} from "./database/database.js";
import type { ControlPlaneRepository } from "./database/control-plane-repository.js";
import type { SpotAgentAuthorizationRepository } from "./database/spot-agent-authorization-repository.js";
import type { PerpReconciliationRepository } from "./features/perp/perp-reconciliation-contract.js";
import type { ReconciliationControlPlane } from "./features/reconciliation/reconciliation-service.js";
import type { CommunityChannelSyncRepository } from "./features/communication/communication-repository.js";
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
  readonly chainRegistry?: ChainRegistryRepository;
  readonly bscIndexer?: BscIndexerRepository;
  readonly marketFacts?: MarketFactCacheRepository;
  readonly alertsV2?: AlertV2Repository;
  readonly notifications?: NotificationRepository;
  readonly communityChannelSync: CommunityChannelSyncRepository;
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

export type BscIndexerWorkerFactory = (
  options: CreateBscIndexerWorkerOptions,
) => BscIndexerWorker;

export type BscPoolIndexerWorkerFactory = (
  options: CreateBscPoolIndexerWorkerOptions,
) => BscPoolIndexerWorker;

export type AlertEvaluatorWorkerFactory = (
  options: CreateAlertEvaluatorWorkerOptions,
) => AlertEvaluatorWorker;

export type BscReadClientFactory = (
  config: NonNullable<ReconciliationWorkerConfig["bscChain"]>,
) => BscReadClient;
export type CommunityChannelSyncWorkerFactory = (
  options: CreateCommunityChannelSyncWorkerOptions,
) => CommunityChannelSyncWorker;

export interface RunReconciliationWorkerOptions {
  readonly config: ReconciliationWorkerConfig;
  readonly logger: ReconciliationWorkerLogger;
  readonly signalSource?: WorkerSignalSource;
  readonly createDatabase?: ReconciliationWorkerDatabaseFactory;
  readonly createWorker?: ReconciliationWorkerFactory;
  readonly createLifecycleWorker?: SpotAgentLifecycleWorkerFactory;
  readonly createQuotaRetentionWorker?: IssuanceQuotaRetentionWorkerFactory;
  readonly createBscIndexerWorker?: BscIndexerWorkerFactory;
  readonly createBscPoolIndexerWorker?: BscPoolIndexerWorkerFactory;
  readonly createAlertEvaluatorWorker?: AlertEvaluatorWorkerFactory;
  readonly createBscReadClient?: BscReadClientFactory;
  readonly createCommunityChannelSyncWorker?: CommunityChannelSyncWorkerFactory;
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
  const indexerWorkerFactory =
    options.createBscIndexerWorker ?? createBscIndexerWorker;
  const poolIndexerWorkerFactory =
    options.createBscPoolIndexerWorker ?? createBscPoolIndexerWorker;
  const alertEvaluatorWorkerFactory =
    options.createAlertEvaluatorWorker ?? createAlertEvaluatorWorker;
  const readClientFactory =
    options.createBscReadClient ??
    ((config): BscReadClient => createBscReadClient({ config }));
  const communityChannelSyncWorkerFactory =
    options.createCommunityChannelSyncWorker ??
    createCommunityChannelSyncWorker;
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
    // The BSC indexer is an independent, default-off lane in the same
    // standalone worker process (Decision 0012 shape). It shares no state with
    // Hyperliquid reconciliation and never signs or submits anything.
    const indexerConfig = options.config.bscIndexer;
    const indexerChainConfig = options.config.bscChain;
    const indexerRepository = database.bscIndexer;
    const indexerRegistry = database.chainRegistry;
    const indexerReadClient =
      indexerChainConfig === null
        ? null
        : readClientFactory(indexerChainConfig);
    const indexerWorker =
      indexerConfig === null ||
      indexerReadClient === null ||
      indexerRepository === undefined ||
      indexerRegistry === undefined
        ? null
        : indexerWorkerFactory({
            repository: indexerRepository,
            registry: indexerRegistry,
            readClient: indexerReadClient,
            chainId: bscChainId,
            startBlockNumber: indexerConfig.startBlockNumber,
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `pool_event` lane shares the BSC_INDEXER_ENABLED switch and the read
    // client but owns its own checkpoint and rewind (Decision 0034).
    const poolIndexerWorker =
      indexerConfig === null ||
      indexerReadClient === null ||
      indexerRepository === undefined ||
      indexerRegistry === undefined
        ? null
        : poolIndexerWorkerFactory({
            repository: indexerRepository,
            registry: indexerRegistry,
            readClient: indexerReadClient,
            chainId: bscChainId,
            startBlockNumber: indexerConfig.startBlockNumber,
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `alert_evaluator` lane (Decision 0034) is default-off and needs the
    // DexScreener Provider, the V2 alert and notification repositories, and
    // the registry. It only ever triggers on a fresh Provider price.
    const evaluatorConfig = options.config.alertEvaluator;
    const alertEvaluatorWorker =
      evaluatorConfig === null ||
      database.alertsV2 === undefined ||
      database.notifications === undefined ||
      database.marketFacts === undefined ||
      database.chainRegistry === undefined
        ? null
        : alertEvaluatorWorkerFactory({
            alerts: database.alertsV2,
            notifications: database.notifications,
            registry: database.chainRegistry,
            facts: createMarketFactService({
              config: options.config.market,
              cache: database.marketFacts,
              pairsProvider: createMarketProviders(
                options.config.market,
                "worker",
              ).pairs,
              securityProvider: null,
              candlesProvider: null,
            }),
            notificationDedupeSeconds:
              evaluatorConfig.notificationDedupeSeconds,
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `community-channel-sync` lane is default-off and only constructed
    // when the complete Stream credential pair is configured (Decision 0032).
    const communityChannelSyncWorker =
      options.config.communityChannelSync === null
        ? null
        : communityChannelSyncWorkerFactory({
            repository: database.communityChannelSync,
            gateway: createStreamCommunityChannelGateway(
              options.config.communityChannelSync,
            ),
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
      ...(indexerWorker === null
        ? []
        : [Promise.resolve().then(() => indexerWorker.run(controller.signal))]),
      ...(poolIndexerWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              poolIndexerWorker.run(controller.signal),
            ),
          ]),
      ...(alertEvaluatorWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              alertEvaluatorWorker.run(controller.signal),
            ),
          ]),
      ...(communityChannelSyncWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              communityChannelSyncWorker.run(controller.signal),
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
