import {
  createAuthoritativeReaderRegistry,
  type AuthoritativeReaderRegistry,
} from "./features/reconciliation/authoritative-reader.js";
import {
  createReconciliationService,
  type ReconciliationControlPlane,
  type ReconciliationRunResult,
  type ReconciliationService,
} from "./features/reconciliation/reconciliation-service.js";

/**
 * Provider-specific authoritative readers are added only after their separate
 * dependency, credential, and conformance gates close. The current production
 * worker therefore has no provider capability.
 */
export const productionAuthoritativeReaders = createAuthoritativeReaderRegistry(
  [],
);

export interface ReconciliationWorker {
  readonly workerId: string;
  runOnce(signal?: AbortSignal): Promise<ReconciliationRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export const WORKER_IDLE_DELAY_MS = 1_000;
export const WORKER_INFRA_RETRY_BASE_DELAY_MS = 1_000;
export const WORKER_INFRA_RETRY_MAX_DELAY_MS = 30_000;

export interface WorkerInfrastructureBackoff {
  readonly reasonCode: "control_plane_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface CreateReconciliationWorkerOptions {
  readonly controlPlane: ReconciliationControlPlane;
  readonly readers?: AuthoritativeReaderRegistry;
  readonly workerId?: string;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: WorkerInfrastructureBackoff,
  ) => void;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * This shell composes the reconciliation control plane directly and never
 * builds the HTTP application. `runOnce` is the one-shot entry point; `run`
 * adds a cancellable, non-overlapping loop without process signal ownership.
 * Cancellation aborts an active authoritative read and leaves its database
 * lease to expire; it is never recorded as a provider failure.
 */
export function createReconciliationWorker(
  options: CreateReconciliationWorkerOptions,
): ReconciliationWorker {
  const serviceOptions = {
    controlPlane: options.controlPlane,
    readers: options.readers ?? productionAuthoritativeReaders,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.createUuid === undefined
      ? {}
      : { createUuid: options.createUuid }),
  };
  const service: ReconciliationService =
    createReconciliationService(serviceOptions);
  let inFlight: Promise<ReconciliationRunResult> | null = null;
  let loopRunning = false;

  function runOnce(signal?: AbortSignal): Promise<ReconciliationRunResult> {
    if (inFlight !== null) {
      return inFlight;
    }

    const current = service.runOnce(signal);
    const tracked = current.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
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

  function infrastructureRetryDelayMs(consecutiveFailures: number): number {
    return Math.min(
      WORKER_INFRA_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1),
      WORKER_INFRA_RETRY_MAX_DELAY_MS,
    );
  }

  return Object.freeze({
    workerId: service.workerId,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The reconciliation worker loop is already running");
      }

      loopRunning = true;
      let consecutiveInfrastructureFailures = 0;

      try {
        while (!isAborted(signal)) {
          try {
            const result = await runOnce(signal);
            consecutiveInfrastructureFailures = 0;

            if (result.kind === "idle") {
              await waitFor(WORKER_IDLE_DELAY_MS, signal);
            }
          } catch {
            if (isAborted(signal)) {
              break;
            }

            consecutiveInfrastructureFailures += 1;
            const delay = infrastructureRetryDelayMs(
              consecutiveInfrastructureFailures,
            );
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "control_plane_unavailable",
                consecutiveFailureCount: consecutiveInfrastructureFailures,
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
