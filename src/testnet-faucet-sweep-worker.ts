import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import {
  createTestnetFaucetPendingSweep,
  testnetFaucetPendingSweepLane,
  type TestnetFaucetSweepEvent,
} from "./features/testnet-faucet/testnet-faucet-sweep.js";
import type {
  TestnetFaucetRepository,
  TestnetFaucetTransactionLookup,
} from "./features/testnet-faucet/testnet-faucet-contract.js";

const retryBaseDelayMs = 1_000;
const retryMaxDelayMs = 60_000;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * S169 (Decision 0128 §9): the `testnet_faucet_pending_sweep` lane of the
 * worker process, on with TESTNET_FAUCET_ENABLED on the BSC Testnet slot.
 * One pass per `intervalMs`; an infrastructure error (database) backs off
 * and never stops the other lanes.
 */
export function createTestnetFaucetSweepLane(options: {
  readonly repository: Pick<
    TestnetFaucetRepository,
    "listStalePending" | "resolveStalePending"
  >;
  readonly lookup: TestnetFaucetTransactionLookup;
  readonly pendingTimeoutSeconds: number;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: TestnetFaucetSweepEvent) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane {
  const sweep = createTestnetFaucetPendingSweep({
    repository: options.repository,
    lookup: options.lookup,
    pendingTimeoutSeconds: options.pendingTimeoutSeconds,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  const tick = async (
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => ({
    ...(await sweep.runOnce(signal)),
  });
  return Object.freeze({
    lane: testnetFaucetPendingSweepLane,
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
            lane: testnetFaucetPendingSweepLane,
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
