import type {
  AtomicDomainReconciliationHandler,
  AuthoritativeReadResult,
} from "../reconciliation/authoritative-reader.js";
import type {
  PerpOrderReconciliationResolution,
  PerpReconciliationRepository,
  PerpReconciliationSubject,
} from "./perp-reconciliation-contract.js";

const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;

export type PerpOrderAuthoritativeReadResult =
  | Readonly<{
      kind: "resolved";
      resolution: PerpOrderReconciliationResolution;
    }>
  | Readonly<{
      kind: "pending";
      reasonCode?: string;
      retryAfterMs?: number;
    }>
  | Readonly<{
      kind: "retry";
      reasonCode: string;
      retryAfterMs?: number;
    }>
  | Readonly<{
      kind: "operator_required";
      reasonCode: string;
    }>;

export interface PerpOrderAuthoritativeReader {
  read(input: {
    readonly readRequestId: string;
    readonly subject: PerpReconciliationSubject;
    readonly signal: AbortSignal;
  }): Promise<PerpOrderAuthoritativeReadResult>;
}

export interface CreatePerpOrderReconciliationHandlerInput {
  readonly repository: PerpReconciliationRepository;
  readonly reader: PerpOrderAuthoritativeReader;
}

function operatorRequired(reasonCode: string): AuthoritativeReadResult {
  return Object.freeze({ kind: "operator_required", reasonCode });
}

function isSupportedLimitOrder(subject: PerpReconciliationSubject): boolean {
  const [item] = subject.items;
  return (
    subject.action === "order" &&
    subject.canonicalAction.action === "order" &&
    subject.canonicalAction.order_type === "limit" &&
    subject.items.length === 1 &&
    item !== undefined &&
    item.index === 0 &&
    item.coin === subject.canonicalAction.coin &&
    item.targetKind === null &&
    item.targetOrderId === null &&
    item.targetClientOrderId === null &&
    item.generatedClientOrderId !== null &&
    clientOrderIdPattern.test(item.generatedClientOrderId)
  );
}

function unresolvedResult(
  result: Exclude<PerpOrderAuthoritativeReadResult, { kind: "resolved" }>,
): AuthoritativeReadResult {
  if (result.kind === "operator_required") {
    return Object.freeze({
      kind: result.kind,
      reasonCode: result.reasonCode,
    });
  }
  if (result.kind === "retry") {
    return Object.freeze({
      kind: result.kind,
      reasonCode: result.reasonCode,
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
    });
  }
  return Object.freeze({
    kind: result.kind,
    ...(result.reasonCode === undefined
      ? {}
      : { reasonCode: result.reasonCode }),
    ...(result.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: result.retryAfterMs }),
  });
}

/**
 * Bridges the generic fenced lease to the Perp-specific read/finalize port.
 * It exposes no submission, signer, formatter, replay, or provider-write path.
 */
export function createPerpOrderReconciliationHandler(
  input: CreatePerpOrderReconciliationHandlerInput,
): AtomicDomainReconciliationHandler {
  return async (runInput) => {
    if (
      runInput.subject.domain !== "hyperliquid" ||
      runInput.subject.operationKind !== "perp_intent" ||
      runInput.subject.transportAttemptId === null ||
      runInput.lease.attemptCommittedAt === null
    ) {
      return operatorRequired("invalid_perp_reconciliation_subject");
    }

    const subject = await input.repository.loadClaimedSubject({
      ownerUserId: runInput.subject.ownerUserId,
      operationId: runInput.subject.operationId,
      workerId: runInput.lease.workerId,
      fenceToken: runInput.lease.fenceToken,
      recordVersion: runInput.lease.recordVersion,
    });

    if (
      subject.operationId !== runInput.subject.operationId ||
      subject.ownerUserId !== runInput.subject.ownerUserId ||
      subject.attemptCommittedAt !== runInput.lease.attemptCommittedAt
    ) {
      return operatorRequired("invalid_perp_reconciliation_subject");
    }

    if (!isSupportedLimitOrder(subject)) {
      return operatorRequired("unsupported_perp_reconciliation_action");
    }

    const result = await input.reader.read({
      readRequestId: runInput.readRequestId,
      subject,
      signal: runInput.signal,
    });

    if (result.kind !== "resolved") {
      return unresolvedResult(result);
    }

    // The provider deadline may expire after a read settles. Never enter the
    // durable transaction with an already-aborted observation.
    runInput.signal.throwIfAborted();
    await input.repository.finalizeOrderResolution({
      ownerUserId: runInput.subject.ownerUserId,
      operationId: runInput.subject.operationId,
      workerId: runInput.lease.workerId,
      fenceToken: runInput.lease.fenceToken,
      recordVersion: runInput.lease.recordVersion,
      expectedIntentRecordVersion: subject.intentRecordVersion,
      requestId: runInput.finalizationRequestId,
      resolution: result.resolution,
    });

    return Object.freeze({
      kind: "resolved",
      state: result.resolution.genericState,
      ...(result.resolution.reasonCode === null
        ? {}
        : { reasonCode: result.resolution.reasonCode }),
    });
  };
}
