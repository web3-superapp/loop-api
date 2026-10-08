import { describe, expect, it, vi } from "vitest";

import {
  createMemberBuyFeedWorker,
  type MemberBuyFeedInfrastructureBackoff,
} from "../src/community-member-buy-feed-worker.js";
import type { MemberBuyFeedRunResult } from "../src/features/community/member-buy-feed-service.js";

function completed(
  kind: MemberBuyFeedRunResult["kind"] = "completed",
): MemberBuyFeedRunResult {
  return {
    kind,
    examinedSwapCount: 0,
    sentCount: 0,
    truncatedCount: 0,
    skippedCount: 0,
    rejectedCount: 0,
    cursor: null,
  };
}

describe("community_member_buy_feed worker loop (Decision 0097)", () => {
  it("backs off 1 s, 2 s on repository failures and resets after a pass", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const backoffs: MemberBuyFeedInfrastructureBackoff[] = [];
      let calls = 0;
      const runOnce = vi.fn(() => {
        calls += 1;
        if (calls <= 2) {
          return Promise.reject(new Error("db down"));
        }
        controller.abort();
        return Promise.resolve(completed("aborted"));
      });
      const worker = createMemberBuyFeedWorker({
        service: { runOnce },
        intervalMs: 15_000,
        onInfrastructureBackoff: (event) => backoffs.push(event),
      });
      const running = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;
      expect(backoffs).toEqual([
        {
          lane: "community_member_buy_feed",
          reasonCode: "member_buy_feed_unavailable",
          consecutiveFailureCount: 1,
          retryDelayMs: 1_000,
        },
        {
          lane: "community_member_buy_feed",
          reasonCode: "member_buy_feed_unavailable",
          consecutiveFailureCount: 2,
          retryDelayMs: 2_000,
        },
      ]);
      expect(runOnce).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the interval between passes and refuses a second loop", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const runOnce = vi.fn(() => Promise.resolve(completed()));
      const worker = createMemberBuyFeedWorker({
        service: { runOnce },
        intervalMs: 15_000,
      });
      const running = worker.run(controller.signal);
      await expect(worker.run(controller.signal)).rejects.toThrow(
        "already running",
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runOnce).toHaveBeenCalledTimes(2);
      controller.abort();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });
});
