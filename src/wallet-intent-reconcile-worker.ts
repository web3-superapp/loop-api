import { randomUUID } from "node:crypto";

import type { AccountWalletRepository } from "./database/account-wallet-repository.js";
import type { WalletIntentRepository } from "./database/wallet-intent-repository.js";
import {
  createWalletIntentReconciler,
  type WalletIntentReconcileResult,
} from "./features/wallet-intents/intent-reconciliation.js";
import type { BscChainCallClient } from "./integrations/bsc/rpc-client.js";
import type { PrivySwapAdapter } from "./integrations/privy/swap-adapter.js";

/**
 * Standalone-worker lane for wallet-intent reconciliation (Decision 0035).
 * Default off (`WALLET_INTENT_RECONCILE_ENABLED`); shares the Decision 0012
 * process and backoff shape with the other lanes and never writes to chain
 * or Provider.
 */

export const WALLET_INTENT_RECONCILE_LANE = "wallet_intent_reconcile" as const;
export const WALLET_INTENT_RECONCILE_IDLE_DELAY_MS = 5_000;
const retryBaseDelayMs = 1_000;
const retryMaxDelayMs = 30_000;

export interface WalletIntentReconcileBackoff {
  readonly reasonCode: "wallet_intent_reconcile_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface WalletIntentReconcileWorker {
  readonly workerId: string;
  readonly lane: typeof WALLET_INTENT_RECONCILE_LANE;
  runOnce(signal?: AbortSignal): Promise<WalletIntentReconcileResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateWalletIntentReconcileWorkerOptions {
  readonly repository: WalletIntentRepository;
  readonly wallets: AccountWalletRepository;
  readonly readClient: BscChainCallClient;
  readonly swapAdapter: PrivySwapAdapter;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: WalletIntentReconcileBackoff,
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

export function createWalletIntentReconcileWorker(
  options: CreateWalletIntentReconcileWorkerOptions,
): WalletIntentReconcileWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  const reconciler = createWalletIntentReconciler({
    repository: options.repository,
    wallets: options.wallets,
    readClient: options.readClient,
    swapAdapter: options.swapAdapter,
    createUuid,
  });
  let loopRunning = false;

  return Object.freeze({
    workerId,
    lane: WALLET_INTENT_RECONCILE_LANE,
    runOnce: (signal?: AbortSignal) => reconciler.reconcileOnce(signal),
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The wallet-intent reconcile lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted) {
          try {
            const result = await reconciler.reconcileOnce(signal);
            consecutiveFailures = 0;
            if (result.leasedCount === 0) {
              await waitFor(WALLET_INTENT_RECONCILE_IDLE_DELAY_MS, signal);
            }
          } catch {
            consecutiveFailures += 1;
            const delay = Math.min(
              retryBaseDelayMs * 2 ** (consecutiveFailures - 1),
              retryMaxDelayMs,
            );
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "wallet_intent_reconcile_unavailable",
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
