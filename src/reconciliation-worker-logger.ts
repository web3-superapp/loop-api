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
]);
const launchIntentSettlements = new Set([
  "confirmed",
  "reverted",
  "failed",
  "expired",
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
  | "LOOP reconciliation worker failed to start"
  | "Unexpected idle PostgreSQL client error"
  | "Community persona bookkeeping failed after a completed sync job"
  | "Community channel activity could not be observed; no observation was recorded"
  | "Community persona projection lease was lost; outcome not recorded"
  | "Community persona projection was not confirmed"
  | "LOOP mining-snapshot lane attempt incomplete: a held asset could not be valued; nothing published"
  | "LOOP push channel stays deferred: the Firebase service account is unusable"
  | "LOOP push delivery was not confirmed"
  | "LOOP market sparkline warm lane stays idle: the OHLCV Provider is disabled"
  | "LOOP market sparkline warm lane could not refresh an asset";

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
  readonly write?: "confirm" | "observe" | "request" | "reset";
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
