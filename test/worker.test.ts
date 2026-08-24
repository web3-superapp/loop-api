import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ControlPlaneRepository,
  ProviderOperation,
} from "../src/database/control-plane-repository.js";
import { createAuthoritativeReaderRegistry } from "../src/features/reconciliation/authoritative-reader.js";
import type { ReconciliationControlPlane } from "../src/features/reconciliation/reconciliation-service.js";
import {
  createReconciliationWorker,
  productionAuthoritativeReaders,
  WORKER_INFRA_RETRY_BASE_DELAY_MS,
  WORKER_INFRA_RETRY_MAX_DELAY_MS,
} from "../src/worker.js";

const workerId = "33b40904-4487-49cd-8481-7075d9025713";

function leasedOperation(): ProviderOperation {
  return Object.freeze({
    id: "6dfbe8ba-b323-4cdc-9ef2-9ab29034a43c",
    ownerUserId: "96590715-84fe-4390-9af2-6e4c35803140",
    domain: "perp",
    operationKind: "order",
    requestSha256:
      "34a446b4166c0d4f4c46e838449250602f26d3c5dd58820241211da215d7f50f",
    state: "unknown",
    attemptCount: 1,
    transportAttemptId: "09d42742-73f0-41b8-9775-a57ddc54de92",
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
  });
}

function fakeControlPlane(
  leases: readonly (readonly ProviderOperation[])[],
): ReconciliationControlPlane {
  const lease =
    vi.fn<ControlPlaneRepository["leaseProviderOperationsForReconciliation"]>();
  for (const operations of leases) {
    lease.mockResolvedValueOnce(operations);
  }

  const repository = {
    quarantineExpiredSubmissions:
      vi.fn<ControlPlaneRepository["quarantineExpiredSubmissions"]>(),
    leaseProviderOperationsForReconciliation: lease,
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
  repository.holdProviderOperationForOperator.mockImplementation(() =>
    Promise.resolve(leasedOperation()),
  );
  return repository;
}

function uuidFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("reconciliation worker shell", () => {
  it("keeps the production reader registry empty until provider gates close", () => {
    expect(productionAuthoritativeReaders.find("perp")).toBeUndefined();
    expect(productionAuthoritativeReaders.find("transfer")).toBeUndefined();
  });

  it("uses the empty production registry and holds unknown work", async () => {
    const controlPlane = fakeControlPlane([[leasedOperation()]]);
    const worker = createReconciliationWorker({
      controlPlane,
      workerId,
      createUuid: uuidFactory(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "operator_required",
      reasonCode: "unknown_reconciliation_domain",
    });
    expect(
      controlPlane.holdProviderOperationForOperator,
    ).toHaveBeenCalledOnce();
  });

  it("keeps one worker identity while creating new request UUIDs per run", async () => {
    const controlPlane = fakeControlPlane([[], []]);
    const created: string[] = [];
    const nextUuid = uuidFactory();
    const worker = createReconciliationWorker({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([]),
      createUuid: () => {
        const value = nextUuid();
        created.push(value);
        return value;
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: "idle" });
    await expect(worker.runOnce()).resolves.toEqual({ kind: "idle" });

    expect(worker.workerId).toBe(created[0]);
    const claims = vi.mocked(
      controlPlane.leaseProviderOperationsForReconciliation,
    ).mock.calls;
    expect(claims).toHaveLength(2);
    expect(claims[0]?.[0].workerId).toBe(worker.workerId);
    expect(claims[1]?.[0].workerId).toBe(worker.workerId);
    expect(claims[0]?.[0].requestId).not.toBe(claims[1]?.[0].requestId);
    expect(new Set(created).size).toBe(created.length);
  });

  it("coalesces concurrent one-shot calls so claims cannot overlap", async () => {
    let releaseLease:
      ((value: readonly ProviderOperation[]) => void) | undefined;
    const controlPlane = fakeControlPlane([]);
    vi.mocked(
      controlPlane.leaseProviderOperationsForReconciliation,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLease = resolve;
        }),
    );
    const worker = createReconciliationWorker({
      controlPlane,
      workerId,
      createUuid: uuidFactory(),
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(
        controlPlane.leaseProviderOperationsForReconciliation,
      ).toHaveBeenCalledOnce();
    });
    releaseLease?.([]);

    await expect(first).resolves.toEqual({ kind: "idle" });
    await expect(second).resolves.toEqual({ kind: "idle" });
  });

  it("runs sequentially and stops an idle wait when aborted", async () => {
    vi.useFakeTimers();
    const controlPlane = fakeControlPlane([[], []]);
    const worker = createReconciliationWorker({
      controlPlane,
      workerId,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();

    const loop = worker.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      controlPlane.leaseProviderOperationsForReconciliation,
    ).toHaveBeenCalledOnce();

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(
      controlPlane.leaseProviderOperationsForReconciliation,
    ).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("aborts an active read without persisting a provider failure", async () => {
    const controlPlane = fakeControlPlane([[leasedOperation()]]);
    let readSignal: AbortSignal | undefined;
    const reader = vi.fn(({ signal }: { signal: AbortSignal }) => {
      readSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const worker = createReconciliationWorker({
      controlPlane,
      readers: createAuthoritativeReaderRegistry([["perp", reader]]),
      workerId,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();

    const loop = worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(reader).toHaveBeenCalledOnce();
    });
    expect(readSignal?.aborted).toBe(false);

    controller.abort();

    await expect(loop).resolves.toBeUndefined();
    expect(readSignal?.aborted).toBe(true);
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

  it("backs infrastructure failures off exponentially with a hard cap", async () => {
    vi.useFakeTimers();
    const controlPlane = fakeControlPlane([]);
    vi.mocked(controlPlane.quarantineExpiredSubmissions).mockRejectedValue(
      new Error("database detail must not escape"),
    );
    const backoffs: number[] = [];
    const worker = createReconciliationWorker({
      controlPlane,
      workerId,
      createUuid: uuidFactory(),
      onInfrastructureBackoff: ({ retryDelayMs }) => {
        backoffs.push(retryDelayMs);
      },
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    const expected = [
      WORKER_INFRA_RETRY_BASE_DELAY_MS,
      2_000,
      4_000,
      8_000,
      16_000,
      WORKER_INFRA_RETRY_MAX_DELAY_MS,
      WORKER_INFRA_RETRY_MAX_DELAY_MS,
    ];
    for (const delay of expected.slice(0, -1)) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(backoffs).toEqual(expected);
    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
