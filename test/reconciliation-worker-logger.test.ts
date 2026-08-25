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
