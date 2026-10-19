import { randomUUID } from "node:crypto";

import type { TokenLogoPrewarmSummary } from "./features/market/token-logo-prewarm.js";

/**
 * The `token_logo_prewarm` lane (Decision 0161 §2), default on behind
 * `TOKEN_LOGO_PREWARM_ENABLED` in the standalone worker process and
 * constructed only with a database. Each tick is one pre-warm pass
 * (`runTokenLogoPrewarmPass`), then the lane sleeps `intervalMs`
 * (`TOKEN_LOGO_PREWARM_INTERVAL_MS`, default 6 h). A pass that throws
 * (registry / watchlist read failed) is retried with backoff; per-token
 * upstream failures are counted in the summary, never thrown.
 */

export const TOKEN_LOGO_PREWARM_LANE = "token_logo_prewarm" as const;
export const TOKEN_LOGO_PREWARM_RETRY_BASE_DELAY_MS = 5_000;
export const TOKEN_LOGO_PREWARM_RETRY_MAX_DELAY_MS = 15 * 60 * 1_000;

export interface TokenLogoPrewarmInfrastructureBackoff {
  readonly reasonCode: "token_logo_prewarm_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface TokenLogoPrewarmWorker {
  readonly workerId: string;
  readonly lane: typeof TOKEN_LOGO_PREWARM_LANE;
  runOnce(signal?: AbortSignal): Promise<TokenLogoPrewarmSummary>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateTokenLogoPrewarmWorkerOptions {
  readonly pass: (signal?: AbortSignal) => Promise<TokenLogoPrewarmSummary>;
  readonly intervalMs: number;
  readonly createUuid?: () => string;
  readonly onRunResult?: (summary: TokenLogoPrewarmSummary) => void;
  readonly onInfrastructureBackoff?: (
    event: TokenLogoPrewarmInfrastructureBackoff,
  ) => void;
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
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

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function tokenLogoPrewarmRetryDelayMs(
  consecutiveFailureCount: number,
): number {
  return Math.min(
    TOKEN_LOGO_PREWARM_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    TOKEN_LOGO_PREWARM_RETRY_MAX_DELAY_MS,
  );
}

export function createTokenLogoPrewarmWorker(
  options: CreateTokenLogoPrewarmWorkerOptions,
): TokenLogoPrewarmWorker {
  const workerId = (options.createUuid ?? randomUUID)();
  let inFlight: Promise<TokenLogoPrewarmSummary> | null = null;
  let loopRunning = false;

  function runOnce(signal?: AbortSignal): Promise<TokenLogoPrewarmSummary> {
    if (inFlight !== null) {
      return inFlight;
    }
    const tracked = options.pass(signal).finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
  }

  return Object.freeze({
    workerId,
    lane: TOKEN_LOGO_PREWARM_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The token logo prewarm lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted) {
          try {
            const summary = await runOnce(signal);
            consecutiveFailures = 0;
            options.onRunResult?.(summary);
            await waitFor(options.intervalMs, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailures += 1;
            const delay = tokenLogoPrewarmRetryDelayMs(consecutiveFailures);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "token_logo_prewarm_unavailable",
                consecutiveFailureCount: consecutiveFailures,
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
