import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresStreamUserIdentityRepository } from "../src/database/stream-user-identity-repository.js";
import {
  createStreamUserIdentitySource,
  type StreamUserGateway,
  type StreamUserIdentityRepository,
} from "../src/features/communication/stream-user-identity.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import { createStreamUserGateway } from "../src/integrations/stream/user-gateway.js";

/**
 * Operator backfill (Decision 0095): upsert every activated account's Stream
 * user as `{ id, name: alias, image: uploaded avatar URL,
 * custom: { publicProfileId } }`.
 *
 * - default / `--dry-run`: counts the accounts and how many carry an alias,
 *   an uploaded avatar, and a public profile ID. Nothing is written.
 * - `--apply`: additionally upserts them to Stream in batches of 100.
 *
 * Output is counts only (no user ID, alias, or URL). Requires
 * `DATABASE_URL`, `STREAM_API_KEY`, `STREAM_API_SECRET`, `PUBLIC_BASE_URL`.
 */

export const STREAM_USERS_BACKFILL_BATCH_SIZE = 100;
export const STREAM_USERS_BACKFILL_BATCH_PAUSE_MS = 200;

export type StreamUsersBackfillErrorCode =
  | "stream_users_backfill_arguments_invalid"
  | "stream_users_backfill_database_unconfigured"
  | "stream_users_backfill_stream_unconfigured"
  | "stream_users_backfill_base_url_unconfigured"
  | "stream_users_backfill_failed";

export class StreamUsersBackfillError extends Error {
  constructor(readonly code: StreamUsersBackfillErrorCode) {
    super("Stream users backfill failed");
    this.name = "StreamUsersBackfillError";
  }
}

export interface StreamUsersBackfillRequest {
  readonly mode: "dry-run" | "apply";
  readonly databaseUrl: string;
  readonly stream: { readonly apiKey: string; readonly apiSecret: string };
  readonly publicBaseUrl: string;
}

export interface StreamUsersBackfillDependencies {
  readonly repository: StreamUserIdentityRepository;
  readonly gateway: StreamUserGateway;
  readonly close: () => Promise<void>;
  readonly pause?: () => Promise<void>;
}

export interface StreamUsersBackfillResult {
  readonly examined: number;
  readonly withName: number;
  readonly withImage: number;
  readonly withPublicProfileId: number;
  readonly upserted: number;
}

export function parseStreamUsersBackfillRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): StreamUsersBackfillRequest {
  const args = argv.slice(2);
  if (
    args.length > 1 ||
    (args[0] !== undefined && args[0] !== "--apply" && args[0] !== "--dry-run")
  ) {
    throw new StreamUsersBackfillError(
      "stream_users_backfill_arguments_invalid",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new StreamUsersBackfillError(
      "stream_users_backfill_database_unconfigured",
    );
  }
  const apiKey = environment["STREAM_API_KEY"]?.trim();
  const apiSecret = environment["STREAM_API_SECRET"];
  if (
    apiKey === undefined ||
    apiKey === "" ||
    apiSecret === undefined ||
    apiSecret.trim() === ""
  ) {
    throw new StreamUsersBackfillError(
      "stream_users_backfill_stream_unconfigured",
    );
  }
  const publicBaseUrl = environment["PUBLIC_BASE_URL"]?.trim();
  if (
    publicBaseUrl === undefined ||
    !/^https?:\/\/[^\s/]+(\/.*)?$/.test(publicBaseUrl)
  ) {
    throw new StreamUsersBackfillError(
      "stream_users_backfill_base_url_unconfigured",
    );
  }
  return Object.freeze({
    mode: args[0] === "--apply" ? "apply" : "dry-run",
    databaseUrl,
    stream: Object.freeze({ apiKey, apiSecret }),
    publicBaseUrl,
  });
}

export async function runStreamUsersBackfill(
  request: StreamUsersBackfillRequest,
  dependencies: StreamUsersBackfillDependencies,
): Promise<StreamUsersBackfillResult> {
  const source = createStreamUserIdentitySource({
    repository: dependencies.repository,
    publicBaseUrl: request.publicBaseUrl,
  });
  const pause =
    dependencies.pause ?? (() => sleep(STREAM_USERS_BACKFILL_BATCH_PAUSE_MS));
  let afterUserId: string | null = null;
  let examined = 0;
  let withName = 0;
  let withImage = 0;
  let withPublicProfileId = 0;
  let upserted = 0;
  for (;;) {
    const userIds = await dependencies.repository.listActivatedUserIds({
      afterUserId,
      limit: STREAM_USERS_BACKFILL_BATCH_SIZE,
    });
    if (userIds.length === 0) {
      break;
    }
    const users = await source.resolve(userIds.map(deriveStreamUserId));
    examined += users.length;
    withName += users.filter((user) => user.name !== undefined).length;
    withImage += users.filter((user) => user.image !== undefined).length;
    withPublicProfileId += users.filter(
      (user) => user.custom?.publicProfileId !== undefined,
    ).length;
    if (request.mode === "apply") {
      await dependencies.gateway.upsertUsers({
        users,
        signal: AbortSignal.timeout(10_000),
      });
      upserted += users.length;
      await pause();
    }
    afterUserId = userIds.at(-1) ?? null;
    if (userIds.length < STREAM_USERS_BACKFILL_BATCH_SIZE) {
      break;
    }
  }
  return Object.freeze({
    examined,
    withName,
    withImage,
    withPublicProfileId,
    upserted,
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  stdout: { write: (contents: string) => unknown } = process.stdout,
  stderr: { write: (contents: string) => unknown } = process.stderr,
): Promise<number> {
  let request: StreamUsersBackfillRequest;
  try {
    request = parseStreamUsersBackfillRequest(argv, environment);
  } catch (error) {
    stderr.write(
      `${error instanceof StreamUsersBackfillError ? error.code : "stream_users_backfill_failed"}\n`,
    );
    return 2;
  }
  const pool = new pg.Pool({
    application_name: "loop-api-stream-users-backfill",
    connectionString: request.databaseUrl,
    max: 1,
  });
  try {
    const result = await runStreamUsersBackfill(request, {
      repository: createPostgresStreamUserIdentityRepository(pool),
      gateway: createStreamUserGateway(request.stream),
      close: () => pool.end(),
    });
    stdout.write(
      `stream:users-backfill ${request.mode}: examined=${result.examined} withName=${result.withName} withImage=${result.withImage} withPublicProfileId=${result.withPublicProfileId} upserted=${result.upserted}\n`,
    );
    return 0;
  } catch {
    stderr.write("stream_users_backfill_failed\n");
    return 1;
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
