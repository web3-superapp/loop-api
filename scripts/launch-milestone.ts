import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import {
  venueEvidenceDigest,
  venueMilestoneMarketTypes,
  venueMilestoneStates,
  venueMilestoneVenues,
  type VenueMilestoneMarketType,
  type VenueMilestoneState,
  type VenueMilestoneVenue,
} from "../src/features/launch/launch-contract.js";
import type {
  LaunchRepository,
  VenueMilestoneRecord,
} from "../src/features/launch/launch-repository.js";

/**
 * Dev-only operator path that records an external venue milestone
 * (Decision 0036, 03 §8.4):
 * `pnpm launch:milestone <projectId> <venue> <marketType> <state> [--evidence <ref> --reviewer <id>]`.
 *
 * LISTED and FEATURED require an evidence reference and a reviewer; only the
 * SHA-256 digest of the reference is stored. The script refuses to run with
 * `NODE_ENV=production`.
 */

export type LaunchMilestoneErrorCode =
  | "launch_milestone_arguments_invalid"
  | "launch_milestone_database_unconfigured"
  | "launch_milestone_forbidden_in_production"
  | "launch_milestone_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reviewerPattern = /^[a-z][a-z0-9_.-]{0,63}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateLaunchMilestoneRepository = (databaseUrl: string) => {
  readonly repository: Pick<LaunchRepository, "recordMilestone">;
  readonly close: () => Promise<void>;
};

export interface RunLaunchMilestoneOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateLaunchMilestoneRepository;
}

export class LaunchMilestoneError extends Error {
  constructor(readonly code: LaunchMilestoneErrorCode) {
    super("Launch milestone recording failed");
    this.name = "LaunchMilestoneError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: LaunchRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-launch-milestone",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresLaunchRepository(pool),
    close: () => pool.end(),
  };
}

export interface LaunchMilestoneRequest {
  readonly projectId: string;
  readonly venue: VenueMilestoneVenue;
  readonly marketType: VenueMilestoneMarketType;
  readonly state: VenueMilestoneState;
  readonly evidenceDigest: string | null;
  readonly reviewer: string | null;
  readonly databaseUrl: string;
}

export function parseLaunchMilestoneRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): LaunchMilestoneRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new LaunchMilestoneError("launch_milestone_forbidden_in_production");
  }
  const args = argv.slice(2);
  const positional: string[] = [];
  let evidence: string | null = null;
  let reviewer: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--evidence" || arg === "--reviewer") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new LaunchMilestoneError("launch_milestone_arguments_invalid");
      }
      if (arg === "--evidence") {
        evidence = value;
      } else {
        reviewer = value;
      }
      index += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  const [projectId, venue, marketType, state] = positional;
  if (
    positional.length !== 4 ||
    projectId === undefined ||
    !opaqueIdPattern.test(projectId) ||
    !venueMilestoneVenues.includes(venue as VenueMilestoneVenue) ||
    !venueMilestoneMarketTypes.includes(
      marketType as VenueMilestoneMarketType,
    ) ||
    !venueMilestoneStates.includes(state as VenueMilestoneState) ||
    (reviewer !== null && !reviewerPattern.test(reviewer)) ||
    (evidence !== null &&
      (evidence.trim() === "" || evidence.length > 4_096)) ||
    (evidence === null) !== (reviewer === null)
  ) {
    throw new LaunchMilestoneError("launch_milestone_arguments_invalid");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new LaunchMilestoneError("launch_milestone_database_unconfigured");
  }
  return Object.freeze({
    projectId,
    venue: venue as VenueMilestoneVenue,
    marketType: marketType as VenueMilestoneMarketType,
    state: state as VenueMilestoneState,
    evidenceDigest: evidence === null ? null : venueEvidenceDigest(evidence),
    reviewer,
    databaseUrl,
  });
}

export async function recordLaunchMilestone(
  request: LaunchMilestoneRequest,
  createRepository: CreateLaunchMilestoneRepository = defaultCreateRepository,
): Promise<VenueMilestoneRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.recordMilestone({
      projectId: request.projectId,
      venue: request.venue,
      marketType: request.marketType,
      state: request.state,
      evidenceDigest: request.evidenceDigest,
      reviewer: request.reviewer,
      requestId: randomUUID(),
    });
  } finally {
    await close();
  }
}

export async function runLaunchMilestone(
  options: RunLaunchMilestoneOptions,
): Promise<0 | 1> {
  let request: LaunchMilestoneRequest;
  try {
    request = parseLaunchMilestoneRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof LaunchMilestoneError
        ? error.code
        : "launch_milestone_failed";
    options.stderr.write(`Launch milestone refused (${code})\n`);
    return 1;
  }
  try {
    const record = await recordLaunchMilestone(
      request,
      options.createRepository,
    );
    options.stdout.write(
      `Milestone ${record.venueMilestoneId} (${record.venue}/${record.marketType}) is ${record.state}` +
        (record.evidenceDigest === null
          ? "\n"
          : ` with evidence ${record.evidenceDigest.slice(0, 12)}…\n`),
    );
    return 0;
  } catch {
    options.stderr.write("Launch milestone failed (launch_milestone_failed)\n");
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLaunchMilestone({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
