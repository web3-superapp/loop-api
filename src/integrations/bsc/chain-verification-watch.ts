import type { BscReadClient, ChainVerificationState } from "./rpc-client.js";

/**
 * Keeps chain-ID verification alive after a failed probe (preflight
 * 2026-09-16, item 3 / 03 §4.5d).
 *
 * The read client owns the verification state and only caches the two
 * terminal outcomes (`verified`, `mismatched`); `unreachable` and `unknown`
 * are re-probed on the next chain read. Nobody makes that read after a cold
 * start, though: the client's capability snapshot sees `bscRead` closed and,
 * by its own capability gate, never issues a chain read again. The closed
 * state then sustains itself until the API is restarted.
 *
 * Two mechanisms remove that loop, both on the server:
 *
 * 1. `verifyAtStartup()` retries a failed startup probe with exponential
 *    backoff until the state is terminal or the budget is spent.
 * 2. `current()` — the capability projection's read — schedules one
 *    throttled background re-probe whenever it observes a non-terminal state.
 *    The response itself is never blocked and never claims more than the
 *    client currently knows.
 *
 * `mismatched` is a configuration error, not jitter, and is never retried.
 */

export interface ChainVerificationRetryPolicy {
  /** Total probes including the first one. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** No retry is scheduled that would start after this budget. */
  readonly maxTotalMs: number;
}

export const defaultChainVerificationRetryPolicy: ChainVerificationRetryPolicy =
  Object.freeze({
    maxAttempts: 5,
    initialDelayMs: 2_000,
    maxDelayMs: 16_000,
    maxTotalMs: 60_000,
  });

/** At most one projection-triggered re-probe per window. */
export const defaultChainReprobeThrottleMs = 30_000;

export interface ChainVerificationWatchLogger {
  warn(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
}

export interface ChainVerificationWatch {
  /**
   * The client's current verification state, exactly as it knows it. When
   * the state is `unreachable` or `unknown`, one background re-probe is
   * scheduled unless another was scheduled inside the throttle window.
   */
  current(): ChainVerificationState;
  /**
   * Probe now and, while the outcome is non-terminal, keep probing with
   * exponential backoff within the retry policy. Resolves with the last
   * observed state; never rejects.
   */
  verifyAtStartup(): Promise<ChainVerificationState>;
  /** Cancels a pending retry delay; used on application close. */
  stop(): void;
}

export interface CreateChainVerificationWatchInput {
  readonly client: Pick<
    BscReadClient,
    "chainId" | "endpointRefs" | "verifyChain" | "currentVerification"
  >;
  readonly chainSlot: "primary" | "launch";
  readonly logger: ChainVerificationWatchLogger | null;
  readonly retry?: ChainVerificationRetryPolicy;
  readonly reprobeThrottleMs?: number;
  readonly monotonicMs?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function isTerminal(state: ChainVerificationState): boolean {
  return state === "verified" || state === "mismatched";
}

/** A timer that never keeps the process alive and stops with the signal. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createChainVerificationWatch(
  input: CreateChainVerificationWatchInput,
): ChainVerificationWatch {
  const retry = input.retry ?? defaultChainVerificationRetryPolicy;
  const throttleMs = input.reprobeThrottleMs ?? defaultChainReprobeThrottleMs;
  const monotonicMs =
    input.monotonicMs ??
    ((): number => Number(process.hrtime.bigint() / 1_000_000n));
  const sleep = input.sleep ?? defaultSleep;
  const controller = new AbortController();
  const configured = input.client.endpointRefs.length > 0;
  let lastReprobeAt: number | null = null;

  const logContext = (): Record<string, unknown> => ({
    chainId: input.client.chainId,
    chainSlot: input.chainSlot,
  });

  async function probe(): Promise<ChainVerificationState> {
    try {
      return await input.client.verifyChain();
    } catch {
      // The client records its own failure state; report what it holds.
      return input.client.currentVerification();
    }
  }

  const watch: ChainVerificationWatch = {
    current() {
      const state = input.client.currentVerification();
      if (!configured || isTerminal(state) || controller.signal.aborted) {
        return state;
      }
      const now = monotonicMs();
      if (lastReprobeAt !== null && now - lastReprobeAt < throttleMs) {
        return state;
      }
      lastReprobeAt = now;
      void probe().then((next) => {
        if (next === "verified") {
          input.logger?.info(
            { ...logContext(), chainVerification: next, trigger: "projection" },
            "BSC chain verification recovered on a projection-triggered re-probe",
          );
        }
      });
      return state;
    },

    async verifyAtStartup() {
      const startedAt = monotonicMs();
      let delayMs = retry.initialDelayMs;
      let state: ChainVerificationState = "unknown";
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        if (controller.signal.aborted) {
          return state;
        }
        state = await probe();
        if (state === "verified") {
          if (attempt > 1) {
            input.logger?.info(
              { ...logContext(), chainVerification: state, attempt },
              "BSC chain verification recovered on a startup retry",
            );
          }
          return state;
        }
        if (state === "mismatched") {
          input.logger?.warn(
            { ...logContext(), chainVerification: state, attempt },
            "BSC chain verification did not confirm the configured chain; not retrying a chain-ID mismatch",
          );
          return state;
        }
        const elapsedMs = monotonicMs() - startedAt;
        const exhausted =
          attempt >= retry.maxAttempts ||
          elapsedMs + delayMs > retry.maxTotalMs;
        input.logger?.warn(
          {
            ...logContext(),
            chainVerification: state,
            attempt,
            maxAttempts: retry.maxAttempts,
            nextRetryInMs: exhausted ? null : delayMs,
          },
          exhausted
            ? "BSC chain verification did not confirm the configured chain; startup retries exhausted, the next chain read or capability projection re-probes"
            : "BSC chain verification did not confirm the configured chain; retrying",
        );
        if (exhausted) {
          return state;
        }
        await sleep(delayMs, controller.signal);
        delayMs = Math.min(delayMs * 2, retry.maxDelayMs);
      }
      return state;
    },

    stop() {
      controller.abort();
    },
  };
  return Object.freeze(watch);
}
