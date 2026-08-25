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

export type ReconciliationWorkerLogMessage =
  | "LOOP reconciliation worker started"
  | "LOOP reconciliation worker shutdown requested"
  | "LOOP reconciliation worker stopped"
  | "LOOP reconciliation worker infrastructure retry scheduled"
  | "LOOP reconciliation worker failed to start"
  | "Unexpected idle PostgreSQL client error";

export interface ReconciliationWorkerLogFields {
  readonly workerId?: string;
  readonly environment?: ReconciliationWorkerConfig["nodeEnv"];
  readonly signal?: "SIGINT" | "SIGTERM";
  readonly reasonCode?: string;
  readonly retryDelayMs?: number;
  readonly consecutiveFailureCount?: number;
  readonly postgresCode?: string;
  readonly startupErrorCode?: string;
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
