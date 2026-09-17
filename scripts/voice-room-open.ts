import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig } from "../src/config.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresCommunicationRepository } from "../src/database/communication-repository.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import {
  createVoiceRoomService,
  type VoiceRoomResource,
  type VoiceRoomService,
} from "../src/features/communication/voice-room-service.js";
import { createStreamCallGateway } from "../src/integrations/stream/call-gateway.js";

/**
 * Dev-only operator path that opens a community voice room as the community
 * owner (Decision 0050): `pnpm voice-room:open <communityId> --confirm`.
 *
 * The product route `POST /v2/communities/{id}/voice-rooms` exists for an
 * owner or admin, but the mobile app has no control that calls it, so on the
 * Development stack no room could ever go live. This script runs the same
 * `VoiceRoomService.createRoom` the route runs, as the owner's principal:
 * the `voice_rooms` row, the host membership and the audit row are committed
 * first, then exactly one Stream `audio_room` call is created with the server
 * key, and the provider outcome is written back as `provisionState`. It does
 * not change Stream role permissions and never reports an unconfirmed
 * provider write as confirmed. Refuses `NODE_ENV=production` before any
 * connection is opened.
 */

export type VoiceRoomOpenErrorCode =
  | "voice_room_open_arguments_invalid"
  | "voice_room_open_confirmation_required"
  | "voice_room_open_database_unconfigured"
  | "voice_room_open_forbidden_in_production"
  | "voice_room_open_stream_unconfigured"
  | "voice_room_open_owner_not_found"
  | "voice_room_open_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface VoiceRoomOwnerPrincipal {
  readonly userId: string;
  readonly privyUserId: string;
  readonly streamUserId: string;
}

export type CreateVoiceRoomOpenDependencies = (
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
) => {
  readonly service: VoiceRoomService;
  readonly findOwner: (
    communityId: string,
  ) => Promise<VoiceRoomOwnerPrincipal | null>;
  readonly close: () => Promise<void>;
};

export interface RunVoiceRoomOpenOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createDependencies?: CreateVoiceRoomOpenDependencies;
}

export class VoiceRoomOpenError extends Error {
  constructor(readonly code: VoiceRoomOpenErrorCode) {
    super("Voice room open failed");
    this.name = "VoiceRoomOpenError";
  }
}

function defaultCreateDependencies(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
): ReturnType<CreateVoiceRoomOpenDependencies> {
  const config = loadConfig(environment);
  if (config.stream === null) {
    throw new VoiceRoomOpenError("voice_room_open_stream_unconfigured");
  }
  const pool = new pg.Pool({
    application_name: "loop-api-voice-room-open",
    connectionString: databaseUrl,
    max: 2,
  });
  return {
    service: createVoiceRoomService({
      repository: createPostgresCommunicationRepository(pool),
      callGateway: createStreamCallGateway(config.stream),
    }),
    async findOwner(communityId) {
      const result = await pool.query<{
        owner_user_id: string;
        privy_user_id: string;
      }>({
        text: `
          select membership.owner_user_id, account.privy_user_id
          from public.community_memberships as membership
          join public.loop_users as account
            on account.id = membership.owner_user_id
          where membership.community_id = $1
            and membership.role = 'owner'
            and membership.status <> 'banned'
          limit 1
        `,
        values: [communityId],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return Object.freeze({
        userId: row.owner_user_id,
        privyUserId: row.privy_user_id,
        streamUserId: deriveStreamUserId(row.owner_user_id),
      });
    },
    close: () => pool.end(),
  };
}

export interface VoiceRoomOpenRequest {
  readonly communityId: string;
  readonly databaseUrl: string;
}

export function parseVoiceRoomOpenRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): VoiceRoomOpenRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new VoiceRoomOpenError("voice_room_open_forbidden_in_production");
  }
  const args = argv.slice(2);
  const positional = args.filter((arg) => arg !== "--confirm");
  const communityId = positional[0];
  if (
    positional.length !== 1 ||
    communityId === undefined ||
    !opaqueIdPattern.test(communityId)
  ) {
    throw new VoiceRoomOpenError("voice_room_open_arguments_invalid");
  }
  if (!args.includes("--confirm")) {
    throw new VoiceRoomOpenError("voice_room_open_confirmation_required");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new VoiceRoomOpenError("voice_room_open_database_unconfigured");
  }
  return Object.freeze({ communityId, databaseUrl });
}

export async function openVoiceRoom(
  request: VoiceRoomOpenRequest,
  environment: NodeJS.ProcessEnv,
  createDependencies: CreateVoiceRoomOpenDependencies = defaultCreateDependencies,
): Promise<VoiceRoomResource> {
  const { service, findOwner, close } = createDependencies(
    request.databaseUrl,
    environment,
  );
  try {
    const owner = await findOwner(request.communityId);
    if (owner === null) {
      throw new VoiceRoomOpenError("voice_room_open_owner_not_found");
    }
    return await service.createRoom({
      principal: owner,
      communityId: request.communityId,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      signal: AbortSignal.timeout(30_000),
    });
  } finally {
    await close();
  }
}

export async function runVoiceRoomOpen(
  options: RunVoiceRoomOpenOptions,
): Promise<0 | 1> {
  let request: VoiceRoomOpenRequest;
  try {
    request = parseVoiceRoomOpenRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof VoiceRoomOpenError
        ? error.code
        : "voice_room_open_failed";
    options.stderr.write(`Voice room open refused (${code})\n`);
    return 1;
  }
  try {
    const resource = await openVoiceRoom(
      request,
      options.environment,
      options.createDependencies,
    );
    options.stdout.write(
      `Voice room ${resource.room.voiceRoomId} is ${resource.room.state} in community ${resource.room.communityId} (call ${resource.room.callCid}, provisionState ${resource.room.provisionState}, providerSync ${resource.providerSync.status}${resource.providerSync.reasonCode === null ? "" : ` ${resource.providerSync.reasonCode}`})\n`,
    );
    return resource.room.provisionState === "provisioned" ? 0 : 1;
  } catch (error) {
    // The service raises the same V2 errors the route would (for example
    // RESOURCE_CONFLICT while a live room exists), so the code is reported
    // verbatim instead of being flattened.
    const code =
      error instanceof VoiceRoomOpenError || error instanceof V2ApiError
        ? error.code
        : "voice_room_open_failed";
    options.stderr.write(`Voice room open failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runVoiceRoomOpen({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
