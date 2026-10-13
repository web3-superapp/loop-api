import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const databaseUrl = requireIntegrationDatabaseUrl();

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5_000);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The child gets a fixed environment instead of `...process.env`: the
 * integration runner loads `.env.local`, so inheriting it made the worker's
 * lane set (Stream, BSC RPC, Provider keys) depend on the developer's
 * checkout. Only the process plumbing variables are passed through.
 */
function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: databaseUrl,
    HYPERLIQUID_RECONCILIATION_READS_ENABLED: "false",
    HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED: "false",
  };
}

/**
 * The worker logger writes `warn` and above to stderr. With optional
 * Providers unconfigured, lanes that need them log one fail-closed
 * "stays idle" warn at startup (e.g. `VOICE_ROOM_REAPER_STREAM_NOT_CONFIGURED`);
 * that is the intended unavailable behaviour, not a failure. Injecting fake
 * Stream credentials instead would switch those lanes on and let them call
 * Stream with a bogus key. So stderr may carry only structured `warn` lines
 * whose reason code ends in `_NOT_CONFIGURED`; any `error`/`fatal` line, any
 * other warn, or any unstructured output fails the test.
 */
function unexpectedStderrLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return true;
      }
      if (typeof entry !== "object" || entry === null) return true;
      const record = entry as Record<string, unknown>;
      return !(
        record["level"] === "warn" &&
        record["service"] === "loop-reconciliation-worker" &&
        typeof record["reasonCode"] === "string" &&
        record["reasonCode"].endsWith("_NOT_CONFIGURED")
      );
    });
}

describe("standalone reconciliation worker process", () => {
  it("starts against PostgreSQL and exits cleanly on SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/reconciliation-worker.ts"],
      {
        cwd: process.cwd(),
        env: workerEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let started = false;
    let resolveStarted: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (
        !started &&
        stdout.includes('"msg":"LOOP reconciliation worker started"')
      ) {
        started = true;
        resolveStarted?.();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await withTimeout(
        Promise.race([
          startedPromise,
          exitPromise.then(({ code, signal }) => {
            throw new Error(
              `worker exited before startup (code=${String(code)}, signal=${String(signal)})`,
            );
          }),
        ]),
        "worker process did not start in time",
      );
      expect(child.kill("SIGTERM")).toBe(true);
      const exit = await withTimeout(
        exitPromise,
        "worker process did not stop in time",
      );

      expect(exit).toEqual({ code: 0, signal: null });
      expect(stdout).toContain('"msg":"LOOP reconciliation worker stopped"');
      expect(unexpectedStderrLines(stderr)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    }
  }, 10_000);
});
