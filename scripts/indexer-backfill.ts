import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  createBscIndexerWorker,
  type BscIndexerRunResult,
} from "../src/bsc-indexer-worker.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createPostgresBscIndexerRepository } from "../src/database/bsc-indexer-repository.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createBscReadClient } from "../src/integrations/bsc/rpc-client.js";

/**
 * Dev-only backfill for the `erc20_transfer` lane (Decision 0033).
 *
 * It runs the same lane the worker runs, one segment at a time, until the lane
 * reaches the chain head. `--from` seeds a brand-new lane; it never rewrites an
 * existing checkpoint, so a running worker and a backfill cannot disagree about
 * where the lane is.
 *
 * Usage: `pnpm indexer:backfill --from <block>`
 */

export type IndexerBackfillErrorCode =
  | "indexer_backfill_arguments_invalid"
  | "indexer_backfill_chain_unconfigured"
  | "indexer_backfill_database_unconfigured"
  | "indexer_backfill_failed";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export class IndexerBackfillError extends Error {
  constructor(readonly code: IndexerBackfillErrorCode) {
    super("Indexer backfill failed");
    this.name = "IndexerBackfillError";
  }
}

export interface IndexerBackfillRequest {
  readonly fromBlockNumber: number;
  readonly maximumSegments: number;
  readonly config: AppConfig;
}

const defaultMaximumSegments = 1_000;

export function parseIndexerBackfillRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): IndexerBackfillRequest {
  const positional = argv.slice(2);
  const fromIndex = positional.indexOf("--from");
  const rawFrom = fromIndex === -1 ? undefined : positional[fromIndex + 1];
  if (
    fromIndex !== 0 ||
    positional.length !== 2 ||
    rawFrom === undefined ||
    !/^(0|[1-9][0-9]{0,15})$/.test(rawFrom)
  ) {
    throw new IndexerBackfillError("indexer_backfill_arguments_invalid");
  }

  let config: AppConfig;
  try {
    config = loadConfig(environment);
  } catch {
    throw new IndexerBackfillError("indexer_backfill_database_unconfigured");
  }
  if (config.bscChain === null) {
    throw new IndexerBackfillError("indexer_backfill_chain_unconfigured");
  }

  return Object.freeze({
    fromBlockNumber: Number.parseInt(rawFrom, 10),
    maximumSegments: defaultMaximumSegments,
    config,
  });
}

export async function runBackfill(
  request: IndexerBackfillRequest,
  onSegment: (result: BscIndexerRunResult) => void,
): Promise<void> {
  const chainConfig = request.config.bscChain;
  if (chainConfig === null) {
    throw new IndexerBackfillError("indexer_backfill_chain_unconfigured");
  }
  const pool = new pg.Pool({
    application_name: "loop-api-indexer-backfill",
    connectionString: request.config.databaseUrl,
    max: 1,
  });
  try {
    const worker = createBscIndexerWorker({
      repository: createPostgresBscIndexerRepository(pool),
      registry: createPostgresChainRegistryRepository(pool),
      readClient: createBscReadClient({ config: chainConfig }),
      chainId: bscChainId,
      startBlockNumber: request.fromBlockNumber,
    });
    for (let segment = 0; segment < request.maximumSegments; segment += 1) {
      const result = await worker.runOnce();
      onSegment(result);
      if (result.kind !== "advanced" && result.kind !== "seeded") {
        return;
      }
    }
  } finally {
    await pool.end();
  }
}

export async function runIndexerBackfill(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly backfill?: typeof runBackfill;
}): Promise<0 | 1> {
  let request: IndexerBackfillRequest;
  try {
    request = parseIndexerBackfillRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof IndexerBackfillError
        ? error.code
        : "indexer_backfill_failed";
    options.stderr.write(`Indexer backfill refused (${code})\n`);
    return 1;
  }

  try {
    const backfill = options.backfill ?? runBackfill;
    await backfill(request, (result) => {
      options.stdout.write(
        `${result.kind} ${result.fromBlockNumber ?? "-"}..${result.toBlockNumber ?? "-"} transfers=${String(result.transferCount)} reason=${result.reasonCode ?? "none"}\n`,
      );
    });
    return 0;
  } catch {
    options.stderr.write("Indexer backfill failed (indexer_backfill_failed)\n");
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runIndexerBackfill({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
