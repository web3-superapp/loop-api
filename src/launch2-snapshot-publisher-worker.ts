import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import {
  createLaunch2SnapshotPublisher,
  launch2SnapshotPublisherLane,
  type Launch2PublicationRepository,
  type Launch2PublisherChain,
  type Launch2PublisherPolicy,
  type Launch2PublisherStep,
  type Launch2SnapshotPublisher,
  type Launch2SnapshotSigner,
} from "./features/launch2/launch2-snapshot-publisher.js";
import type { Launch2Repository } from "./features/launch2/launch2-ports.js";

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Decision 0118: the `launch2_snapshot_publisher` lane of the worker
 * process (default off). One tick advances every in-flight publication and
 * starts the ones whose cutoff is final; infrastructure errors back off.
 * A waiting reason is logged once per instance until it changes.
 */
export function createLaunch2SnapshotPublisherLane(options: {
  readonly repository: Launch2PublicationRepository;
  readonly launch2: Pick<Launch2Repository, "nftHoldersAt" | "getCheckpoint">;
  readonly chain: Launch2PublisherChain;
  readonly signers: readonly Launch2SnapshotSigner[];
  readonly policy: Launch2PublisherPolicy;
  readonly pollIntervalMs: number;
  readonly now?: () => Date;
  readonly onStep?: (step: Launch2PublisherStep) => void;
  readonly onWaiting?: (event: {
    readonly instanceId: string | null;
    readonly reasonCode: string;
  }) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane & { readonly publisher: Launch2SnapshotPublisher } {
  const publisher = createLaunch2SnapshotPublisher({
    repository: options.repository,
    launch2: options.launch2,
    chain: options.chain,
    signers: options.signers,
    policy: options.policy,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
  });
  let lastWaiting = new Map<string, string>();
  let lastUnavailable: string | null = null;

  async function tick(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await publisher.runOnce(signal);
    if (result.kind === "unavailable") {
      if (result.reasonCode !== null && result.reasonCode !== lastUnavailable) {
        options.onWaiting?.({
          instanceId: null,
          reasonCode: result.reasonCode,
        });
      }
      lastUnavailable = result.reasonCode;
      return { ...result };
    }
    lastUnavailable = null;
    const next = new Map(Object.entries(result.waiting));
    for (const [instanceId, reasonCode] of next) {
      if (lastWaiting.get(instanceId) !== reasonCode) {
        options.onWaiting?.({ instanceId, reasonCode });
      }
    }
    lastWaiting = next;
    return { ...result };
  }

  return Object.freeze({
    lane: launch2SnapshotPublisherLane,
    publisher,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(options.pollIntervalMs, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: launch2SnapshotPublisherLane,
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
