import { waitFor, type PeriodicLane } from "../../bsc-meme-indexer-worker.js";
import type { ChainGuardHoldCheck } from "../chain-guard/chain-guard-hold.js";
import { launch2DynamicCandleSeconds } from "./launch2-dynamic.js";
import type { Launch2Repository } from "./launch2-ports.js";

/**
 * Decision 0131 (S166): the `launch2_dynamic_poke` lane (default off,
 * `LAUNCH2_DYNAMIC_POKE_ENABLED`). Every `intervalSeconds` it reads each
 * indexed LoopDynamic Hook and, when a round is armed and the 5-minute
 * candle has ended without a swap since (`block.timestamp / 300 >
 * candleId`), calls the permissionless `poke()` once so the candle closes
 * on time (a green close ends the round and makes it claimable). It never
 * pokes an unarmed Hook (nothing to finalise) and sends at most one
 * transaction per Hook per tick, after a passing simulation. The lane
 * writes no database row; the Hook's logs reach the read model through the
 * `launch2_event` lane.
 */

export const launch2DynamicPokeLane = "launch2_dynamic_poke";

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface Launch2DynamicPokeChain {
  readonly pokerAddress: string;
  chainId(): Promise<number>;
  readPokeState(hook: string): Promise<{
    readonly armed: boolean;
    readonly initialized: boolean;
    readonly candleId: bigint;
    readonly blockTimestamp: bigint;
  }>;
  /** eth_call of `poke()` from the poker: null = passes, else the error. */
  simulatePoke(hook: string): Promise<string | null>;
  /** Sends `poke()` and waits for the receipt. */
  sendPoke(hook: string): Promise<{
    readonly transactionHash: string;
    readonly status: "success" | "reverted";
  }>;
}

export interface Launch2DynamicPokeStep {
  readonly instanceId: string;
  readonly hook: string;
  readonly outcome: "poked" | "reverted" | "refused";
  readonly transactionHash: string | null;
  readonly reasonCode: string | null;
}

export function launch2DynamicPokeDue(
  state: {
    readonly armed: boolean;
    readonly initialized: boolean;
    readonly candleId: bigint;
  },
  blockTimestamp: bigint,
): boolean {
  return (
    state.initialized &&
    state.armed &&
    blockTimestamp / launch2DynamicCandleSeconds > state.candleId
  );
}

export function createLaunch2DynamicPokeLane(options: {
  readonly repository: Pick<Launch2Repository, "listLaneInstances">;
  readonly chain: Launch2DynamicPokeChain;
  readonly chainId: string;
  readonly expectedChainReference?: number;
  readonly intervalSeconds: number;
  /**
   * Decision 0134: the chain guard's hold check; a non-null answer is this
   * tick's result (`CHAIN_GUARD_HOLD`) and nothing else runs.
   */
  readonly chainGuardHold?: ChainGuardHoldCheck;
  readonly onStep?: (step: Launch2DynamicPokeStep) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane {
  const expected = options.expectedChainReference ?? 97;

  async function tick(): Promise<Record<string, unknown>> {
    const held = await options.chainGuardHold?.();
    if (held !== null && held !== undefined) return { ...held };
    if ((await options.chain.chainId()) !== expected) {
      return { kind: "unavailable", reasonCode: "LAUNCH2_CHAIN_MISMATCH" };
    }
    const instances = await options.repository.listLaneInstances(
      options.chainId,
    );
    let checked = 0;
    let poked = 0;
    for (const instance of instances) {
      const hook = instance.dynamicHook ?? null;
      if (hook === null || instance.holdReason !== null) continue;
      checked += 1;
      const state = await options.chain.readPokeState(hook);
      if (!launch2DynamicPokeDue(state, state.blockTimestamp)) continue;
      const refusal = await options.chain.simulatePoke(hook);
      if (refusal !== null) {
        options.onStep?.({
          instanceId: instance.instanceId,
          hook,
          outcome: "refused",
          transactionHash: null,
          reasonCode: refusal,
        });
        continue;
      }
      const sent = await options.chain.sendPoke(hook);
      poked += sent.status === "success" ? 1 : 0;
      options.onStep?.({
        instanceId: instance.instanceId,
        hook,
        outcome: sent.status === "success" ? "poked" : "reverted",
        transactionHash: sent.transactionHash,
        reasonCode: null,
      });
    }
    return { kind: "advanced", checked, poked };
  }

  return Object.freeze({
    lane: launch2DynamicPokeLane,
    runOnce: () => tick(),
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick();
          failures = 0;
          await waitFor(options.intervalSeconds * 1000, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: launch2DynamicPokeLane,
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
