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
});
