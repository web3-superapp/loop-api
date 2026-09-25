import type { LaunchChainId } from "../chain/chain-contract.js";
import {
  isRpcForbiddenError,
  type BscChainCallClient,
} from "../../integrations/bsc/rpc-client.js";
import type {
  LaunchChainRepository,
  LaunchIntentReceipt,
  LaunchIntentRecord,
  LaunchIntentSettlement,
} from "./launch-chain-repository.js";
import {
  launchIntentReasonCodes,
  launchTransactionMatches,
} from "./launch-intent-service.js";

/**
 * Receipt reconciliation of reported Launch purchase Intents (Decision 0080),
 * run by the 0035 `wallet-intent-reconcile` lane on the launch chain slot's
 * read client (0038). Read/finalize only: it never signs, broadcasts, or
 * replays a write.
 *
 * Per leased `submitted` Intent (its hash was reported by the device):
 *
 * - an unverified report is verified against the sealed payload first; a
 *   different transaction under that hash → `failed` /
 *   `LAUNCH_TX_PAYLOAD_MISMATCH`;
 * - a receipt at or past the slot's confirmation depth
 *   (`LAUNCH_BSC_CONFIRMATIONS` on 97, the primary depth on 56) settles it:
 *   `status 0x1` → `confirmed`, `status 0x0` → `reverted` /
 *   `LAUNCH_TX_REVERTED`; a shallower receipt waits;
 * - no receipt once the on-chain `deadline` (= `expiresAt`) is past by the
 *   grace → `expired` / `LAUNCH_TX_NOT_OBSERVED`. A transaction the endpoint
 *   still holds as pending gets the longer pending grace, after which a
 *   late inclusion can only revert (`buy()` checks the deadline).
 *
 * Every write is conditional on the row still being `submitted` with that
 * hash, so the `launch_event` lane (Purchased log → `confirmed`) and this
 * lane never overwrite each other: whichever evidence lands first settles
 * the Intent, the other is a no-op.
 */

export const LAUNCH_INTENT_RECONCILE_BATCH = 10;
export const LAUNCH_INTENT_RECONCILE_LEASE_MS = 15_000;
/** Past the deadline with no trace of the transaction at all. */
export const LAUNCH_INTENT_RECEIPT_GRACE_MS = 5 * 60_000;
/** Past the deadline while the endpoint still reports the transaction pending. */
export const LAUNCH_INTENT_PENDING_GRACE_MS = 60 * 60_000;

export const launchIntentReconcileReasonCodes = Object.freeze({
  rpcNotConfigured: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
  receiptUnavailable: "LAUNCH_RPC_RECEIPT_UNAVAILABLE",
  readFailed: "LAUNCH_INTENT_RECONCILE_READ_FAILED",
} as const);

export interface LaunchIntentReconcileTransition {
  readonly intentId: string;
  readonly toState: LaunchIntentSettlement;
  readonly reasonCode: string | null;
}

export type LaunchIntentReconcileResult =
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly leasedCount: 0;
      readonly transitions: readonly [];
      readonly readFailures: readonly [];
    }
  | {
      readonly status: "available";
      readonly leasedCount: number;
      readonly transitions: readonly LaunchIntentReconcileTransition[];
      /** Intents whose read failed this tick; retried after the lease. */
      readonly readFailures: readonly {
        readonly intentId: string;
        readonly reasonCode: string;
      }[];
    };

export interface CreateLaunchIntentReconcilerOptions {
  readonly repository: LaunchChainRepository;
  /** The launch slot's call client; `null` fails the lane part closed. */
  readonly readClient: BscChainCallClient | null;
  readonly chainId: LaunchChainId;
  readonly now?: () => Date;
}

export interface LaunchIntentReconciler {
  reconcileOnce(signal?: AbortSignal): Promise<LaunchIntentReconcileResult>;
}

type Outcome =
  | {
      readonly kind: "settle";
      readonly toState: LaunchIntentSettlement;
      readonly reasonCode: string | null;
      readonly receipt: LaunchIntentReceipt | null;
    }
  | { readonly kind: "wait" };

const wait: Outcome = Object.freeze({ kind: "wait" });

export function createLaunchIntentReconciler(
  options: CreateLaunchIntentReconcilerOptions,
): LaunchIntentReconciler {
  const now = options.now ?? ((): Date => new Date());

  function pastDeadline(record: LaunchIntentRecord, graceMs: number): boolean {
    return now().getTime() > Date.parse(record.deadline) + graceMs;
  }

  async function decide(
    client: BscChainCallClient,
    record: LaunchIntentRecord,
    hash: string,
  ): Promise<Outcome> {
    let pending = false;
    if (!record.payloadVerified) {
      const observed = await client.getTransaction(hash);
      if (observed === null) {
        return pastDeadline(record, LAUNCH_INTENT_RECEIPT_GRACE_MS)
          ? {
              kind: "settle",
              toState: "expired",
              reasonCode: launchIntentReasonCodes.txNotObserved,
              receipt: null,
            }
          : wait;
      }
      if (!launchTransactionMatches(observed, record.unsignedTransaction)) {
        return {
          kind: "settle",
          toState: "failed",
          reasonCode: launchIntentReasonCodes.txPayloadMismatch,
          receipt: null,
        };
      }
      await options.repository.markIntentPayloadVerified({
        intentId: record.intentId,
        transactionHash: hash,
      });
      pending = observed.blockNumber === null;
    }
    const receipt = await client.getTransactionReceipt(hash);
    if (receipt === null) {
      if (!pastDeadline(record, LAUNCH_INTENT_RECEIPT_GRACE_MS)) {
        return wait;
      }
      if (!pending && record.payloadVerified) {
        // Verified at report time: ask once more whether it is still pending.
        const observed = await client.getTransaction(hash);
        pending = observed !== null && observed.blockNumber === null;
      }
      if (pending && !pastDeadline(record, LAUNCH_INTENT_PENDING_GRACE_MS)) {
        return wait;
      }
      return {
        kind: "settle",
        toState: "expired",
        reasonCode: launchIntentReasonCodes.txNotObserved,
        receipt: null,
      };
    }
    const head = await client.getHead();
    const depth = head.blockNumber - receipt.blockNumber + 1n;
    if (depth < BigInt(client.confirmations)) {
      return wait;
    }
    const fact: LaunchIntentReceipt = Object.freeze({
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(10),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(10),
      confirmations: Number(depth),
      observedAt: now().toISOString(),
    });
    return receipt.status === "success"
      ? {
          kind: "settle",
          toState: "confirmed",
          reasonCode: null,
          receipt: fact,
        }
      : {
          kind: "settle",
          toState: "reverted",
          reasonCode: launchIntentReasonCodes.txReverted,
          receipt: fact,
        };
  }

  return Object.freeze({
    async reconcileOnce(
      signal: AbortSignal = new AbortController().signal,
    ): Promise<LaunchIntentReconcileResult> {
      const client = options.readClient;
      if (client === null || client.chainId !== options.chainId) {
        // Fail closed: without the launch slot's own client nothing is read
        // and nothing moves; reported Intents stay `submitted`.
        return Object.freeze({
          status: "unavailable",
          reasonCode: launchIntentReconcileReasonCodes.rpcNotConfigured,
          leasedCount: 0,
          transitions: [] as const,
          readFailures: [] as const,
        });
      }
      const leased = await options.repository.leaseReconcilableIntents({
        chainId: options.chainId,
        limit: LAUNCH_INTENT_RECONCILE_BATCH,
        leaseMs: LAUNCH_INTENT_RECONCILE_LEASE_MS,
      });
      const transitions: LaunchIntentReconcileTransition[] = [];
      const readFailures: { intentId: string; reasonCode: string }[] = [];
      for (const record of leased) {
        if (signal.aborted) {
          break;
        }
        const hash = record.transactionHash;
        if (hash === null) {
          continue;
        }
        let outcome: Outcome;
        try {
          outcome = await decide(client, record, hash);
        } catch (error) {
          // One unreadable Intent never stops the batch; the lease already
          // moved reconcile_after forward.
          readFailures.push({
            intentId: record.intentId,
            reasonCode: isRpcForbiddenError(error)
              ? launchIntentReconcileReasonCodes.receiptUnavailable
              : launchIntentReconcileReasonCodes.readFailed,
          });
          continue;
        }
        if (outcome.kind === "wait") {
          continue;
        }
        const settled = await options.repository.settleIntent({
          intentId: record.intentId,
          transactionHash: hash,
          toState: outcome.toState,
          reasonCode: outcome.reasonCode,
          // No public read surface returns a revert reason for a mined
          // transaction (no debug_trace; an eth_call replay would run on a
          // different state). Decision 0080 keeps it null until one does.
          revertReason: null,
          receipt: outcome.receipt,
        });
        if (settled !== null) {
          transitions.push({
            intentId: settled.intentId,
            toState: outcome.toState,
            reasonCode: outcome.reasonCode,
          });
        }
      }
      return Object.freeze({
        status: "available",
        leasedCount: leased.length,
        transitions: Object.freeze(transitions),
        readFailures: Object.freeze(readFailures),
      });
    },
  });
}
