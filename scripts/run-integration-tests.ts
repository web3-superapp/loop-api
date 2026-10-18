/**
 * Runs every `test/*.integration.test.ts` suite against `DATABASE_URL_TEST`.
 *
 * Refuses to start when `DATABASE_URL_TEST` is missing or names a database
 * without `test` in its name. `DATABASE_URL` is removed from the child
 * environment so no suite can silently reach the developer database.
 *
 * Decision 0159: every suite runs in its own vitest process (one at a time,
 * 38 suites share `DATABASE_URL_TEST`), in its own process group, under a
 * wall-clock budget. The runner prints each suite as it starts and ends, a
 * heartbeat naming the running suite every minute, and on budget expiry
 * kills the whole group (vitest worker plus any anvil/forge it spawned),
 * names the suite as TIMED OUT and carries on. Nothing ever hangs silently.
 *
 * Budget: `INTEGRATION_SUITE_TIMEOUT_MS` (default 20 minutes, above the
 * largest per-test timeout an anvil suite declares). Extra CLI arguments
 * starting with `-` are passed to vitest; the rest are suite files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTEGRATION_DATABASE_URL_VARIABLE,
  integrationDatabaseName,
  requireIntegrationDatabaseUrl,
} from "../test/helpers/integration-database.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let databaseUrl: string;
try {
  databaseUrl = requireIntegrationDatabaseUrl();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`test:integration refused to run: ${message}\n`);
  process.stderr.write(
    `Add ${INTEGRATION_DATABASE_URL_VARIABLE}=postgres://.../loop_api_test to .env.local ` +
      `and run \`pnpm db:migrate:test\` first.\n`,
  );
  process.exit(1);
}

const cliArguments = process.argv.slice(2);
const vitestFlags = cliArguments.filter((value) => value.startsWith("-"));
const explicitFiles = cliArguments.filter((value) => !value.startsWith("-"));
const suiteFiles =
  explicitFiles.length > 0
    ? explicitFiles
    : readdirSync(path.join(repositoryRoot, "test"))
        .filter((name) => name.endsWith(".integration.test.ts"))
        .sort()
        .map((name) => `test/${name}`);

if (suiteFiles.length === 0) {
  process.stderr.write(
    "test:integration found no *.integration.test.ts files\n",
  );
  process.exit(1);
}

process.stdout.write(
  `test:integration → ${integrationDatabaseName(databaseUrl)} ` +
    `(${suiteFiles.length} suites)\n`,
);

const suiteBudgetMs = (() => {
  const raw = process.env["INTEGRATION_SUITE_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return 20 * 60_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    process.stderr.write(
      `test:integration refused to run: INTEGRATION_SUITE_TIMEOUT_MS must be a positive integer\n`,
    );
    process.exit(1);
  }
  return parsed;
})();
const heartbeatMs = 60_000;

const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
delete childEnvironment["DATABASE_URL"];
childEnvironment[INTEGRATION_DATABASE_URL_VARIABLE] = databaseUrl;

type SuiteOutcome = "passed" | "failed" | "timed out";

interface SuiteResult {
  readonly file: string;
  readonly outcome: SuiteOutcome;
  readonly seconds: number;
}

let running: ChildProcess | null = null;

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid: the whole group (vitest, its fork worker, anvil, forge).
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Group already gone.
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (running !== null) killGroup(running);
    process.exit(130);
  });
}

function runSuite(file: string, index: number): Promise<SuiteResult> {
  const label = `[${index + 1}/${suiteFiles.length}] ${file}`;
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  process.stdout.write(`\n▶ ${label}\n`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
        "run",
        // Suites create throwaway databases and replay every migration;
        // vitest's 5s default is a load-dependent flake source, not an
        // assertion. Suites that need longer declare it per hook/test.
        "--testTimeout=60000",
        "--hookTimeout=60000",
        // Bounded worker shutdown: a leaked handle fails the suite instead
        // of keeping the process alive.
        "--teardownTimeout=10000",
        ...vitestFlags,
        file,
      ],
      {
        cwd: repositoryRoot,
        env: childEnvironment,
        stdio: "inherit",
        detached: true,
      },
    );
    running = child;
    let timedOut = false;
    const heartbeat = setInterval(() => {
      process.stdout.write(`… ${label} still running (${elapsed()}s)\n`);
    }, heartbeatMs);
    const watchdog = setTimeout(() => {
      timedOut = true;
      process.stdout.write(
        `\n✖ ${label} TIMED OUT after ${elapsed()}s ` +
          `(INTEGRATION_SUITE_TIMEOUT_MS=${suiteBudgetMs}); killing its process group\n`,
      );
      killGroup(child);
    }, suiteBudgetMs);
    child.on("exit", (code) => {
      clearInterval(heartbeat);
      clearTimeout(watchdog);
      // Reap anything the suite left behind in its group (e.g. an anvil
      // whose afterAll never ran).
      killGroup(child);
      running = null;
      const outcome: SuiteOutcome = timedOut
        ? "timed out"
        : code === 0
          ? "passed"
          : "failed";
      const seconds = elapsed();
      process.stdout.write(
        `${outcome === "passed" ? "✔" : "✖"} ${label} ${outcome} (${seconds}s)\n`,
      );
      resolve({ file, outcome, seconds });
    });
  });
}

const runStarted = Date.now();
const results: SuiteResult[] = [];
for (const [index, file] of suiteFiles.entries()) {
  results.push(await runSuite(file, index));
}

const count = (outcome: SuiteOutcome) =>
  results.filter((result) => result.outcome === outcome).length;
const problems = results.filter((result) => result.outcome !== "passed");
process.stdout.write(
  `\ntest:integration summary: ${count("passed")} passed, ${count("failed")} failed, ` +
    `${count("timed out")} timed out of ${results.length} suites in ` +
    `${Math.round((Date.now() - runStarted) / 1000)}s\n`,
);
for (const problem of problems) {
  process.stdout.write(
    `  ${problem.outcome}: ${problem.file} (${problem.seconds}s)\n`,
  );
}
process.exit(problems.length === 0 ? 0 : 1);
