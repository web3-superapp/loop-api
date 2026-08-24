import { randomUUID } from "node:crypto";

import {
  StaleProviderOperationLeaseError,
  type ControlPlaneRepository,
  type ProviderOperation,
} from "../../database/control-plane-repository.js";
import {
  parseAuthoritativeReadResult,
  type AuthoritativeReaderRegistry,
  type AuthoritativeReadInput,
  type AuthoritativeReadResult,
  type AuthoritativeResultReader,
} from "./authoritative-reader.js";

export const RECONCILIATION_READ_DEADLINE_MS = 5_000;
export const RECONCILIATION_LEASE_DURATION_MS = 30_000;
export const RECONCILIATION_MAX_READ_ATTEMPTS = 8;
export const RECONCILIATION_RETRY_BASE_DELAY_MS = 5_000;
export const RECONCILIATION_RETRY_MAX_DELAY_MS = 300_000;

export type ReconciliationControlPlane = Pick<
  ControlPlaneRepository,
  | "quarantineExpiredSubmissions"
  | "leaseProviderOperationsForReconciliation"
  | "completeProviderOperationReconciliation"
  | "rescheduleProviderOperationReconciliation"
  | "holdProviderOperationForOperator"
>;

const reconciliationReasons = Object.freeze({
  attemptBudgetExhausted: "reconciliation_attempt_budget_exhausted",
  authoritativeReadFailed: "authoritative_read_failed",
  authoritativeReadPending: "authoritative_result_pending",
  authoritativeReadTimedOut: "authoritative_read_timeout",
  invalidAuthoritativeResult: "invalid_authoritative_read_result",
  unknownDomain: "unknown_reconciliation_domain",
});

export type ReconciliationRunResult =
  | Readonly<{ kind: "aborted"; operationId?: string }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "resolved"; operationId: string }>
  | Readonly<{
      kind: "rescheduled";
      operationId: string;
      retryDelayMs: number;
    }>
  | Readonly<{
      kind: "operator_required";
      operationId: string;
      reasonCode: string;
    }>
  | Readonly<{ kind: "stale_lease_discarded"; operationId: string }>;

export interface ReconciliationService {
  readonly workerId: string;
  runOnce(signal?: AbortSignal): Promise<ReconciliationRunResult>;
}

export interface CreateReconciliationServiceOptions {
  readonly controlPlane: ReconciliationControlPlane;
  readonly readers: AuthoritativeReaderRegistry;
  readonly workerId?: string;
  readonly createUuid?: () => string;
}

class AuthoritativeReadDeadlineError extends Error {
  constructor() {
    super("The authoritative read deadline elapsed");
    this.name = "AuthoritativeReadDeadlineError";
  }
}

class ReconciliationRunAbortedError extends Error {
  constructor() {
    super("The reconciliation run was aborted");
    this.name = "ReconciliationRunAbortedError";
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function retryDelayMs(
  reconciliationAttemptCount: number,
  requestedRetryAfterMs?: number,
): number {
  const exponent = Math.max(0, reconciliationAttemptCount - 1);
  const backoff = Math.min(
    RECONCILIATION_RETRY_BASE_DELAY_MS * 2 ** exponent,
    RECONCILIATION_RETRY_MAX_DELAY_MS,
  );
  const requested =
    requestedRetryAfterMs === undefined
      ? 0
      : Math.min(
          Math.max(requestedRetryAfterMs, RECONCILIATION_RETRY_BASE_DELAY_MS),
          RECONCILIATION_RETRY_MAX_DELAY_MS,
        );
  return Math.max(backoff, requested);
}

async function readWithDeadline(
  reader: AuthoritativeResultReader,
  input: Omit<AuthoritativeReadInput, "signal">,
  externalSignal?: AbortSignal,
): Promise<AuthoritativeReadResult | null> {
  if (isAborted(externalSignal)) {
    throw new ReconciliationRunAbortedError();
  }

  const deadlineController = new AbortController();
  const signal =
    externalSignal === undefined
      ? deadlineController.signal
      : AbortSignal.any([externalSignal, deadlineController.signal]);
  let onAbort: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      reject(
        externalSignal?.aborted === true
          ? new ReconciliationRunAbortedError()
          : new AuthoritativeReadDeadlineError(),
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new AuthoritativeReadDeadlineError());
  }, RECONCILIATION_READ_DEADLINE_MS);

  try {
    const rawResult = await Promise.race([
      Promise.resolve().then(() =>
        reader({
          ...input,
          signal,
        }),
      ),
      aborted,
    ]);
    return parseAuthoritativeReadResult(rawResult);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    clearTimeout(deadlineTimer);
  }
}

function transitionInput(
  operation: ProviderOperation,
  workerId: string,
  requestId: string,
) {
  return {
    ownerUserId: operation.ownerUserId,
    operationId: operation.id,
    workerId,
    fenceToken: operation.fenceToken,
    recordVersion: operation.recordVersion,
    requestId,
  } as const;
}

export function createReconciliationService(
  options: CreateReconciliationServiceOptions,
): ReconciliationService {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = options.workerId ?? createUuid();

  async function discardStaleLease(
    operationId: string,
    transition: () => Promise<unknown>,
    completed: ReconciliationRunResult,
  ): Promise<ReconciliationRunResult> {
    try {
      await transition();
      return completed;
    } catch (error) {
      if (error instanceof StaleProviderOperationLeaseError) {
        return Object.freeze({
          kind: "stale_lease_discarded",
          operationId,
        });
      }

      throw error;
    }
  }

  async function holdForOperator(
    operation: ProviderOperation,
    reasonCode: string,
  ): Promise<ReconciliationRunResult> {
    return discardStaleLease(
      operation.id,
      () =>
        options.controlPlane.holdProviderOperationForOperator({
          ...transitionInput(operation, workerId, createUuid()),
          reasonCode,
        }),
      Object.freeze({
        kind: "operator_required",
        operationId: operation.id,
        reasonCode,
      }),
    );
  }

  async function reschedule(
    operation: ProviderOperation,
    reasonCode: string,
    requestedRetryAfterMs?: number,
  ): Promise<ReconciliationRunResult> {
    if (
      operation.reconciliationAttemptCount >= RECONCILIATION_MAX_READ_ATTEMPTS
    ) {
      return holdForOperator(
        operation,
        reconciliationReasons.attemptBudgetExhausted,
      );
    }

    const delay = retryDelayMs(
      operation.reconciliationAttemptCount,
      requestedRetryAfterMs,
    );
    return discardStaleLease(
      operation.id,
      () =>
        options.controlPlane.rescheduleProviderOperationReconciliation({
          ...transitionInput(operation, workerId, createUuid()),
          reasonCode,
          retryDelayMs: delay,
        }),
      Object.freeze({
        kind: "rescheduled",
        operationId: operation.id,
        retryDelayMs: delay,
      }),
    );
  }

  async function applyReadResult(
    operation: ProviderOperation,
    result: AuthoritativeReadResult | null,
  ): Promise<ReconciliationRunResult> {
    if (result === null) {
      return holdForOperator(
        operation,
        reconciliationReasons.invalidAuthoritativeResult,
      );
    }

    if (result.kind === "operator_required") {
      return holdForOperator(operation, result.reasonCode);
    }

    if (result.kind === "pending") {
      return reschedule(
        operation,
        result.reasonCode ?? reconciliationReasons.authoritativeReadPending,
        result.retryAfterMs,
      );
    }

    if (result.kind === "retry") {
      return reschedule(operation, result.reasonCode, result.retryAfterMs);
    }

    return discardStaleLease(
      operation.id,
      () =>
        options.controlPlane.completeProviderOperationReconciliation({
          ...transitionInput(operation, workerId, createUuid()),
          state: result.state,
          ...(result.reasonCode === undefined
            ? {}
            : { reasonCode: result.reasonCode }),
        }),
      Object.freeze({ kind: "resolved", operationId: operation.id }),
    );
  }

  return Object.freeze({
    workerId,
    async runOnce(signal?: AbortSignal): Promise<ReconciliationRunResult> {
      if (isAborted(signal)) {
        return Object.freeze({ kind: "aborted" });
      }

      await options.controlPlane.quarantineExpiredSubmissions({
        requestId: createUuid(),
        limit: 1,
      });

      if (isAborted(signal)) {
        return Object.freeze({ kind: "aborted" });
      }

      const operations =
        await options.controlPlane.leaseProviderOperationsForReconciliation({
          workerId,
          requestId: createUuid(),
          limit: 1,
          leaseDurationMs: RECONCILIATION_LEASE_DURATION_MS,
        });
      const operation = operations[0];

      if (isAborted(signal)) {
        // A claimed operation is intentionally left leased. The database lease
        // expiry makes it eligible for a later read without recording shutdown
        // as a provider failure or consuming a hot retry.
        return Object.freeze({
          kind: "aborted",
          ...(operation === undefined ? {} : { operationId: operation.id }),
        });
      }

      if (operation === undefined) {
        return Object.freeze({ kind: "idle" });
      }

      const reader = options.readers.find(operation.domain);

      if (reader === undefined) {
        return holdForOperator(operation, reconciliationReasons.unknownDomain);
      }

      if (
        operation.reconciliationAttemptCount > RECONCILIATION_MAX_READ_ATTEMPTS
      ) {
        return holdForOperator(
          operation,
          reconciliationReasons.attemptBudgetExhausted,
        );
      }

      try {
        const result = await readWithDeadline(
          reader,
          {
            readRequestId: createUuid(),
            subject: Object.freeze({
              operationId: operation.id,
              ownerUserId: operation.ownerUserId,
              domain: operation.domain,
              operationKind: operation.operationKind,
              transportAttemptId: operation.transportAttemptId,
            }),
          },
          signal,
        );
        return applyReadResult(operation, result);
      } catch (error) {
        if (error instanceof ReconciliationRunAbortedError) {
          // The combined signal stopped the read. Do not persist a provider
          // outcome; lease expiry safely returns the operation to the queue.
          return Object.freeze({ kind: "aborted", operationId: operation.id });
        }

        return reschedule(
          operation,
          error instanceof AuthoritativeReadDeadlineError
            ? reconciliationReasons.authoritativeReadTimedOut
            : reconciliationReasons.authoritativeReadFailed,
        );
      }
    },
  });
}
