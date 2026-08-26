import { randomUUID } from "node:crypto";

export const SPOT_AGENT_LIFECYCLE_BATCH_LIMIT = 100;
export const SPOT_AGENT_LIFECYCLE_INTERVAL_MS = 60_000;
export const SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS = 1_000;
export const SPOT_AGENT_LIFECYCLE_RETRY_MAX_DELAY_MS = 30_000;

export interface SpotAgentLifecycleMaintenancePort {
  readonly expireElapsedPrepared: (input: {
    readonly requestId: string;
    readonly limit: number;
  }) => Promise<Readonly<{ expiredCount: number }>>;
  readonly retireElapsedAgentIdentities: (input: {
    readonly requestId: string;
    readonly limit: number;
  }) => Promise<Readonly<{ retiredCount: number }>>;
}

export type SpotAgentLifecycleBackoffReasonCode =
  | "spot_agent_prepared_expiry_unavailable"
  | "spot_agent_identity_retirement_unavailable"
  | "spot_agent_lifecycle_unavailable";

export interface SpotAgentLifecycleInfrastructureBackoff {
  readonly reasonCode: SpotAgentLifecycleBackoffReasonCode;
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export type SpotAgentLifecycleRunResult = Readonly<{
  kind: "aborted" | "completed";
  expiredPreparedCount: number;
  retiredAgentIdentityCount: number;
}>;

export interface SpotAgentLifecycleWorker {
  readonly runOnce: (
    signal?: AbortSignal,
  ) => Promise<SpotAgentLifecycleRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateSpotAgentLifecycleWorkerOptions {
  readonly maintenance: SpotAgentLifecycleMaintenancePort;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: SpotAgentLifecycleInfrastructureBackoff,
  ) => void;
}

class SpotAgentLifecycleStepUnavailableError extends Error {
  readonly code: SpotAgentLifecycleBackoffReasonCode;

  constructor(code: SpotAgentLifecycleBackoffReasonCode) {
    super("Spot Agent lifecycle maintenance is unavailable");
    this.name = "SpotAgentLifecycleStepUnavailableError";
    this.code = code;
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function runResult(
  kind: SpotAgentLifecycleRunResult["kind"],
  expiredPreparedCount: number,
  retiredAgentIdentityCount: number,
): SpotAgentLifecycleRunResult {
  return Object.freeze({
    kind,
    expiredPreparedCount,
    retiredAgentIdentityCount,
  });
}

function assertBatchCount(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > SPOT_AGENT_LIFECYCLE_BATCH_LIMIT
  ) {
    throw new Error("Invalid Spot Agent lifecycle maintenance count");
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
    SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS *
      2 ** (consecutiveFailureCount - 1),
    SPOT_AGENT_LIFECYCLE_RETRY_MAX_DELAY_MS,
  );
}

/**
 * Runs bounded, database-only Spot Agent lifecycle maintenance. This worker
 * receives no signer, provider transport, authorization issuer, or HTTP
 * capability. Process configuration and signal ownership remain outside this
 * library shell.
 */
export function createSpotAgentLifecycleWorker(
  options: CreateSpotAgentLifecycleWorkerOptions,
): SpotAgentLifecycleWorker {
  const createUuid = options.createUuid ?? randomUUID;
  let inFlight: Promise<SpotAgentLifecycleRunResult> | null = null;
  let loopRunning = false;

  async function performRunOnce(
    signal?: AbortSignal,
  ): Promise<SpotAgentLifecycleRunResult> {
    if (isAborted(signal)) {
      return runResult("aborted", 0, 0);
    }

    let expiredPreparedCount = 0;
    let preparedExpiryFailed = false;
    try {
      const result = await options.maintenance.expireElapsedPrepared({
        requestId: createUuid(),
        limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
      });
      expiredPreparedCount = assertBatchCount(result.expiredCount);
    } catch {
      preparedExpiryFailed = true;
    }

    if (isAborted(signal)) {
      return runResult("aborted", expiredPreparedCount, 0);
    }

    let retiredAgentIdentityCount = 0;
    let identityRetirementFailed = false;
    try {
      const result = await options.maintenance.retireElapsedAgentIdentities({
        requestId: createUuid(),
        limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
      });
      retiredAgentIdentityCount = assertBatchCount(result.retiredCount);
    } catch {
      identityRetirementFailed = true;
    }

    if (preparedExpiryFailed || identityRetirementFailed) {
      const code =
        preparedExpiryFailed && identityRetirementFailed
          ? "spot_agent_lifecycle_unavailable"
          : preparedExpiryFailed
            ? "spot_agent_prepared_expiry_unavailable"
            : "spot_agent_identity_retirement_unavailable";
      throw new SpotAgentLifecycleStepUnavailableError(code);
    }

    return runResult(
      isAborted(signal) ? "aborted" : "completed",
      expiredPreparedCount,
      retiredAgentIdentityCount,
    );
  }

  function runOnce(signal?: AbortSignal): Promise<SpotAgentLifecycleRunResult> {
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
          "The Spot Agent lifecycle worker loop is already running",
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
            await waitFor(SPOT_AGENT_LIFECYCLE_INTERVAL_MS, signal);
          } catch (error) {
            if (isAborted(signal)) {
              break;
            }

            consecutiveFailureCount += 1;
            const delay = retryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode:
                  error instanceof SpotAgentLifecycleStepUnavailableError
                    ? error.code
                    : "spot_agent_lifecycle_unavailable",
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
