import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig } from "../src/config.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createPostgresMarketFactCacheRepository } from "../src/database/market-fact-cache-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createMarketFactService } from "../src/features/market/market-fact-service.js";
import { createMarketProviders } from "../src/integrations/market/provider-factory.js";
import {
  createMiningSnapshotWorker,
  type CreateMiningSnapshotWorkerOptions,
  type MiningSnapshotRunResult,
} from "../src/mining-snapshot-worker.js";

/**
 * Dev-only operator path that runs the `mining-snapshot` lane exactly once
 * (Decision 0043): `pnpm mining:snapshot --confirm`.
 *
 * It composes the same repository, registry, and fresh-price reader the
 * standalone worker uses and calls the lane's `runOnce`. Nothing is
 * different from a worker tick: no approved formula → idle; a skipped asset
 * is reported with its reason; a run that cannot value a held asset is
 * recorded as an incomplete attempt and exits 1 (Decision 0057); the
 * snapshot is written only when the pure computation succeeds. Refuses
 * `NODE_ENV=production` before opening a connection.
 */

export type MiningSnapshotScriptErrorCode =
  | "mining_snapshot_arguments_invalid"
  | "mining_snapshot_confirmation_required"
  | "mining_snapshot_database_unconfigured"
  | "mining_snapshot_forbidden_in_production"
  | "mining_snapshot_failed";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningSnapshotDependencies = (
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
) => {
  readonly dependencies: Omit<CreateMiningSnapshotWorkerOptions, "createUuid">;
  readonly close: () => Promise<void>;
};

export interface RunMiningSnapshotOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createDependencies?: CreateMiningSnapshotDependencies;
}

export class MiningSnapshotScriptError extends Error {
  constructor(readonly code: MiningSnapshotScriptErrorCode) {
    super("Mining snapshot run failed");
    this.name = "MiningSnapshotScriptError";
  }
}

function defaultCreateDependencies(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
): ReturnType<CreateMiningSnapshotDependencies> {
  const config = loadConfig(environment);
  const pool = new pg.Pool({
    application_name: "loop-api-mining-snapshot",
    connectionString: databaseUrl,
    max: 2,
  });
  return {
    dependencies: {
      repository: createPostgresMiningRepository(pool),
      registry: createPostgresChainRegistryRepository(pool),
      prices: createMarketFactService({
        config: config.market,
        cache: createPostgresMarketFactCacheRepository(pool),
        pairsProvider: createMarketProviders(config.market, "worker").pairs,
        securityProvider: null,
        candlesProvider: null,
      }),
    },
    close: () => pool.end(),
  };
}

export interface MiningSnapshotRequest {
  readonly databaseUrl: string;
}

export function parseMiningSnapshotRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningSnapshotRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new MiningSnapshotScriptError(
      "mining_snapshot_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  if (args.some((arg) => arg !== "--confirm")) {
    throw new MiningSnapshotScriptError("mining_snapshot_arguments_invalid");
  }
  if (!args.includes("--confirm")) {
    throw new MiningSnapshotScriptError(
      "mining_snapshot_confirmation_required",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningSnapshotScriptError(
      "mining_snapshot_database_unconfigured",
    );
  }
  return Object.freeze({ databaseUrl });
}

export async function runMiningSnapshotOnce(
  request: MiningSnapshotRequest,
  environment: NodeJS.ProcessEnv,
  createDependencies: CreateMiningSnapshotDependencies = defaultCreateDependencies,
): Promise<MiningSnapshotRunResult> {
  const { dependencies, close } = createDependencies(
    request.databaseUrl,
    environment,
  );
  try {
    return await createMiningSnapshotWorker(dependencies).runOnce();
  } finally {
    await close();
  }
}

export async function runMiningSnapshot(
  options: RunMiningSnapshotOptions,
): Promise<0 | 1> {
  let request: MiningSnapshotRequest;
  try {
    request = parseMiningSnapshotRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof MiningSnapshotScriptError
        ? error.code
        : "mining_snapshot_failed";
    options.stderr.write(`Mining snapshot refused (${code})\n`);
    return 1;
  }
  try {
    const result = await runMiningSnapshotOnce(
      request,
      options.environment,
      options.createDependencies,
    );
    const list = (items: readonly { assetId: string; reasonCode: string }[]) =>
      items.map((item) => `${item.assetId} (${item.reasonCode})`).join(", ");
    const skipped =
      result.skipped.length === 0 ? "" : `; skipped ${list(result.skipped)}`;
    options.stdout.write(
      result.kind === "snapshotted"
        ? `Mining snapshot ${result.snapshotId ?? "?"} written with ${result.powerRowCount} power row(s)${skipped}\n`
        : result.kind === "incomplete"
          ? `Mining snapshot attempt ${result.snapshotId ?? "?"} incomplete (${result.reasonCode ?? "n/a"}); nothing published; unread ${list(result.unread)}${skipped}\n`
          : `Mining snapshot lane ${result.kind} (${result.reasonCode ?? "n/a"})${skipped}\n`,
    );
    return result.kind === "snapshotted" ? 0 : 1;
  } catch {
    options.stderr.write("Mining snapshot failed (mining_snapshot_failed)\n");
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runMiningSnapshot({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
