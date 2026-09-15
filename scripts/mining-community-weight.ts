import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { isUnsignedDecimalString } from "../src/features/mining/mining-contract.js";
import {
  MiningCommunityAssetNotBoundError,
  MiningCommunityNotFoundError,
  MiningCommunityWeightConflictError,
  MiningFormulaNotFoundError,
  MiningFormulaStateError,
  MiningWeightOutOfRangeError,
  type CommunityWeightRecord,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";

/**
 * Dev-only operator path that records a community's reviewed Mining weight
 * (Decision 0043):
 * `pnpm mining:community-weight <communityId> <weight> --confirm [--config-version <v>]`.
 *
 * This is the only path that writes `community_mining_weights`; no read
 * path defaults a weight. The weight must lie inside the version's
 * documented community range, the community must have a bound asset, and
 * no other community may already carry an approved weight on that asset
 * under the same version. Without `--config-version` the version in force
 * (the approved one) is used. Refuses `NODE_ENV=production` before opening
 * a connection.
 */

export type MiningCommunityWeightErrorCode =
  | "mining_weight_arguments_invalid"
  | "mining_weight_confirmation_required"
  | "mining_weight_database_unconfigured"
  | "mining_weight_forbidden_in_production"
  | "mining_weight_no_approved_version"
  | "mining_weight_version_not_found"
  | "mining_weight_version_retired"
  | "mining_weight_out_of_range"
  | "mining_weight_community_not_found"
  | "mining_weight_asset_not_bound"
  | "mining_weight_asset_conflict"
  | "mining_weight_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const configVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningCommunityWeightRepository = (databaseUrl: string) => {
  readonly repository: Pick<
    MiningRepository,
    "setCommunityWeight" | "getApprovedFormula"
  >;
  readonly close: () => Promise<void>;
};

export interface RunMiningCommunityWeightOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateMiningCommunityWeightRepository;
}

export class MiningCommunityWeightError extends Error {
  constructor(readonly code: MiningCommunityWeightErrorCode) {
    super("Mining community weight failed");
    this.name = "MiningCommunityWeightError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: MiningRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-mining-community-weight",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresMiningRepository(pool),
    close: () => pool.end(),
  };
}

export interface MiningCommunityWeightRequest {
  readonly communityId: string;
  readonly weight: string;
  /** Null selects the approved version at run time. */
  readonly configVersion: string | null;
  readonly databaseUrl: string;
}

export function parseMiningCommunityWeightRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningCommunityWeightRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new MiningCommunityWeightError(
      "mining_weight_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  const positional: string[] = [];
  let confirmed = false;
  let configVersion: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm") {
      confirmed = true;
    } else if (arg === "--config-version") {
      const value = args[index + 1];
      if (
        value === undefined ||
        !configVersionPattern.test(value) ||
        configVersion !== null
      ) {
        throw new MiningCommunityWeightError("mining_weight_arguments_invalid");
      }
      configVersion = value;
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new MiningCommunityWeightError("mining_weight_arguments_invalid");
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  const [communityId, weight] = positional;
  if (
    positional.length !== 2 ||
    communityId === undefined ||
    !opaqueIdPattern.test(communityId) ||
    !isUnsignedDecimalString(weight)
  ) {
    throw new MiningCommunityWeightError("mining_weight_arguments_invalid");
  }
  if (!confirmed) {
    throw new MiningCommunityWeightError("mining_weight_confirmation_required");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningCommunityWeightError("mining_weight_database_unconfigured");
  }
  return Object.freeze({ communityId, weight, configVersion, databaseUrl });
}

function translate(error: unknown): never {
  if (error instanceof MiningFormulaNotFoundError) {
    throw new MiningCommunityWeightError("mining_weight_version_not_found");
  }
  if (error instanceof MiningFormulaStateError) {
    throw new MiningCommunityWeightError("mining_weight_version_retired");
  }
  if (error instanceof MiningWeightOutOfRangeError) {
    throw new MiningCommunityWeightError("mining_weight_out_of_range");
  }
  if (error instanceof MiningCommunityNotFoundError) {
    throw new MiningCommunityWeightError("mining_weight_community_not_found");
  }
  if (error instanceof MiningCommunityAssetNotBoundError) {
    throw new MiningCommunityWeightError("mining_weight_asset_not_bound");
  }
  if (error instanceof MiningCommunityWeightConflictError) {
    throw new MiningCommunityWeightError("mining_weight_asset_conflict");
  }
  throw error;
}

export async function setMiningCommunityWeight(
  request: MiningCommunityWeightRequest,
  createRepository: CreateMiningCommunityWeightRepository = defaultCreateRepository,
): Promise<CommunityWeightRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    let configVersion = request.configVersion;
    if (configVersion === null) {
      const approved = await repository.getApprovedFormula();
      if (approved === null) {
        throw new MiningCommunityWeightError(
          "mining_weight_no_approved_version",
        );
      }
      configVersion = approved.configVersion;
    }
    try {
      return await repository.setCommunityWeight({
        communityId: request.communityId,
        weight: request.weight,
        configVersion,
        requestId: randomUUID(),
      });
    } catch (error) {
      return translate(error);
    }
  } finally {
    await close();
  }
}

export async function runMiningCommunityWeight(
  options: RunMiningCommunityWeightOptions,
): Promise<0 | 1> {
  let request: MiningCommunityWeightRequest;
  try {
    request = parseMiningCommunityWeightRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof MiningCommunityWeightError
        ? error.code
        : "mining_weight_failed";
    options.stderr.write(`Mining community weight refused (${code})\n`);
    return 1;
  }
  try {
    const record = await setMiningCommunityWeight(
      request,
      options.createRepository,
    );
    options.stdout.write(
      `Community ${record.communityId} (${record.communityName}) weight ${record.weight ?? "?"} ` +
        `is ${record.status} under ${record.configVersion ?? "?"} on ${record.boundAssetId ?? "?"}\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof MiningCommunityWeightError
        ? error.code
        : "mining_weight_failed";
    options.stderr.write(`Mining community weight failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runMiningCommunityWeight({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
