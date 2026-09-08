import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import {
  launchReviewDecisions,
  type LaunchReviewDecision,
} from "../src/features/launch/launch-contract.js";
import type {
  LaunchProjectRecord,
  LaunchRecord,
  LaunchRepository,
} from "../src/features/launch/launch-repository.js";

/**
 * Dev-only operator path that advances a Launch application
 * (Decision 0036): `pnpm launch:review <projectId> <review|approve|return|reject> [reasonCode]`.
 *
 * Review is never self-served through the API. This script is the single
 * documented way to move a submitted project, it always appends an operator
 * `launch_review_events` row, `approve` creates the catalog `launches` row
 * (unscheduled, contractAddress null), and it refuses to run with
 * `NODE_ENV=production` — the Admin console with two-person review is a
 * later module.
 */

export type LaunchReviewErrorCode =
  | "launch_review_arguments_invalid"
  | "launch_review_database_unconfigured"
  | "launch_review_forbidden_in_production"
  | "launch_review_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const defaultReasonCode = "operator_manual_review";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateLaunchReviewRepository = (databaseUrl: string) => {
  readonly repository: Pick<LaunchRepository, "reviewProject">;
  readonly close: () => Promise<void>;
};

export interface RunLaunchReviewOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateLaunchReviewRepository;
}

export class LaunchReviewError extends Error {
  constructor(readonly code: LaunchReviewErrorCode) {
    super("Launch review failed");
    this.name = "LaunchReviewError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: LaunchRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-launch-review",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresLaunchRepository(pool),
    close: () => pool.end(),
  };
}

export interface LaunchReviewRequest {
  readonly projectId: string;
  readonly decision: LaunchReviewDecision;
  readonly reasonCode: string;
  readonly databaseUrl: string;
}

export function parseLaunchReviewRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): LaunchReviewRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new LaunchReviewError("launch_review_forbidden_in_production");
  }
  const positional = argv.slice(2);
  const projectId = positional[0];
  const decision = positional[1];
  const reasonCode = positional[2] ?? defaultReasonCode;
  if (
    positional.length < 2 ||
    positional.length > 3 ||
    projectId === undefined ||
    !opaqueIdPattern.test(projectId) ||
    !launchReviewDecisions.includes(decision as LaunchReviewDecision) ||
    !reasonCodePattern.test(reasonCode)
  ) {
    throw new LaunchReviewError("launch_review_arguments_invalid");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new LaunchReviewError("launch_review_database_unconfigured");
  }
  return Object.freeze({
    projectId,
    decision: decision as LaunchReviewDecision,
    reasonCode,
    databaseUrl,
  });
}

export async function reviewLaunchProject(
  request: LaunchReviewRequest,
  createRepository: CreateLaunchReviewRepository = defaultCreateRepository,
): Promise<{
  readonly project: LaunchProjectRecord;
  readonly launch: LaunchRecord | null;
}> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.reviewProject({
      projectId: request.projectId,
      decision: request.decision,
      reasonCode: request.reasonCode,
      requestId: randomUUID(),
    });
  } finally {
    await close();
  }
}

export async function runLaunchReview(
  options: RunLaunchReviewOptions,
): Promise<0 | 1> {
  let request: LaunchReviewRequest;
  try {
    request = parseLaunchReviewRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof LaunchReviewError ? error.code : "launch_review_failed";
    options.stderr.write(`Launch review refused (${code})\n`);
    return 1;
  }
  try {
    const result = await reviewLaunchProject(request, options.createRepository);
    options.stdout.write(
      `Project ${result.project.projectId} is ${result.project.reviewStatus}` +
        (result.launch === null
          ? "\n"
          : ` (launch ${result.launch.launchId}, ${result.launch.scheduleStatus})\n`),
    );
    return 0;
  } catch {
    options.stderr.write("Launch review failed (launch_review_failed)\n");
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLaunchReview({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
