import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresCommunityChannelPersonaRepository } from "../src/database/communication-repository.js";
import type {
  CommunityChannelPersonaBackfillTarget,
  CommunityChannelPersonaRepository,
} from "../src/features/communication/communication-repository.js";
import {
  createCommunityPersonaService,
  type CommunityPersonaService,
} from "../src/features/communication/community-persona-service.js";
import { createStreamCommunityChannelGateway } from "../src/integrations/stream/channel-gateway.js";

/**
 * Dev-only operator backfill (Decision 0055): give every `synced` member of
 * a provisioned official community channel a community persona and project
 * it onto the Stream channel member as `loop_group_alias*` custom data.
 *
 * It walks the same service layer the `community-channel-sync` worker uses
 * (`CommunityPersonaService.ensurePersona` + `projectPersona`), so a persona
 * created here is indistinguishable from one created on join. It is
 * idempotent: a member whose persona is already `confirmed` is skipped, a
 * `pending` one is re-projected, and a member without a persona gets one.
 * No process is restarted and nothing is written to Stream users.
 *
 * Refuses `NODE_ENV=production`, requires `--confirm`, and fails closed
 * without `DATABASE_URL`, `STREAM_API_KEY`, and `STREAM_API_SECRET`.
 */

export type CommunityPersonaBackfillErrorCode =
  | "community_persona_backfill_arguments_invalid"
  | "community_persona_backfill_confirmation_required"
  | "community_persona_backfill_database_unconfigured"
  | "community_persona_backfill_stream_unconfigured"
  | "community_persona_backfill_forbidden_in_production"
  | "community_persona_backfill_failed";

const pageSize = 100;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface CommunityPersonaBackfillRequest {
  readonly databaseUrl: string;
  readonly stream: { readonly apiKey: string; readonly apiSecret: string };
}

export type CreateCommunityPersonaBackfillDependencies = (
  request: CommunityPersonaBackfillRequest,
) => {
  readonly personas: Pick<
    CommunityChannelPersonaRepository,
    "listBackfillTargets"
  >;
  readonly service: Pick<
    CommunityPersonaService,
    "ensurePersona" | "projectPersona"
  >;
  readonly close: () => Promise<void>;
};

export interface RunCommunityPersonaBackfillOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createDependencies?: CreateCommunityPersonaBackfillDependencies;
  readonly signal?: AbortSignal;
}

export class CommunityPersonaBackfillError extends Error {
  constructor(readonly code: CommunityPersonaBackfillErrorCode) {
    super("Community persona backfill failed");
    this.name = "CommunityPersonaBackfillError";
  }
}

function defaultCreateDependencies(
  request: CommunityPersonaBackfillRequest,
): ReturnType<CreateCommunityPersonaBackfillDependencies> {
  const pool = new pg.Pool({
    application_name: "loop-api-community-persona-backfill",
    connectionString: request.databaseUrl,
    max: 1,
  });
  const personas = createPostgresCommunityChannelPersonaRepository(pool);
  const gateway = createStreamCommunityChannelGateway(request.stream);
  return {
    personas,
    service: createCommunityPersonaService({ personas, gateway }),
    close: () => pool.end(),
  };
}

export function parseCommunityPersonaBackfillRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommunityPersonaBackfillRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  if (args.some((arg) => arg !== "--confirm")) {
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_arguments_invalid",
    );
  }
  if (!args.includes("--confirm")) {
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_confirmation_required",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_database_unconfigured",
    );
  }
  const apiKey = environment["STREAM_API_KEY"]?.trim();
  const apiSecret = environment["STREAM_API_SECRET"];
  if (
    apiKey === undefined ||
    apiKey === "" ||
    apiSecret === undefined ||
    apiSecret === ""
  ) {
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_stream_unconfigured",
    );
  }
  return Object.freeze({
    databaseUrl,
    stream: Object.freeze({ apiKey, apiSecret }),
  });
}

export interface CommunityPersonaBackfillResult {
  /** `synced` members on provisioned channels that were examined. */
  readonly examined: number;
  /** Members that had no persona row before this run. */
  readonly generated: number;
  /** Personas already confirmed; nothing was sent for them. */
  readonly skipped: number;
  /** Personas Stream echoed during this run. */
  readonly confirmed: number;
  /** Personas still pending after this run; rerun or let the worker retry. */
  readonly pending: number;
}

export async function backfillCommunityPersonas(
  request: CommunityPersonaBackfillRequest,
  createDependencies: CreateCommunityPersonaBackfillDependencies = defaultCreateDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<CommunityPersonaBackfillResult> {
  const { personas, service, close } = createDependencies(request);
  try {
    let examined = 0;
    let generated = 0;
    let skipped = 0;
    let confirmed = 0;
    let pending = 0;
    let after: CommunityChannelPersonaBackfillTarget | null = null;
    for (;;) {
      signal.throwIfAborted();
      const page = await personas.listBackfillTargets({
        limit: pageSize,
        after:
          after === null
            ? null
            : {
                communityId: after.communityId,
                ownerUserId: after.ownerUserId,
              },
      });
      for (const target of page) {
        signal.throwIfAborted();
        examined += 1;
        let persona = target.persona;
        if (persona === null) {
          persona = await service.ensurePersona({
            communityId: target.communityId,
            ownerUserId: target.ownerUserId,
          });
          generated += 1;
        }
        if (persona.projectionState === "confirmed") {
          skipped += 1;
          continue;
        }
        const outcome = await service.projectPersona({
          persona,
          streamChannelId: target.streamChannelId,
          memberStreamUserId: target.memberStreamUserId,
          signal,
        });
        if (outcome === "confirmed") {
          confirmed += 1;
        } else {
          pending += 1;
        }
      }
      const last = page.at(-1);
      if (page.length < pageSize || last === undefined) {
        break;
      }
      after = last;
    }
    return Object.freeze({ examined, generated, skipped, confirmed, pending });
  } finally {
    await close();
  }
}

export async function runCommunityPersonaBackfill(
  options: RunCommunityPersonaBackfillOptions,
): Promise<0 | 1> {
  let request: CommunityPersonaBackfillRequest;
  try {
    request = parseCommunityPersonaBackfillRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof CommunityPersonaBackfillError
        ? error.code
        : "community_persona_backfill_failed";
    options.stderr.write(`Community persona backfill refused (${code})\n`);
    return 1;
  }

  try {
    const result = await backfillCommunityPersonas(
      request,
      options.createDependencies,
      options.signal,
    );
    options.stdout.write(
      `Examined ${String(result.examined)} synced official-channel members: ` +
        `${String(result.generated)} personas generated, ` +
        `${String(result.skipped)} already confirmed, ` +
        `${String(result.confirmed)} projected and confirmed, ` +
        `${String(result.pending)} still pending\n`,
    );
    if (result.pending > 0) {
      options.stderr.write(
        `${String(result.pending)} persona projections were not confirmed by Stream; rerun after the provider recovers or let the community-channel-sync persona lane retry them\n`,
      );
      return 1;
    }
    return 0;
  } catch {
    options.stderr.write(
      "Community persona backfill failed (community_persona_backfill_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCommunityPersonaBackfill({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
