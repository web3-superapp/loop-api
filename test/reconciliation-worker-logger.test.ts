import { describe, expect, it, vi } from "vitest";

import { createReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";

const workerId = "33b40904-4487-49cd-8481-7075d9025713";

describe("reconciliation worker logger", () => {
  it("emits allowlisted JSON fields to the expected stream", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      writeStdout: stdout,
      writeStderr: stderr,
    });

    logger.info(
      { environment: "test", workerId },
      "LOOP reconciliation worker started",
    );
    logger.warn(
      {
        workerId,
        reasonCode: "control_plane_unavailable",
        consecutiveFailureCount: 2,
        retryDelayMs: 2_000,
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );

    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({
        level: "info",
        time: "2026-08-25T10:00:00.000Z",
        service: "loop-reconciliation-worker",
        version: "0.1.0",
        workerId,
        environment: "test",
        msg: "LOOP reconciliation worker started",
      })}\n`,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('"reasonCode":"control_plane_unavailable"'),
    );
  });

  it("drops malformed identifiers and error codes", () => {
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "error",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      writeStderr: stderr,
    });

    logger.error(
      {
        workerId: "contains-provider-payload",
        postgresCode: "postgres://user:secret@example.com/private",
        startupErrorCode: "line\nbreak",
      },
      "Unexpected idle PostgreSQL client error",
    );

    const line = stderr.mock.calls[0]?.[0] ?? "";
    expect(line).not.toContain("contains-provider-payload");
    expect(line).not.toContain("postgres://");
    expect(line).not.toContain("line\\nbreak");
    expect(line).not.toContain("secret");
  });

  it("passes the BSC indexer classification fields through and drops anything that is not a class, code, or host (Decision 0068)", () => {
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "warn",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      writeStderr: stderr,
    });

    logger.warn(
      {
        reasonCode: "bsc_indexer_unavailable",
        lane: "erc20_transfer",
        consecutiveFailureCount: 6,
        retryDelayMs: 30_000,
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );
    expect(stderr).toHaveBeenCalledWith(
      `${JSON.stringify({
        level: "warn",
        time: "2026-09-22T10:00:00.000Z",
        service: "loop-reconciliation-worker",
        version: "0.1.0",
        reasonCode: "bsc_indexer_unavailable",
        retryDelayMs: 30_000,
        consecutiveFailureCount: 6,
        lane: "erc20_transfer",
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
        msg: "LOOP reconciliation worker infrastructure retry scheduled",
      })}\n`,
    );

    logger.warn(
      {
        lane: "not-a-lane",
        state: "unavailable",
        reasonCode: "BSC_LOG_QUERY_REJECTED",
        errorClass: "Http\nRequestError",
        rpcStatus: 4030,
        rpcCode: Number.NaN,
        rpcUrlHost: "https://user:secret@bsc-rpc.publicnode.com/key?token=x",
        method: 'eth_getLogs {"address":["0xabc"]}',
      },
      "LOOP BSC indexer lane is unavailable",
    );
    const line = stderr.mock.calls[1]?.[0] ?? "";
    expect(line).toContain('"state":"unavailable"');
    expect(line).toContain('"reasonCode":"BSC_LOG_QUERY_REJECTED"');
    expect(line).not.toContain("not-a-lane");
    expect(line).not.toContain("errorClass");
    expect(line).not.toContain("rpcStatus");
    expect(line).not.toContain("rpcCode");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("rpcUrlHost");
    expect(line).not.toContain("0xabc");
  });

  it("passes the learned log-query limits through as non-negative integers only (Decision 0079)", () => {
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "warn",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-09-25T07:00:00.000Z"),
      writeStderr: stderr,
    });

    logger.warn(
      {
        reasonCode: "BSC_LOG_LIMITS_RESET",
        detailReasonCode: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
        learnedAddressLimit: 8,
        learnedTopicGroupLimit: 200,
        learnedRangeLimit: 2_000,
        relaxAfterCleanReads: 4,
        previousAddressLimit: 1,
        previousTopicGroupLimit: 100,
        previousRangeLimit: 500,
      },
      "LOOP BSC log-query limits reset to their configured values",
    );
    expect(JSON.parse(stderr.mock.calls[0]?.[0] ?? "{}")).toEqual({
      level: "warn",
      time: "2026-09-25T07:00:00.000Z",
      service: "loop-reconciliation-worker",
      version: "0.1.0",
      reasonCode: "BSC_LOG_LIMITS_RESET",
      detailReasonCode: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
      learnedAddressLimit: 8,
      learnedTopicGroupLimit: 200,
      learnedRangeLimit: 2_000,
      relaxAfterCleanReads: 4,
      previousAddressLimit: 1,
      previousTopicGroupLimit: 100,
      previousRangeLimit: 500,
      msg: "LOOP BSC log-query limits reset to their configured values",
    });

    logger.warn(
      {
        lane: "pool_event",
        learnedAddressLimit: -1,
        learnedTopicGroupLimit: 1.5,
        learnedRangeLimit: Number.NaN,
        relaxAfterCleanReads: "4" as unknown as number,
      },
      "LOOP reconciliation worker infrastructure retry scheduled",
    );
    const line = stderr.mock.calls[1]?.[0] ?? "";
    expect(line).toContain('"lane":"pool_event"');
    expect(line).not.toContain("learned");
    expect(line).not.toContain("relaxAfterCleanReads");
  });

  it("passes behindBlocks (S82d) and the Launch Intent settlement fields (Decision 0080) through, and drops malformed ones", () => {
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-09-25T07:00:00.000Z"),
      writeStderr: stderr,
      writeStdout: stderr,
    });
    logger.warn(
      {
        lane: "erc20_transfer",
        state: "unavailable",
        reasonCode: "BSC_LOG_ARCHIVE_REQUIRED",
        behindBlocks: 10_240,
      },
      "LOOP BSC indexer lane is unavailable",
    );
    expect(stderr.mock.calls[0]?.[0]).toContain('"behindBlocks":10240');
    logger.info(
      {
        lane: "launch_intent_reconcile",
        launchIntentId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
        toState: "reverted",
        reasonCode: "LAUNCH_TX_REVERTED",
      },
      "LOOP launch intent settled from its receipt",
    );
    const settled = JSON.parse(stderr.mock.calls[1]?.[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(settled).toMatchObject({
      lane: "launch_intent_reconcile",
      launchIntentId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
      toState: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
    });
    logger.info(
      {
        lane: "launch_intent_reconcile",
        launchIntentId: "0xabc",
        toState: "gone",
        behindBlocks: -1,
      },
      "LOOP launch intent settled from its receipt",
    );
    const dropped = stderr.mock.calls[2]?.[0] ?? "";
    expect(dropped).not.toContain("launchIntentId");
    expect(dropped).not.toContain("toState");
    expect(dropped).not.toContain("behindBlocks");
  });

  it("passes the voice_room_reaper fields (Decision 0094) through and drops malformed ones", () => {
    const stdout = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-10-08T10:00:00.000Z"),
      writeStdout: stdout,
    });
    const voiceRoomId = "b1ab0c3b-4fb3-483c-be6f-7b98f0ac065b";
    const requestId = "8f9a0c1e-2b3d-4e5f-8a6b-7c8d9e0f1a2b";

    logger.info(
      {
        workerId,
        lane: "voice_room_reaper",
        voiceRoomId,
        reasonCode: "VOICE_ROOM_IDLE_ENDED",
        providerSyncStatus: "confirmed",
        requestId,
      },
      "LOOP voice room reaper ended a room",
    );
    logger.info(
      {
        lane: "voice_room_reaper",
        voiceRoomId: "loop_voice_not-a-uuid",
        requestId: "x",
        providerSyncStatus: "maybe" as "confirmed",
      },
      "LOOP voice room reaper ended a room",
    );

    expect(stdout).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({
        level: "info",
        time: "2026-10-08T10:00:00.000Z",
        service: "loop-reconciliation-worker",
        version: "0.1.0",
        workerId,
        reasonCode: "VOICE_ROOM_IDLE_ENDED",
        lane: "voice_room_reaper",
        voiceRoomId,
        requestId,
        providerSyncStatus: "confirmed",
        msg: "LOOP voice room reaper ended a room",
      })}\n`,
    );
    expect(stdout).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({
        level: "info",
        time: "2026-10-08T10:00:00.000Z",
        service: "loop-reconciliation-worker",
        version: "0.1.0",
        lane: "voice_room_reaper",
        msg: "LOOP voice room reaper ended a room",
      })}\n`,
    );
  });

  it("passes the community_member_buy_feed fields (Decision 0097) through and drops malformed ones", () => {
    const stdout = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-10-08T10:00:00.000Z"),
      writeStdout: stdout,
      writeStderr: stdout,
    });
    const communityId = "0b6a3f0e-9f3c-4d7a-8c41-6a1e2b3c4d5e";
    const messageId = `loop_buy_${"a".repeat(32)}`;
    logger.warn(
      {
        lane: "community_member_buy_feed",
        reasonCode: "MEMBER_BUY_FEED_TRUNCATED",
        communityId,
        truncatedCount: 3,
      },
      "LOOP member buy feed truncated a community's pass",
    );
    logger.info(
      {
        lane: "community_member_buy_feed",
        communityId: "not-a-uuid",
        messageId: "0x4444444444444444444444444444444444444444",
      },
      "LOOP member buy feed posted a message",
    );
    logger.info(
      { lane: "community_member_buy_feed", communityId, messageId },
      "LOOP member buy feed posted a message",
    );

    const lines = stdout.mock.calls.map(
      ([line]) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(lines[0]).toMatchObject({
      lane: "community_member_buy_feed",
      reasonCode: "MEMBER_BUY_FEED_TRUNCATED",
      communityId,
      truncatedCount: 3,
    });
    expect(lines[1]).not.toHaveProperty("communityId");
    expect(lines[1]).not.toHaveProperty("messageId");
    expect(lines[2]).toMatchObject({ communityId, messageId });
  });

  it("emits nothing at the silent level", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "silent",
      serviceVersion: "0.1.0",
      writeStdout: stdout,
      writeStderr: stderr,
    });

    logger.fatal(
      { startupErrorCode: "unknown" },
      "LOOP reconciliation worker failed to start",
    );

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
  it("keeps only safe Hooks executor fields (Decision 0112)", () => {
    const stdout = vi.fn<(line: string) => void>();
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "0.1.0",
      now: () => new Date("2026-10-10T10:00:00.000Z"),
      writeStdout: stdout,
    });
    const txHash = `0x${"ab".repeat(32)}`;
    logger.info(
      {
        lane: "hooks_launch_executor",
        hooksDeploymentJobId: "00000000-0000-4000-8000-000000000011",
        fromStatus: "claimed",
        toStatus: "broadcast",
        step: "broadcast",
        transactionHash: txHash,
        executorAddress: "0x2222222222222222222222222222222222222222",
        confirmations: 3,
      },
      "LOOP hooks launch executor step",
    );
    logger.info(
      {
        lane: "hooks_launch_executor",
        hooksDeploymentJobId: "not-a-uuid",
        fromStatus: "pwned",
        step: "Bad Step!",
        executorAddress: "0xKEY",
        factoryAddress: `0x${"42".repeat(32)}`,
      },
      "LOOP hooks launch executor step",
    );
    const [first, second] = stdout.mock.calls.map(
      ([line]) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(first).toMatchObject({
      lane: "hooks_launch_executor",
      hooksDeploymentJobId: "00000000-0000-4000-8000-000000000011",
      fromStatus: "claimed",
      toStatus: "broadcast",
      step: "broadcast",
      transactionHash: txHash,
      executorAddress: "0x2222222222222222222222222222222222222222",
      confirmations: 3,
    });
    expect(second).toEqual({
      level: "info",
      time: "2026-10-10T10:00:00.000Z",
      service: "loop-reconciliation-worker",
      version: "0.1.0",
      lane: "hooks_launch_executor",
      msg: "LOOP hooks launch executor step",
    });
  });
});
