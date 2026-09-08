import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import {
  WalletIntentStateConflictError,
  type IntentReceipt,
  type WalletIntentRecord,
  type WalletIntentRepository,
} from "../../database/wallet-intent-repository.js";
import {
  isRpcForbiddenError,
  type BscChainCallClient,
} from "../../integrations/bsc/rpc-client.js";
import {
  PrivySwapProviderError,
  type PrivySwapAdapter,
} from "../../integrations/privy/swap-adapter.js";
import { walletIntentReasonCodes } from "./intent-contract.js";
import { transactionMatchesPayload } from "./wallet-intent-service.js";

/**
 * `wallet-intent-reconcile` lane (Decision 0035). Read/finalize only: it
 * expires elapsed intents, reads receipts for device-broadcast intents, and
 * polls Privy wallet-action status for Swap intents. It never signs,
 * broadcasts, or replays a write. An intent whose identifiers are exhausted
 * (no hash appears, no action ID exists) becomes `unknown` and stays there
 * for an operator.
 */

export const WALLET_INTENT_RECONCILE_LEASE_MS = 15_000;
export const WALLET_INTENT_RECONCILE_BATCH = 10;
/** Roughly one hour of 15 s polls before a never-seen hash is given up on. */
export const WALLET_INTENT_RECONCILE_MAX_ATTEMPTS = 240;
/** Once locked as unknown, an intent is re-polled hourly, not every tick. */
export const WALLET_INTENT_UNKNOWN_HOLD_MS = 3_600_000;

export interface WalletIntentReconcileResult {
  readonly expiredCount: number;
  readonly leasedCount: number;
  readonly transitions: readonly {
    readonly intentId: string;
    readonly toState: string;
    readonly reasonCode: string | null;
  }[];
}

export interface CreateWalletIntentReconcilerOptions {
  readonly repository: WalletIntentRepository;
  readonly wallets: AccountWalletRepository;
  readonly readClient: BscChainCallClient;
  readonly swapAdapter: PrivySwapAdapter;
  readonly createUuid: () => string;
  readonly now?: () => Date;
}

export interface WalletIntentReconciler {
  reconcileOnce(signal?: AbortSignal): Promise<WalletIntentReconcileResult>;
}

export function createWalletIntentReconciler(
  options: CreateWalletIntentReconcilerOptions,
): WalletIntentReconciler {
  const now = options.now ?? ((): Date => new Date());

  async function transition(
    record: WalletIntentRecord,
    input: {
      readonly toState:
        "confirmed" | "reverted" | "failed" | "unknown" | "submitted";
      readonly eventType: string;
      readonly reasonCode: string | null;
      readonly transactionHash?: string | null;
      readonly receipt?: IntentReceipt | null;
      readonly reconcileAfter?: string | null;
      readonly payloadVerified?: boolean;
    },
  ): Promise<WalletIntentRecord | null> {
    try {
      return await options.repository.transition({
        ownerUserId: record.ownerUserId,
        intentId: record.intentId,
        expectedVersion: record.recordVersion,
        fromStates: ["submitted", "unknown"],
        toState: input.toState,
        eventType: input.eventType,
        actorType: "worker",
        requestId: options.createUuid(),
        reasonCode: input.reasonCode,
        ...(input.transactionHash === undefined
          ? {}
          : { transactionHash: input.transactionHash }),
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        ...(input.reconcileAfter === undefined
          ? {}
          : { reconcileAfter: input.reconcileAfter }),
        ...(input.payloadVerified === undefined
          ? {}
          : { payloadVerified: input.payloadVerified }),
      });
    } catch (error) {
      if (error instanceof WalletIntentStateConflictError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A hash that never appears within the poll budget locks the intent as
   * `unknown` for an operator. An already-unknown intent keeps being polled
   * at a slow cadence but never transitions again on the same evidence.
   */
  async function budgetExhausted(
    record: WalletIntentRecord,
  ): Promise<WalletIntentRecord | null> {
    if (record.reconcileAttemptCount < WALLET_INTENT_RECONCILE_MAX_ATTEMPTS) {
      return null;
    }
    const holdUntil = new Date(
      now().getTime() + WALLET_INTENT_UNKNOWN_HOLD_MS,
    ).toISOString();
    if (record.state === "unknown") {
      try {
        await options.repository.transition({
          ownerUserId: record.ownerUserId,
          intentId: record.intentId,
          expectedVersion: record.recordVersion,
          fromStates: ["unknown"],
          toState: "unknown",
          eventType: "reconciliation_held",
          actorType: "worker",
          requestId: options.createUuid(),
          reconcileAfter: holdUntil,
        });
      } catch (error) {
        if (!(error instanceof WalletIntentStateConflictError)) {
          throw error;
        }
      }
      return null;
    }
    return transition(record, {
      toState: "unknown",
      eventType: "reconciliation_budget_exhausted",
      reasonCode:
        record.kind === "swap"
          ? walletIntentReasonCodes.providerAmbiguous
          : walletIntentReasonCodes.txNotObserved,
      reconcileAfter: holdUntil,
    });
  }

  async function reconcileDeviceBroadcast(
    record: WalletIntentRecord,
  ): Promise<WalletIntentRecord | null> {
    const transaction = record.canonicalPayload.transaction;
    const hash = record.transactionHash;
    if (hash === null || transaction === null) {
      return transition(record, {
        toState: "unknown",
        eventType: "reconciliation_no_identifier",
        reasonCode: walletIntentReasonCodes.txNotObserved,
        reconcileAfter: null,
      });
    }
    // The payload is verified unconditionally before a receipt can finalise
    // the intent, even when the report already compared it: the flag is the
    // only evidence the lane trusts.
    let payloadVerified = record.payloadVerified;
    if (!payloadVerified) {
      const observed = await options.readClient.getTransaction(hash);
      if (observed === null) {
        return budgetExhausted(record);
      }
      if (!transactionMatchesPayload(observed, transaction)) {
        return transition(record, {
          toState: "failed",
          eventType: "broadcast_payload_mismatch",
          reasonCode: walletIntentReasonCodes.txPayloadMismatch,
          reconcileAfter: null,
        });
      }
      payloadVerified = true;
    }
    let receipt;
    try {
      receipt = await options.readClient.getTransactionReceipt(hash);
    } catch (error) {
      if (isRpcForbiddenError(error)) {
        // The endpoint refuses eth_getTransactionReceipt (publicnode 403);
        // that is an operator problem, not an intent outcome.
        await options.repository.recordEvent({
          ownerUserId: record.ownerUserId,
          intentId: record.intentId,
          eventType: "reconciliation_read_failed",
          actorType: "worker",
          requestId: options.createUuid(),
          reasonCode: walletIntentReasonCodes.rpcReceiptUnavailable,
        });
        return null;
      }
      throw error;
    }
    if (receipt === null) {
      if (record.receipt !== null) {
        // A receipt that was stored and is now gone means the block was
        // reorged out; the intent is back to waiting for inclusion.
        return transition(record, {
          toState: "submitted",
          eventType: "receipt_lost",
          reasonCode: null,
          receipt: null,
          payloadVerified,
        });
      }
      if (
        record.reconcileAttemptCount >= WALLET_INTENT_RECONCILE_MAX_ATTEMPTS
      ) {
        return budgetExhausted(record);
      }
      if (
        !record.payloadVerified ||
        record.reasonCode === walletIntentReasonCodes.txPendingVerification
      ) {
        // Verified now; clear the pending marker while still waiting for a receipt.
        return transition(record, {
          toState: "submitted",
          eventType: "broadcast_payload_verified",
          reasonCode: null,
          payloadVerified,
        });
      }
      return null;
    }
    const head = await options.readClient.getHead();
    const confirmations = Number(head.blockNumber - receipt.blockNumber + 1n);
    const receiptFact: IntentReceipt = Object.freeze({
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(10),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(10),
      observedAt: now().toISOString(),
    });
    if (confirmations < options.readClient.confirmations) {
      return transition(record, {
        toState: "submitted",
        eventType: "receipt_observed",
        reasonCode: null,
        receipt: receiptFact,
        payloadVerified,
      });
    }
    return transition(record, {
      toState: receipt.status === "success" ? "confirmed" : "reverted",
      eventType: "receipt_finalized",
      reasonCode:
        receipt.status === "success"
          ? null
          : walletIntentReasonCodes.txReverted,
      receipt: receiptFact,
      reconcileAfter: null,
      payloadVerified,
    });
  }

  async function reconcileSwap(
    record: WalletIntentRecord,
    signal: AbortSignal,
  ): Promise<WalletIntentRecord | null> {
    const actionId = record.providerActionId;
    if (actionId === null) {
      if (record.state === "unknown") {
        return null;
      }
      // The attempt started but no action ID was ever recorded (crash or
      // ambiguous transport). Lock it for an operator; nothing is replayed.
      return transition(record, {
        toState: "unknown",
        eventType: "reconciliation_no_identifier",
        reasonCode: walletIntentReasonCodes.providerAmbiguous,
        reconcileAfter: null,
      });
    }
    const wallet = await options.wallets.get(
      record.ownerUserId,
      record.walletId,
    );
    if (wallet === null || wallet.providerWalletId === null) {
      return transition(record, {
        toState: "unknown",
        eventType: "reconciliation_wallet_missing",
        reasonCode: walletIntentReasonCodes.walletNotSignable,
        reconcileAfter: null,
      });
    }
    let action;
    try {
      action = await options.swapAdapter.getAction({
        providerWalletId: wallet.providerWalletId,
        actionId,
        signal,
      });
    } catch (error) {
      if (error instanceof PrivySwapProviderError) {
        await options.repository.recordEvent({
          ownerUserId: record.ownerUserId,
          intentId: record.intentId,
          eventType: "reconciliation_read_failed",
          actorType: "worker",
          requestId: options.createUuid(),
          reasonCode: error.reasonCode,
        });
        return budgetExhausted(record);
      }
      throw error;
    }
    const hash =
      action.steps.find((step) => step.transactionHash !== null)
        ?.transactionHash ?? record.transactionHash;
    switch (action.status) {
      case "succeeded": {
        return transition(record, {
          toState: "confirmed",
          eventType: "provider_action_succeeded",
          reasonCode: null,
          transactionHash: hash,
          reconcileAfter: null,
        });
      }
      case "rejected": {
        return transition(record, {
          toState: "failed",
          eventType: "provider_action_rejected",
          reasonCode:
            action.failureReasonCode ?? walletIntentReasonCodes.privyRejected,
          transactionHash: hash,
          reconcileAfter: null,
        });
      }
      case "failed": {
        const reverted = action.steps.some(
          (step) => step.status === "reverted",
        );
        return transition(record, {
          toState: reverted ? "reverted" : "failed",
          eventType: "provider_action_failed",
          reasonCode: reverted
            ? walletIntentReasonCodes.txReverted
            : (action.failureReasonCode ?? walletIntentReasonCodes.privyFailed),
          transactionHash: hash,
          reconcileAfter: null,
        });
      }
      case "pending": {
        if (hash !== null && hash !== record.transactionHash) {
          return transition(record, {
            toState: "submitted",
            eventType: "provider_action_pending",
            reasonCode: null,
            transactionHash: hash,
          });
        }
        return budgetExhausted(record);
      }
    }
  }

  return Object.freeze({
    async reconcileOnce(
      signal: AbortSignal = new AbortController().signal,
    ): Promise<WalletIntentReconcileResult> {
      const expiredCount = await options.repository.expireElapsed({
        requestId: options.createUuid(),
        limit: 100,
      });
      const leased = await options.repository.leaseReconcilable({
        limit: WALLET_INTENT_RECONCILE_BATCH,
        leaseMs: WALLET_INTENT_RECONCILE_LEASE_MS,
      });
      const transitions: {
        readonly intentId: string;
        readonly toState: string;
        readonly reasonCode: string | null;
      }[] = [];
      for (const record of leased) {
        if (signal.aborted) {
          break;
        }
        let changed: WalletIntentRecord | null;
        try {
          changed =
            record.kind === "swap"
              ? await reconcileSwap(record, signal)
              : await reconcileDeviceBroadcast(record);
        } catch (error) {
          // One unreadable intent never stops the batch. The lease already
          // moved reconcile_after forward, so it is retried on a later tick.
          await options.repository.recordEvent({
            ownerUserId: record.ownerUserId,
            intentId: record.intentId,
            eventType: "reconciliation_read_failed",
            actorType: "worker",
            requestId: options.createUuid(),
            reasonCode: isRpcForbiddenError(error)
              ? walletIntentReasonCodes.rpcReceiptUnavailable
              : walletIntentReasonCodes.reconciliationReadFailed,
          });
          continue;
        }
        if (changed !== null) {
          transitions.push({
            intentId: changed.intentId,
            toState: changed.state,
            reasonCode: changed.reasonCode,
          });
        }
      }
      return Object.freeze({
        expiredCount,
        leasedCount: leased.length,
        transitions: Object.freeze(transitions),
      });
    },
  });
}
