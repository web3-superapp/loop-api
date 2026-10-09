import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import type {
  MiningFormulaRecord,
  MiningRepository,
} from "../src/features/mining/mining-repository.js";

/**
 * Dev-only operator path that approves a Mining formula version
 * (Decision 0036): `pnpm mining:approve-formula <configVersion> --confirm`.
 *
 * Approval is the only thing that lets the `mining-snapshot` lane compute.
 * It requires the explicit `--confirm` flag, refuses to run with
 * `NODE_ENV=production` (the formula, weights, price guard, and reward
 * budget need a product/legal freeze first — 03 §19), retires any other
 * approved version, and sets `effectiveAt`.
 */

export type MiningApproveFormulaErrorCode =
  | "mining_approve_arguments_invalid"
  | "mining_approve_confirmation_required"
  | "mining_approve_database_unconfigured"
  | "mining_approve_forbidden_in_production"
  | "mining_approve_failed";

const configVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningApproveRepository = (databaseUrl: string) => {
  readonly repository: Pick<MiningRepository, "approveFormula">;
  readonly close: () => Promise<void>;
};

export interface RunMiningApproveFormulaOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateMiningApproveRepository;
}

export class MiningApproveFormulaError extends Error {
  constructor(readonly code: MiningApproveFormulaErrorCode) {
    super("Mining formula approval failed");
    this.name = "MiningApproveFormulaError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: MiningRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-mining-approve-formula",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresMiningRepository(pool),
    close: () => pool.end(),
  };
}

export interface MiningApproveFormulaRequest {
  readonly configVersion: string;
  readonly databaseUrl: string;
}

export function parseMiningApproveFormulaRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningApproveFormulaRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new MiningApproveFormulaError(
      "mining_approve_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  const confirmed = args.includes("--confirm");
  const positional = args.filter((arg) => arg !== "--confirm");
  const configVersion = positional[0];
  if (
    positional.length !== 1 ||
    configVersion === undefined ||
    !configVersionPattern.test(configVersion)
  ) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  if (!confirmed) {
    throw new MiningApproveFormulaError("mining_approve_confirmation_required");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningApproveFormulaError("mining_approve_database_unconfigured");
  }
  return Object.freeze({ configVersion, databaseUrl });
}

export async function approveMiningFormula(
  request: MiningApproveFormulaRequest,
  createRepository: CreateMiningApproveRepository = defaultCreateRepository,
): Promise<MiningFormulaRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.approveFormula({
      configVersion: request.configVersion,
      requestId: randomUUID(),
    });
  } finally {
    await close();
  }
}

export async function runMiningApproveFormula(
  options: RunMiningApproveFormulaOptions,
): Promise<0 | 1> {
  let request: MiningApproveFormulaRequest;
  try {
    request = parseMiningApproveFormulaRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof MiningApproveFormulaError
        ? error.code
        : "mining_approve_failed";
    options.stderr.write(`Mining formula approval refused (${code})\n`);
    return 1;
  }
  try {
    const record = await approveMiningFormula(
      request,
      options.createRepository,
    );
    options.stdout.write(
      `Mining formula ${record.configVersion} is ${record.status} (effective ${record.effectiveAt ?? "n/a"})\n`,
    );
    return 0;
  } catch {
    options.stderr.write(
      "Mining formula approval failed (mining_approve_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runMiningApproveFormula({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
