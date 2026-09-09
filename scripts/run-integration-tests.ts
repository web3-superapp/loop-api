/**
 * Runs every `test/*.integration.test.ts` suite against `DATABASE_URL_TEST`.
 *
 * Refuses to start when `DATABASE_URL_TEST` is missing or names a database
 * without `test` in its name. `DATABASE_URL` is removed from the child
 * environment so no suite can silently reach the developer database.
 */
import { spawn } from "node:child_process";
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

const explicitFiles = process.argv.slice(2);
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

const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
delete childEnvironment["DATABASE_URL"];
childEnvironment[INTEGRATION_DATABASE_URL_VARIABLE] = databaseUrl;

const child = spawn(
  process.execPath,
  [
    path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--no-file-parallelism",
    // Suites create throwaway databases and replay every migration; vitest's
    // 5s default is a load-dependent flake source, not an assertion.
    "--testTimeout=60000",
    "--hookTimeout=60000",
    ...suiteFiles,
  ],
  { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
