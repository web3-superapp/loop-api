import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import {
  MiningFormulaNotFoundError,
  MiningFormulaSelfApprovalError,
  MiningFormulaStateError,
  type MiningFormulaCliApproval,
  type MiningFormulaRecord,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";

/**
 * Break-glass operator path that approves a Mining formula version
 * (Decisions 0036, 0111):
 *
 *   pnpm mining:approve-formula <configVersion> --confirm \
 *     --approved-by <name> --reason <text> [--i-know-this-bypasses-review]
 *
 * Approval is the only thing that lets the `mining-snapshot` lane compute.
 * The console route (reviewer, Decision 0110) is the normal channel; this
 * CLI leaves a separation-of-duties trail instead of skipping it:
 * `--approved-by` (the person on duty: name or staff number, account-name
 * characters) and `--reason` are required; the version records
 * `approved_by = cli:<name>`; a draft saved by the same name is refused; the
 * `mining.formula.approve` audit row (actor `cli`) lands in the approving
 * transaction. With `NODE_ENV=production` it also needs
 * `--i-know-this-bypasses-review`, and the audit row says `bypass: true`.
 * Any other approved version is retired and `effectiveAt` is set.
 */

export type MiningApproveFormulaErrorCode =
  | "mining_approve_arguments_invalid"
  | "mining_approve_confirmation_required"
  | "mining_approve_approver_required"
  | "mining_approve_reason_required"
  | "mining_approve_database_unconfigured"
  | "mining_approve_forbidden_in_production"
  | "mining_approve_self_approval"
  | "mining_approve_not_found"
  | "mining_approve_state_invalid"
  | "mining_approve_failed";

const configVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const approvedByPattern = /^[A-Za-z0-9._@-]{1,60}$/u;
const forbiddenReasonCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const miningApproveReasonMaximumLength = 500;
export const miningApproveBypassFlag = "--i-know-this-bypasses-review";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningApproveRepository = (databaseUrl: string) => {
  readonly repository: Pick<
    MiningRepository,
    "approveFormula" | "recordFormulaApprovalRefusal"
  >;
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
  readonly approval: MiningFormulaCliApproval;
}

/** `--name value` once; a missing value or a repeat is invalid. */
function optionValue(
  args: string[],
  name: string,
): { readonly value: string | null; readonly rest: string[] } {
  const indexes = args.flatMap((arg, index) => (arg === name ? [index] : []));
  if (indexes.length === 0) {
    return { value: null, rest: args };
  }
  const index = indexes[0]!;
  const value = args[index + 1];
  if (indexes.length > 1 || value === undefined || value.startsWith("--")) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  return {
    value,
    rest: args.filter(
      (_, position) => position !== index && position !== index + 1,
    ),
  };
}

export function parseMiningApproveFormulaRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningApproveFormulaRequest {
  const production = environment["NODE_ENV"]?.trim() === "production";
  let args = argv.slice(2);
  const approvedByOption = optionValue(args, "--approved-by");
  args = approvedByOption.rest;
  const reasonOption = optionValue(args, "--reason");
  args = reasonOption.rest;
  const flags = new Set(["--confirm", miningApproveBypassFlag]);
  const confirmed = args.includes("--confirm");
  const bypassRequested = args.includes(miningApproveBypassFlag);
  if (
    args.filter((arg) => flags.has(arg)).length !==
    new Set(args.filter((arg) => flags.has(arg))).size
  ) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  const positional = args.filter((arg) => !flags.has(arg));
  const configVersion = positional[0];
  if (
    positional.length !== 1 ||
    configVersion === undefined ||
    !configVersionPattern.test(configVersion)
  ) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  if (approvedByOption.value === null) {
    throw new MiningApproveFormulaError("mining_approve_approver_required");
  }
  if (!approvedByPattern.test(approvedByOption.value)) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  const reason = reasonOption.value?.trim() ?? "";
  if (reason === "") {
    throw new MiningApproveFormulaError("mining_approve_reason_required");
  }
  if (
    Array.from(reason).length > miningApproveReasonMaximumLength ||
    forbiddenReasonCharacters.test(reason)
  ) {
    throw new MiningApproveFormulaError("mining_approve_arguments_invalid");
  }
  if (!confirmed) {
    throw new MiningApproveFormulaError("mining_approve_confirmation_required");
  }
  if (production && !bypassRequested) {
    throw new MiningApproveFormulaError(
      "mining_approve_forbidden_in_production",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningApproveFormulaError("mining_approve_database_unconfigured");
  }
  return Object.freeze({
    configVersion,
    databaseUrl,
    approval: Object.freeze({
      approvedBy: approvedByOption.value,
      reason,
      // Only production skips the reviewer gate the console enforces there.
      bypass: production,
    }),
  });
}

function refusalCode(error: unknown): MiningApproveFormulaErrorCode {
  if (error instanceof MiningFormulaSelfApprovalError) {
    return "mining_approve_self_approval";
  }
  if (error instanceof MiningFormulaNotFoundError) {
    return "mining_approve_not_found";
  }
  if (error instanceof MiningFormulaStateError) {
    return "mining_approve_state_invalid";
  }
  return "mining_approve_failed";
}

export async function approveMiningFormula(
  request: MiningApproveFormulaRequest,
  createRepository: CreateMiningApproveRepository = defaultCreateRepository,
): Promise<MiningFormulaRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  const requestId = randomUUID();
  try {
    return await repository.approveFormula({
      configVersion: request.configVersion,
      requestId,
      approval: request.approval,
    });
  } catch (error) {
    const code = refusalCode(error);
    if (code !== "mining_approve_failed") {
      // The refused attempt is part of the trail too (best effort).
      await repository.recordFormulaApprovalRefusal({
        configVersion: request.configVersion,
        requestId,
        approval: request.approval,
        reasonCode: code,
      });
      throw new MiningApproveFormulaError(code);
    }
    throw error;
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
      `Mining formula ${record.configVersion} is ${record.status} (effective ${record.effectiveAt ?? "n/a"}; approved by cli:${request.approval.approvedBy}${request.approval.bypass ? "; review bypassed" : ""})\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof MiningApproveFormulaError
        ? error.code
        : "mining_approve_failed";
    options.stderr.write(`Mining formula approval failed (${code})\n`);
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
