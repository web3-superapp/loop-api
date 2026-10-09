import { randomUUID } from "node:crypto";

import type { AccountWalletRepository } from "./database/account-wallet-repository.js";
import type { WalletIntentRepository } from "./database/wallet-intent-repository.js";
import {
  createWalletIntentReconciler,
  type WalletIntentReconcileResult,
} from "./features/wallet-intents/intent-reconciliation.js";
import type { LaunchChainId } from "./features/chain/chain-contract.js";
import type { LaunchChainRepository } from "./features/launch/launch-chain-repository.js";
import {
  createLaunchIntentReconciler,
  type LaunchIntentReconcileResult,
} from "./features/launch/launch-intent-reconciliation.js";
import type { BscChainCallClient } from "./integrations/bsc/rpc-client.js";
import type { PrivySwapAdapter } from "./integrations/privy/swap-adapter.js";

/**
 * Standalone-worker lane for wallet-intent reconciliation (Decision 0035).
 * Default off (`WALLET_INTENT_RECONCILE_ENABLED`); shares the Decision 0012
 * process and backoff shape with the other lanes and never writes to chain
 * or Provider. Since Decision 0080 each tick also reconciles reported Launch
 * purchase Intents on the launch chain slot, when the Launch repository is
 * wired.
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
  runOnce(signal?: AbortSignal): Promise<WalletIntentReconcileTickResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface WalletIntentReconcileTickResult extends WalletIntentReconcileResult {
  /** Decision 0080; `null` when no Launch repository is wired. */
  readonly launch: LaunchIntentReconcileResult | null;
}

export interface LaunchIntentReconcileLaneOptions {
  readonly repository: LaunchChainRepository;
  /** The launch slot's call client; `null` keeps the part unavailable. */
  readonly readClient: BscChainCallClient | null;
  readonly chainId: LaunchChainId;
}

export interface CreateWalletIntentReconcileWorkerOptions {
  readonly repository: WalletIntentRepository;
  readonly wallets: AccountWalletRepository;
  readonly readClient: BscChainCallClient;
  /** Launch slot client for intents recorded on it (Decision 0077). */
  readonly launchReadClient?: BscChainCallClient | null;
  readonly swapAdapter: PrivySwapAdapter;
  /** Launch purchase Intents on the launch slot (Decision 0080). */
  readonly launchIntents?: LaunchIntentReconcileLaneOptions | null;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: WalletIntentReconcileBackoff,
  ) => void;
  /** Emitted once per change of the Launch part's availability reason. */
  readonly onLaunchIntentUnavailable?: (reasonCode: string) => void;
  /** Per-Intent read failures and settlements of the Launch part. */
  readonly onLaunchIntentResult?: (result: LaunchIntentReconcileResult) => void;
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
    launchReadClient: options.launchReadClient ?? null,
    swapAdapter: options.swapAdapter,
    createUuid,
  });
  const launchLane = options.launchIntents ?? null;
  const launchReconciler =
    launchLane === null
      ? null
      : createLaunchIntentReconciler({
          repository: launchLane.repository,
          readClient: launchLane.readClient,
          chainId: launchLane.chainId,
        });
  let loopRunning = false;
  let launchUnavailable: string | null = null;

  async function runOnce(
    signal?: AbortSignal,
  ): Promise<WalletIntentReconcileTickResult> {
    const wallet = await reconciler.reconcileOnce(signal);
    const launch =
      launchReconciler === null
        ? null
        : await launchReconciler.reconcileOnce(signal);
    if (launch !== null) {
      const reason = launch.status === "unavailable" ? launch.reasonCode : null;
      if (reason !== null && reason !== launchUnavailable) {
        options.onLaunchIntentUnavailable?.(reason);
      }
      launchUnavailable = reason;
      if (
        launch.status === "available" &&
        (launch.transitions.length > 0 || launch.readFailures.length > 0)
      ) {
        options.onLaunchIntentResult?.(launch);
      }
    }
    return Object.freeze({ ...wallet, launch });
  }

  return Object.freeze({
    workerId,
    lane: WALLET_INTENT_RECONCILE_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The wallet-intent reconcile lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted) {
          try {
            const result = await runOnce(signal);
            consecutiveFailures = 0;
            if (
              result.leasedCount === 0 &&
              (result.launch?.leasedCount ?? 0) === 0
            ) {
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
