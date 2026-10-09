import { describe, expect, it, vi } from "vitest";

import { createChainVerificationWatch } from "../src/integrations/bsc/chain-verification-watch.js";
import type { ChainVerificationState } from "../src/integrations/bsc/rpc-client.js";

/**
 * Preflight 2026-09-16 item 3: a cold start whose first chain-ID probe fails
 * must heal on its own, and a projection that reads a non-terminal state
 * must trigger one throttled re-probe instead of sustaining the closed
 * capability.
 */

function fakeClient(sequence: readonly ChainVerificationState[]) {
  let state: ChainVerificationState = "unknown";
  let index = 0;
  const verifyChain = vi.fn((): Promise<ChainVerificationState> => {
    if (state === "verified" || state === "mismatched") {
      return Promise.resolve(state);
    }
    state = sequence[Math.min(index, sequence.length - 1)] ?? "unreachable";
    index += 1;
    return Promise.resolve(state);
  });
  return {
    chainId: "eip155:56" as const,
    endpointRefs: ["rpc-abc"] as readonly string[],
    verifyChain,
    currentVerification: (): ChainVerificationState => state,
  };
}

function harness(
  sequence: readonly ChainVerificationState[],
  overrides: {
    readonly endpointRefs?: readonly string[];
    readonly reprobeThrottleMs?: number;
  } = {},
) {
  const client = {
    ...fakeClient(sequence),
    ...(overrides.endpointRefs === undefined
      ? {}
      : { endpointRefs: overrides.endpointRefs }),
  };
  let clock = 0;
  const sleeps: number[] = [];
  const sleep = vi.fn((ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  });
  const logger = { warn: vi.fn(), info: vi.fn() };
  const watch = createChainVerificationWatch({
    client,
    chainSlot: "primary",
    logger,
    retry: {
      maxAttempts: 5,
      initialDelayMs: 2_000,
      maxDelayMs: 16_000,
      maxTotalMs: 60_000,
    },
    ...(overrides.reprobeThrottleMs === undefined
      ? {}
      : { reprobeThrottleMs: overrides.reprobeThrottleMs }),
    monotonicMs: () => clock,
    sleep,
  });
  return {
    client,
    watch,
    logger,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("chain verification watch — startup retry", () => {
  it("retries a failed cold-start probe with exponential backoff until verified", async () => {
    const { client, watch, sleeps, logger } = harness([
      "unreachable",
      "unreachable",
      "verified",
    ]);

    await expect(watch.verifyAtStartup()).resolves.toBe("verified");

    expect(client.verifyChain).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(client.currentVerification()).toBe("verified");
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      chainVerification: "unreachable",
      attempt: 1,
      nextRetryInMs: 2_000,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chainVerification: "verified", attempt: 3 }),
      expect.stringContaining("recovered"),
    );
  });

  it("never retries a chain-ID mismatch: that is configuration, not jitter", async () => {
    const { client, watch, sleeps, logger } = harness(["mismatched"]);

    await expect(watch.verifyAtStartup()).resolves.toBe("mismatched");

    expect(client.verifyChain).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toContain("not retrying");
  });

  it("stops after maxAttempts and leaves the state to the next read or projection", async () => {
    const { client, watch, sleeps, logger } = harness(["unreachable"]);

    await expect(watch.verifyAtStartup()).resolves.toBe("unreachable");

    expect(client.verifyChain).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({
      attempt: 5,
      nextRetryInMs: null,
    });
  });

  it("does not schedule a retry that would start past the total budget", async () => {
    const { client, watch, sleeps, advance } = harness(["unreachable"]);
    // Each probe "takes" 20 s of wall clock: 2 s + 20 s + 4 s + 20 s = 46 s
    // after the second probe; the next 8 s delay would end at 54 s (fits),
    // but the following probe pushes past 60 s, so no fourth delay.
    client.verifyChain.mockImplementation(
      (): Promise<ChainVerificationState> => {
        advance(20_000);
        return Promise.resolve("unreachable");
      },
    );

    await expect(watch.verifyAtStartup()).resolves.toBe("unreachable");

    expect(sleeps.length).toBeLessThan(4);
    expect(client.verifyChain.mock.calls.length).toBe(sleeps.length + 1);
  });

  it("a verified first probe is silent and returns immediately", async () => {
    const { client, watch, sleeps, logger } = harness(["verified"]);
    await expect(watch.verifyAtStartup()).resolves.toBe("verified");
    expect(client.verifyChain).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("stop() cancels a pending delay", async () => {
    const client = fakeClient(["unreachable"]);
    let release: () => void = () => {};
    const sleep = vi.fn(
      (_ms: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const watch = createChainVerificationWatch({
      client,
      chainSlot: "primary",
      logger: null,
      sleep,
      monotonicMs: () => 0,
    });
    const startup = watch.verifyAtStartup();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    watch.stop();
    await expect(startup).resolves.toBe("unreachable");
    expect(client.verifyChain).toHaveBeenCalledTimes(1);
    release();
  });
});

describe("chain verification watch — projection-triggered re-probe", () => {
  it("returns the client's state unchanged and schedules one throttled background re-probe on unreachable", async () => {
    const { client, watch, advance } = harness(["unreachable", "verified"], {
      reprobeThrottleMs: 30_000,
    });
    // Startup left the state unreachable.
    await client.verifyChain();
    expect(client.currentVerification()).toBe("unreachable");

    // First projection read: reports unreachable, triggers a re-probe.
    expect(watch.current()).toBe("unreachable");
    expect(client.verifyChain).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(client.currentVerification()).toBe("verified");

    // Once verified, reads never probe again.
    expect(watch.current()).toBe("verified");
    expect(client.verifyChain).toHaveBeenCalledTimes(2);
    advance(60_000);
    expect(watch.current()).toBe("verified");
    expect(client.verifyChain).toHaveBeenCalledTimes(2);
  });

  it("throttles re-probes to one per window while the state stays unreachable", async () => {
    const { client, watch, advance, logger } = harness(["unreachable"], {
      reprobeThrottleMs: 30_000,
    });

    expect(watch.current()).toBe("unknown");
    expect(client.verifyChain).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(client.currentVerification()).toBe("unreachable");

    advance(10_000);
    expect(watch.current()).toBe("unreachable");
    advance(19_999);
    expect(watch.current()).toBe("unreachable");
    expect(client.verifyChain).toHaveBeenCalledTimes(1);

    advance(1);
    expect(watch.current()).toBe("unreachable");
    expect(client.verifyChain).toHaveBeenCalledTimes(2);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("never re-probes a mismatched chain or a client without endpoints", async () => {
    const mismatched = harness(["mismatched"]);
    await mismatched.watch.verifyAtStartup();
    expect(mismatched.watch.current()).toBe("mismatched");
    mismatched.advance(120_000);
    expect(mismatched.watch.current()).toBe("mismatched");
    expect(mismatched.client.verifyChain).toHaveBeenCalledTimes(1);

    const unconfigured = harness(["unknown"], { endpointRefs: [] });
    expect(unconfigured.watch.current()).toBe("unknown");
    expect(unconfigured.client.verifyChain).not.toHaveBeenCalled();
  });

  it("logs the recovery when a projection-triggered re-probe verifies the chain", async () => {
    const { client, watch, logger } = harness(["unreachable", "verified"]);
    await client.verifyChain();
    expect(watch.current()).toBe("unreachable");
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          chainVerification: "verified",
          trigger: "projection",
        }),
        expect.stringContaining("recovered"),
      ),
    );
  });
});
