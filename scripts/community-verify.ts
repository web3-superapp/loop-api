import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommunityReviewResult } from "../src/features/community/community-review-service.js";
import {
  createCommunityReviewRuntime,
  type CreateCommunityReviewRuntime,
} from "./community-review-runtime.js";

/**
 * Dev-only operator path that sets a community to `verified`
 * (Decision 0031, main-agent ruling 2026-09-07; Decision 0073).
 *
 * Verification is never self-served through the API: `POST /v2/communities`
 * only creates a `pending` record. This script is the single documented way
 * to promote one, it always writes an operator audit row, it tells the owner
 * through the feed (and the push channel when one is composed), and it
 * refuses to run with `NODE_ENV=production` — the reviewed Admin console and
 * RBAC land in D17.
 */

export type CommunityVerificationErrorCode =
  | "community_verify_arguments_invalid"
  | "community_verify_database_unconfigured"
  | "community_verify_forbidden_in_production"
  | "community_verify_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const defaultReasonCode = "operator_manual_review";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunCommunityVerificationOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRuntime?: CreateCommunityReviewRuntime;
}

export class CommunityVerificationError extends Error {
  constructor(readonly code: CommunityVerificationErrorCode) {
    super("Community verification failed");
    this.name = "CommunityVerificationError";
  }
}

export interface CommunityVerificationRequest {
  readonly communityId: string;
  readonly reasonCode: string;
  readonly databaseUrl: string;
}

/**
 * Parse and authorize the operator request. Production is refused before any
 * connection is opened, so the script cannot be repurposed as an unreviewed
 * production admin path.
 */
export function parseCommunityVerificationRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommunityVerificationRequest {
  const nodeEnv = environment["NODE_ENV"]?.trim();
  if (nodeEnv === "production") {
    throw new CommunityVerificationError(
      "community_verify_forbidden_in_production",
    );
  }

  const positional = argv.slice(2);
  const communityId = positional[0];
  const reasonCode = positional[1] ?? defaultReasonCode;
  if (
    positional.length < 1 ||
    positional.length > 2 ||
    communityId === undefined ||
    !opaqueIdPattern.test(communityId) ||
    !reasonCodePattern.test(reasonCode)
  ) {
    throw new CommunityVerificationError("community_verify_arguments_invalid");
  }

  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new CommunityVerificationError(
      "community_verify_database_unconfigured",
    );
  }

  return Object.freeze({ communityId, reasonCode, databaseUrl });
}

/** One line per fact the operator needs: outcome, feed row, push. */
export function describeReviewResult(
  result: CommunityReviewResult,
  pushReasonCode: string | null,
): string {
  const community = result.community;
  const push =
    pushReasonCode !== null
      ? `unavailable (${pushReasonCode})`
      : result.push.reasonCode === null
        ? result.push.status
        : `${result.push.status} (${result.push.reasonCode})`;
  return (
    `Community ${community.communityId} is ${community.verificationStatus} ` +
    `(slug ${community.slug}, members ${String(community.memberCount)}, ` +
    `changed ${String(result.changed)}, notification ${result.notification}, ` +
    `push ${push})\n`
  );
}

export async function runCommunityVerification(
  options: RunCommunityVerificationOptions,
): Promise<0 | 1> {
  let request: CommunityVerificationRequest;
  try {
    request = parseCommunityVerificationRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof CommunityVerificationError
        ? error.code
        : "community_verify_failed";
    options.stderr.write(`Community verification refused (${code})\n`);
    return 1;
  }

  const runtime = (options.createRuntime ?? createCommunityReviewRuntime)({
    databaseUrl: request.databaseUrl,
    environment: options.environment,
    stderr: options.stderr,
  });
  try {
    const result = await runtime.service.verify({
      communityId: request.communityId,
      requestId: randomUUID(),
      reasonCode: request.reasonCode,
    });
    options.stdout.write(describeReviewResult(result, runtime.pushReasonCode));
    return 0;
  } catch {
    options.stderr.write(
      "Community verification failed (community_verify_failed)\n",
    );
    return 1;
  } finally {
    await runtime.close();
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCommunityVerification({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
