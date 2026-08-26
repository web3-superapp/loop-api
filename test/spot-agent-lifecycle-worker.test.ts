import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpotAgentLifecycleWorker,
  SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
  SPOT_AGENT_LIFECYCLE_INTERVAL_MS,
  SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS,
  SPOT_AGENT_LIFECYCLE_RETRY_MAX_DELAY_MS,
  type SpotAgentLifecycleMaintenancePort,
} from "../src/spot-agent-lifecycle-worker.js";

function uuidFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function fakeMaintenance(): SpotAgentLifecycleMaintenancePort {
  return {
    expireElapsedPrepared: vi.fn(() => Promise.resolve({ expiredCount: 0 })),
    retireElapsedAgentIdentities: vi.fn(() =>
      Promise.resolve({ retiredCount: 0 }),
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Spot Agent lifecycle worker", () => {
  it("drains one bounded batch immediately, uses fresh UUIDs, then waits for the period", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();

    const loop = worker.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledWith({
      requestId: "10000000-0000-4000-8000-000000000001",
      limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
    });
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledWith({
      requestId: "10000000-0000-4000-8000-000000000002",
      limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
    });

    await vi.advanceTimersByTimeAsync(SPOT_AGENT_LIFECYCLE_INTERVAL_MS - 1);
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledTimes(2);
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledTimes(2);
    expect(maintenance.expireElapsedPrepared).toHaveBeenLastCalledWith({
      requestId: "10000000-0000-4000-8000-000000000003",
      limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
    });
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenLastCalledWith({
      requestId: "10000000-0000-4000-8000-000000000004",
      limit: SPOT_AGENT_LIFECYCLE_BATCH_LIMIT,
    });

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  it("coalesces concurrent one-shot calls so maintenance never overlaps", async () => {
    let releasePrepared:
      ((value: Readonly<{ expiredCount: number }>) => void) | undefined;
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.expireElapsedPrepared).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePrepared = resolve;
        }),
    );
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });

    const first = worker.runOnce();
    const second = worker.runOnce();

    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    });
    expect(maintenance.retireElapsedAgentIdentities).not.toHaveBeenCalled();
    releasePrepared?.({ expiredCount: 3 });

    await expect(first).resolves.toEqual({
      kind: "completed",
      expiredPreparedCount: 3,
      retiredAgentIdentityCount: 0,
    });
    await expect(second).resolves.toEqual({
      kind: "completed",
      expiredPreparedCount: 3,
      retiredAgentIdentityCount: 0,
    });
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledOnce();
  });

  it("backs prepared-expiry failures off while still attempting identity retirement", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.expireElapsedPrepared).mockRejectedValue(
      new Error("postgres://user:secret@example.com/private"),
    );
    const backoffs: unknown[] = [];
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
      onInfrastructureBackoff: (event) => {
        backoffs.push(event);
      },
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    const expectedDelays = [
      SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS,
      2_000,
      4_000,
      8_000,
      16_000,
      SPOT_AGENT_LIFECYCLE_RETRY_MAX_DELAY_MS,
      SPOT_AGENT_LIFECYCLE_RETRY_MAX_DELAY_MS,
    ];
    for (const delay of expectedDelays.slice(0, -1)) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(backoffs).toEqual(
      expectedDelays.map((retryDelayMs, index) => ({
        reasonCode: "spot_agent_prepared_expiry_unavailable",
        consecutiveFailureCount: index + 1,
        retryDelayMs,
      })),
    );
    expect(JSON.stringify(backoffs)).not.toContain("secret");
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledTimes(
      expectedDelays.length,
    );

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  it("reports one safe lifecycle code after attempting both failing lanes", async () => {
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.expireElapsedPrepared).mockRejectedValue(
      new Error("private prepared detail"),
    );
    vi.mocked(maintenance.retireElapsedAgentIdentities).mockRejectedValue(
      new Error("private retirement detail"),
    );
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });

    await expect(worker.runOnce()).rejects.toMatchObject({
      code: "spot_agent_lifecycle_unavailable",
      message: "Spot Agent lifecycle maintenance is unavailable",
    });
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledOnce();
  });

  it("reports identity-retirement failures with a fixed safe code and resets backoff after success", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.retireElapsedAgentIdentities)
      .mockRejectedValueOnce(new Error("first private database detail"))
      .mockResolvedValueOnce({ retiredCount: 2 })
      .mockRejectedValueOnce(new Error("second private database detail"));
    const backoffs: unknown[] = [];
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
      onInfrastructureBackoff: (event) => {
        backoffs.push(event);
      },
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(backoffs).toEqual([
      {
        reasonCode: "spot_agent_identity_retirement_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS,
      },
    ]);

    await vi.advanceTimersByTimeAsync(SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS);
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledTimes(2);
    expect(backoffs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SPOT_AGENT_LIFECYCLE_INTERVAL_MS);
    expect(backoffs).toEqual([
      {
        reasonCode: "spot_agent_identity_retirement_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS,
      },
      {
        reasonCode: "spot_agent_identity_retirement_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: SPOT_AGENT_LIFECYCLE_RETRY_BASE_DELAY_MS,
      },
    ]);

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  it("aborts an idle wait without starting another batch", async () => {
    vi.useFakeTimers();
    const maintenance = fakeMaintenance();
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledOnce();

    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    expect(maintenance.retireElapsedAgentIdentities).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight DB call on abort and does not start the next lifecycle method", async () => {
    let releasePrepared:
      ((value: Readonly<{ expiredCount: number }>) => void) | undefined;
    const maintenance = fakeMaintenance();
    vi.mocked(maintenance.expireElapsedPrepared).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePrepared = resolve;
        }),
    );
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);

    await vi.waitFor(() => {
      expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    });
    controller.abort();
    releasePrepared?.({ expiredCount: 1 });

    await expect(loop).resolves.toBeUndefined();
    expect(maintenance.retireElapsedAgentIdentities).not.toHaveBeenCalled();
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
  });

  it("does no work when already aborted and rejects a second running loop", async () => {
    const maintenance = fakeMaintenance();
    let releasePrepared:
      ((value: Readonly<{ expiredCount: number }>) => void) | undefined;
    vi.mocked(maintenance.expireElapsedPrepared).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePrepared = resolve;
        }),
    );
    const worker = createSpotAgentLifecycleWorker({
      maintenance,
      createUuid: uuidFactory(),
    });
    const controller = new AbortController();
    const loop = worker.run(controller.signal);
    await vi.waitFor(() => {
      expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
    });

    await expect(worker.run(controller.signal)).rejects.toThrow(
      "The Spot Agent lifecycle worker loop is already running",
    );
    controller.abort();
    releasePrepared?.({ expiredCount: 0 });
    await loop;

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(worker.runOnce(alreadyAborted.signal)).resolves.toEqual({
      kind: "aborted",
      expiredPreparedCount: 0,
      retiredAgentIdentityCount: 0,
    });
    expect(maintenance.expireElapsedPrepared).toHaveBeenCalledOnce();
  });
});
