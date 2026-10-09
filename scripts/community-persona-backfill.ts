import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresCommunityChannelPersonaRepository } from "../src/database/communication-repository.js";
import type {
  CommunityChannelMemberWithoutPersona,
  CommunityChannelPersonaRepository,
} from "../src/features/communication/communication-repository.js";
import {
  COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS,
  createCommunityPersonaService,
  type CommunityPersonaService,
} from "../src/features/communication/community-persona-service.js";
import { createStreamCommunityChannelGateway } from "../src/integrations/stream/channel-gateway.js";

/**
 * Dev-only operator backfill (Decision 0055): give every `synced` member of
 * a provisioned official community channel a community persona and project
 * it onto the Stream channel member as `loop_group_alias*` custom data.
 *
 * Two phases, both through `CommunityPersonaService`:
 *
 * 1. Members without a persona row: `ensurePersona` (which issues the
 *    projection lease) then one `projectPersona` under that lease.
 * 2. Pending personas of `synced` members: taken through the same fenced
 *    `claimPendingProjections` the worker's persona lane uses, so the two
 *    never project the same persona concurrently and the worker may keep
 *    running while this script runs.
 *
 * Idempotent: a confirmed persona is neither claimed nor touched; a pending
 * one is re-projected. `--max N` bounds the number of members processed in
 * this run; batches are paced 200 ms apart. No process is restarted and
 * nothing is written to Stream users.
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

export const COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE = 50;
export const COMMUNITY_PERSONA_BACKFILL_BATCH_PAUSE_MS = 200;
const defaultMaximum = 100_000;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface CommunityPersonaBackfillRequest {
  readonly databaseUrl: string;
  readonly stream: { readonly apiKey: string; readonly apiSecret: string };
  /** Upper bound on members processed (both phases together). */
  readonly maximum: number;
}

export type CreateCommunityPersonaBackfillDependencies = (
  request: CommunityPersonaBackfillRequest,
) => {
  readonly personas: Pick<
    CommunityChannelPersonaRepository,
    "listMembersWithoutPersona" | "claimPendingProjections"
  >;
  readonly service: Pick<
    CommunityPersonaService,
    "ensurePersona" | "projectPersona"
  >;
  readonly close: () => Promise<void>;
  /** Injected in tests; defaults to a real 200 ms pause between batches. */
  readonly pause?: () => Promise<void>;
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
    service: createCommunityPersonaService({
      personas,
      gateway,
      logger: {
        warn: (context, message) => {
          process.stderr.write(`${message} ${JSON.stringify(context)}\n`);
        },
      },
    }),
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
  let confirmed = false;
  let maximum = defaultMaximum;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm") {
      confirmed = true;
      continue;
    }
    if (arg === "--max") {
      const raw = args[index + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (
        !/^[1-9][0-9]{0,6}$/.test(raw ?? "") ||
        !Number.isSafeInteger(parsed)
      ) {
        throw new CommunityPersonaBackfillError(
          "community_persona_backfill_arguments_invalid",
        );
      }
      maximum = parsed;
      index += 1;
      continue;
    }
    throw new CommunityPersonaBackfillError(
      "community_persona_backfill_arguments_invalid",
    );
  }
  if (!confirmed) {
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
    maximum,
  });
}

export interface CommunityPersonaBackfillResult {
  /** Members processed in this run (phase 1 + phase 2), bounded by `--max`. */
  readonly processed: number;
  /** Members that had no persona row before this run. */
  readonly generated: number;
  /** Pending personas claimed from the shared lane in phase 2. */
  readonly claimed: number;
  /** Personas Stream echoed during this run. */
  readonly confirmed: number;
  /** Personas still pending after this run; rerun or let the worker retry. */
  readonly pending: number;
  /** True when `--max` stopped the run before the directory was exhausted. */
  readonly truncated: boolean;
}

export async function backfillCommunityPersonas(
  request: CommunityPersonaBackfillRequest,
  createDependencies: CreateCommunityPersonaBackfillDependencies = defaultCreateDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<CommunityPersonaBackfillResult> {
  const dependencies = createDependencies(request);
  const { personas, service, close } = dependencies;
  const pause =
    dependencies.pause ??
    (() => sleep(COMMUNITY_PERSONA_BACKFILL_BATCH_PAUSE_MS));
  try {
    let processed = 0;
    let generated = 0;
    let claimed = 0;
    let confirmed = 0;
    let pending = 0;
    const remaining = (): number => request.maximum - processed;
    const batchSize = (): number =>
      Math.min(COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE, remaining());

    // Phase 1: members without a persona row.
    let after: CommunityChannelMemberWithoutPersona | null = null;
    let truncated = false;
    while (remaining() > 0) {
      signal.throwIfAborted();
      const page = await personas.listMembersWithoutPersona({
        limit: batchSize(),
        after:
          after === null
            ? null
            : {
                communityId: after.communityId,
                ownerUserId: after.ownerUserId,
              },
      });
      for (const member of page) {
        signal.throwIfAborted();
        const lease = await service.ensurePersona({
          communityId: member.communityId,
          ownerUserId: member.ownerUserId,
        });
        generated += 1;
        processed += 1;
        const outcome = await service.projectPersona({
          ...lease,
          streamChannelId: member.streamChannelId,
          memberStreamUserId: member.memberStreamUserId,
          signal,
        });
        if (outcome === "confirmed") {
          confirmed += 1;
        } else {
          pending += 1;
        }
      }
      const last = page.at(-1);
      if (
        last === undefined ||
        page.length < COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE
      ) {
        // The final (short) page: when `--max` cut it short there may be
        // more; that is reported through `truncated` below.
        truncated = last !== undefined && remaining() === 0;
        break;
      }
      after = last;
      await pause();
    }

    // Phase 2: pending personas, through the same fenced claim as the lane.
    while (remaining() > 0) {
      signal.throwIfAborted();
      const targets = await personas.claimPendingProjections({
        limit: batchSize(),
        leaseSeconds: COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS,
      });
      if (targets.length === 0) {
        break;
      }
      for (const target of targets) {
        signal.throwIfAborted();
        claimed += 1;
        processed += 1;
        const outcome = await service.projectPersona({
          persona: target.persona,
          leaseToken: target.leaseToken,
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
      if (remaining() === 0) {
        truncated = true;
        break;
      }
      await pause();
    }

    return Object.freeze({
      processed,
      generated,
      claimed,
      confirmed,
      pending,
      truncated,
    });
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
      `Processed ${String(result.processed)} synced official-channel members: ` +
        `${String(result.generated)} personas generated, ` +
        `${String(result.claimed)} pending personas claimed, ` +
        `${String(result.confirmed)} projected and confirmed, ` +
        `${String(result.pending)} still pending` +
        (result.truncated
          ? ` (stopped at --max ${String(request.maximum)})`
          : "") +
        "\n",
    );
    if (result.pending > 0 || result.truncated) {
      options.stderr.write(
        result.pending > 0
          ? `${String(result.pending)} persona projections were not confirmed by Stream; rerun after the provider recovers or let the community-channel-sync persona lane retry them\n`
          : "More members remain; rerun to continue\n",
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
