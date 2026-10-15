import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import {
  createSquareFeedIngest,
  squareFeedIngestLane,
  type SquareFeedIngestRepository,
  type SquareFeedIngestResult,
} from "./features/square/square-ingest.js";

const retryBaseDelayMs = 1_000;
const retryMaxDelayMs = 60_000;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Decision 0143 §4: the `square_feed_ingest` lane of the worker process
 * (default on, `SQUARE_FEED_INGEST_ENABLED`). Database only: it reads the
 * member buy, LoopDynamic claim and graduation read models and writes
 * `square_posts`. One pass per `intervalMs` (default 60 s); a database
 * error backs off 1 s → 60 s and never stops the other lanes.
 */
export function createSquareFeedIngestLane(options: {
  readonly repository: SquareFeedIngestRepository;
  readonly usd1Address: string | null;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly onPass?: (result: SquareFeedIngestResult) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane {
  const ingest = createSquareFeedIngest({
    repository: options.repository,
    usd1Address: options.usd1Address,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const tick = async (
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const result = await ingest.runOnce(signal);
    options.onPass?.(result);
    return { ...result };
  };
  return Object.freeze({
    lane: squareFeedIngestLane,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(options.intervalMs, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(
            retryBaseDelayMs * 2 ** (failures - 1),
            retryMaxDelayMs,
          );
          options.onInfrastructureBackoff?.({
            lane: squareFeedIngestLane,
            consecutiveFailureCount: failures,
            retryDelayMs: delay,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
          await waitFor(delay, signal);
        }
      }
    },
  });
}
