import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StaleProviderOperationLeaseError,
  type ControlPlaneRepository,
  type ProviderOperation,
} from "../src/database/control-plane-repository.js";
import {
  createAuthoritativeReaderRegistry,
  type AtomicDomainReconciliationHandler,
  type AuthoritativeResultReader,
} from "../src/features/reconciliation/authoritative-reader.js";
import {
  createReconciliationService,
  RECONCILIATION_LEASE_DURATION_MS,
  RECONCILIATION_MAX_READ_ATTEMPTS,
  RECONCILIATION_READ_DEADLINE_MS,
  RECONCILIATION_RETRY_MAX_DELAY_MS,
  type ReconciliationControlPlane,
} from "../src/features/reconciliation/reconciliation-service.js";

const ownerUserId = "86f5c568-f078-4a3e-95b1-b9942d2a41ef";
const operationId = "e2c2c7ea-15c4-4ef9-ad12-217d56ce4642";
const transportAttemptId = "f008c1b0-aa55-4c9f-976b-c9eaa631a4f4";
const workerId = "d9c6f78e-9ae3-49d2-b606-0329ecb986bf";

function leasedOperation(
  overrides: Partial<ProviderOperation> = {},
): ProviderOperation {
  return Object.freeze({
    id: operationId,
    ownerUserId,
    domain: "perp",
    operationKind: "order",
    requestSha256:
      "34a446b4166c0d4f4c46e838449250602f26d3c5dd58820241211da215d7f50f",
    state: "unknown",
    attemptCount: 1,
    transportAttemptId,
    attemptCommittedAt: "2026-08-24T12:00:00.000Z",
    attemptDeadlineAt: "2026-08-24T12:00:10.000Z",
    reconciliationStatus: "leased",
    reconciliationAttemptCount: 1,
    reconcileAfter: "2026-08-24T12:00:10.000Z",
    operatorRequiredAt: null,
    leaseOwner: workerId,
    leaseExpiresAt: "2026-08-24T12:00:40.000Z",
    fenceToken: "1",
    recordVersion: "4",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:10.000Z",
    ...overrides,
  });
}

function fakeControlPlane(
  operation: ProviderOperation | undefined,
): ReconciliationControlPlane {
  const repository = {
    quarantineExpiredSubmissions:
      vi.fn<ControlPlaneRepository["quarantineExpiredSubmissions"]>(),
    leaseProviderOperationsForReconciliation:
      vi.fn<
        ControlPlaneRepository["leaseProviderOperationsForReconciliation"]
      >(),
    completeProviderOperationReconciliation:
      vi.fn<
        ControlPlaneRepository["completeProviderOperationReconciliation"]
      >(),
    rescheduleProviderOperationReconciliation:
      vi.fn<
        ControlPlaneRepository["rescheduleProviderOperationReconciliation"]
      >(),
    holdProviderOperationForOperator:
      vi.fn<ControlPlaneRepository["holdProviderOperationForOperator"]>(),
  } satisfies ReconciliationControlPlane;

  repository.quarantineExpiredSubmissions.mockResolvedValue([]);
  repository.leaseProviderOperationsForReconciliation.mockResolvedValue(
    operation === undefined ? [] : [operation],
  );

  if (operation !== undefined) {
    repository.completeProviderOperationReconciliation.mockResolvedValue(
      operation,
    );
    repository.rescheduleProviderOperationReconciliation.mockResolvedValue(
      operation,
    );
    repository.holdProviderOperationForOperator.mockResolvedValue(operation);
  }

  return repository;
}

function uuidSequence() {
  let counter = 0;
  const created: string[] = [];

  return {
    created,
    createUuid(): string {
      counter += 1;
      const value = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      created.push(value);
      return value;
    },
  };
}

function serviceFor(
  controlPlane: ReconciliationControlPlane,
  reader?: AuthoritativeResultReader,
) {
  const uuids = uuidSequence();
  const service = createReconciliationService({
    controlPlane,
    readers: createAuthoritativeReaderRegistry(
      reader === undefined ? [] : [["perp", reader]],
    ),
    workerId,
    createUuid: () => uuids.createUuid(),
  });
  return { service, uuids };
}

function serviceForAtomic(
  controlPlane: ReconciliationControlPlane,
  handler: AtomicDomainReconciliationHandler,
) {
  const uuids = uuidSequence();
  const service = createReconciliationService({
    controlPlane,
    readers: createAuthoritativeReaderRegistry([
      ["perp", { mode: "atomic_domain", run: handler }],
    ]),
    workerId,
    createUuid: () => uuids.createUuid(),
  });
  return { service, uuids };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authoritative reconciliation service", () => {
  it("quarantines and claims at most one operation per run", async () => {
    const controlPlane = fakeControlPlane(undefined);
    const { service, uuids } = serviceFor(controlPlane);

    await expect(service.runOnce()).resolves.toEqual({ kind: "idle" });

    expect(controlPlane.quarantineExpiredSubmissions).toHaveBeenCalledWith({
      requestId: uuids.created[0],
      limit: 1,
    });
    expect(
      controlPlane.leaseProviderOperationsForReconciliation,
    ).toHaveBeenCalledWith({
      workerId,
      requestId: uuids.created[1],
      limit: 1,
      leaseDurationMs: RECONCILIATION_LEASE_DURATION_MS,
    });
  });

  it("holds an unknown domain without attempting an authoritative read", async () => {
    const operation = leasedOperation({ domain: "unknown_provider" });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>();
    const uuids = uuidSequence();
    const service = createReconciliationService({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([["perp", reader]]),
      workerId,
      createUuid: () => uuids.createUuid(),
    });

    await expect(service.runOnce()).resolves.toEqual({
      kind: "operator_required",
      operationId,
      reasonCode: "unknown_reconciliation_domain",
    });
    expect(reader).not.toHaveBeenCalled();
    expect(controlPlane.holdProviderOperationForOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId,
        operationId,
        workerId,
        fenceToken: "1",
        recordVersion: "4",
        reasonCode: "unknown_reconciliation_domain",
      }),
    );
  });

  it("performs one read with a new UUID and completes an authoritative result", async () => {
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({ kind: "resolved", state: "succeeded" }),
    );
    const { service, uuids } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "resolved",
      operationId,
    });

    expect(reader).toHaveBeenCalledOnce();
    const readInput = reader.mock.calls[0]?.[0];
    expect(readInput).toMatchObject({
      readRequestId: uuids.created[2],
      subject: {
        operationId,
        ownerUserId,
        domain: "perp",
        operationKind: "order",
        transportAttemptId,
      },
    });
    expect(readInput?.signal).toBeInstanceOf(AbortSignal);
    expect(new Set(uuids.created).size).toBe(uuids.created.length);
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      workerId,
      fenceToken: "1",
      recordVersion: "4",
      requestId: uuids.created[3],
      state: "succeeded",
    });
  });

  it("preserves direct-call this semantics for the legacy reader shorthand", async () => {
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    let receivedUndefinedThis = false;
    const reader: AuthoritativeResultReader = function (
      this: unknown,
      { signal },
    ) {
      signal.throwIfAborted();
      receivedUndefinedThis = this === undefined;
      return Promise.resolve({ kind: "pending" });
    };
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toMatchObject({
      kind: "rescheduled",
      operationId,
    });
    expect(receivedUndefinedThis).toBe(true);
  });

  it("lets an atomic-domain handler own the sole resolved completion", async () => {
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    const handler = vi.fn<AtomicDomainReconciliationHandler>(() =>
      Promise.resolve({ kind: "resolved", state: "succeeded" }),
    );
    const uuids = uuidSequence();
    const service = createReconciliationService({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([
        ["perp", { mode: "atomic_domain", run: handler }],
      ]),
      workerId,
      createUuid: () => uuids.createUuid(),
    });

    await expect(service.runOnce()).resolves.toEqual({
      kind: "resolved",
      operationId,
    });

    expect(handler).toHaveBeenCalledOnce();
    const handlerInput = handler.mock.calls[0]?.[0];
    expect(handlerInput).toMatchObject({
      readRequestId: uuids.created[2],
      finalizationRequestId: uuids.created[3],
      subject: {
        operationId,
        ownerUserId,
        domain: "perp",
        operationKind: "order",
        transportAttemptId,
      },
      lease: {
        workerId,
        fenceToken: "1",
        recordVersion: "4",
        attemptCommittedAt: "2026-08-24T12:00:00.000Z",
      },
    });
    expect(handlerInput?.signal).toBeInstanceOf(AbortSignal);
    expect(new Set(uuids.created).size).toBe(uuids.created.length);
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();
  });

  it("uses the generic control plane for an unresolved atomic-domain result", async () => {
    const operation = leasedOperation({ reconciliationAttemptCount: 2 });
    const controlPlane = fakeControlPlane(operation);
    const handler = vi.fn<AtomicDomainReconciliationHandler>(() =>
      Promise.resolve({ kind: "pending" }),
    );
    const uuids = uuidSequence();
    const service = createReconciliationService({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([
        ["perp", { mode: "atomic_domain", run: handler }],
      ]),
      workerId,
      createUuid: () => uuids.createUuid(),
    });

    await expect(service.runOnce()).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: 10_000,
    });
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: uuids.created[4],
        reasonCode: "authoritative_result_pending",
        retryDelayMs: 10_000,
      }),
    );
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
  });

  it("discards an atomic finalizer stale lease without any fallback write", async () => {
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    const handler = vi.fn<AtomicDomainReconciliationHandler>(() =>
      Promise.reject(new StaleProviderOperationLeaseError()),
    );
    const uuids = uuidSequence();
    const service = createReconciliationService({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([
        ["perp", { mode: "atomic_domain", run: handler }],
      ]),
      workerId,
      createUuid: () => uuids.createUuid(),
    });

    await expect(service.runOnce()).resolves.toEqual({
      kind: "stale_lease_discarded",
      operationId,
    });
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();
  });

  it("awaits an in-flight atomic finalizer across the read deadline", async () => {
    vi.useFakeTimers();
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    let finishFinalizer: (() => void) | undefined;
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn<AtomicDomainReconciliationHandler>(({ signal }) => {
      // This models the required boundary immediately before the handler
      // enters its domain transaction.
      signal.throwIfAborted();
      handlerSignal = signal;
      return new Promise((resolve) => {
        finishFinalizer = () => {
          resolve({ kind: "resolved", state: "succeeded" });
        };
      });
    });
    const uuids = uuidSequence();
    const service = createReconciliationService({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([
        ["perp", { mode: "atomic_domain", run: handler }],
      ]),
      workerId,
      createUuid: () => uuids.createUuid(),
    });

    const run = service.runOnce();
    const settled = vi.fn();
    void run.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(RECONCILIATION_READ_DEADLINE_MS);
    expect(handlerSignal?.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();

    if (finishFinalizer === undefined) {
      throw new Error("The atomic finalizer did not start");
    }
    finishFinalizer();
    await expect(run).resolves.toEqual({ kind: "resolved", operationId });
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();
  });

  it("maps an atomic provider-stage abort to the deadline policy", async () => {
    vi.useFakeTimers();
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    const handler = vi.fn<AtomicDomainReconciliationHandler>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("authoritative read aborted"));
            },
            { once: true },
          );
        }),
    );
    const { service } = serviceForAtomic(controlPlane, handler);

    const run = service.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RECONCILIATION_READ_DEADLINE_MS);

    await expect(run).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: 5_000,
    });
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authoritative_read_timeout" }),
    );
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
  });

  it("does not apply an unresolved atomic result that settles after deadline", async () => {
    vi.useFakeTimers();
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    const handler = vi.fn<AtomicDomainReconciliationHandler>(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve({
                kind: "operator_required",
                reasonCode: "late_provider_result",
              });
            },
            { once: true },
          );
        }),
    );
    const { service } = serviceForAtomic(controlPlane, handler);

    const run = service.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_READ_DEADLINE_MS);

    await expect(run).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: 5_000,
    });
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authoritative_read_timeout" }),
    );
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
  });

  it("reschedules a pending result once without reading again", async () => {
    const operation = leasedOperation({ reconciliationAttemptCount: 2 });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({ kind: "pending" }),
    );
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: 10_000,
    });
    expect(reader).toHaveBeenCalledOnce();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "authoritative_result_pending",
        retryDelayMs: 10_000,
      }),
    );
  });

  it("uses bounded exponential backoff for retryable read failures", async () => {
    const operation = leasedOperation({ reconciliationAttemptCount: 7 });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.reject(new Error("provider detail must not escape")),
    );
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: RECONCILIATION_RETRY_MAX_DELAY_MS,
    });
    expect(reader).toHaveBeenCalledOnce();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "authoritative_read_failed",
        retryDelayMs: RECONCILIATION_RETRY_MAX_DELAY_MS,
      }),
    );
  });

  it("distinguishes adapter retry and clamps retry-after to policy bounds", async () => {
    const operation = leasedOperation({ reconciliationAttemptCount: 2 });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({
        kind: "retry",
        reasonCode: "provider_read_unavailable",
        retryAfterMs: 86_400_000,
      }),
    );
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: RECONCILIATION_RETRY_MAX_DELAY_MS,
    });
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "provider_read_unavailable",
        retryDelayMs: RECONCILIATION_RETRY_MAX_DELAY_MS,
      }),
    );
  });

  it("holds after the final permitted read remains pending", async () => {
    const operation = leasedOperation({
      reconciliationAttemptCount: RECONCILIATION_MAX_READ_ATTEMPTS,
    });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({ kind: "pending" }),
    );
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "operator_required",
      operationId,
      reasonCode: "reconciliation_attempt_budget_exhausted",
    });
    expect(reader).toHaveBeenCalledOnce();
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
  });

  it("does not exceed the read budget after a reclaimed lease", async () => {
    const operation = leasedOperation({
      reconciliationAttemptCount: RECONCILIATION_MAX_READ_ATTEMPTS + 1,
    });
    const controlPlane = fakeControlPlane(operation);
    const reader = vi.fn<AuthoritativeResultReader>();
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "operator_required",
      operationId,
      reasonCode: "reconciliation_attempt_budget_exhausted",
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("enforces the five-second read deadline and aborts the read signal", async () => {
    vi.useFakeTimers();
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    let readSignal: AbortSignal | undefined;
    const reader = vi.fn<AuthoritativeResultReader>(({ signal }) => {
      readSignal = signal;
      return new Promise(() => undefined);
    });
    const { service } = serviceFor(controlPlane, reader);

    const run = service.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).toHaveBeenCalledOnce();
    expect(readSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(RECONCILIATION_READ_DEADLINE_MS);
    await expect(run).resolves.toEqual({
      kind: "rescheduled",
      operationId,
      retryDelayMs: 5_000,
    });
    expect(readSignal?.aborted).toBe(true);
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "authoritative_read_timeout" }),
    );
  });

  it("holds malformed or explicitly operator-required read results", async () => {
    const malformedOperation = leasedOperation();
    const malformedControlPlane = fakeControlPlane(malformedOperation);
    const malformedReader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({
        kind: "retry",
        reasonCode: "raw provider error must not persist",
        retryAfterMs: 10_000,
      } as never),
    );
    const malformed = serviceFor(malformedControlPlane, malformedReader);

    await expect(malformed.service.runOnce()).resolves.toEqual({
      kind: "operator_required",
      operationId,
      reasonCode: "invalid_authoritative_read_result",
    });

    const explicitOperation = leasedOperation();
    const explicitControlPlane = fakeControlPlane(explicitOperation);
    const explicitReader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({
        kind: "operator_required",
        reasonCode: "provider_status_unrecognized",
      }),
    );
    const explicit = serviceFor(explicitControlPlane, explicitReader);

    await expect(explicit.service.runOnce()).resolves.toEqual({
      kind: "operator_required",
      operationId,
      reasonCode: "provider_status_unrecognized",
    });
  });

  it("silently discards a result after losing the lease fence", async () => {
    const operation = leasedOperation();
    const controlPlane = fakeControlPlane(operation);
    vi.mocked(
      controlPlane.completeProviderOperationReconciliation,
    ).mockRejectedValue(new StaleProviderOperationLeaseError());
    const reader = vi.fn<AuthoritativeResultReader>(() =>
      Promise.resolve({ kind: "resolved", state: "accepted" }),
    );
    const { service } = serviceFor(controlPlane, reader);

    await expect(service.runOnce()).resolves.toEqual({
      kind: "stale_lease_discarded",
      operationId,
    });
    expect(
      controlPlane.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).not.toHaveBeenCalled();
  });
});
