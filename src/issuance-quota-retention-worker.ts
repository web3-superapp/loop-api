import { randomUUID } from "node:crypto";

export const ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT = 1_000;
export const ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN = 10;
export const ISSUANCE_QUOTA_RETENTION_INTERVAL_MS = 60_000;
export const ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS = 1_000;
export const ISSUANCE_QUOTA_RETENTION_RETRY_MAX_DELAY_MS = 30_000;

export interface IssuanceQuotaRetentionMaintenancePort {
  readonly deleteExpiredIssuanceQuotaRecords: (input: {
    readonly requestId: string;
    readonly limit: number;
  }) => Promise<Readonly<{ deletedCount: number }>>;
}

export interface IssuanceQuotaRetentionInfrastructureBackoff {
  readonly reasonCode: "issuance_quota_retention_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export type IssuanceQuotaRetentionRunResult = Readonly<{
  kind: "aborted" | "completed";
  batchCount: number;
  deletedCount: number;
}>;

export interface IssuanceQuotaRetentionWorker {
  readonly runOnce: (
    signal?: AbortSignal,
  ) => Promise<IssuanceQuotaRetentionRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateIssuanceQuotaRetentionWorkerOptions {
  readonly maintenance: IssuanceQuotaRetentionMaintenancePort;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: IssuanceQuotaRetentionInfrastructureBackoff,
  ) => void;
}

class IssuanceQuotaRetentionUnavailableError extends Error {
  readonly code = "issuance_quota_retention_unavailable";

  constructor() {
    super("Issuance quota retention maintenance is unavailable");
    this.name = "IssuanceQuotaRetentionUnavailableError";
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function runResult(
  kind: IssuanceQuotaRetentionRunResult["kind"],
  batchCount: number,
  deletedCount: number,
): IssuanceQuotaRetentionRunResult {
  return Object.freeze({ kind, batchCount, deletedCount });
}

function assertDeletedCount(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT
  ) {
    throw new IssuanceQuotaRetentionUnavailableError();
  }

  return value;
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(consecutiveFailureCount: number): number {
  return Math.min(
    ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS *
      2 ** (consecutiveFailureCount - 1),
    ISSUANCE_QUOTA_RETENTION_RETRY_MAX_DELAY_MS,
  );
}

/**
 * Runs bounded, database-only retention maintenance. It receives no HTTP,
 * identity, provider, signer, or product capability. An abort cannot cancel a
 * PostgreSQL statement already in flight; the worker waits for that bounded
 * call and starts no later batch.
 */
export function createIssuanceQuotaRetentionWorker(
  options: CreateIssuanceQuotaRetentionWorkerOptions,
): IssuanceQuotaRetentionWorker {
  const createUuid = options.createUuid ?? randomUUID;
  let inFlight: Promise<IssuanceQuotaRetentionRunResult> | null = null;
  let loopRunning = false;

  async function performRunOnce(
    signal?: AbortSignal,
  ): Promise<IssuanceQuotaRetentionRunResult> {
    if (isAborted(signal)) {
      return runResult("aborted", 0, 0);
    }

    let batchCount = 0;
    let deletedCount = 0;

    try {
      while (batchCount < ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN) {
        if (isAborted(signal)) {
          return runResult("aborted", batchCount, deletedCount);
        }

        const result =
          await options.maintenance.deleteExpiredIssuanceQuotaRecords({
            requestId: createUuid(),
            limit: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
          });
        const currentDeletedCount = assertDeletedCount(result.deletedCount);
        batchCount += 1;
        deletedCount += currentDeletedCount;

        if (isAborted(signal)) {
          return runResult("aborted", batchCount, deletedCount);
        }

        if (currentDeletedCount < ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT) {
          break;
        }
      }
    } catch {
      throw new IssuanceQuotaRetentionUnavailableError();
    }

    return runResult("completed", batchCount, deletedCount);
  }

  function runOnce(
    signal?: AbortSignal,
  ): Promise<IssuanceQuotaRetentionRunResult> {
    if (inFlight !== null) {
      return inFlight;
    }

    const current = performRunOnce(signal);
    const tracked = current.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
  }

  return Object.freeze({
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error(
          "The issuance quota retention worker loop is already running",
        );
      }

      loopRunning = true;
      let consecutiveFailureCount = 0;

      try {
        while (!signal.aborted) {
          try {
            const result = await runOnce(signal);
            if (result.kind === "aborted") {
              break;
            }

            consecutiveFailureCount = 0;
            await waitFor(ISSUANCE_QUOTA_RETENTION_INTERVAL_MS, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }

            consecutiveFailureCount += 1;
            const delay = retryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "issuance_quota_retention_unavailable",
                consecutiveFailureCount,
                retryDelayMs: delay,
              }),
            );
            await waitFor(delay, signal);
          }
        }
      } finally {
        loopRunning = false;
      }
    },
  });
}
