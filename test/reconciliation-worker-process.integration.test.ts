import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

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

describe("standalone reconciliation worker process", () => {
  it("starts against PostgreSQL and exits cleanly on SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/reconciliation-worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          LOG_LEVEL: "info",
          DATABASE_URL: databaseUrl,
        },
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
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    }
  }, 10_000);
});
