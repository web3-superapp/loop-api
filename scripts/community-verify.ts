import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import type {
  CommunityRecord,
  CommunityRepository,
} from "../src/features/community/community-repository.js";

/**
 * Dev-only operator path that sets a community to `verified`
 * (Decision 0031, main-agent ruling 2026-09-07).
 *
 * Verification is never self-served through the API: `POST /v2/communities`
 * only creates a `pending` record. This script is the single documented way
 * to promote one, it always writes an operator audit row, and it refuses to
 * run with `NODE_ENV=production` — the reviewed Admin console and RBAC land
 * in D17.
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

export type CreateCommunityVerifyRepository = (databaseUrl: string) => {
  readonly repository: CommunityRepository;
  readonly close: () => Promise<void>;
};

export interface RunCommunityVerificationOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateCommunityVerifyRepository;
}

export class CommunityVerificationError extends Error {
  constructor(readonly code: CommunityVerificationErrorCode) {
    super("Community verification failed");
    this.name = "CommunityVerificationError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: CommunityRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-community-verify",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresCommunityRepository(pool),
    close: () => pool.end(),
  };
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

export async function verifyCommunity(
  request: CommunityVerificationRequest,
  createRepository: CreateCommunityVerifyRepository = defaultCreateRepository,
): Promise<CommunityRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.verifyCommunity({
      communityId: request.communityId,
      requestId: randomUUID(),
      reasonCode: request.reasonCode,
    });
  } finally {
    await close();
  }
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

  try {
    const record = await verifyCommunity(request, options.createRepository);
    options.stdout.write(
      `Community ${record.communityId} is ${record.verificationStatus} (slug ${record.slug}, members ${String(record.memberCount)})\n`,
    );
    return 0;
  } catch {
    options.stderr.write(
      "Community verification failed (community_verify_failed)\n",
    );
    return 1;
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
