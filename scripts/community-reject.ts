import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCommunityReviewRuntime,
  type CreateCommunityReviewRuntime,
} from "./community-review-runtime.js";
import { describeReviewResult } from "./community-verify.js";

/**
 * Dev-only operator path that sets a `pending` community to `rejected`
 * (Decision 0073).
 *
 * Usage: `pnpm community:reject <communityId> --reason "<text>" [reasonCode]`
 *
 * The reason is mandatory, trimmed, 1-280 code points under the alias
 * text-safety rules, stored on the community for the owner to read, and
 * kept on the `community_rejected` audit row after a resubmission clears
 * it. A `verified` community is refused (`community_reject_state_invalid`):
 * unverifying has channel consequences nobody has decided on. The script
 * refuses `NODE_ENV=production`.
 */

export type CommunityRejectionErrorCode =
  | "community_reject_arguments_invalid"
  | "community_reject_database_unconfigured"
  | "community_reject_forbidden_in_production"
  | "community_reject_state_invalid"
  | "community_reject_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const defaultReasonCode = "operator_manual_review";
export const maximumRejectionReasonCodePoints = 280;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunCommunityRejectionOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRuntime?: CreateCommunityReviewRuntime;
}

export class CommunityRejectionError extends Error {
  constructor(readonly code: CommunityRejectionErrorCode) {
    super("Community rejection failed");
    this.name = "CommunityRejectionError";
  }
}

export interface CommunityRejectionRequest {
  readonly communityId: string;
  readonly reason: string;
  readonly reasonCode: string;
  readonly databaseUrl: string;
}

function invalid(): never {
  throw new CommunityRejectionError("community_reject_arguments_invalid");
}

/**
 * Parse `<communityId> --reason <text> [reasonCode]` in any order. The
 * `--reason` flag takes exactly one following argument (quote the text);
 * `--reason=<text>` is accepted too. Production is refused before anything
 * else is examined.
 */
export function parseCommunityRejectionRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommunityRejectionRequest {
  const nodeEnv = environment["NODE_ENV"]?.trim();
  if (nodeEnv === "production") {
    throw new CommunityRejectionError(
      "community_reject_forbidden_in_production",
    );
  }

  const positional: string[] = [];
  let reason: string | undefined;
  const arguments_ = argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      invalid();
    }
    if (argument === "--reason") {
      const next = arguments_[index + 1];
      if (next === undefined || reason !== undefined) {
        invalid();
      }
      reason = next;
      index += 1;
    } else if (argument.startsWith("--reason=")) {
      if (reason !== undefined) {
        invalid();
      }
      reason = argument.slice("--reason=".length);
    } else if (argument.startsWith("--")) {
      invalid();
    } else {
      positional.push(argument);
    }
  }

  const communityId = positional[0];
  const reasonCode = positional[1] ?? defaultReasonCode;
  if (
    positional.length < 1 ||
    positional.length > 2 ||
    communityId === undefined ||
    !opaqueIdPattern.test(communityId) ||
    !reasonCodePattern.test(reasonCode) ||
    reason === undefined
  ) {
    invalid();
  }
  const trimmedReason = reason.trim();
  const codePoints = Array.from(trimmedReason).length;
  if (
    codePoints < 1 ||
    codePoints > maximumRejectionReasonCodePoints ||
    forbiddenTextCharacters.test(trimmedReason)
  ) {
    invalid();
  }

  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new CommunityRejectionError("community_reject_database_unconfigured");
  }

  return Object.freeze({
    communityId,
    reason: trimmedReason,
    reasonCode,
    databaseUrl,
  });
}

export async function runCommunityRejection(
  options: RunCommunityRejectionOptions,
): Promise<0 | 1> {
  let request: CommunityRejectionRequest;
  try {
    request = parseCommunityRejectionRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof CommunityRejectionError
        ? error.code
        : "community_reject_failed";
    options.stderr.write(`Community rejection refused (${code})\n`);
    return 1;
  }

  const runtime = (options.createRuntime ?? createCommunityReviewRuntime)({
    databaseUrl: request.databaseUrl,
    environment: options.environment,
    stderr: options.stderr,
  });
  try {
    const result = await runtime.service.reject({
      communityId: request.communityId,
      requestId: randomUUID(),
      reasonCode: request.reasonCode,
      reason: request.reason,
    });
    options.stdout.write(describeReviewResult(result, runtime.pushReasonCode));
    return 0;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "community_data_stale"
        ? "community_reject_state_invalid"
        : "community_reject_failed";
    options.stderr.write(`Community rejection failed (${code})\n`);
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
  process.exitCode = await runCommunityRejection({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
