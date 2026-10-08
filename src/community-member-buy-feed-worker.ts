import type {
  MemberBuyFeedRunResult,
  MemberBuyFeedService,
} from "./features/community/member-buy-feed-service.js";

export const MEMBER_BUY_FEED_RETRY_BASE_DELAY_MS = 1_000;
export const MEMBER_BUY_FEED_RETRY_MAX_DELAY_MS = 60_000;

export interface MemberBuyFeedInfrastructureBackoff {
  readonly lane: "community_member_buy_feed";
  readonly reasonCode: "member_buy_feed_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface MemberBuyFeedWorker {
  readonly runOnce: (signal: AbortSignal) => Promise<MemberBuyFeedRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateMemberBuyFeedWorkerOptions {
  readonly service: MemberBuyFeedService;
  /** `COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS`, default 15 000. */
  readonly intervalMs: number;
  readonly onInfrastructureBackoff?: (
    event: MemberBuyFeedInfrastructureBackoff,
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
    MEMBER_BUY_FEED_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    MEMBER_BUY_FEED_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The `community_member_buy_feed` lane loop (Decision 0097). A pass whose
 * database read or write failed backs off 1 s → 60 s; it never rejects the
 * loop, so it cannot stop the worker's other lanes. A Stream failure is not
 * an infrastructure failure: the pass resolves `stalled` and the next
 * interval retries the same swap.
 */
export function createMemberBuyFeedWorker(
  options: CreateMemberBuyFeedWorkerOptions,
): MemberBuyFeedWorker {
  let loopRunning = false;

  return Object.freeze({
    runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The member buy feed loop is already running");
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
            await waitFor(options.intervalMs, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailureCount += 1;
            const delay = retryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                lane: "community_member_buy_feed",
                reasonCode: "member_buy_feed_unavailable",
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
