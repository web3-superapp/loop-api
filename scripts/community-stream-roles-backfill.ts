import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  createPostgresCommunityChannelRoleRepository,
  type CommunityChannelRoleRepository,
  type FriendGroupCreatorRole,
  type SyncedCommunityChannelMemberRole,
} from "../src/database/community-channel-role-repository.js";
import {
  createStreamCommunityChannelGateway,
  type StreamCommunityChannelGateway,
} from "../src/integrations/stream/channel-gateway.js";

/**
 * Operator backfill (Decision 0091): bring the Stream channel role of every
 * existing official-channel member in line with its community role — owner
 * and admin `channel_moderator`, member `channel_member` — and make every
 * active friend-group creator `channel_moderator` of its group channel
 * (ruling 2026-09-28; other group members and direct chats are untouched).
 *
 * - default / `--dry-run`: reads the `synced` members and the group
 *   creators from PostgreSQL and their current roles from Stream (read-only `queryMembers`), and prints
 *   one line per difference plus a summary. Nothing is written.
 * - `--apply`: additionally sends one `assign_roles` update per channel
 *   batch for the differing members.
 *
 * A member Stream does not report (not in the channel) is counted as
 * `missing` and never written here: the community-channel-sync lane owns
 * membership. `--max N` bounds the members examined; batches are paced.
 * Requires `DATABASE_URL`, `STREAM_API_KEY`, `STREAM_API_SECRET`.
 */

export type CommunityStreamRolesBackfillErrorCode =
  | "community_stream_roles_backfill_arguments_invalid"
  | "community_stream_roles_backfill_database_unconfigured"
  | "community_stream_roles_backfill_stream_unconfigured"
  | "community_stream_roles_backfill_failed";

export const COMMUNITY_STREAM_ROLES_BACKFILL_BATCH_SIZE = 100;
export const COMMUNITY_STREAM_ROLES_BACKFILL_BATCH_PAUSE_MS = 200;
const defaultMaximum = 100_000;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface CommunityStreamRolesBackfillRequest {
  readonly mode: "dry-run" | "apply";
  readonly databaseUrl: string;
  readonly stream: { readonly apiKey: string; readonly apiSecret: string };
  readonly maximum: number;
}

export type CreateCommunityStreamRolesBackfillDependencies = (
  request: CommunityStreamRolesBackfillRequest,
) => {
  readonly members: CommunityChannelRoleRepository;
  readonly gateway: Pick<
    StreamCommunityChannelGateway,
    "readMemberChannelRoles" | "assignMemberChannelRoles"
  >;
  readonly close: () => Promise<void>;
  readonly pause?: () => Promise<void>;
};

export class CommunityStreamRolesBackfillError extends Error {
  constructor(readonly code: CommunityStreamRolesBackfillErrorCode) {
    super("Community Stream roles backfill failed");
    this.name = "CommunityStreamRolesBackfillError";
  }
}

export function parseCommunityStreamRolesBackfillRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommunityStreamRolesBackfillRequest {
  const args = argv.slice(2);
  let mode: "dry-run" | "apply" | null = null;
  let maximum = defaultMaximum;
  let maximumSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--dry-run" || arg === "--apply") && mode === null) {
      mode = arg === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (arg === "--max" && !maximumSeen) {
      const raw = args[index + 1] ?? "";
      if (!/^[1-9][0-9]{0,6}$/.test(raw)) {
        throw new CommunityStreamRolesBackfillError(
          "community_stream_roles_backfill_arguments_invalid",
        );
      }
      maximum = Number(raw);
      maximumSeen = true;
      index += 1;
      continue;
    }
    throw new CommunityStreamRolesBackfillError(
      "community_stream_roles_backfill_arguments_invalid",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new CommunityStreamRolesBackfillError(
      "community_stream_roles_backfill_database_unconfigured",
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
    throw new CommunityStreamRolesBackfillError(
      "community_stream_roles_backfill_stream_unconfigured",
    );
  }
  return Object.freeze({
    mode: mode ?? "dry-run",
    databaseUrl,
    stream: Object.freeze({ apiKey, apiSecret }),
    maximum,
  });
}

function defaultCreateDependencies(
  request: CommunityStreamRolesBackfillRequest,
): ReturnType<CreateCommunityStreamRolesBackfillDependencies> {
  const pool = new pg.Pool({
    application_name: "loop-api-community-stream-roles-backfill",
    connectionString: request.databaseUrl,
    max: 1,
  });
  return {
    members: createPostgresCommunityChannelRoleRepository(pool),
    gateway: createStreamCommunityChannelGateway(request.stream),
    close: () => pool.end(),
  };
}

export interface CommunityStreamRoleDifference {
  /** `community` official channel member, or `group` friend-group creator. */
  readonly scope: "community" | "group";
  /** The community ID or the group ID. */
  readonly scopeId: string;
  readonly memberStreamUserId: string;
  readonly currentChannelRole: string | null;
  readonly desiredChannelRole: "channel_moderator" | "channel_member";
}

export interface CommunityStreamRolesBackfillResult {
  /** Community channel members plus friend-group creators examined. */
  readonly examined: number;
  readonly matching: number;
  readonly differing: readonly CommunityStreamRoleDifference[];
  /** In LOOP but not reported by Stream; left to the owning lane. */
  readonly missing: number;
  /** Differences written in `--apply`; always 0 in a dry run. */
  readonly applied: number;
  readonly truncated: boolean;
}

interface RoleTarget {
  readonly scope: "community" | "group";
  readonly scopeId: string;
  readonly streamChannelId: string;
  readonly actingStreamUserId: string;
  readonly memberStreamUserId: string;
  readonly desiredChannelRole: "channel_moderator" | "channel_member";
}

function groupByChannel(
  rows: readonly RoleTarget[],
): readonly (readonly RoleTarget[])[] {
  const groups = new Map<string, RoleTarget[]>();
  for (const row of rows) {
    const group = groups.get(row.streamChannelId) ?? [];
    group.push(row);
    groups.set(row.streamChannelId, group);
  }
  return [...groups.values()];
}

function communityTarget(row: SyncedCommunityChannelMemberRole): RoleTarget {
  return {
    scope: "community",
    scopeId: row.communityId,
    streamChannelId: row.streamChannelId,
    actingStreamUserId: row.channelCreatedByStreamUserId,
    memberStreamUserId: row.memberStreamUserId,
    desiredChannelRole: row.desiredChannelRole,
  };
}

function groupTarget(row: FriendGroupCreatorRole): RoleTarget {
  return {
    scope: "group",
    scopeId: row.groupId,
    streamChannelId: row.streamChannelId,
    actingStreamUserId: row.creatorStreamUserId,
    memberStreamUserId: row.creatorStreamUserId,
    desiredChannelRole: row.desiredChannelRole,
  };
}

export async function backfillCommunityStreamRoles(
  request: CommunityStreamRolesBackfillRequest,
  createDependencies: CreateCommunityStreamRolesBackfillDependencies = defaultCreateDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<CommunityStreamRolesBackfillResult> {
  const dependencies = createDependencies(request);
  const { members, gateway, close } = dependencies;
  const pause =
    dependencies.pause ??
    (() => sleep(COMMUNITY_STREAM_ROLES_BACKFILL_BATCH_PAUSE_MS));
  let examined = 0;
  let matching = 0;
  let missing = 0;
  let applied = 0;
  const differing: CommunityStreamRoleDifference[] = [];

  async function reconcile(page: readonly RoleTarget[]): Promise<void> {
    for (const channel of groupByChannel(page)) {
      signal.throwIfAborted();
      const first = channel[0];
      if (first === undefined) {
        continue;
      }
      const observed = await gateway.readMemberChannelRoles({
        channelId: first.streamChannelId,
        streamUserIds: channel.map((row) => row.memberStreamUserId),
        signal,
      });
      const roles = new Map(
        observed.map((entry) => [entry.streamUserId, entry.channelRole]),
      );
      const toAssign: RoleTarget[] = [];
      for (const row of channel) {
        examined += 1;
        if (!roles.has(row.memberStreamUserId)) {
          missing += 1;
          continue;
        }
        const current = roles.get(row.memberStreamUserId) ?? null;
        if (current === row.desiredChannelRole) {
          matching += 1;
          continue;
        }
        differing.push(
          Object.freeze({
            scope: row.scope,
            scopeId: row.scopeId,
            memberStreamUserId: row.memberStreamUserId,
            currentChannelRole: current,
            desiredChannelRole: row.desiredChannelRole,
          }),
        );
        toAssign.push(row);
      }
      if (request.mode === "apply" && toAssign.length > 0) {
        await gateway.assignMemberChannelRoles({
          channelId: first.streamChannelId,
          actingStreamUserId: first.actingStreamUserId,
          assignments: toAssign.map((row) => ({
            streamUserId: row.memberStreamUserId,
            channelRole: row.desiredChannelRole,
          })),
          signal,
        });
        applied += toAssign.length;
      }
    }
  }

  const remaining = (): number => request.maximum - examined;
  const nextLimit = (): number =>
    Math.min(COMMUNITY_STREAM_ROLES_BACKFILL_BATCH_SIZE, remaining());

  try {
    let truncated = false;
    // Phase 1: official community channel members.
    let after: SyncedCommunityChannelMemberRole | null = null;
    let communitiesDone = false;
    while (remaining() > 0) {
      signal.throwIfAborted();
      const limit = nextLimit();
      const page: readonly SyncedCommunityChannelMemberRole[] =
        await members.listSyncedMemberRoles({
          limit,
          after:
            after === null
              ? null
              : {
                  communityId: after.communityId,
                  ownerUserId: after.ownerUserId,
                },
        });
      await reconcile(page.map(communityTarget));
      const last = page.at(-1);
      if (last === undefined || page.length < limit) {
        communitiesDone = true;
        break;
      }
      after = last;
      await pause();
    }
    // Phase 2: friend-group creators (ruling 2026-09-28).
    let afterGroupId: string | null = null;
    let groupsDone = false;
    while (communitiesDone && remaining() > 0) {
      signal.throwIfAborted();
      const limit = nextLimit();
      const page: readonly FriendGroupCreatorRole[] =
        await members.listGroupCreators({ limit, afterGroupId });
      await reconcile(page.map(groupTarget));
      const last = page.at(-1);
      if (last === undefined || page.length < limit) {
        groupsDone = true;
        break;
      }
      afterGroupId = last.groupId;
      await pause();
    }
    truncated = !(communitiesDone && groupsDone);
    return Object.freeze({
      examined,
      matching,
      differing: Object.freeze(differing),
      missing,
      applied,
      truncated,
    });
  } finally {
    await close();
  }
}

export function formatCommunityStreamRolesBackfill(
  mode: "dry-run" | "apply",
  result: CommunityStreamRolesBackfillResult,
): string {
  const lines = result.differing.map(
    (difference) =>
      `${mode === "apply" ? "assigned" : "would assign"} ${difference.scope}=${difference.scopeId} member=${difference.memberStreamUserId} ${difference.currentChannelRole ?? "(none)"} -> ${difference.desiredChannelRole}`,
  );
  lines.push(
    `${mode === "apply" ? "Applied" : "Dry run"}: examined ${String(result.examined)} (community members + group creators), ` +
      `${String(result.matching)} already match, ${String(result.differing.length)} differ, ` +
      `${String(result.missing)} not in the Stream channel (left to the owning lane), ` +
      `${String(result.applied)} written` +
      (result.truncated ? " (stopped at --max)" : ""),
  );
  if (mode === "dry-run" && result.differing.length > 0) {
    lines.push("Nothing written; rerun with --apply");
  }
  return `${lines.join("\n")}\n`;
}

export interface RunCommunityStreamRolesBackfillOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createDependencies?: CreateCommunityStreamRolesBackfillDependencies;
  readonly signal?: AbortSignal;
}

export async function runCommunityStreamRolesBackfill(
  options: RunCommunityStreamRolesBackfillOptions,
): Promise<0 | 1> {
  let request: CommunityStreamRolesBackfillRequest;
  try {
    request = parseCommunityStreamRolesBackfillRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof CommunityStreamRolesBackfillError
        ? error.code
        : "community_stream_roles_backfill_failed";
    options.stderr.write(`Community Stream roles backfill refused (${code})\n`);
    return 1;
  }
  try {
    const result = await backfillCommunityStreamRoles(
      request,
      options.createDependencies,
      options.signal,
    );
    options.stdout.write(
      formatCommunityStreamRolesBackfill(request.mode, result),
    );
    return result.truncated ? 1 : 0;
  } catch {
    options.stderr.write(
      "Community Stream roles backfill failed (community_stream_roles_backfill_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCommunityStreamRolesBackfill({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
