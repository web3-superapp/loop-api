import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import type { ChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  buildMiningDevBaselineDocuments,
  miningDevBaselineConfigVersion,
} from "../src/features/mining/mining-dev-baseline.js";
import {
  MiningFormulaExistsError,
  type MiningFormulaRecord,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";

/**
 * Dev-only operator path that creates the Development Mining baseline
 * version (Decision 0043): `pnpm mining:dev-baseline --confirm`.
 *
 * It reads the registered, non-blocked BSC assets, writes
 * `miningFormula-devBaseline-…` as `pending_approval` with every asset at
 * weight 1, the documented community range, and the placeholder daily
 * budget, and stops there. Approval is a second explicit step
 * (`pnpm mining:approve-formula <configVersion> --confirm`). The script
 * requires `--confirm`, refuses `NODE_ENV=production` before opening a
 * connection, and refuses to overwrite an existing version.
 */

export type MiningDevBaselineErrorCode =
  | "mining_dev_baseline_arguments_invalid"
  | "mining_dev_baseline_confirmation_required"
  | "mining_dev_baseline_database_unconfigured"
  | "mining_dev_baseline_forbidden_in_production"
  | "mining_dev_baseline_exists"
  | "mining_dev_baseline_no_registered_assets"
  | "mining_dev_baseline_failed";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningDevBaselineRepositories = (databaseUrl: string) => {
  readonly mining: Pick<MiningRepository, "createFormulaVersion">;
  readonly registry: Pick<ChainRegistryRepository, "listReadableAssets">;
  readonly close: () => Promise<void>;
};

export interface RunMiningDevBaselineOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepositories?: CreateMiningDevBaselineRepositories;
}

export class MiningDevBaselineError extends Error {
  constructor(readonly code: MiningDevBaselineErrorCode) {
    super("Mining dev baseline creation failed");
    this.name = "MiningDevBaselineError";
  }
}

function defaultCreateRepositories(databaseUrl: string): {
  readonly mining: MiningRepository;
  readonly registry: ChainRegistryRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-mining-dev-baseline",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    mining: createPostgresMiningRepository(pool),
    registry: createPostgresChainRegistryRepository(pool),
    close: () => pool.end(),
  };
}

export interface MiningDevBaselineRequest {
  readonly databaseUrl: string;
}

export function parseMiningDevBaselineRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningDevBaselineRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new MiningDevBaselineError(
      "mining_dev_baseline_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  const confirmed = args.includes("--confirm");
  if (args.some((arg) => arg !== "--confirm")) {
    throw new MiningDevBaselineError("mining_dev_baseline_arguments_invalid");
  }
  if (!confirmed) {
    throw new MiningDevBaselineError(
      "mining_dev_baseline_confirmation_required",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningDevBaselineError(
      "mining_dev_baseline_database_unconfigured",
    );
  }
  return Object.freeze({ databaseUrl });
}

export async function createMiningDevBaseline(
  request: MiningDevBaselineRequest,
  createRepositories: CreateMiningDevBaselineRepositories = defaultCreateRepositories,
): Promise<{
  readonly record: MiningFormulaRecord;
  readonly assetIds: readonly string[];
}> {
  const { mining, registry, close } = createRepositories(request.databaseUrl);
  try {
    const assets = await registry.listReadableAssets(bscChainId);
    const assetIds = assets.map((asset) => asset.assetId);
    if (assetIds.length === 0) {
      throw new MiningDevBaselineError(
        "mining_dev_baseline_no_registered_assets",
      );
    }
    const documents = buildMiningDevBaselineDocuments(assetIds);
    try {
      const record = await mining.createFormulaVersion({
        configVersion: documents.configVersion,
        formula: documents.formula,
        weightRange: documents.weightRange,
        priceGuardRules: documents.priceGuardRules,
        requestId: randomUUID(),
      });
      return { record, assetIds: Object.freeze(assetIds) };
    } catch (error) {
      if (error instanceof MiningFormulaExistsError) {
        throw new MiningDevBaselineError("mining_dev_baseline_exists");
      }
      throw error;
    }
  } finally {
    await close();
  }
}

export async function runMiningDevBaseline(
  options: RunMiningDevBaselineOptions,
): Promise<0 | 1> {
  let request: MiningDevBaselineRequest;
  try {
    request = parseMiningDevBaselineRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof MiningDevBaselineError
        ? error.code
        : "mining_dev_baseline_failed";
    options.stderr.write(`Mining dev baseline refused (${code})\n`);
    return 1;
  }
  try {
    const { record, assetIds } = await createMiningDevBaseline(
      request,
      options.createRepositories,
    );
    const dailyOutput = record.formula.dailyOutput;
    options.stdout.write(
      `Mining formula ${record.configVersion} is ${record.status} ` +
        `(scope ${record.formula.scope ?? "product"}, ${assetIds.length} asset(s) at weight 1, ` +
        `community range ${record.weightRange.community.range?.min ?? "?"}-${record.weightRange.community.range?.max ?? "?"}, ` +
        `daily output ${dailyOutput?.budget ?? "?"} ${dailyOutput?.status ?? ""})\n` +
        `Approve it with: pnpm mining:approve-formula ${miningDevBaselineConfigVersion} --confirm\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof MiningDevBaselineError
        ? error.code
        : "mining_dev_baseline_failed";
    options.stderr.write(`Mining dev baseline failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runMiningDevBaseline({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
