import {
  FRIEND_DIRECT_CHANNEL_CLAIM_LIMIT,
  type FriendDirectChannelRunResult,
  type FriendDirectChannelService,
} from "./features/communication/friend-direct-channel-service.js";

export const FRIEND_DIRECT_CHANNEL_RETRY_BASE_DELAY_MS = 1_000;
export const FRIEND_DIRECT_CHANNEL_RETRY_MAX_DELAY_MS = 60_000;

export interface FriendDirectChannelInfrastructureBackoff {
  readonly reasonCode: "friend_direct_channel_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface FriendDirectChannelWorker {
  readonly runOnce: (
    signal: AbortSignal,
  ) => Promise<FriendDirectChannelRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateFriendDirectChannelWorkerOptions {
  readonly service: FriendDirectChannelService;
  /** `FRIEND_DIRECT_CHANNEL_INTERVAL_MS`, default 5 000. */
  readonly intervalMs: number;
  readonly onInfrastructureBackoff?: (
    event: FriendDirectChannelInfrastructureBackoff,
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
    FRIEND_DIRECT_CHANNEL_RETRY_BASE_DELAY_MS *
      2 ** (consecutiveFailureCount - 1),
    FRIEND_DIRECT_CHANNEL_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The `friend_direct_channel` lane loop (Decision 0172). A full batch runs
 * the next pass at once; a failed pass (the outbox could not be read)
 * backs off and retries; it never rejects
 * the loop, so it cannot stop the worker's other lanes.
 */
export function createFriendDirectChannelWorker(
  options: CreateFriendDirectChannelWorkerOptions,
): FriendDirectChannelWorker {
  let loopRunning = false;

  return Object.freeze({
    runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The friend direct channel loop is already running");
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
            if (result.claimed >= FRIEND_DIRECT_CHANNEL_CLAIM_LIMIT) {
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
                reasonCode: "friend_direct_channel_unavailable",
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
