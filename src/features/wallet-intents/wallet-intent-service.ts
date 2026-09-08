import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { InvalidV2CursorError } from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { InvalidProviderOperationStateError } from "../../database/control-plane-repository.js";
import {
  WalletIntentStateConflictError,
  type WalletIntentRecord,
} from "../../database/wallet-intent-repository.js";
import type { BscTransactionObservation } from "../../integrations/bsc/rpc-client.js";
import { bscChainReference } from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  walletIntentListLimits,
  walletIntentReasonCodes,
  type UnsignedTransaction,
} from "./intent-contract.js";
import {
  enforceCanaryCeiling,
  fromHexQuantity,
  isElapsed,
  projectIntent,
  requireWriteAdmission,
  type WalletIntentResource,
  type WalletIntentRuntime,
} from "./intent-preparation.js";

/**
 * Intent lifecycle shared by every kind (Decision 0035): read, list, cancel,
 * and the device broadcast report for send/approve/revoke.
 */

export interface WalletIntentListResource {
  readonly items: readonly WalletIntentResource[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletIntentService {
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly intentId: string;
  }): Promise<WalletIntentResource>;
  list(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<WalletIntentListResource>;
  cancel(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly intentId: string;
  }): Promise<WalletIntentResource>;
  reportBroadcast(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly intentId: string;
    readonly body: unknown;
  }): Promise<WalletIntentResource>;
}

const listCursorRoute = "walletIntents";
const transactionHashPattern = /^0x[0-9a-f]{64}$/;
const broadcastReconcileDelayMs = 10_000;

/**
 * Compares an observed transaction with the reviewed payload. `from`, `to`,
 * `data`, `value`, and (when reported) `chainId` must all match; a different
 * nonce means the wallet signed something else in between and is also a
 * mismatch.
 */
export function transactionMatchesPayload(
  observed: BscTransactionObservation,
  transaction: UnsignedTransaction,
): boolean {
  return (
    observed.from === transaction.from &&
    observed.to === transaction.to &&
    observed.input === transaction.data &&
    observed.value === fromHexQuantity(transaction.value) &&
    BigInt(observed.nonce) === fromHexQuantity(transaction.nonce) &&
    (observed.chainId === null || observed.chainId === bscChainReference)
  );
}

export function createWalletIntentService(
  runtime: WalletIntentRuntime,
): WalletIntentService {
  async function requireIntent(
    principal: AuthenticatedLoopPrincipal,
    intentId: string,
  ): Promise<WalletIntentRecord> {
    if (!isOpaqueId(intentId)) {
      throw V2ApiError.invalidRequest();
    }
    const record = await runtime.repository.get(principal.userId, intentId);
    if (record === null) {
      throw V2ApiError.notFound();
    }
    return record;
  }

  async function headBlock(): Promise<bigint | null> {
    try {
      return (await runtime.readClient.getHead()).blockNumber;
    } catch {
      return null;
    }
  }

  /** Persists a lazily observed expiry so later transitions see the truth. */
  async function persistExpiry(
    principal: AuthenticatedLoopPrincipal,
    record: WalletIntentRecord,
    requestId: string,
  ): Promise<WalletIntentRecord> {
    try {
      return await runtime.repository.transition({
        ownerUserId: principal.userId,
        intentId: record.intentId,
        expectedVersion: record.recordVersion,
        fromStates: ["prepared", "awaiting_signature"],
        toState: "expired",
        eventType: "intent_expired",
        actorType: "api",
        requestId,
        reasonCode: walletIntentReasonCodes.expired,
      });
    } catch (error) {
      if (error instanceof WalletIntentStateConflictError) {
        return (
          (await runtime.repository.get(principal.userId, record.intentId)) ??
          record
        );
      }
      throw error;
    }
  }

  const service: WalletIntentService = {
    async get({ principal, intentId }) {
      const record = await requireIntent(principal, intentId);
      const head = record.receipt === null ? null : await headBlock();
      return projectIntent(
        record,
        runtime.now(),
        head,
        runtime.readClient.confirmations,
      );
    },

    async list({ principal, cursor, limit }) {
      const codec = runtime.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const filter = "all";
      let pageSize: number = walletIntentListLimits.default;
      let before:
        { readonly createdAt: string; readonly intentId: string } | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: listCursorRoute,
            filter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const createdAt = continuation["createdAt"];
        const intentId = continuation["intentId"];
        const size = continuation["limit"];
        if (
          typeof createdAt !== "string" ||
          !isOpaqueId(intentId) ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { createdAt, intentId };
        pageSize = size;
      } else if (typeof limit === "number") {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > walletIntentListLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      }
      const page = await runtime.repository.list({
        ownerUserId: principal.userId,
        limit: pageSize,
        ...(before === undefined ? {} : { before }),
      });
      const now = runtime.now();
      const last = page.items.at(-1);
      return Object.freeze({
        items: Object.freeze(
          page.items.map((record) =>
            projectIntent(record, now, null, runtime.readClient.confirmations),
          ),
        ),
        nextCursor:
          page.hasMore && last !== undefined
            ? codec.encode({
                ownerId: principal.userId,
                route: listCursorRoute,
                filter,
                continuation: {
                  createdAt: last.createdAt,
                  intentId: last.intentId,
                  limit: pageSize,
                },
              })
            : null,
        contractVersion: v2ContractVersion,
      });
    },

    async cancel({ principal, intentId }) {
      const record = await requireIntent(principal, intentId);
      const requestId = runtime.createUuid();
      if (record.state === "cancelled") {
        return projectIntent(
          record,
          runtime.now(),
          null,
          runtime.readClient.confirmations,
        );
      }
      if (isElapsed(record, runtime.now())) {
        const expired = await persistExpiry(principal, record, requestId);
        return projectIntent(
          expired,
          runtime.now(),
          null,
          runtime.readClient.confirmations,
        );
      }
      let cancelled: WalletIntentRecord;
      try {
        cancelled = await runtime.repository.transition({
          ownerUserId: principal.userId,
          intentId,
          expectedVersion: record.recordVersion,
          fromStates: ["prepared", "awaiting_signature"],
          toState: "cancelled",
          eventType: "intent_cancelled",
          actorType: "api",
          requestId,
          reasonCode: walletIntentReasonCodes.cancelled,
        });
      } catch (error) {
        if (error instanceof WalletIntentStateConflictError) {
          // Anything past awaiting_signature may already be on chain.
          throw V2ApiError.fromCode("DATA_STALE");
        }
        throw error;
      }
      return projectIntent(
        cancelled,
        runtime.now(),
        null,
        runtime.readClient.confirmations,
      );
    },

    async reportBroadcast({ principal, intentId, body }) {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const rawHash = (body as { readonly txHash?: unknown }).txHash;
      if (typeof rawHash !== "string") {
        throw V2ApiError.invalidRequest();
      }
      const txHash = rawHash.toLowerCase();
      if (!transactionHashPattern.test(txHash)) {
        throw V2ApiError.invalidRequest();
      }
      const writes = await requireWriteAdmission(runtime);
      const record = await requireIntent(principal, intentId);
      if (
        record.kind === "swap" ||
        record.canonicalPayload.transaction === null
      ) {
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }
      const requestId = runtime.createUuid();
      // Idempotent on the same hash once the intent has moved on.
      if (
        record.transactionHash === txHash &&
        record.state !== "prepared" &&
        record.state !== "awaiting_signature"
      ) {
        return projectIntent(
          record,
          runtime.now(),
          null,
          runtime.readClient.confirmations,
        );
      }
      if (isElapsed(record, runtime.now())) {
        await persistExpiry(principal, record, requestId);
        throw V2ApiError.fromCode("DATA_STALE");
      }
      if (record.state === "prepared") {
        throw V2ApiError.fromCode("SIMULATION_FAILED");
      }
      if (record.state !== "awaiting_signature") {
        throw V2ApiError.fromCode("DATA_STALE");
      }
      if (record.policyConfigVersion !== writes.configVersion) {
        throw V2ApiError.fromCode("DATA_STALE");
      }
      // The ceiling may have been lowered since the review was shown.
      if (record.canonicalPayload.policy.valueUsd !== null) {
        enforceCanaryCeiling(writes, record.canonicalPayload.policy.valueUsd);
      }

      let observed: BscTransactionObservation | null;
      try {
        observed = await runtime.readClient.getTransaction(txHash);
      } catch {
        throw V2ApiError.capabilityUnavailable();
      }
      if (
        observed !== null &&
        !transactionMatchesPayload(
          observed,
          record.canonicalPayload.transaction,
        )
      ) {
        await runtime.repository.recordEvent({
          ownerUserId: principal.userId,
          intentId,
          eventType: "broadcast_report_rejected",
          actorType: "api",
          requestId,
          reasonCode: walletIntentReasonCodes.txPayloadMismatch,
          details: { reportedHash: txHash },
        });
        throw V2ApiError.fromCode("VALIDATION_FAILED");
      }

      // Journal the device broadcast as the single attempt of this intent's
      // provider operation, then move the intent to submitted. A hash the
      // endpoint has not seen yet is accepted as pending verification: the
      // reconciliation lane re-checks the payload when the transaction
      // appears and fails the intent on a mismatch.
      if (record.providerOperationId !== null) {
        try {
          const operation =
            await runtime.controlPlane.markProviderOperationSubmitting({
              ownerUserId: principal.userId,
              operationId: record.providerOperationId,
              requestId,
              attemptDurationMs: 10_000,
            });
          await runtime.controlPlane.markProviderOperationResult({
            ownerUserId: principal.userId,
            operationId: operation.id,
            requestId,
            transportAttemptId: operation.transportAttemptId as string,
            recordVersion: operation.recordVersion,
            state: "accepted",
          });
        } catch (error) {
          if (!(error instanceof InvalidProviderOperationStateError)) {
            throw error;
          }
          // Already journaled by a concurrent report; the intent transition
          // below is the fence that decides which report wins.
        }
      }
      let submitted: WalletIntentRecord;
      try {
        submitted = await runtime.repository.transition({
          ownerUserId: principal.userId,
          intentId,
          expectedVersion: record.recordVersion,
          fromStates: ["awaiting_signature"],
          toState: "submitted",
          eventType: "broadcast_reported",
          actorType: "api",
          requestId,
          transactionHash: txHash,
          reasonCode:
            observed === null
              ? walletIntentReasonCodes.txPendingVerification
              : null,
          reconcileAfter: new Date(
            runtime.now().getTime() + broadcastReconcileDelayMs,
          ).toISOString(),
          details: { verified: observed !== null },
        });
      } catch (error) {
        if (error instanceof WalletIntentStateConflictError) {
          throw V2ApiError.fromCode("DATA_STALE");
        }
        throw error;
      }
      return projectIntent(
        submitted,
        runtime.now(),
        null,
        runtime.readClient.confirmations,
      );
    },
  };
  return Object.freeze(service);
}
