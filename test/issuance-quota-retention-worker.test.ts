import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIssuanceQuotaRetentionWorker,
  ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
  ISSUANCE_QUOTA_RETENTION_INTERVAL_MS,
  ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN,
  ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
  ISSUANCE_QUOTA_RETENTION_RETRY_MAX_DELAY_MS,
  type IssuanceQuotaRetentionMaintenancePort,
} from "../src/issuance-quota-retention-worker.js";

function uuidFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `20000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function fakeMaintenance(): IssuanceQuotaRetentionMaintenancePort {
  return {
    deleteExpiredIssuanceQuotaRecords: vi.fn(() =>
      Promise.resolve({ deletedCount: 0 }),
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("issuance quota retention worker", () => {
  it("drains full batches with a fresh UUID until the first partial batch", async () => {
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.deleteExpiredIssuanceQuotaRecords)
      .mockResolvedValueOnce({
        deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
      })
      .mockResolvedValueOnce({
        deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
      })
      .mockResolvedValueOnce({ deletedCount: 42 });
    const worker = createIssuanceQuotaRetentionWorker({
      maintenance,
      createUuid: uuidFactory(),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      kind: "completed",
      batchCount: 3,
      deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT * 2 + 42,
    });
    expect(maintenance.deleteExpiredIssuanceQuotaRecords).toHaveBeenCalledTimes(
      3,
    );
    expect(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).toHaveBeenNthCalledWith(1, {
      requestId: "20000000-0000-4000-8000-000000000001",
      limit: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
    });
    expect(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).toHaveBeenNthCalledWith(3, {
      requestId: "20000000-0000-4000-8000-000000000003",
      limit: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
    });
  });

  it("caps one retention burst even while every batch remains full", async () => {
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.deleteExpiredIssuanceQuotaRecords).mockResolvedValue({
      deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT,
    });
    const worker = createIssuanceQuotaRetentionWorker({ maintenance });

    await expect(worker.runOnce()).resolves.toEqual({
      kind: "completed",
      batchCount: ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN,
      deletedCount:
        ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT *
        ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN,
    });
    expect(maintenance.deleteExpiredIssuanceQuotaRecords).toHaveBeenCalledTimes(
      ISSUANCE_QUOTA_RETENTION_MAX_BATCHES_PER_RUN,
    );
  });

  it("coalesces concurrent one-shot calls", async () => {
    let release:
      ((value: Readonly<{ deletedCount: number }>) => void) | undefined;
    const maintenance = fakeMaintenance();
    vi.mocked(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const worker = createIssuanceQuotaRetentionWorker({ maintenance });

    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(
        maintenance.deleteExpiredIssuanceQuotaRecords,
      ).toHaveBeenCalledOnce();
    });
    release?.({ deletedCount: 7 });

    await expect(first).resolves.toEqual({
      kind: "completed",
      batchCount: 1,
      deletedCount: 7,
    });
    await expect(second).resolves.toEqual({
      kind: "completed",
      batchCount: 1,
      deletedCount: 7,
    });
  });

  it("waits for an in-flight batch after abort and starts no later batch", async () => {
    let release:
      ((value: Readonly<{ deletedCount: number }>) => void) | undefined;
    const maintenance = fakeMaintenance();
    vi.mocked(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const worker = createIssuanceQuotaRetentionWorker({ maintenance });
    const controller = new AbortController();

    const loop = worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(
        maintenance.deleteExpiredIssuanceQuotaRecords,
      ).toHaveBeenCalledOnce();
    });
    controller.abort();
    release?.({ deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT });

    await expect(loop).resolves.toBeUndefined();
    expect(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).toHaveBeenCalledOnce();
  });

  it("backs database failures off with a stable code and resets after success", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.deleteExpiredIssuanceQuotaRecords)
      .mockRejectedValueOnce(new Error("private database detail"))
      .mockResolvedValueOnce({ deletedCount: 0 })
      .mockRejectedValueOnce(new Error("another private database detail"));
    const backoffs: unknown[] = [];
    const worker = createIssuanceQuotaRetentionWorker({
      maintenance,
      onInfrastructureBackoff: (event) => {
        backoffs.push(event);
      },
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(backoffs).toEqual([
      {
        reasonCode: "issuance_quota_retention_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
      },
    ]);

    await vi.advanceTimersByTimeAsync(
      ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
    );
    expect(maintenance.deleteExpiredIssuanceQuotaRecords).toHaveBeenCalledTimes(
      2,
    );

    await vi.advanceTimersByTimeAsync(ISSUANCE_QUOTA_RETENTION_INTERVAL_MS);
    expect(backoffs).toEqual([
      {
        reasonCode: "issuance_quota_retention_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
      },
      {
        reasonCode: "issuance_quota_retention_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
      },
    ]);
    expect(JSON.stringify(backoffs)).not.toContain("private");

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  it("caps repeated failure backoff and never reports the raw error", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.deleteExpiredIssuanceQuotaRecords).mockRejectedValue(
      new Error("postgres://user:secret@example.com/private"),
    );
    const backoffs: unknown[] = [];
    const worker = createIssuanceQuotaRetentionWorker({
      maintenance,
      onInfrastructureBackoff: (event) => {
        backoffs.push(event);
      },
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    const expectedDelays = [
      ISSUANCE_QUOTA_RETENTION_RETRY_BASE_DELAY_MS,
      2_000,
      4_000,
      8_000,
      16_000,
      ISSUANCE_QUOTA_RETENTION_RETRY_MAX_DELAY_MS,
      ISSUANCE_QUOTA_RETENTION_RETRY_MAX_DELAY_MS,
    ];
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of expectedDelays.slice(0, -1)) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(backoffs).toEqual(
      expectedDelays.map((retryDelayMs, index) => ({
        reasonCode: "issuance_quota_retention_unavailable",
        consecutiveFailureCount: index + 1,
        retryDelayMs,
      })),
    );
    expect(JSON.stringify(backoffs)).not.toContain("secret");

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  it("does no work when pre-aborted and rejects a second running loop", async () => {
    const maintenance = fakeMaintenance();
    let release:
      ((value: Readonly<{ deletedCount: number }>) => void) | undefined;
    vi.mocked(
      maintenance.deleteExpiredIssuanceQuotaRecords,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const worker = createIssuanceQuotaRetentionWorker({ maintenance });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(
        maintenance.deleteExpiredIssuanceQuotaRecords,
      ).toHaveBeenCalledOnce();
    });

    await expect(worker.run(controller.signal)).rejects.toThrow(
      "The issuance quota retention worker loop is already running",
    );
    controller.abort();
    release?.({ deletedCount: 0 });
    await expect(loop).resolves.toBeUndefined();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(worker.runOnce(alreadyAborted.signal)).resolves.toEqual({
      kind: "aborted",
      batchCount: 0,
      deletedCount: 0,
    });
  });

  it("rejects impossible repository counts with a sanitized error", async () => {
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.deleteExpiredIssuanceQuotaRecords).mockResolvedValue({
      deletedCount: ISSUANCE_QUOTA_RETENTION_BATCH_LIMIT + 1,
    });
    const worker = createIssuanceQuotaRetentionWorker({ maintenance });

    await expect(worker.runOnce()).rejects.toMatchObject({
      code: "issuance_quota_retention_unavailable",
      message: "Issuance quota retention maintenance is unavailable",
    });
  });
});
