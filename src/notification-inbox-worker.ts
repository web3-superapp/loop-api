import type {
  NotificationInboxRunResult,
  NotificationInboxService,
} from "./features/notifications/notification-inbox-service.js";

export const NOTIFICATION_INBOX_RETRY_BASE_DELAY_MS = 1_000;
export const NOTIFICATION_INBOX_RETRY_MAX_DELAY_MS = 60_000;

export interface NotificationInboxInfrastructureBackoff {
  readonly reasonCode: "notification_inbox_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface NotificationInboxWorker {
  readonly runOnce: (
    signal: AbortSignal,
  ) => Promise<NotificationInboxRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateNotificationInboxWorkerOptions {
  readonly service: NotificationInboxService;
  /** `NOTIFICATION_INBOX_INTERVAL_MS`, default 10 000. */
  readonly intervalMs: number;
  readonly onInfrastructureBackoff?: (
    event: NotificationInboxInfrastructureBackoff,
  ) => void;
}

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (isAborted(signal)) {
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
    NOTIFICATION_INBOX_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    NOTIFICATION_INBOX_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The `notification_inbox` lane loop (Decision 0177). A saturated pass runs
 * the next one at once; a failed pass backs off and retries; it never
 * rejects the loop, so it cannot stop the worker's other lanes.
 */
export function createNotificationInboxWorker(
  options: CreateNotificationInboxWorkerOptions,
): NotificationInboxWorker {
  let loopRunning = false;
  return Object.freeze({
    runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The notification inbox loop is already running");
      }
      loopRunning = true;
      let consecutiveFailureCount = 0;
      try {
        while (!isAborted(signal)) {
          try {
            const result = await options.service.runOnce(signal);
            if (result.kind === "aborted") {
              break;
            }
            consecutiveFailureCount = 0;
            if (result.saturated) {
              continue;
            }
            await waitFor(options.intervalMs, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailureCount += 1;
            const delay = retryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "notification_inbox_unavailable",
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
