import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import type { HooksLaunchExecutorConfig } from "./config.js";
import type { LaunchSlotPolicy } from "./features/chain/chain-contract.js";
import type { ChainGuardHoldCheck } from "./features/chain-guard/chain-guard-hold.js";
import {
  createHooksLaunchExecutor,
  hooksLaunchExecutorDefaults,
  type HooksLaunchExecutor,
  type HooksLaunchExecutorChain,
  type HooksLaunchExecutorIdleReason,
  type HooksLaunchExecutorRepository,
  type HooksLaunchExecutorStepEvent,
} from "./features/launch/hooks-launch-executor.js";

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Decision 0112: the `hooks_launch_executor` lane of the worker process.
 * One tick = preflight (the launch slot — 97, or 56 with the Decision 0150
 * ack —, pinned Factory code hash, executor
 * authorized) + up to `tasksPerTick` leased tasks advanced as far as each
 * goes without waiting on the chain. Infrastructure errors back off; the
 * lease lets another worker resume a task after a crash.
 */
export function createHooksLaunchExecutorLane(options: {
  readonly repository: HooksLaunchExecutorRepository;
  readonly chain: HooksLaunchExecutorChain;
  readonly config: HooksLaunchExecutorConfig;
  readonly executorId: string;
  /** Decision 0150: the configured launch slot (absent = BSC Testnet). */
  readonly launchSlot?: LaunchSlotPolicy;
  readonly now?: () => number;
  /**
   * Decision 0134: the chain guard's hold check; a non-null answer is this
   * tick's result (`CHAIN_GUARD_HOLD`) and nothing else runs.
   */
  readonly chainGuardHold?: ChainGuardHoldCheck;
  readonly onStep?: (event: HooksLaunchExecutorStepEvent) => void;
  readonly onIdle?: (reason: HooksLaunchExecutorIdleReason) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane & { readonly executor: HooksLaunchExecutor } {
  const executor = createHooksLaunchExecutor({
    repository: options.repository,
    chain: options.chain,
    executorId: options.executorId,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    policy: {
      ...(options.launchSlot === undefined
        ? {}
        : { launchSlot: options.launchSlot }),
      // Decision 0132: absent for OfficialTax (unchanged policy object).
      ...(options.config.hookKind === "loopDynamic"
        ? { hookKind: "loopDynamic" as const }
        : {}),
      factoryCodeHash: options.config.factoryCodeHash,
      confirmations: options.config.confirmations,
      maxAttempts: options.config.maxAttempts,
      retryDelaySeconds: options.config.retryDelaySeconds,
      gasLimitCap: BigInt(options.config.gasLimitCap),
      maxGasPriceWei: BigInt(options.config.maxGasPriceGwei) * 10n ** 9n,
      deadlineMarginSeconds: hooksLaunchExecutorDefaults.deadlineMarginSeconds,
      activationMarginSeconds:
        hooksLaunchExecutorDefaults.activationMarginSeconds,
      tasksPerTick: hooksLaunchExecutorDefaults.tasksPerTick,
    },
  });
  let lastIdle: HooksLaunchExecutorIdleReason | null = null;
  async function tick(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const held = await options.chainGuardHold?.();
    if (held !== null && held !== undefined) return { ...held };
    const result = await executor.runOnce(signal);
    if (result.idleReason !== null && result.idleReason !== lastIdle) {
      options.onIdle?.(result.idleReason);
    }
    lastIdle = result.idleReason;
    return { ...result };
  }
  return Object.freeze({
    lane: "hooks_launch_executor",
    executor,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(options.config.pollIntervalMs, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: "hooks_launch_executor",
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
