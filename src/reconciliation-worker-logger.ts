import { launch2PublicationStatuses } from "./features/launch2/launch2-snapshot-publisher.js";
import { launch2BuybackAttemptStatuses } from "./features/launch2/launch2-buyback-keeper.js";
import { hooksLaunchDeploymentStatuses } from "./features/launch/hooks-launch-deployment-status.js";
import type { ReconciliationWorkerConfig } from "./config.js";

type WorkerLogLevel = ReconciliationWorkerConfig["logLevel"];
type EmittedWorkerLogLevel = Exclude<WorkerLogLevel, "silent">;

const levelValues = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
});

const safeCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;
const safeWorkerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeAssetIdPattern = /^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/;
/** A host name only: no scheme, port, path, query, or user-info (Decision 0068). */
const safeHostPattern = /^[A-Za-z0-9.-]{1,253}$/;
const indexerLanes = new Set([
  "erc20_transfer",
  "pool_event",
  "launch_event",
  "market_sparkline_warm",
  // Decision 0080: the Launch part of the wallet-intent reconcile lane.
  "launch_intent_reconcile",
  // Decision 0094: ends abandoned and over-age voice rooms.
  "voice_room_reaper",
  // Decision 0097: member buys of a community's bound asset.
  "community_member_buy_feed",
  // Decision 0101: the MEME launchpad lanes.
  "meme_event",
  "meme_salt_pool",
  "meme_intent_reconcile",
  "meme_graduation_executor",
  "hooks_launch_executor",
  // Decision 0114 / 0118 / 0121: the MEME v2 lanes.
  "launch2_event",
  "launch2_snapshot_publisher",
  "launch2_buyback_keeper",
]);
const memeGraduationOutcomes = new Set([
  "confirmed",
  "reverted",
  "not_full",
  "failed",
]);
const safeFeedMessageIdPattern = /^loop_buy_[0-9a-f]{32}$/;
const providerSyncStatuses = new Set(["confirmed", "unconfirmed"]);
const launchIntentSettlements = new Set([
  "confirmed",
  "reverted",
  "failed",
  "expired",
]);

const hooksDeploymentStatusSet: ReadonlySet<string> = new Set([
  ...hooksLaunchDeploymentStatuses,
  // Decision 0118 / 0121: snapshot publication and buyback attempt statuses.
  ...launch2PublicationStatuses,
  ...launch2BuybackAttemptStatuses,
]);

export type ReconciliationWorkerLogMessage =
  | "LOOP reconciliation worker started"
  | "LOOP reconciliation worker shutdown requested"
  | "LOOP reconciliation worker stopped"
  | "LOOP reconciliation worker infrastructure retry scheduled"
  | "LOOP BSC indexer lane is unavailable"
  | "LOOP BSC indexer lane recovered"
  | "LOOP BSC log-query limits reset to their configured values"
  | "LOOP launch_event lane skipped a fact"
  | "LOOP launch_event lane is idle"
  | "LOOP launch intent reconciliation is unavailable"
  | "LOOP launch intent receipt read failed"
  | "LOOP launch intent settled from its receipt"
  | "LOOP meme lanes stay idle: the MEME contract is not configured"
  | "LOOP meme graduation executor stays idle"
  | "LOOP meme graduation executor attempted graduate"
  | "LOOP hooks launch executor stays idle"
  | "LOOP hooks launch executor is idle"
  | "LOOP hooks launch executor enabled"
  | "LOOP hooks launch executor step"
  | "LOOP launch2_event lane stays idle"
  | "LOOP launch2_event lane is idle"
  | "LOOP launch2_event lane enabled"
  | "LOOP launch2_event lane skipped facts"
  | "LOOP launch2_event MEME transfer coverage incomplete; re-scanning"
  | "LOOP launch2_event MEME transfer coverage incomplete after 3 re-scans; operator required"
  | "LOOP launch2 snapshot publisher stays idle"
  | "LOOP launch2 snapshot publisher enabled"
  | "LOOP launch2 snapshot publisher step"
  | "LOOP launch2 snapshot publisher is waiting"
  | "LOOP launch2 buyback keeper stays idle"
  | "LOOP launch2 buyback keeper enabled"
  | "LOOP launch2 buyback keeper step"
  | "LOOP launch2 buyback keeper is waiting"
  | "LOOP launch2 buyback keeper refused: the key is not a Factory keeper"
  | "LOOP mining_hourly_settlement lane stays idle"
  | "LOOP mining_hourly_settlement lane enabled"
  | "LOOP mining_hourly_settlement tick failed"
  | "LOOP mining hour settled"
  | "LOOP mining hour not settled"
  | "LOOP meme salt pool refilled"
  | "LOOP meme intent settled from its receipt"
  | "LOOP meme intent receipt read failed"
  | "LOOP meme_event lane skipped facts"
  | "LOOP meme_event lane is idle"
  | "LOOP reconciliation worker failed to start"
  | "Unexpected idle PostgreSQL client error"
  | "Community persona bookkeeping failed after a completed sync job"
  | "Community channel activity could not be observed; no observation was recorded"
  | "Community channel mute was not applied; the membership sync completed without it"
  | "Community persona projection lease was lost; outcome not recorded"
  | "Community persona projection was not confirmed"
  | "LOOP mining-snapshot lane attempt incomplete: a held asset could not be valued; nothing published"
  | "LOOP push channel stays deferred: the Firebase service account is unusable"
  | "LOOP push delivery was not confirmed"
  | "LOOP market sparkline warm lane stays idle: the OHLCV Provider is disabled"
  | "LOOP market sparkline warm lane could not refresh an asset"
  | "LOOP voice room reaper ended a room"
  | "LOOP voice room reaper could not confirm the Stream call end"
  | "LOOP voice room reaper could not end a room"
  | "LOOP voice room reaper could not observe presence; the room is kept"
  | "LOOP voice room reaper lane stays idle: Stream is not configured"
  | "LOOP member buy feed lane stays idle: Stream is not configured"
  | "LOOP member buy feed cursor initialized at the indexer checkpoint"
  | "LOOP member buy feed posted a message"
  | "LOOP member buy feed truncated a community's pass"
  | "LOOP member buy feed message was rejected by Stream"
  | "LOOP member buy feed could not reach Stream; the pass stalls";

/** One holding a mining snapshot attempt could not value (Decision 0057). */
export interface ReconciliationWorkerUnreadInput {
  readonly assetId: string;
  readonly reasonCode: string;
}

export interface ReconciliationWorkerLogFields {
  readonly workerId?: string;
  readonly environment?: ReconciliationWorkerConfig["nodeEnv"];
  readonly signal?: "SIGINT" | "SIGTERM";
  readonly reasonCode?: string;
  readonly retryDelayMs?: number;
  readonly consecutiveFailureCount?: number;
  readonly postgresCode?: string;
  readonly startupErrorCode?: string;
  /** Decision 0057 mining-snapshot lane; an opaque attempt ID and asset IDs with reason codes only. */
  readonly snapshotId?: string;
  readonly unreadInputs?: readonly ReconciliationWorkerUnreadInput[];
  /** Decision 0055 persona lane; opaque identifiers and an error class only. */
  readonly communityId?: string;
  readonly ownerUserId?: string;
  readonly personaId?: string;
  readonly write?: "confirm" | "mute" | "observe" | "request" | "reset";
  readonly projectionAttempts?: number;
  readonly errorName?: string;
  /**
   * Decision 0068 BSC indexer lanes: which lane, the error class, the HTTP
   * status and JSON-RPC code the Provider answered with, the endpoint host
   * name, and the JSON-RPC method. Never a URL, a body, or an address list.
   */
  readonly lane?: string;
  readonly state?: "unavailable" | "recovered";
  /** Decision 0074 sparkline lane: the asset that could not be refreshed, by id only. */
  readonly assetId?: string;
  readonly errorClass?: string | null;
  readonly rpcStatus?: number | null;
  readonly rpcCode?: number | null;
  readonly rpcUrlHost?: string | null;
  readonly method?: string | null;
  /** Decision 0077 launch_event lane: a contract saleId and a block, decimal strings. */
  readonly saleId?: string | null;
  readonly blockNumber?: string;
  readonly detailReasonCode?: string | null;
  /**
   * Decision 0079: the shared BSC read client's learned `eth_getLogs` limits
   * (addresses per request, wallets per topic array, blocks per request) and
   * the clean-read streak before the next widening probe; numbers only. On a
   * `BSC_LOG_LIMITS_RESET` line the `previous*` fields are the values before
   * the reset and the `learned*` fields the values after it.
   */
  readonly learnedAddressLimit?: number | undefined;
  readonly learnedTopicGroupLimit?: number | undefined;
  readonly learnedRangeLimit?: number | undefined;
  readonly relaxAfterCleanReads?: number | undefined;
  readonly previousAddressLimit?: number | undefined;
  readonly previousTopicGroupLimit?: number | undefined;
  readonly previousRangeLimit?: number | undefined;
  /**
   * Decision 0079 (S82d): with `BSC_LOG_ARCHIVE_REQUIRED`, head − the first
   * block of the segment the endpoint refused as an archive read.
   */
  readonly behindBlocks?: number | undefined;
  /** Decision 0080: the opaque Launch Intent ID and the state it settled to. */
  readonly launchIntentId?: string;
  readonly toState?: string;
  /**
   * Decision 0094 voice_room_reaper lane: the opaque room ID, the request ID
   * of the system end (the `voice_room_events.request_id`), and whether the
   * Stream `end` call was confirmed.
   */
  readonly voiceRoomId?: string;
  readonly requestId?: string;
  readonly providerSyncStatus?: "confirmed" | "unconfirmed";
  /**
   * Decision 0097 community_member_buy_feed lane: the community (opaque ID,
   * also used by the 0055 persona lines), the deterministic Stream message
   * ID, and how many buys a pass recorded without sending.
   */
  readonly messageId?: string;
  readonly truncatedCount?: number;
  /**
   * Decision 0101 MEME lanes: opaque token / Intent IDs, the executor's
   * outcome, attempt count and operator flag, the graduate transaction
   * hash, salt-pool counts, and skipped-event counts. Never a key or URL.
   */
  readonly memeTokenId?: string;
  readonly memeIntentId?: string;
  /**
   * Decision 0112 Hooks executor: the opaque task ID, the status pair and
   * step name, the executor / Factory addresses (public), and the
   * configured confirmations. Never a key, a raw transaction, or a URL.
   */
  readonly hooksDeploymentJobId?: string;
  /** Decision 0114 launch2_event lane: the opaque instance ID. */
  readonly instanceId?: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly step?: string;
  readonly executorAddress?: string;
  readonly factoryAddress?: string;
  readonly confirmations?: number;
  readonly outcome?: string;
  readonly attempts?: number;
  readonly needsOperator?: boolean;
  readonly transactionHash?: string;
  readonly released?: number;
  readonly inserted?: number;
  readonly free?: number;
  readonly count?: number;
  /** Decision 0116 settlement lane: the UTC hour and claim reconciliation. */
  readonly hourStart?: string;
  readonly claimReconcile?: boolean;
}

export interface ReconciliationWorkerLogger {
  readonly trace: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
  readonly debug: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
  readonly info: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
  readonly warn: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
  readonly error: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
  readonly fatal: (
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ) => void;
}

export interface CreateReconciliationWorkerLoggerOptions {
  readonly level: WorkerLogLevel;
  readonly serviceVersion: string;
  readonly now?: () => Date;
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
}

function safeCode(value: string | undefined): string | undefined {
  return value !== undefined && safeCodePattern.test(value) ? value : undefined;
}

function sanitizeFields(
  fields: ReconciliationWorkerLogFields,
): ReconciliationWorkerLogFields {
  const workerId =
    fields.workerId !== undefined && safeWorkerIdPattern.test(fields.workerId)
      ? fields.workerId
      : undefined;
  const retryDelayMs =
    fields.retryDelayMs !== undefined &&
    Number.isSafeInteger(fields.retryDelayMs) &&
    fields.retryDelayMs >= 0
      ? fields.retryDelayMs
      : undefined;
  const consecutiveFailureCount =
    fields.consecutiveFailureCount !== undefined &&
    Number.isSafeInteger(fields.consecutiveFailureCount) &&
    fields.consecutiveFailureCount >= 0
      ? fields.consecutiveFailureCount
      : undefined;
  const reasonCode = safeCode(fields.reasonCode);
  const postgresCode = safeCode(fields.postgresCode);
  const startupErrorCode = safeCode(fields.startupErrorCode);
  const environment =
    fields.environment === "development" ||
    fields.environment === "test" ||
    fields.environment === "production"
      ? fields.environment
      : undefined;
  const signal =
    fields.signal === "SIGINT" || fields.signal === "SIGTERM"
      ? fields.signal
      : undefined;
  const snapshotId =
    fields.snapshotId !== undefined &&
    safeWorkerIdPattern.test(fields.snapshotId)
      ? fields.snapshotId
      : undefined;
  const lane =
    fields.lane !== undefined && indexerLanes.has(fields.lane)
      ? fields.lane
      : undefined;
  const state =
    fields.state === "unavailable" || fields.state === "recovered"
      ? fields.state
      : undefined;
  const errorClass = safeCode(fields.errorClass ?? undefined);
  const method = safeCode(fields.method ?? undefined);
  const rpcStatus =
    typeof fields.rpcStatus === "number" &&
    Number.isInteger(fields.rpcStatus) &&
    fields.rpcStatus >= 100 &&
    fields.rpcStatus <= 599
      ? fields.rpcStatus
      : undefined;
  const rpcCode =
    typeof fields.rpcCode === "number" && Number.isSafeInteger(fields.rpcCode)
      ? fields.rpcCode
      : undefined;
  const rpcUrlHost =
    typeof fields.rpcUrlHost === "string" &&
    safeHostPattern.test(fields.rpcUrlHost)
      ? fields.rpcUrlHost
      : undefined;
  const assetId =
    fields.assetId !== undefined && safeAssetIdPattern.test(fields.assetId)
      ? fields.assetId
      : undefined;
  const saleId =
    typeof fields.saleId === "string" &&
    /^[1-9][0-9]{0,77}$/.test(fields.saleId)
      ? fields.saleId
      : undefined;
  const blockNumber =
    typeof fields.blockNumber === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(fields.blockNumber)
      ? fields.blockNumber
      : undefined;
  const detailReasonCode = safeCode(fields.detailReasonCode ?? undefined);
  const launchIntentId =
    fields.launchIntentId !== undefined &&
    safeUuidPattern.test(fields.launchIntentId)
      ? fields.launchIntentId
      : undefined;
  const toState =
    fields.toState !== undefined && launchIntentSettlements.has(fields.toState)
      ? fields.toState
      : undefined;
  const voiceRoomId =
    fields.voiceRoomId !== undefined && safeUuidPattern.test(fields.voiceRoomId)
      ? fields.voiceRoomId
      : undefined;
  const requestId =
    fields.requestId !== undefined && safeUuidPattern.test(fields.requestId)
      ? fields.requestId
      : undefined;
  const providerSyncStatus =
    fields.providerSyncStatus !== undefined &&
    providerSyncStatuses.has(fields.providerSyncStatus)
      ? fields.providerSyncStatus
      : undefined;
  const messageId =
    fields.messageId !== undefined &&
    safeFeedMessageIdPattern.test(fields.messageId)
      ? fields.messageId
      : undefined;
  const communityId =
    fields.lane === "community_member_buy_feed" &&
    fields.communityId !== undefined &&
    safeUuidPattern.test(fields.communityId)
      ? fields.communityId
      : undefined;
  const limits = Object.fromEntries(
    (
      [
        "learnedAddressLimit",
        "learnedTopicGroupLimit",
        "learnedRangeLimit",
        "relaxAfterCleanReads",
        "previousAddressLimit",
        "previousTopicGroupLimit",
        "previousRangeLimit",
        "behindBlocks",
        "truncatedCount",
        "attempts",
        "released",
        "inserted",
        "free",
        "count",
        "confirmations",
      ] as const
    ).flatMap((key) => {
      const value = fields[key];
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? [[key, value]]
        : [];
    }),
  );
  const memeTokenId =
    fields.memeTokenId !== undefined && safeUuidPattern.test(fields.memeTokenId)
      ? fields.memeTokenId
      : undefined;
  const memeIntentId =
    fields.memeIntentId !== undefined &&
    safeUuidPattern.test(fields.memeIntentId)
      ? fields.memeIntentId
      : undefined;
  const outcome =
    fields.outcome !== undefined && memeGraduationOutcomes.has(fields.outcome)
      ? fields.outcome
      : undefined;
  const needsOperator =
    typeof fields.needsOperator === "boolean"
      ? fields.needsOperator
      : undefined;
  const transactionHash =
    fields.transactionHash !== undefined &&
    /^0x[0-9a-f]{64}$/.test(fields.transactionHash)
      ? fields.transactionHash
      : undefined;
  const instanceId =
    fields.instanceId !== undefined && safeUuidPattern.test(fields.instanceId)
      ? fields.instanceId
      : undefined;
  const hooksDeploymentJobId =
    fields.hooksDeploymentJobId !== undefined &&
    safeUuidPattern.test(fields.hooksDeploymentJobId)
      ? fields.hooksDeploymentJobId
      : undefined;
  const hooksStatus = (value: string | undefined): string | undefined =>
    value !== undefined && hooksDeploymentStatusSet.has(value)
      ? value
      : undefined;
  const fromStatus = hooksStatus(fields.fromStatus);
  const toStatus = hooksStatus(fields.toStatus);
  const step =
    fields.step !== undefined && /^[a-z_]{1,40}$/u.test(fields.step)
      ? fields.step
      : undefined;
  const publicAddress = (value: string | undefined): string | undefined =>
    value !== undefined && /^0x[0-9a-f]{40}$/u.test(value) ? value : undefined;
  const executorAddress = publicAddress(fields.executorAddress);
  const factoryAddress = publicAddress(fields.factoryAddress);
  const unreadInputs =
    fields.unreadInputs === undefined
      ? undefined
      : fields.unreadInputs.flatMap((input) => {
          const code = safeCode(input.reasonCode);
          return safeAssetIdPattern.test(input.assetId) && code !== undefined
            ? [Object.freeze({ assetId: input.assetId, reasonCode: code })]
            : [];
        });

  return Object.freeze({
    ...(workerId === undefined ? {} : { workerId }),
    ...(environment === undefined ? {} : { environment }),
    ...(signal === undefined ? {} : { signal }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(consecutiveFailureCount === undefined
      ? {}
      : { consecutiveFailureCount }),
    ...(postgresCode === undefined ? {} : { postgresCode }),
    ...(startupErrorCode === undefined ? {} : { startupErrorCode }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(unreadInputs === undefined || unreadInputs.length === 0
      ? {}
      : { unreadInputs: Object.freeze(unreadInputs) }),
    ...(lane === undefined ? {} : { lane }),
    ...(state === undefined ? {} : { state }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(rpcStatus === undefined ? {} : { rpcStatus }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    ...(rpcUrlHost === undefined ? {} : { rpcUrlHost }),
    ...(method === undefined ? {} : { method }),
    ...(saleId === undefined ? {} : { saleId }),
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(detailReasonCode === undefined ? {} : { detailReasonCode }),
    ...(launchIntentId === undefined ? {} : { launchIntentId }),
    ...(toState === undefined ? {} : { toState }),
    ...(voiceRoomId === undefined ? {} : { voiceRoomId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(providerSyncStatus === undefined ? {} : { providerSyncStatus }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(communityId === undefined ? {} : { communityId }),
    ...(memeTokenId === undefined ? {} : { memeTokenId }),
    ...(memeIntentId === undefined ? {} : { memeIntentId }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(needsOperator === undefined ? {} : { needsOperator }),
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(hooksDeploymentJobId === undefined ? {} : { hooksDeploymentJobId }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(fromStatus === undefined ? {} : { fromStatus }),
    ...(toStatus === undefined ? {} : { toStatus }),
    ...(step === undefined ? {} : { step }),
    ...(executorAddress === undefined ? {} : { executorAddress }),
    ...(factoryAddress === undefined ? {} : { factoryAddress }),
    ...limits,
  });
}

export function createReconciliationWorkerLogger(
  options: CreateReconciliationWorkerLoggerOptions,
): ReconciliationWorkerLogger {
  const now = options.now ?? (() => new Date());
  const writeStdout =
    options.writeStdout ?? ((line: string) => process.stdout.write(line));
  const writeStderr =
    options.writeStderr ?? ((line: string) => process.stderr.write(line));

  function emit(
    level: EmittedWorkerLogLevel,
    fields: ReconciliationWorkerLogFields,
    message: ReconciliationWorkerLogMessage,
  ): void {
    if (levelValues[level] < levelValues[options.level]) {
      return;
    }

    const line = `${JSON.stringify({
      level,
      time: now().toISOString(),
      service: "loop-reconciliation-worker",
      version: options.serviceVersion,
      ...sanitizeFields(fields),
      msg: message,
    })}\n`;

    if (levelValues[level] >= levelValues.warn) {
      writeStderr(line);
      return;
    }

    writeStdout(line);
  }

  const logger: ReconciliationWorkerLogger = {
    trace: (fields, message) => emit("trace", fields, message),
    debug: (fields, message) => emit("debug", fields, message),
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
    fatal: (fields, message) => emit("fatal", fields, message),
  };
  return Object.freeze(logger);
}
