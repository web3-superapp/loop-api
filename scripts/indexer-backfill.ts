import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  createBscIndexerWorker,
  type BscIndexerRunResult,
} from "../src/bsc-indexer-worker.js";
import { createBscPoolIndexerWorker } from "../src/bsc-pool-indexer-worker.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  createPostgresBscIndexerRepository,
  indexerLanes,
  type IndexerLane,
} from "../src/database/bsc-indexer-repository.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createBscReadClient } from "../src/integrations/bsc/rpc-client.js";

/**
 * Dev-only backfill for the `erc20_transfer` lane (Decision 0033) and the
 * `pool_event` lane (Decision 0034).
 *
 * It runs the same lane the worker runs, one segment at a time, until the lane
 * reaches the chain head. `--from` seeds a brand-new lane; it never rewrites an
 * existing checkpoint, so a running worker and a backfill cannot disagree about
 * where the lane is.
 *
 * Usage: `pnpm indexer:backfill --from <block> [--lane erc20_transfer|pool_event]`
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
  readonly lane: IndexerLane;
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
  const laneIndex = positional.indexOf("--lane");
  const rawLane =
    laneIndex === -1 ? "erc20_transfer" : positional[laneIndex + 1];
  const expectedLength = laneIndex === -1 ? 2 : 4;
  if (
    fromIndex === -1 ||
    positional.length !== expectedLength ||
    rawFrom === undefined ||
    !/^(0|[1-9][0-9]{0,15})$/.test(rawFrom) ||
    rawLane === undefined ||
    !(indexerLanes as readonly string[]).includes(rawLane)
  ) {
    throw new IndexerBackfillError("indexer_backfill_arguments_invalid");
  }
  const lane = rawLane as IndexerLane;

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
    lane,
    fromBlockNumber: Number.parseInt(rawFrom, 10),
    maximumSegments: defaultMaximumSegments,
    config,
  });
}

export interface BackfillSegmentResult {
  readonly kind: BscIndexerRunResult["kind"];
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly rowCount: number;
  readonly reasonCode: string | null;
}

export async function runBackfill(
  request: IndexerBackfillRequest,
  onSegment: (result: BackfillSegmentResult) => void,
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
    const laneOptions = {
      repository: createPostgresBscIndexerRepository(pool),
      registry: createPostgresChainRegistryRepository(pool),
      readClient: createBscReadClient({ config: chainConfig }),
      chainId: bscChainId,
      startBlockNumber: request.fromBlockNumber,
    };
    const runOnce: () => Promise<BackfillSegmentResult> =
      request.lane === "pool_event"
        ? (() => {
            const worker = createBscPoolIndexerWorker(laneOptions);
            return async () => {
              const result = await worker.runOnce();
              return { ...result, rowCount: result.eventCount };
            };
          })()
        : (() => {
            const worker = createBscIndexerWorker(laneOptions);
            return async () => {
              const result = await worker.runOnce();
              return { ...result, rowCount: result.transferCount };
            };
          })();
    for (let segment = 0; segment < request.maximumSegments; segment += 1) {
      const result = await runOnce();
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
        `${request.lane} ${result.kind} ${result.fromBlockNumber ?? "-"}..${result.toBlockNumber ?? "-"} rows=${String(result.rowCount)} reason=${result.reasonCode ?? "none"}\n`,
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
