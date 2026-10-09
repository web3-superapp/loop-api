import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { miningReasonCodes } from "../src/features/mining/mining-contract.js";
import {
  MiningSnapshotNotFoundError,
  type InvalidateMiningSnapshotsResult,
  type InvalidateMiningSnapshotsSelector,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";

/**
 * Dev-only operator path that withdraws published Mining snapshots
 * (Decision 0057):
 *
 *   pnpm mining:invalidate-snapshots --after <snapshotId> [--reason CODE] --confirm
 *   pnpm mining:invalidate-snapshots <snapshotId> [<snapshotId> …] [--reason CODE] --confirm
 *
 * A withdrawn snapshot is never read as the latest one again; the rows and
 * their power rows are kept (the reward ledger may reference them). The
 * anchor of `--after` stays valid and every complete snapshot computed
 * after it is invalidated. The default reason names the case this exists
 * for: a snapshot the old writer published while a holding was unread.
 * Refuses `NODE_ENV=production` before opening a connection.
 */

export type MiningInvalidateSnapshotsErrorCode =
  | "mining_invalidate_arguments_invalid"
  | "mining_invalidate_confirmation_required"
  | "mining_invalidate_database_unconfigured"
  | "mining_invalidate_forbidden_in_production"
  | "mining_invalidate_snapshot_not_found"
  | "mining_invalidate_failed";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateMiningInvalidateRepository = (databaseUrl: string) => {
  readonly repository: Pick<MiningRepository, "invalidateSnapshots">;
  readonly close: () => Promise<void>;
};

export interface RunMiningInvalidateSnapshotsOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateMiningInvalidateRepository;
}

export class MiningInvalidateSnapshotsError extends Error {
  constructor(readonly code: MiningInvalidateSnapshotsErrorCode) {
    super("Mining snapshot invalidation failed");
    this.name = "MiningInvalidateSnapshotsError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: MiningRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-mining-invalidate-snapshots",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresMiningRepository(pool),
    close: () => pool.end(),
  };
}

export interface MiningInvalidateSnapshotsRequest {
  readonly selector: InvalidateMiningSnapshotsSelector;
  readonly reason: string;
  readonly databaseUrl: string;
}

export function parseMiningInvalidateSnapshotsRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): MiningInvalidateSnapshotsRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new MiningInvalidateSnapshotsError(
      "mining_invalidate_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  const invalid = (): never => {
    throw new MiningInvalidateSnapshotsError(
      "mining_invalidate_arguments_invalid",
    );
  };
  let confirmed = false;
  let after: string | null = null;
  let reason: string = miningReasonCodes.snapshotPublishedIncomplete;
  const ids: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--confirm") {
      confirmed = true;
    } else if (arg === "--after") {
      const value = args[index + 1] ?? "";
      if (after !== null || !uuidPattern.test(value)) {
        invalid();
      }
      after = value;
      index += 1;
    } else if (arg === "--reason") {
      const value = args[index + 1] ?? "";
      if (!reasonPattern.test(value)) {
        invalid();
      }
      reason = value;
      index += 1;
    } else if (uuidPattern.test(arg)) {
      ids.push(arg);
    } else {
      invalid();
    }
  }
  if ((after === null) === (ids.length === 0)) {
    invalid();
  }
  if (!confirmed) {
    throw new MiningInvalidateSnapshotsError(
      "mining_invalidate_confirmation_required",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new MiningInvalidateSnapshotsError(
      "mining_invalidate_database_unconfigured",
    );
  }
  return Object.freeze({
    selector:
      after === null
        ? Object.freeze({
            kind: "ids" as const,
            snapshotIds: Object.freeze(ids),
          })
        : Object.freeze({ kind: "after" as const, snapshotId: after }),
    reason,
    databaseUrl,
  });
}

export async function invalidateMiningSnapshots(
  request: MiningInvalidateSnapshotsRequest,
  createRepository: CreateMiningInvalidateRepository = defaultCreateRepository,
): Promise<InvalidateMiningSnapshotsResult> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.invalidateSnapshots({
      selector: request.selector,
      reason: request.reason,
      requestId: randomUUID(),
    });
  } finally {
    await close();
  }
}

export async function runMiningInvalidateSnapshots(
  options: RunMiningInvalidateSnapshotsOptions,
): Promise<0 | 1> {
  let request: MiningInvalidateSnapshotsRequest;
  try {
    request = parseMiningInvalidateSnapshotsRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof MiningInvalidateSnapshotsError
        ? error.code
        : "mining_invalidate_failed";
    options.stderr.write(`Mining snapshot invalidation refused (${code})\n`);
    return 1;
  }
  try {
    const result = await invalidateMiningSnapshots(
      request,
      options.createRepository,
    );
    options.stdout.write(
      `Invalidated ${String(result.snapshotIds.length)} mining snapshot(s) (${request.reason})${
        result.snapshotIds.length === 0
          ? ""
          : `: ${result.snapshotIds.join(", ")}`
      }\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof MiningSnapshotNotFoundError
        ? "mining_invalidate_snapshot_not_found"
        : "mining_invalidate_failed";
    options.stderr.write(`Mining snapshot invalidation failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runMiningInvalidateSnapshots({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
