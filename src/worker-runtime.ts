import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { configureOutboundKeepAlive } from "./core/http/outbound-keep-alive.js";
import {
  createBscIndexerWorker,
  type BscIndexerLaneAvailabilityEvent,
  type BscIndexerWorker,
  type CreateBscIndexerWorkerOptions,
} from "./bsc-indexer-worker.js";
import {
  createBscPoolIndexerWorker,
  type BscPoolIndexerWorker,
  type CreateBscPoolIndexerWorkerOptions,
} from "./bsc-pool-indexer-worker.js";
import {
  createLaunchIndexerWorker,
  type CreateLaunchIndexerWorkerOptions,
  type LaunchIndexerWorker,
} from "./bsc-launch-indexer-worker.js";
import type { LaunchChainRepository } from "./features/launch/launch-chain-repository.js";
import {
  createMemeGraduationExecutor,
  createMemeIndexerWorker,
  createMemeIntentReconciler,
  createMemeSaltPoolWorker,
  type PeriodicLane,
} from "./bsc-meme-indexer-worker.js";
import type { MemeRepository } from "./features/meme/meme-repository.js";
import { createMemeContractAdapter } from "./integrations/meme/meme-contract-adapter.js";
import {
  MemeGraduationSenderRefusedError,
  createMemeGraduationSender,
  type MemeGraduationSender,
} from "./integrations/meme/meme-graduation-sender.js";
import { createLaunchContractAdapter } from "./integrations/launch/launch-contract-adapter.js";
import {
  HooksLaunchExecutorChainRefusedError,
  createHooksLaunchExecutorChain,
} from "./integrations/launch/hooks-launch-executor-chain.js";
import type { HooksLaunchExecutorRepository } from "./features/launch/hooks-launch-executor.js";
import { createHooksLaunchExecutorLane } from "./hooks-launch-executor-worker.js";
import { createLaunch2Lane } from "./launch2-indexer-worker.js";
import type { Launch2Repository } from "./features/launch2/launch2-ports.js";
import { createLaunch2Chain } from "./integrations/launch2/launch2-chain.js";
import {
  launch2PublisherDefaults,
  type Launch2PublicationRepository,
} from "./features/launch2/launch2-snapshot-publisher.js";
import {
  Launch2PublisherChainRefusedError,
  createLaunch2PublisherChain,
  createLaunch2SnapshotSigners,
} from "./integrations/launch2/launch2-snapshot-publisher-chain.js";
import { createLaunch2SnapshotPublisherLane } from "./launch2-snapshot-publisher-worker.js";
import {
  createAlertEvaluatorWorker,
  type AlertEvaluatorWorker,
  type CreateAlertEvaluatorWorkerOptions,
} from "./alert-evaluator-worker.js";
import type { AlertV2Repository } from "./database/alert-v2-repository.js";
import type { AccountWalletRepository } from "./database/account-wallet-repository.js";
import type { WalletIntentRepository } from "./database/wallet-intent-repository.js";
import {
  createWalletIntentReconcileWorker,
  type CreateWalletIntentReconcileWorkerOptions,
  type WalletIntentReconcileWorker,
} from "./wallet-intent-reconcile-worker.js";
import { createPrivyServerClient } from "./integrations/privy/client.js";
import {
  createPrivySwapAdapter,
  createUnavailablePrivySwapAdapter,
} from "./integrations/privy/swap-adapter.js";
import type { MarketFactCacheRepository } from "./database/market-fact-cache-repository.js";
import type { MiningRepository } from "./features/mining/mining-repository.js";
import {
  createMiningSnapshotWorker,
  type CreateMiningSnapshotWorkerOptions,
  type MiningSnapshotWorker,
} from "./mining-snapshot-worker.js";
import type { NotificationRepository } from "./database/notification-repository.js";
import {
  createPushDispatchService,
  type PushDispatchLogger,
  type PushDispatchService,
} from "./features/push/push-dispatch-service.js";
import type { PushRepository } from "./features/push/push-repository.js";
import {
  createFcmSender,
  nodeFcmFetch,
} from "./integrations/fcm/fcm-sender.js";
import {
  FirebaseServiceAccountError,
  loadFirebaseServiceAccount,
} from "./integrations/fcm/service-account.js";
import { createMarketFactService } from "./features/market/market-fact-service.js";
import { marketReasonCodes } from "./features/market/market-contract.js";
import { createMarketProviders } from "./integrations/market/provider-factory.js";
import {
  createMarketSparklineWarmWorker,
  type CreateMarketSparklineWarmWorkerOptions,
  type MarketSparklineWarmWorker,
} from "./market-sparkline-warm-worker.js";
import type { WatchlistV2Repository } from "./database/watchlist-v2-repository.js";
import type { ReconciliationWorkerConfig } from "./config.js";
import type {
  BscIndexerRepository,
  BscIndexerWalletSetRepository,
} from "./database/bsc-indexer-repository.js";
import type { ChainRegistryRepository } from "./database/chain-registry-repository.js";
import { bscChainId } from "./features/chain/chain-contract.js";
import {
  asChainCallClient,
  createBscReadClient,
  createUnavailableBscReadClient,
  type BscLogQueryLimitsResetEvent,
  type BscReadClient,
} from "./integrations/bsc/rpc-client.js";
import {
  createCommunityChannelSyncWorker,
  type CommunityChannelSyncWorker,
  type CreateCommunityChannelSyncWorkerOptions,
} from "./community-channel-sync-worker.js";
import { createStreamCommunityChannelGateway } from "./integrations/stream/channel-gateway.js";
import { createCommunityPersonaService } from "./features/communication/community-persona-service.js";
import {
  createStreamUserIdentitySource,
  type StreamUserIdentityRepository,
} from "./features/communication/stream-user-identity.js";
import {
  createVoiceRoomReaperService,
  type VoiceRoomReaperEvent,
} from "./features/communication/voice-room-reaper-service.js";
import { createStreamCallGateway } from "./integrations/stream/call-gateway.js";
import {
  createMemberBuyFeedService,
  type MemberBuyFeedEvent,
} from "./features/community/member-buy-feed-service.js";
import type { MemberBuyFeedRepository } from "./features/community/member-buy-feed-repository.js";
import {
  createMemberBuyFeedWorker,
  type CreateMemberBuyFeedWorkerOptions,
  type MemberBuyFeedWorker,
} from "./community-member-buy-feed-worker.js";
import {
  createVoiceRoomReaperWorker,
  type CreateVoiceRoomReaperWorkerOptions,
  type VoiceRoomReaperWorker,
} from "./voice-room-reaper-worker.js";
import {
  createPostgresDatabase,
  type PostgresDatabaseConfig,
  type PostgresDatabaseLogger,
} from "./database/database.js";
import type { ControlPlaneRepository } from "./database/control-plane-repository.js";
import type { SpotAgentAuthorizationRepository } from "./database/spot-agent-authorization-repository.js";
import type { PerpReconciliationRepository } from "./features/perp/perp-reconciliation-contract.js";
import type { ReconciliationControlPlane } from "./features/reconciliation/reconciliation-service.js";
import type {
  CommunityChannelPersonaRepository,
  CommunityChannelSyncRepository,
  VoiceRoomReaperRepository,
} from "./features/communication/communication-repository.js";
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
  /** Wallet filter of the transfer lane (Decision 0075); absent keeps it off. */
  readonly bscIndexerWallets?: BscIndexerWalletSetRepository;
  readonly marketFacts?: MarketFactCacheRepository;
  /** Watchlisted asset ids for the sparkline warm lane (Decision 0074). */
  readonly watchlistsV2?: WatchlistV2Repository;
  readonly alertsV2?: AlertV2Repository;
  readonly notifications?: NotificationRepository;
  /** Device push tokens and delivery attempts (Decision 0067). */
  readonly push?: PushRepository;
  readonly accountWallets?: AccountWalletRepository;
  readonly walletIntents?: WalletIntentRepository;
  readonly mining?: MiningRepository;
  /** `launch_event` lane persistence (Decision 0077); absent keeps it off. */
  readonly launchChain?: LaunchChainRepository;
  /** MEME launchpad lanes (Decision 0101); absent keeps them off. */
  readonly meme?: MemeRepository;
  /** `launch2_event` lane (Decision 0114); absent keeps it off. */
  readonly launch2?: Launch2Repository;
  /** Snapshot publisher (Decision 0118); absent keeps it off. */
  readonly launch2Publications?: Launch2PublicationRepository;
  /** Hooks deployment executor (Decision 0112); absent keeps it off. */
  readonly hooksLaunchExecutor?: (
    leaseSeconds: number,
  ) => HooksLaunchExecutorRepository;
  readonly communityChannelSync: CommunityChannelSyncRepository;
  readonly communityChannelPersonas: CommunityChannelPersonaRepository;
  /** Decision 0095: identities the channel sync upserts; absent keeps `{id}`. */
  readonly streamUserIdentities?: StreamUserIdentityRepository;
  /** `voice_room_reaper` lane (Decision 0094); absent keeps it off. */
  readonly voiceRoomReaper?: VoiceRoomReaperRepository;
  /** `community_member_buy_feed` lane (Decision 0097); absent keeps it off. */
  readonly memberBuyFeed?: MemberBuyFeedRepository;
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

export type LaunchIndexerWorkerFactory = (
  options: CreateLaunchIndexerWorkerOptions,
) => LaunchIndexerWorker;

export type AlertEvaluatorWorkerFactory = (
  options: CreateAlertEvaluatorWorkerOptions,
) => AlertEvaluatorWorker;

export type WalletIntentReconcileWorkerFactory = (
  options: CreateWalletIntentReconcileWorkerOptions,
) => WalletIntentReconcileWorker;

export type MiningSnapshotWorkerFactory = (
  options: CreateMiningSnapshotWorkerOptions,
) => MiningSnapshotWorker;

export type MarketSparklineWarmWorkerFactory = (
  options: CreateMarketSparklineWarmWorkerOptions,
) => MarketSparklineWarmWorker;

export type VoiceRoomReaperWorkerFactory = (
  options: CreateVoiceRoomReaperWorkerOptions,
) => VoiceRoomReaperWorker;

export type MemberBuyFeedWorkerFactory = (
  options: CreateMemberBuyFeedWorkerOptions,
) => MemberBuyFeedWorker;

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
  readonly createLaunchIndexerWorker?: LaunchIndexerWorkerFactory;
  /** Test seam for the MEME graduation signer (Decision 0101). */
  readonly createMemeGraduationSender?: typeof createMemeGraduationSender;
  /** Test seams for the Hooks executor chain client and lane (Decision 0112). */
  readonly createHooksLaunchExecutorChain?: typeof createHooksLaunchExecutorChain;
  readonly createHooksLaunchExecutorLane?: typeof createHooksLaunchExecutorLane;
  /** Test seam for the launch2 lane's chain reader (Decision 0114). */
  readonly createLaunch2Chain?: typeof createLaunch2Chain;
  /** Test seam for the snapshot publisher's chain client (Decision 0118). */
  readonly createLaunch2PublisherChain?: typeof createLaunch2PublisherChain;
  readonly createLaunch2SnapshotPublisherLane?: typeof createLaunch2SnapshotPublisherLane;
  /** Test seam for the launch slot's read client (Decision 0077). */
  readonly createLaunchReadClient?: (
    config: ReconciliationWorkerConfig["launchChain"],
  ) => BscReadClient;
  readonly createAlertEvaluatorWorker?: AlertEvaluatorWorkerFactory;
  readonly createWalletIntentReconcileWorker?: WalletIntentReconcileWorkerFactory;
  readonly createMiningSnapshotWorker?: MiningSnapshotWorkerFactory;
  readonly createMarketSparklineWarmWorker?: MarketSparklineWarmWorkerFactory;
  readonly createBscReadClient?: BscReadClientFactory;
  readonly createCommunityChannelSyncWorker?: CommunityChannelSyncWorkerFactory;
  readonly createVoiceRoomReaperWorker?: VoiceRoomReaperWorkerFactory;
  /** Test seam for the reaper's Stream call gateway (Decision 0094). */
  readonly createVoiceRoomCallGateway?: typeof createStreamCallGateway;
  readonly createMemberBuyFeedWorker?: MemberBuyFeedWorkerFactory;
  /** Test seam for the member buy feed's Stream gateway (Decision 0097). */
  readonly createMemberBuyFeedGateway?: typeof createStreamCommunityChannelGateway;
  /**
   * Installs the process-wide outbound keep-alive dispatcher before any
   * Provider client is built (Decision 0088 ruling 1, S93b). Test seam; the
   * default is `configureOutboundKeepAlive`.
   */
  readonly configureOutboundKeepAlive?: () => unknown;
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
  // Decision 0088 ruling 1 (S93b): the worker's Provider reads (RPC,
  // DexScreener, GeckoTerminal, Privy, Stream, FCM) reuse idle connections
  // for 60 s like the API's, instead of Node's 4 s default.
  (options.configureOutboundKeepAlive ?? configureOutboundKeepAlive)();
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
  const walletIntentReconcileWorkerFactory =
    options.createWalletIntentReconcileWorker ??
    createWalletIntentReconcileWorker;
  const miningSnapshotWorkerFactory =
    options.createMiningSnapshotWorker ?? createMiningSnapshotWorker;
  const sparklineWarmWorkerFactory =
    options.createMarketSparklineWarmWorker ?? createMarketSparklineWarmWorker;
  // Decision 0079: a read that ran out of budget resets the client's learned
  // log-query limits; the reset is one warn line with the numbers only.
  const onLogQueryLimitsReset = (event: BscLogQueryLimitsResetEvent): void => {
    options.logger.warn(
      {
        ...logFields(),
        reasonCode: event.reasonCode,
        detailReasonCode: event.trigger,
        ...event.after,
        previousAddressLimit: event.before.learnedAddressLimit,
        previousTopicGroupLimit: event.before.learnedTopicGroupLimit,
        previousRangeLimit: event.before.learnedRangeLimit,
      },
      "LOOP BSC log-query limits reset to their configured values",
    );
  };
  const readClientFactory =
    options.createBscReadClient ??
    ((config): BscReadClient =>
      createBscReadClient({ config, onLogQueryLimitsReset }));
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
    // A lane that idles on a Provider refusal is logged once per transition
    // (Decision 0068), with the classification fields and nothing else.
    const onLaneAvailability = (
      event: BscIndexerLaneAvailabilityEvent,
    ): void => {
      if (event.state === "unavailable") {
        const { reasonCode, ...classification } = event;
        options.logger.warn(
          {
            ...logFields(),
            ...classification,
            ...(reasonCode === null ? {} : { reasonCode }),
          },
          "LOOP BSC indexer lane is unavailable",
        );
        return;
      }
      options.logger.info(
        {
          ...logFields(),
          lane: event.lane,
          state: event.state,
          learnedAddressLimit: event.learnedAddressLimit,
          learnedTopicGroupLimit: event.learnedTopicGroupLimit,
          learnedRangeLimit: event.learnedRangeLimit,
          relaxAfterCleanReads: event.relaxAfterCleanReads,
        },
        "LOOP BSC indexer lane recovered",
      );
    };
    const indexerRepository = database.bscIndexer;
    const indexerRegistry = database.chainRegistry;
    // The transfer lane filters on active LOOP wallets (Decision 0075); without
    // the wallet source it stays off rather than falling back to a full scan.
    const indexerWalletSet = database.bscIndexerWallets;
    const indexerReadClient =
      indexerChainConfig === null
        ? null
        : readClientFactory(indexerChainConfig);
    const indexerWorker =
      indexerConfig === null ||
      indexerReadClient === null ||
      indexerRepository === undefined ||
      indexerRegistry === undefined ||
      indexerWalletSet === undefined
        ? null
        : indexerWorkerFactory({
            repository: indexerRepository,
            registry: indexerRegistry,
            walletSet: indexerWalletSet,
            walletTopicChunkSize: indexerConfig.walletTopicChunkSize,
            readClient: indexerReadClient,
            chainId: bscChainId,
            startBlockNumber: indexerConfig.startBlockNumber,
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
            onLaneAvailability,
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
            onLaneAvailability,
          });
    // The `launch_event` lane (Decision 0077) is default-off and reads the
    // launch chain slot, which may be the BSC testnet while every other lane
    // stays on 56. With the four contract keys blank it idles with
    // LAUNCH_CONTRACT_BASELINE_PENDING; it never signs or submits.
    const launchChainConfig = options.config.launchChain;
    const launchIndexerWorker = ((): LaunchIndexerWorker | null => {
      if (
        !options.config.launchIndexerEnabled ||
        database.launchChain === undefined
      ) {
        return null;
      }
      const launchReadClient =
        options.createLaunchReadClient !== undefined
          ? options.createLaunchReadClient(launchChainConfig)
          : launchChainConfig.sharedWithPrimary && indexerReadClient !== null
            ? indexerReadClient
            : launchChainConfig.rpcUrls.length === 0
              ? createUnavailableBscReadClient({
                  chainId: launchChainConfig.chainId,
                  chainReference: launchChainConfig.chainReference,
                  confirmations: launchChainConfig.confirmations,
                  reorgDepthBlocks: launchChainConfig.reorgDepthBlocks,
                  reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
                })
              : createBscReadClient({
                  config: launchChainConfig,
                  onLogQueryLimitsReset,
                });
      const adapter = createLaunchContractAdapter({
        contract: options.config.launchContract,
        chain: launchChainConfig,
        verifyChain: () => launchReadClient.verifyChain(),
      });
      return (options.createLaunchIndexerWorker ?? createLaunchIndexerWorker)({
        repository: database.launchChain,
        readClient: launchReadClient,
        adapter,
        chainId: launchChainConfig.chainId,
        onWarning: (warning) => {
          options.logger.warn(
            { ...logFields(), lane: "launch_event", ...warning },
            "LOOP launch_event lane skipped a fact",
          );
        },
        onUnavailable: (reasonCode, detail) => {
          options.logger.warn(
            { ...logFields(), lane: "launch_event", reasonCode, ...detail },
            "LOOP launch_event lane is idle",
          );
        },
        onInfrastructureBackoff: (event) => {
          options.logger.warn(
            { ...logFields(), ...event },
            "LOOP reconciliation worker infrastructure retry scheduled",
          );
        },
      });
    })();
    // MEME launchpad lanes (Decision 0101), default-off: the `meme_event`
    // lane, the salt pool, and the Intent receipt reconcile run behind
    // MEME_INDEXER_ENABLED; the graduation fallback signs only behind
    // MEME_GRADUATION_EXECUTOR_ENABLED, on the testnet slot.
    const memeLanes: PeriodicLane[] = [];
    // Hooks deployment executor (Decision 0112), default off. Config load
    // already refused boot for `on` without a key / Factory / chain 97.
    const hooksExecutorConfig = options.config.hooksLaunchExecutor;
    if (hooksExecutorConfig !== null) {
      const repositoryFactory = database.hooksLaunchExecutor;
      let chain: ReturnType<typeof createHooksLaunchExecutorChain> | null =
        null;
      try {
        chain = (
          options.createHooksLaunchExecutorChain ??
          createHooksLaunchExecutorChain
        )({
          privateKey: hooksExecutorConfig.privateKey,
          factoryAddress: hooksExecutorConfig.factoryAddress,
          rpcUrls: launchChainConfig.rpcUrls,
        });
      } catch (error) {
        options.logger.warn(
          {
            ...logFields(),
            lane: "hooks_launch_executor",
            reasonCode:
              error instanceof HooksLaunchExecutorChainRefusedError
                ? error.reasonCode
                : "HOOKS_EXECUTOR_CHAIN_UNAVAILABLE",
          },
          "LOOP hooks launch executor stays idle",
        );
      }
      if (repositoryFactory === undefined) {
        options.logger.warn(
          {
            ...logFields(),
            lane: "hooks_launch_executor",
            reasonCode: "HOOKS_EXECUTOR_REPOSITORY_UNAVAILABLE",
          },
          "LOOP hooks launch executor stays idle",
        );
      } else if (chain !== null) {
        const executorId = `hooks-executor:${hostname()
          .replace(/[^A-Za-z0-9.-]/gu, "-")
          .slice(0, 64)}:${process.pid}:${randomUUID().slice(0, 8)}`;
        memeLanes.push(
          (
            options.createHooksLaunchExecutorLane ??
            createHooksLaunchExecutorLane
          )({
            repository: repositoryFactory(hooksExecutorConfig.leaseSeconds),
            chain,
            config: hooksExecutorConfig,
            executorId,
            onStep: (event) => {
              const log =
                event.errorCode === null
                  ? options.logger.info.bind(options.logger)
                  : options.logger.warn.bind(options.logger);
              log(
                {
                  ...logFields(),
                  lane: "hooks_launch_executor",
                  hooksDeploymentJobId: event.jobId,
                  fromStatus: event.from,
                  toStatus: event.to,
                  step: event.kind,
                  ...(event.txHash === null
                    ? {}
                    : { transactionHash: event.txHash }),
                  ...(event.errorCode === null
                    ? {}
                    : { reasonCode: event.errorCode }),
                },
                "LOOP hooks launch executor step",
              );
            },
            onIdle: (reasonCode) => {
              options.logger.warn(
                { ...logFields(), lane: "hooks_launch_executor", reasonCode },
                "LOOP hooks launch executor is idle",
              );
            },
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          }),
        );
        options.logger.info(
          {
            ...logFields(),
            lane: "hooks_launch_executor",
            executorAddress: chain.executorAddress,
            factoryAddress: hooksExecutorConfig.factoryAddress,
            confirmations: hooksExecutorConfig.confirmations,
          },
          "LOOP hooks launch executor enabled",
        );
      }
    }
    // MEME v2 read model (Decision 0114), default off. The lane needs the
    // Hooks Factory address and the BSC Testnet launch slot RPC; anything
    // missing keeps it idle with the reason (never a fixture).
    const launch2Config = options.config.launch2Indexer;
    if (launch2Config !== null) {
      const reason =
        database.launch2 === undefined
          ? "LAUNCH2_REPOSITORY_UNAVAILABLE"
          : launch2Config.factoryAddress === null
            ? "LAUNCH2_FACTORY_NOT_CONFIGURED"
            : launchChainConfig.chainId !== "eip155:97" ||
                launchChainConfig.rpcUrls.length === 0
              ? "LAUNCH2_CHAIN_NOT_CONFIGURED"
              : null;
      if (reason !== null || database.launch2 === undefined) {
        options.logger.warn(
          {
            ...logFields(),
            lane: "launch2_event",
            reasonCode: reason ?? "LAUNCH2_REPOSITORY_UNAVAILABLE",
          },
          "LOOP launch2_event lane stays idle",
        );
      } else {
        memeLanes.push(
          createLaunch2Lane({
            repository: database.launch2,
            chain: (options.createLaunch2Chain ?? createLaunch2Chain)({
              rpcUrls: launchChainConfig.rpcUrls,
            }),
            chainId: launchChainConfig.chainId,
            factoryAddress: launch2Config.factoryAddress as string,
            reorgDepthBlocks: launchChainConfig.reorgDepthBlocks,
            pollIntervalMs: launch2Config.pollIntervalMs,
            onWarning: (warning) => {
              options.logger.warn(
                { ...logFields(), lane: "launch2_event", ...warning },
                "LOOP launch2_event lane skipped facts",
              );
            },
            onIdle: (reasonCode) => {
              options.logger.warn(
                { ...logFields(), lane: "launch2_event", reasonCode },
                "LOOP launch2_event lane is idle",
              );
            },
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          }),
        );
        options.logger.info(
          {
            ...logFields(),
            lane: "launch2_event",
            factoryAddress: launch2Config.factoryAddress as string,
          },
          "LOOP launch2_event lane enabled",
        );
      }
    }
    // MEME v2 snapshot publisher (Decision 0118), default off. Config load
    // already refused boot for `true` without ≥ 2 signer keys, a submitter
    // key, or chain 97; a missing RPC / store keeps it idle with the reason.
    const publisherConfig = options.config.launch2SnapshotPublisher;
    if (publisherConfig !== null) {
      const reason =
        database.launch2 === undefined ||
        database.launch2Publications === undefined
          ? "LAUNCH2_REPOSITORY_UNAVAILABLE"
          : launchChainConfig.chainId !== "eip155:97" ||
              launchChainConfig.rpcUrls.length === 0
            ? "LAUNCH2_CHAIN_NOT_CONFIGURED"
            : null;
      let publisherChain: ReturnType<
        typeof createLaunch2PublisherChain
      > | null = null;
      let refused: string | null = reason;
      if (refused === null) {
        try {
          publisherChain = (
            options.createLaunch2PublisherChain ?? createLaunch2PublisherChain
          )({
            privateKey: publisherConfig.submitterPrivateKey,
            rpcUrls: launchChainConfig.rpcUrls,
          });
        } catch (error) {
          refused =
            error instanceof Launch2PublisherChainRefusedError
              ? error.reasonCode
              : "LAUNCH2_SNAPSHOT_CHAIN_UNAVAILABLE";
        }
      }
      if (
        refused !== null ||
        publisherChain === null ||
        database.launch2 === undefined ||
        database.launch2Publications === undefined
      ) {
        options.logger.warn(
          {
            ...logFields(),
            lane: "launch2_snapshot_publisher",
            reasonCode: refused ?? "LAUNCH2_REPOSITORY_UNAVAILABLE",
          },
          "LOOP launch2 snapshot publisher stays idle",
        );
      } else {
        const signers = createLaunch2SnapshotSigners({
          privateKeys: publisherConfig.signerPrivateKeys,
          chainId: 97,
        });
        memeLanes.push(
          (
            options.createLaunch2SnapshotPublisherLane ??
            createLaunch2SnapshotPublisherLane
          )({
            repository: database.launch2Publications,
            launch2: database.launch2,
            chain: publisherChain,
            signers,
            policy: {
              chainId: launchChainConfig.chainId,
              confirmations: publisherConfig.confirmations,
              maxGasPriceWei:
                BigInt(publisherConfig.maxGasPriceGwei) * 10n ** 9n,
              gasLimitCap: launch2PublisherDefaults.gasLimitCap,
              maxAttempts: launch2PublisherDefaults.maxAttempts,
              retryDelaySeconds: launch2PublisherDefaults.retryDelaySeconds,
            },
            pollIntervalMs: publisherConfig.pollIntervalMs,
            onStep: (step) => {
              const log =
                step.failureCode === null
                  ? options.logger.info.bind(options.logger)
                  : options.logger.warn.bind(options.logger);
              log(
                {
                  ...logFields(),
                  lane: "launch2_snapshot_publisher",
                  instanceId: step.instanceId,
                  ...(step.from === null ? {} : { fromStatus: step.from }),
                  toStatus: step.to,
                  ...(step.txHash === null
                    ? {}
                    : { transactionHash: step.txHash }),
                  ...(step.failureCode === null
                    ? {}
                    : { reasonCode: step.failureCode }),
                },
                "LOOP launch2 snapshot publisher step",
              );
            },
            onWaiting: (event) => {
              options.logger.info(
                {
                  ...logFields(),
                  lane: "launch2_snapshot_publisher",
                  ...(event.instanceId === null
                    ? {}
                    : { instanceId: event.instanceId }),
                  reasonCode: event.reasonCode,
                },
                "LOOP launch2 snapshot publisher is waiting",
              );
            },
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          }),
        );
        options.logger.info(
          {
            ...logFields(),
            lane: "launch2_snapshot_publisher",
            executorAddress: publisherChain.submitterAddress,
            confirmations: publisherConfig.confirmations,
            count: signers.length,
          },
          "LOOP launch2 snapshot publisher enabled",
        );
      }
    }
    const memeIndexerWorker = (() => {
      const memeConfig = options.config.meme;
      const memeRepository = database.meme;
      if (memeRepository === undefined || memeConfig.contract === null) {
        if (
          options.config.memeIndexerEnabled ||
          options.config.memeGraduationExecutor !== null
        ) {
          options.logger.warn(
            {
              ...logFields(),
              lane: "meme_event",
              reasonCode:
                memeConfig.unconfiguredReason ?? "MEME_RUNTIME_UNAVAILABLE",
            },
            "LOOP meme lanes stay idle: the MEME contract is not configured",
          );
        }
        return null;
      }
      const contract = memeConfig.contract;
      const memeReadClient =
        launchChainConfig.sharedWithPrimary && indexerReadClient !== null
          ? indexerReadClient
          : launchChainConfig.rpcUrls.length === 0
            ? createUnavailableBscReadClient({
                chainId: launchChainConfig.chainId,
                chainReference: launchChainConfig.chainReference,
                confirmations: launchChainConfig.confirmations,
                reorgDepthBlocks: launchChainConfig.reorgDepthBlocks,
                reasonCode: "MEME_CHAIN_RPC_NOT_CONFIGURED",
              })
            : createBscReadClient({
                config: launchChainConfig,
                onLogQueryLimitsReset,
              });
      const executor = options.config.memeGraduationExecutor;
      if (executor !== null) {
        let sender: MemeGraduationSender | null = null;
        try {
          sender = (
            options.createMemeGraduationSender ?? createMemeGraduationSender
          )({
            privateKey: executor.privateKey,
            curveAddress: contract.address,
            chainReference: launchChainConfig.chainReference,
            rpcUrls: launchChainConfig.rpcUrls,
          });
        } catch (error) {
          options.logger.warn(
            {
              ...logFields(),
              lane: "meme_graduation_executor",
              reasonCode:
                error instanceof MemeGraduationSenderRefusedError
                  ? error.reasonCode
                  : "MEME_GRADUATION_SENDER_UNAVAILABLE",
            },
            "LOOP meme graduation executor stays idle",
          );
        }
        if (sender !== null) {
          memeLanes.push(
            createMemeGraduationExecutor({
              repository: memeRepository,
              sender,
              chainId: launchChainConfig.chainId,
              fullGraceMs: executor.delaySeconds * 1_000,
              onAttempt: (event) => {
                const log =
                  event.outcome === "confirmed" || event.outcome === "not_full"
                    ? options.logger.info.bind(options.logger)
                    : options.logger.warn.bind(options.logger);
                log(
                  {
                    ...logFields(),
                    lane: "meme_graduation_executor",
                    memeTokenId: event.memeTokenId,
                    outcome: event.outcome,
                    attempts: event.attempts,
                    needsOperator: event.needsOperator,
                    ...(event.errorCode === null
                      ? {}
                      : { reasonCode: event.errorCode }),
                    ...(event.transactionHash === null
                      ? {}
                      : { transactionHash: event.transactionHash }),
                  },
                  "LOOP meme graduation executor attempted graduate",
                );
              },
              onInfrastructureBackoff: (event) => {
                options.logger.warn(
                  { ...logFields(), ...event },
                  "LOOP reconciliation worker infrastructure retry scheduled",
                );
              },
            }),
          );
        }
      }
      if (!options.config.memeIndexerEnabled) {
        return null;
      }
      memeLanes.push(
        createMemeSaltPoolWorker({
          repository: memeRepository,
          scope: {
            chainId: launchChainConfig.chainId,
            contractAddress: contract.address,
            tokenImplementation: contract.tokenImplementation,
            suffix: memeConfig.vanitySuffix,
          },
          target: memeConfig.saltPoolTarget,
          onRefilled: (event) => {
            options.logger.info(
              { ...logFields(), lane: "meme_salt_pool", ...event },
              "LOOP meme salt pool refilled",
            );
          },
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        }),
        createMemeIntentReconciler({
          repository: memeRepository,
          readClient: asChainCallClient(memeReadClient),
          chainId: launchChainConfig.chainId,
          onTransition: (transition) => {
            options.logger.info(
              {
                ...logFields(),
                lane: "meme_intent_reconcile",
                memeIntentId: transition.intentId,
                toState: transition.toState,
                ...(transition.reasonCode === null
                  ? {}
                  : { reasonCode: transition.reasonCode }),
              },
              "LOOP meme intent settled from its receipt",
            );
          },
          onReadFailure: (failure) => {
            options.logger.warn(
              {
                ...logFields(),
                lane: "meme_intent_reconcile",
                memeIntentId: failure.intentId,
                reasonCode: failure.reasonCode,
              },
              "LOOP meme intent receipt read failed",
            );
          },
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        }),
      );
      return createMemeIndexerWorker({
        repository: memeRepository,
        readClient: memeReadClient,
        adapter: createMemeContractAdapter({
          contract,
          chain: launchChainConfig,
          verifyChain: () => memeReadClient.verifyChain(),
        }),
        chainId: launchChainConfig.chainId,
        onWarning: (warning) => {
          options.logger.warn(
            { ...logFields(), lane: "meme_event", ...warning },
            "LOOP meme_event lane skipped facts",
          );
        },
        onUnavailable: (reasonCode, detail) => {
          options.logger.warn(
            { ...logFields(), lane: "meme_event", reasonCode, ...detail },
            "LOOP meme_event lane is idle",
          );
        },
        onInfrastructureBackoff: (event) => {
          options.logger.warn(
            { ...logFields(), ...event },
            "LOOP reconciliation worker infrastructure retry scheduled",
          );
        },
      });
    })();
    // Push channel (Decision 0067). The worker sends only when a Firebase
    // credential and the push repository are both present; an unusable
    // credential file leaves the lane feed-only and is logged by reason code.
    const pushDispatchService = ((): PushDispatchService | null => {
      if (options.config.push === null || database.push === undefined) {
        return null;
      }
      // The worker log line carries a reason code and nothing else: no
      // token, no owner, no message text.
      const pushLogger: PushDispatchLogger = {
        warn: (context) => {
          const reasonCode = context["reasonCode"];
          options.logger.warn(
            {
              ...logFields(),
              ...(typeof reasonCode === "string" ? { reasonCode } : {}),
            },
            "LOOP push delivery was not confirmed",
          );
        },
      };
      try {
        return createPushDispatchService({
          repository: database.push,
          sender: createFcmSender({
            account: loadFirebaseServiceAccount(
              options.config.push.serviceAccountJsonPath,
            ),
            fetch: nodeFcmFetch,
          }),
          logger: pushLogger,
        });
      } catch (error) {
        options.logger.warn(
          {
            ...logFields(),
            reasonCode:
              error instanceof FirebaseServiceAccountError
                ? error.reasonCode
                : "PUSH_CREDENTIAL_FILE_UNREADABLE",
          },
          "LOOP push channel stays deferred: the Firebase service account is unusable",
        );
        return null;
      }
    })();
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
            ...(pushDispatchService === null
              ? {}
              : { push: pushDispatchService }),
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `wallet-intent-reconcile` lane (Decision 0035) is default-off. It
    // reads receipts over RPC and Privy action status when credentials exist;
    // it never signs, broadcasts, or replays.
    const walletIntentConfig = options.config.walletIntentReconcile;
    const walletIntentLaunchClient =
      walletIntentConfig === null ||
      options.config.launchChain.sharedWithPrimary ||
      options.config.launchChain.rpcUrls.length === 0
        ? null
        : asChainCallClient(
            createBscReadClient({
              config: options.config.launchChain,
            }),
          );
    const walletIntentReconcileWorker =
      walletIntentConfig === null ||
      indexerReadClient === null ||
      database.walletIntents === undefined ||
      database.accountWallets === undefined
        ? null
        : walletIntentReconcileWorkerFactory({
            repository: database.walletIntents,
            wallets: database.accountWallets,
            readClient: asChainCallClient(indexerReadClient),
            // Decision 0077: approvals recorded on the launch slot.
            launchReadClient: walletIntentLaunchClient,
            // Decision 0080: reported Launch purchase Intents, read on the
            // launch slot (the primary client when LAUNCH_CHAIN_ID=56). With
            // the four contract keys blank no Intent exists and the part is
            // not wired; without a launch RPC it stays unavailable.
            launchIntents:
              database.launchChain === undefined ||
              options.config.launchContract === null
                ? null
                : {
                    repository: database.launchChain,
                    readClient: options.config.launchChain.sharedWithPrimary
                      ? asChainCallClient(indexerReadClient)
                      : walletIntentLaunchClient,
                    chainId: options.config.launchChain.chainId,
                  },
            onLaunchIntentUnavailable: (reasonCode) => {
              options.logger.warn(
                { ...logFields(), lane: "launch_intent_reconcile", reasonCode },
                "LOOP launch intent reconciliation is unavailable",
              );
            },
            onLaunchIntentResult: (result) => {
              if (result.status !== "available") {
                return;
              }
              for (const failure of result.readFailures) {
                options.logger.warn(
                  {
                    ...logFields(),
                    lane: "launch_intent_reconcile",
                    launchIntentId: failure.intentId,
                    reasonCode: failure.reasonCode,
                  },
                  "LOOP launch intent receipt read failed",
                );
              }
              for (const transition of result.transitions) {
                options.logger.info(
                  {
                    ...logFields(),
                    lane: "launch_intent_reconcile",
                    launchIntentId: transition.intentId,
                    toState: transition.toState,
                    ...(transition.reasonCode === null
                      ? {}
                      : { reasonCode: transition.reasonCode }),
                  },
                  "LOOP launch intent settled from its receipt",
                );
              }
            },
            swapAdapter:
              walletIntentConfig.privy === null
                ? createUnavailablePrivySwapAdapter()
                : createPrivySwapAdapter(
                    createPrivyServerClient(walletIntentConfig.privy).wallets(),
                  ),
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `mining-snapshot` lane (Decision 0036) is default-off. Even when
    // enabled it is idle until a Mining formula version is approved; it
    // reads fresh DexScreener prices through the same fact service and never
    // settles or claims a reward.
    const miningSnapshotWorker =
      !options.config.miningSnapshotEnabled ||
      database.mining === undefined ||
      database.chainRegistry === undefined ||
      database.marketFacts === undefined
        ? null
        : miningSnapshotWorkerFactory({
            repository: database.mining,
            registry: database.chainRegistry,
            // Decision 0061: off unless the Development stack asked for the
            // seeded holdings; the configuration refuses it in production.
            includeMockSeedHoldings: options.config.miningMockHoldingsEnabled,
            prices: createMarketFactService({
              config: options.config.market,
              cache: database.marketFacts,
              pairsProvider: createMarketProviders(
                options.config.market,
                "worker",
              ).pairs,
              securityProvider: null,
              candlesProvider: null,
            }),
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
            onRunResult: (result) => {
              // Decision 0057: an incomplete attempt publishes nothing, so
              // it must be visible somewhere other than the database.
              if (result.kind === "incomplete") {
                options.logger.warn(
                  {
                    ...logFields(),
                    ...(result.reasonCode === null
                      ? {}
                      : { reasonCode: result.reasonCode }),
                    ...(result.snapshotId === null
                      ? {}
                      : { snapshotId: result.snapshotId }),
                    unreadInputs: result.unread,
                  },
                  "LOOP mining-snapshot lane attempt incomplete: a held asset could not be valued; nothing published",
                );
              }
            },
          });
    // The `market_sparkline_warm` lane (Decision 0074) is default-on but has
    // nothing to warm from without the OHLCV Provider: it is then left out
    // and said so once, with the same reason the API publishes.
    const sparklineWarmConfig = options.config.sparklineWarm;
    let sparklineWarmWorker: MarketSparklineWarmWorker | null = null;
    if (
      sparklineWarmConfig !== null &&
      database.chainRegistry !== undefined &&
      database.marketFacts !== undefined
    ) {
      if (!options.config.market.geckoterminal.enabled) {
        options.logger.info(
          {
            ...logFields(),
            lane: "market_sparkline_warm",
            reasonCode: marketReasonCodes.geckoterminalDisabled,
          },
          "LOOP market sparkline warm lane stays idle: the OHLCV Provider is disabled",
        );
      } else {
        const providers = createMarketProviders(
          options.config.market,
          "worker",
        );
        sparklineWarmWorker = sparklineWarmWorkerFactory({
          registry: database.chainRegistry,
          watchlist: database.watchlistsV2 ?? null,
          cache: database.marketFacts,
          facts: createMarketFactService({
            config: options.config.market,
            cache: database.marketFacts,
            pairsProvider: providers.pairs,
            securityProvider: null,
            candlesProvider: providers.candles,
            tokenLookupProvider: providers.tokenLookup,
          }),
          chainId: bscChainId,
          intervalMs: sparklineWarmConfig.intervalMs,
          sparklineTtlSeconds: options.config.market.sparklineTtlSeconds,
          poolRevalidationSeconds:
            options.config.market.unlistedMetadataTtlSeconds,
          onRunResult: (result) => {
            if (result.kind === "failed") {
              options.logger.warn(
                {
                  ...logFields(),
                  lane: "market_sparkline_warm",
                  assetId: result.assetId,
                  reasonCode: result.reasonCode,
                },
                "LOOP market sparkline warm lane could not refresh an asset",
              );
            }
          },
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        });
      }
    }
    // The `community-channel-sync` lane is default-off and only constructed
    // when the complete Stream credential pair is configured (Decision 0032).
    const communityChannelGateway =
      options.config.communityChannelSync === null
        ? null
        : createStreamCommunityChannelGateway(
            options.config.communityChannelSync,
            {
              // Decision 0095: the joiner is upserted with its real
              // `{id, name, image}` so a member add never erases them.
              identities:
                database.streamUserIdentities === undefined
                  ? null
                  : createStreamUserIdentitySource({
                      repository: database.streamUserIdentities,
                      publicBaseUrl: options.config.publicBaseUrl,
                    }),
            },
          );
    const communityChannelSyncWorker =
      communityChannelGateway === null
        ? null
        : communityChannelSyncWorkerFactory({
            repository: database.communityChannelSync,
            gateway: communityChannelGateway,
            realIdentity: options.config.communityChatRealIdentity,
            personas: createCommunityPersonaService({
              personas: database.communityChannelPersonas,
              gateway: communityChannelGateway,
              logger: {
                warn: (context, message) => {
                  options.logger.warn({ ...logFields(), ...context }, message);
                },
              },
            }),
            logger: {
              warn: (context, message) => {
                options.logger.warn({ ...logFields(), ...context }, message);
              },
            },
            onInfrastructureBackoff: (event) => {
              options.logger.warn(
                { ...logFields(), ...event },
                "LOOP reconciliation worker infrastructure retry scheduled",
              );
            },
          });
    // The `voice_room_reaper` lane (Decision 0094) is default-on. It needs the
    // Stream pair to observe presence and end the call; without it the lane
    // is left out and said so once.
    const reaperConfig = options.config.voiceRoomReaper;
    let voiceRoomReaperWorker: VoiceRoomReaperWorker | null = null;
    if (reaperConfig !== null && database.voiceRoomReaper !== undefined) {
      if (reaperConfig.stream === null) {
        options.logger.warn(
          {
            ...logFields(),
            lane: "voice_room_reaper",
            reasonCode: "VOICE_ROOM_REAPER_STREAM_NOT_CONFIGURED",
          },
          "LOOP voice room reaper lane stays idle: Stream is not configured",
        );
      } else {
        const onReaperEvent = (event: VoiceRoomReaperEvent): void => {
          const lane = "voice_room_reaper";
          switch (event.kind) {
            case "ended":
              options.logger.info(
                {
                  ...logFields(),
                  lane,
                  voiceRoomId: event.voiceRoomId,
                  reasonCode: event.reasonCode,
                  providerSyncStatus: event.providerSync,
                  requestId: event.requestId,
                },
                "LOOP voice room reaper ended a room",
              );
              return;
            case "end_unconfirmed":
              options.logger.warn(
                {
                  ...logFields(),
                  lane,
                  voiceRoomId: event.voiceRoomId,
                  reasonCode: event.reasonCode,
                  detailReasonCode: event.detailReasonCode,
                  errorClass: event.errorClass,
                  requestId: event.requestId,
                },
                "LOOP voice room reaper could not confirm the Stream call end",
              );
              return;
            case "presence_unavailable":
              options.logger.debug(
                {
                  ...logFields(),
                  lane,
                  voiceRoomId: event.voiceRoomId,
                  errorClass: event.errorClass,
                },
                "LOOP voice room reaper could not observe presence; the room is kept",
              );
              return;
            case "room_failed":
              options.logger.warn(
                {
                  ...logFields(),
                  lane,
                  voiceRoomId: event.voiceRoomId,
                  reasonCode: "voice_room_reaper_end_failed",
                  errorClass: event.errorClass,
                },
                "LOOP voice room reaper could not end a room",
              );
              return;
          }
        };
        voiceRoomReaperWorker = (
          options.createVoiceRoomReaperWorker ?? createVoiceRoomReaperWorker
        )({
          service: createVoiceRoomReaperService({
            repository: database.voiceRoomReaper,
            callGateway: (
              options.createVoiceRoomCallGateway ?? createStreamCallGateway
            )(reaperConfig.stream),
            thresholds: {
              idleEndMinutes: reaperConfig.idleEndMinutes,
              maxLiveHours: reaperConfig.maxLiveHours,
            },
            onEvent: onReaperEvent,
          }),
          intervalMs: reaperConfig.intervalMs,
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        });
      }
    }
    // The `community_member_buy_feed` lane (Decision 0097) is default-on.
    // It posts into Stream, so without the Stream pair it is left out and
    // said so once.
    const memberBuyFeedConfig = options.config.communityMemberBuyFeed;
    let memberBuyFeedWorker: MemberBuyFeedWorker | null = null;
    if (memberBuyFeedConfig !== null && database.memberBuyFeed !== undefined) {
      const lane = "community_member_buy_feed";
      if (memberBuyFeedConfig.stream === null) {
        options.logger.warn(
          {
            ...logFields(),
            lane,
            reasonCode: "MEMBER_BUY_FEED_STREAM_NOT_CONFIGURED",
          },
          "LOOP member buy feed lane stays idle: Stream is not configured",
        );
      } else {
        const onMemberBuyFeedEvent = (event: MemberBuyFeedEvent): void => {
          switch (event.kind) {
            case "cursor_initialized":
              options.logger.info(
                {
                  ...logFields(),
                  lane,
                  reasonCode: event.reasonCode,
                  blockNumber: event.blockNumber,
                },
                "LOOP member buy feed cursor initialized at the indexer checkpoint",
              );
              return;
            case "sent":
              options.logger.info(
                {
                  ...logFields(),
                  lane,
                  reasonCode: event.duplicate
                    ? "MEMBER_BUY_FEED_MESSAGE_ALREADY_SENT"
                    : "MEMBER_BUY_FEED_MESSAGE_SENT",
                  communityId: event.communityId,
                  messageId: event.messageId,
                },
                "LOOP member buy feed posted a message",
              );
              return;
            case "truncated":
              options.logger.warn(
                {
                  ...logFields(),
                  lane,
                  reasonCode: event.reasonCode,
                  communityId: event.communityId,
                  truncatedCount: event.truncatedCount,
                },
                "LOOP member buy feed truncated a community's pass",
              );
              return;
            case "rejected":
              options.logger.warn(
                {
                  ...logFields(),
                  lane,
                  reasonCode: event.reasonCode,
                  communityId: event.communityId,
                  messageId: event.messageId,
                },
                "LOOP member buy feed message was rejected by Stream",
              );
              return;
            case "stream_unavailable":
              options.logger.warn(
                {
                  ...logFields(),
                  lane,
                  reasonCode: event.reasonCode,
                  communityId: event.communityId,
                  errorClass: event.errorClass,
                },
                "LOOP member buy feed could not reach Stream; the pass stalls",
              );
              return;
          }
        };
        memberBuyFeedWorker = (
          options.createMemberBuyFeedWorker ?? createMemberBuyFeedWorker
        )({
          service: createMemberBuyFeedService({
            repository: database.memberBuyFeed,
            sender: (
              options.createMemberBuyFeedGateway ??
              createStreamCommunityChannelGateway
            )(memberBuyFeedConfig.stream),
            chainId: bscChainId,
            usd1Address: memberBuyFeedConfig.usd1Address,
            onEvent: onMemberBuyFeedEvent,
          }),
          intervalMs: memberBuyFeedConfig.intervalMs,
          onInfrastructureBackoff: (event) => {
            options.logger.warn(
              { ...logFields(), ...event },
              "LOOP reconciliation worker infrastructure retry scheduled",
            );
          },
        });
      }
    }
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
      ...(launchIndexerWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              launchIndexerWorker.run(controller.signal),
            ),
          ]),
      ...(memeIndexerWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              memeIndexerWorker.run(controller.signal),
            ),
          ]),
      ...memeLanes.map((lane) =>
        Promise.resolve().then(() => lane.run(controller.signal)),
      ),
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
      ...(walletIntentReconcileWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              walletIntentReconcileWorker.run(controller.signal),
            ),
          ]),
      ...(miningSnapshotWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              miningSnapshotWorker.run(controller.signal),
            ),
          ]),
      ...(sparklineWarmWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              sparklineWarmWorker.run(controller.signal),
            ),
          ]),
      ...(voiceRoomReaperWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              voiceRoomReaperWorker.run(controller.signal),
            ),
          ]),
      ...(memberBuyFeedWorker === null
        ? []
        : [
            Promise.resolve().then(() =>
              memberBuyFeedWorker.run(controller.signal),
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
