import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createMemeSaltPoolWorker } from "../src/bsc-meme-indexer-worker.js";
import { loadConfig } from "../src/config.js";
import { createPostgresMemeRepository } from "../src/database/meme-repository.js";

/**
 * `pnpm meme:salt-refill [--target N]` (Decision 0101): runs one tick of the
 * worker's salt-pool lane — frees lapsed draft reservations, then mines
 * CREATE2 salts offline (no chain read) until N free salts (default
 * `MEME_SALT_POOL_TARGET`) end in `MEME_VANITY_SUFFIX`. For the first fill
 * after a deployment, before the worker's lane is switched on. Reads the
 * same `.env.local` as the API; never prints a secret or a URL.
 */

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export async function runMemeSaltRefill(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
}): Promise<number> {
  let target: number | null = null;
  const argv = [...options.argv];
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--target") {
      const value = argv.shift();
      if (value === undefined || !/^[1-9][0-9]{0,3}$/u.test(value)) {
        options.stderr.write("usage: pnpm meme:salt-refill [--target N]\n");
        return 1;
      }
      target = Number(value);
    } else {
      options.stderr.write("usage: pnpm meme:salt-refill [--target N]\n");
      return 1;
    }
  }
  const config = loadConfig(options.environment);
  const contract = config.meme.contract;
  if (contract === null) {
    options.stderr.write(
      `meme:salt-refill refused: ${config.meme.unconfiguredReason ?? "MEME_CONTRACT_NOT_CONFIGURED"}\n`,
    );
    return 1;
  }
  const pool = new pg.Pool({
    application_name: "loop-api-meme-salt-refill",
    connectionString: config.databaseUrl,
    max: 2,
  });
  try {
    const lane = createMemeSaltPoolWorker({
      repository: createPostgresMemeRepository(pool),
      scope: {
        chainId: config.launchChain.chainId,
        contractAddress: contract.address,
        tokenImplementation: contract.tokenImplementation,
        suffix: config.meme.vanitySuffix,
      },
      target: target ?? config.meme.saltPoolTarget,
    });
    const outcome = await lane.runOnce();
    options.stdout.write(
      `meme salt pool: released=${String(outcome["released"])} inserted=${String(outcome["inserted"])} free=${String(outcome["free"])} suffix=${config.meme.vanitySuffix || "(none)"}\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  runMemeSaltRefill({
    argv: process.argv.slice(2),
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `meme:salt-refill failed: ${error instanceof Error ? error.name : "UnknownError"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
