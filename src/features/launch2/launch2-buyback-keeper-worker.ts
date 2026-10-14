import { waitFor, type PeriodicLane } from "../../bsc-meme-indexer-worker.js";
import type { ChainGuardHoldCheck } from "../chain-guard/chain-guard-hold.js";
import {
  createLaunch2BuybackKeeper,
  launch2BuybackKeeperLane,
  type Launch2BuybackAttemptRepository,
  type Launch2BuybackKeeper,
  type Launch2BuybackKeeperChain,
  type Launch2BuybackKeeperPolicy,
  type Launch2KeeperStep,
} from "./launch2-buyback-keeper.js";

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Decision 0121: the `launch2_buyback_keeper` lane of the reconciliation
 * worker (default off). One tick every `intervalSeconds` (≥ 10) advances
 * in-flight attempts and starts new ones; infrastructure errors back off
 * exponentially. A waiting reason is reported once per instance until it
 * changes, and a refreshed same-reason refusal is not reported as a new
 * step — a refusal that persists (price protection, pause) produces one
 * log line, not one every tick.
 */
export function createLaunch2BuybackKeeperLane(options: {
  readonly repository: Launch2BuybackAttemptRepository;
  readonly chain: Launch2BuybackKeeperChain;
  readonly policy: Launch2BuybackKeeperPolicy;
  readonly now?: () => Date;
  /**
   * Decision 0134: the chain guard's hold check; a non-null answer is this
   * tick's result (`CHAIN_GUARD_HOLD`) and nothing else runs.
   */
  readonly chainGuardHold?: ChainGuardHoldCheck;
  readonly onStep?: (step: Launch2KeeperStep) => void;
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
}): PeriodicLane & { readonly keeper: Launch2BuybackKeeper } {
  const keeper = createLaunch2BuybackKeeper({
    repository: options.repository,
    chain: options.chain,
    policy: options.policy,
    ...(options.now === undefined ? {} : { now: options.now }),
    onStep: (step) => {
      if (!step.repeated) options.onStep?.(step);
    },
  });
  let lastWaiting = new Map<string, string>();
  let lastUnavailable: string | null = null;

  async function tick(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const held = await options.chainGuardHold?.();
    if (held !== null && held !== undefined) return { ...held };
    const result = await keeper.runOnce(signal);
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

  const intervalMs = options.policy.intervalSeconds * 1000;
  return Object.freeze({
    lane: launch2BuybackKeeperLane,
    keeper,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(intervalMs, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: launch2BuybackKeeperLane,
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
